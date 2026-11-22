// 변경 패널 파일 감시(git-watch.cjs) 테스트. 임시 Git 저장소와 worktree에서 실제로 감시한다.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { createGitWatcher, relevantWorkTreeChange, relevantGitDirChange } = require('../git-watch.cjs');
const { repositoryPaths } = require('../changes.cjs');

let base;
let repo;
const git = (cwd, ...args) => execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8' });
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

before(() => {
  base = fs.mkdtempSync(path.join(os.tmpdir(), 'workbench-watch-'));
  repo = path.join(base, 'repo');
  fs.mkdirSync(repo);
  git(repo, 'init', '-q', '-b', 'main');
  git(repo, 'config', 'user.email', 'test@example.com');
  git(repo, 'config', 'user.name', 'test');
  fs.writeFileSync(path.join(repo, 'a.txt'), 'a\n');
  git(repo, 'add', '.');
  git(repo, 'commit', '-qm', 'init');
});

after(() => fs.rmSync(base, { recursive: true, force: true }));

// notify가 불린 횟수를 세는 감시기
function counted() {
  const calls = [];
  const watcher = createGitWatcher(repositoryPaths, root => calls.push(root));
  return { watcher, calls };
}

async function waitFor(check, limit = 3000) {
  const start = Date.now();
  while (Date.now() - start < limit) {
    if (check()) return true;
    await sleep(50);
  }
  return check();
}

test('상태에 영향이 없는 경로는 거른다', () => {
  assert.equal(relevantWorkTreeChange('src\\a.js'), true);
  assert.equal(relevantWorkTreeChange('node_modules\\x\\index.js'), false);
  assert.equal(relevantWorkTreeChange('web/node_modules/y.js'), false);
  assert.equal(relevantWorkTreeChange('.git\\index'), true);
  assert.equal(relevantWorkTreeChange('.git\\objects\\ab\\cdef'), false);
  assert.equal(relevantWorkTreeChange('.git\\index.lock'), false);
  assert.equal(relevantWorkTreeChange(null), true, '이름을 모르면 갱신한다');
  assert.equal(relevantGitDirChange('refs/heads/main'), true);
  assert.equal(relevantGitDirChange('logs\\HEAD'), true);
  assert.equal(relevantGitDirChange('logs/refs/heads/main'), false);
});

test('Git 저장소가 아니거나 잘못된 경로면 감시하지 않는다', async () => {
  const { watcher } = counted();
  assert.equal(await watcher.watch(fs.mkdtempSync(path.join(base, 'plain-'))), null);
  await assert.rejects(watcher.watch('relative'), /잘못된 폴더/);
  assert.equal(await watcher.watch(null), null);
});

test('파일을 고치면 한 번으로 묶어 알리고, node_modules 변경은 무시한다', async () => {
  const { watcher, calls } = counted();
  const result = await watcher.watch(path.join(repo));
  assert.equal(result.watching, true);
  await sleep(200);
  calls.length = 0;
  fs.mkdirSync(path.join(repo, 'node_modules', 'pkg'), { recursive: true });
  fs.writeFileSync(path.join(repo, 'node_modules', 'pkg', 'x.js'), 'x');
  await sleep(700);
  assert.equal(calls.length, 0, 'node_modules 변경은 알리지 않는다');
  for (let i = 0; i < 5; i++) fs.writeFileSync(path.join(repo, 'a.txt'), 'change ' + i);
  assert.ok(await waitFor(() => calls.length > 0), '작업 트리 변경을 알린다');
  await sleep(500);
  assert.equal(calls.length, 1, '연속 변경은 한 번으로 묶는다');
  assert.equal(calls[0].toLowerCase(), path.resolve(repo).toLowerCase());
  watcher.stop();
  calls.length = 0;
  fs.writeFileSync(path.join(repo, 'a.txt'), 'after stop');
  await sleep(600);
  assert.equal(calls.length, 0, '멈춘 뒤에는 알리지 않는다');
  git(repo, 'checkout', '-q', '--', 'a.txt');
});

test('worktree에서 git add로 스테이지만 바뀌어도 알린다(작업 트리 밖의 git 폴더 감시)', async () => {
  const tree = path.join(base, 'tree');
  git(repo, 'worktree', 'add', '-q', '-b', 'feature', tree);
  fs.writeFileSync(path.join(tree, 'b.txt'), 'b');
  const { watcher, calls } = counted();
  assert.equal((await watcher.watch(tree)).watching, true);
  await sleep(300);
  calls.length = 0;
  git(tree, 'add', 'b.txt');
  assert.ok(await waitFor(() => calls.length > 0), 'git add를 알린다');
  calls.length = 0;
  git(tree, 'commit', '-qm', 'b');
  assert.ok(await waitFor(() => calls.length > 0), '커밋을 알린다');
  watcher.stop();
});

test('같은 저장소를 다시 감시하면 그대로 두고, 다른 저장소로 바꾸면 앞의 감시를 멈춘다', async () => {
  const other = path.join(base, 'other');
  fs.mkdirSync(other);
  git(other, 'init', '-q');
  const { watcher, calls } = counted();
  await watcher.watch(repo);
  assert.equal((await watcher.watch(path.join(repo))).watching, true);
  await watcher.watch(other);
  await sleep(300);
  calls.length = 0;
  fs.writeFileSync(path.join(repo, 'a.txt'), 'old repo change');
  await sleep(600);
  assert.equal(calls.length, 0, '앞 저장소는 더 이상 감시하지 않는다');
  fs.writeFileSync(path.join(other, 'n.txt'), 'n');
  assert.ok(await waitFor(() => calls.length > 0));
  watcher.stop();
  git(repo, 'checkout', '-q', '--', 'a.txt');
});
