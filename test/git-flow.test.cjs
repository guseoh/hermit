// 스테이지·커밋·푸시·PR 입력 검사(changes.cjs)와 AI 커밋 메시지 정리(commit-message.cjs) 테스트.
// 푸시는 로컬 bare 저장소를 origin으로 써서 확인한다. GitHub와 AI는 호출하지 않는다.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const changes = require('../changes.cjs');
const commitMessage = require('../commit-message.cjs');

let base;
let repo;
const git = (cwd, ...args) => execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8' });
const write = (name, text) => fs.writeFileSync(path.join(repo, name), text);
const kinds = async () => (await changes.status(repo)).files.map(file => file.kind + ':' + file.name).sort();

function init(directory) {
  fs.mkdirSync(directory, { recursive: true });
  git(directory, 'init', '-q', '-b', 'main');
  git(directory, 'config', 'user.email', 'test@example.com');
  git(directory, 'config', 'user.name', 'test');
  git(directory, 'config', 'core.autocrlf', 'false');
  git(directory, 'config', 'commit.gpgsign', 'false');
}

before(() => {
  base = fs.mkdtempSync(path.join(os.tmpdir(), 'workbench-git-'));
  repo = path.join(base, 'repo');
  init(repo);
  write('a.txt', 'a\n');
  git(repo, 'add', '.');
  git(repo, 'commit', '-qm', '처음');
  git(base, 'init', '-q', '--bare', '-b', 'main', 'origin.git');
  git(repo, 'remote', 'add', 'origin', path.join(base, 'origin.git'));
});

after(() => fs.rmSync(base, { recursive: true, force: true }));

test('파일 하나씩 스테이지하고 취소한다', async () => {
  write('a.txt', 'a\nb\n');
  write('새 파일.txt', '한글 이름\n');
  assert.deepEqual(await kinds(), ['new:새 파일.txt', 'unstaged:a.txt']);
  await changes.stage(repo, ['새 파일.txt']);
  assert.deepEqual(await kinds(), ['staged:새 파일.txt', 'unstaged:a.txt']);
  await changes.unstage(repo, ['새 파일.txt']);
  assert.deepEqual(await kinds(), ['new:새 파일.txt', 'unstaged:a.txt']);
  await changes.stageAll(repo);
  assert.deepEqual(await kinds(), ['staged:a.txt', 'staged:새 파일.txt']);
});

test('지금 변경 목록에 없는 경로는 git에 넘기지 않는다', async () => {
  await assert.rejects(changes.stage(repo, ['../outside.txt']), /변경 목록이 바뀌었습니다/);
  await assert.rejects(changes.stage(repo, ['-A']), /변경 목록이 바뀌었습니다/);
  await assert.rejects(changes.unstage(repo, ['없는 파일']), /변경 목록이 바뀌었습니다/);
  await assert.rejects(changes.stage(repo, []), /파일을 선택하세요/);
  await assert.rejects(changes.stage(repo, 'a.txt'), /파일을 선택하세요/);
});

test('커밋 전에 메시지와 스테이지를 확인하고, 여러 줄 메시지로 커밋한다', async () => {
  await assert.rejects(changes.commit(repo, '   '), /커밋 메시지/);
  await assert.rejects(changes.commit(repo, 7), /커밋 메시지/);
  const result = await changes.commit(repo, 'b 줄과 새 파일 추가\r\n\r\n- 본문 한 줄');
  assert.equal(result.subject, 'b 줄과 새 파일 추가');
  assert.equal(git(repo, 'log', '-1', '--format=%B').trim(), 'b 줄과 새 파일 추가\n\n- 본문 한 줄');
  assert.deepEqual(await kinds(), []);
  await assert.rejects(changes.commit(repo, '빈 커밋'), /스테이지한 변경이 없습니다/);
});

test('처음 푸시하면 upstream을 만들고, 이후 앞선 커밋 수를 보여 준다', async () => {
  let snapshot = await changes.status(repo);
  assert.equal(snapshot.upstream, null);
  const pushed = await changes.push(repo);
  assert.deepEqual(pushed, { branch: 'main', upstream: 'origin/main' });
  snapshot = await changes.status(repo);
  assert.equal(snapshot.upstream, 'origin/main');
  assert.equal(snapshot.ahead, 0);
  write('c.txt', 'c\n');
  await changes.stageAll(repo);
  await changes.commit(repo, 'c 추가');
  assert.equal((await changes.status(repo)).ahead, 1);
  await changes.push(repo);
  assert.equal((await changes.status(repo)).ahead, 0);
  assert.equal(git(path.join(base, 'origin.git'), 'log', '-1', '--format=%s', 'main').trim(), 'c 추가');
});

test('원격에 새 커밋이 있으면 푸시 거부를 알려 준다', async () => {
  const other = path.join(base, 'other');
  git(base, 'clone', '-q', path.join(base, 'origin.git'), other);
  git(other, 'config', 'user.email', 'test@example.com');
  git(other, 'config', 'user.name', 'test');
  fs.writeFileSync(path.join(other, 'd.txt'), 'd\n');
  git(other, 'add', '.');
  git(other, 'commit', '-qm', '다른 곳 커밋');
  git(other, 'push', '-q');
  write('e.txt', 'e\n');
  await changes.stageAll(repo);
  await changes.commit(repo, 'e 추가');
  await assert.rejects(changes.push(repo), /먼저 pull/);
  git(repo, 'reset', '-q', '--hard', 'origin/main');
  git(repo, 'pull', '-q', '--ff-only');
});

test('PR 만들기 입력을 검사한다(GitHub 호출 전)', async () => {
  await assert.rejects(changes.createPullRequest(repo, { title: '', base: 'main' }), /PR 제목/);
  await assert.rejects(changes.createPullRequest(repo, { title: 't', base: '-x' }), /기준 브랜치/);
  await assert.rejects(changes.createPullRequest(repo, { title: 't', base: 'main', draft: 'yes' }), /기준 브랜치/);
  await assert.rejects(changes.createPullRequest(repo, { title: 't', base: 'main' }), /기준 브랜치와 다른/);
  git(repo, 'switch', '-q', '-c', 'feature');
  await assert.rejects(changes.createPullRequest(repo, { title: 't', base: 'main' }), /먼저 브랜치를 푸시/);
  git(repo, 'switch', '-q', 'main');
});

test('AI에 넘길 자료는 staged diff만 쓰고 길면 자른다', async () => {
  await assert.rejects(changes.commitContext(repo), /스테이지한 변경이 없습니다/);
  write('big.txt', 'x'.repeat(100) + '\n'.repeat(1) + Array.from({ length: 2000 }, (_, i) => 'line ' + i).join('\n'));
  write('a.txt', 'unstaged change\n');
  await changes.stage(repo, ['big.txt']);
  const context = await changes.commitContext(repo);
  assert.equal(context.branch, 'main');
  assert.match(context.stat, /big\.txt/);
  assert.doesNotMatch(context.diff, /unstaged change/);
  assert.ok(context.diff.length <= 60000);
  assert.match(context.recent, /c 추가/);
  const prompt = commitMessage.buildPrompt(context);
  assert.match(prompt, /커밋 메시지만 출력/);
  assert.match(prompt, /big\.txt/);
});

test('AI 답변에서 코드 블록·머리말·따옴표를 걷어 낸다', () => {
  assert.equal(commitMessage.clean('```\n제목\n\n- 본문\n```'), '제목\n\n- 본문');
  assert.equal(commitMessage.clean('커밋 메시지: 로그인 오류 수정'), '로그인 오류 수정');
  assert.equal(commitMessage.clean('"Fix login bug"'), 'Fix login bug');
  assert.equal(commitMessage.clean('  제목\r\n\r\n본문  '), '제목\n\n본문');
  assert.equal(commitMessage.clean(''), '');
});
