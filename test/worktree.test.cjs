// 작업별 worktree 생성·정리(changes.cjs) 테스트. 임시 폴더에 진짜 Git 저장소를 만들어 확인한다.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const changes = require('../changes.cjs');

let base;
let repo;
const git = (cwd, ...args) => execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8' });
const id = character => character.repeat(8) + '-1111-4111-8111-111111111111';

before(() => {
  base = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'workbench-worktree-')));
  repo = path.join(base, 'repo');
  fs.mkdirSync(repo);
  git(repo, 'init', '-q', '-b', 'main');
  git(repo, 'config', 'user.email', 'test@example.com');
  git(repo, 'config', 'user.name', 'test');
  git(repo, 'config', 'core.autocrlf', 'false');
  fs.writeFileSync(path.join(repo, 'a.txt'), 'a\n');
  git(repo, 'add', '.');
  git(repo, 'commit', '-qm', 'init');
});

after(() => fs.rmSync(base, { recursive: true, force: true }));

test('Git 저장소가 아니거나 커밋이 없으면 만들지 않는다', async () => {
  const plain = fs.mkdtempSync(path.join(base, 'plain-'));
  await assert.rejects(changes.createTaskWorktree(plain, 'x', id('a')), /Git 저장소가 아닌/);
  const empty = fs.mkdtempSync(path.join(base, 'empty-'));
  git(empty, 'init', '-q');
  await assert.rejects(changes.createTaskWorktree(empty, 'x', id('a')), /커밋이 하나 이상/);
});

test('잘못된 입력을 거부한다', async () => {
  await assert.rejects(changes.createTaskWorktree(repo, 'x', 'not-an-id'), /작업 ID/);
  await assert.rejects(changes.createTaskWorktree('relative', 'x', id('a')), /작업 폴더/);
  await assert.rejects(changes.createTaskWorktree(repo, '', id('a')), /작업 이름/);
});

test('작업마다 agent/ 브랜치와 <저장소>.worktrees 폴더를 만든다', async () => {
  const created = await changes.createTaskWorktree(repo, '로그인 오류 수정', id('a'));
  assert.equal(created.branch, 'agent/task-aaaaaaaa', '한글 이름은 task로 바뀐다');
  assert.equal(created.path, path.join(base, 'repo.worktrees', 'task-aaaaaaaa'));
  assert.equal(created.base, 'main');
  assert.ok(fs.existsSync(path.join(created.path, 'a.txt')));
  await assert.rejects(changes.createTaskWorktree(repo, '다시', id('a')), /이미 있습니다/);

  const nested = await changes.createTaskWorktree(created.path, 'Fix Login Bug!', id('b'));
  assert.equal(nested.branch, 'agent/fix-login-bug-bbbbbbbb');
  assert.equal(nested.root, path.resolve(repo), 'worktree 안에서 만들어도 원래 저장소 기준이다');

  await changes.removeWorktree(created.path, created.branch);
  await changes.removeWorktree(nested.path, nested.branch);
});

test('Workbench가 만든 worktree만 정리한다', async () => {
  const created = await changes.createTaskWorktree(repo, 'guard', id('c'));
  await assert.rejects(changes.removeWorktree(repo, 'agent/guard-cccccccc'), /Workbench가 만든/);
  await assert.rejects(changes.removeWorktree(created.path, 'main'), /올바르지 않습니다/);
  await assert.rejects(changes.removeWorktree(created.path, 'agent/other-cccccccc'), /Workbench가 만든/);
  await assert.rejects(changes.removeWorktree('relative\\x', created.branch), /올바르지 않습니다/);
  await assert.rejects(changes.removeWorktree(created.path, created.branch, 'yes'), /올바르지 않습니다/);
  await changes.removeWorktree(created.path, created.branch);
});

test('커밋하지 않은 변경이 있으면 force 없이는 지우지 않는다', async () => {
  const created = await changes.createTaskWorktree(repo, 'dirty', id('d'));
  fs.writeFileSync(path.join(created.path, 'new.txt'), 'x');
  assert.deepEqual(await changes.removeWorktree(created.path, created.branch), { dirty: 1 });
  assert.ok(fs.existsSync(created.path));
  const result = await changes.removeWorktree(created.path, created.branch, true);
  assert.equal(result.removed, true);
  assert.equal(result.branchDeleted, true, '커밋이 없는 브랜치는 병합된 것으로 보고 지운다');
  assert.ok(!fs.existsSync(created.path));
});

test('병합되지 않은 브랜치는 남긴다', async () => {
  const created = await changes.createTaskWorktree(repo, 'unmerged', id('e'));
  fs.writeFileSync(path.join(created.path, 'b.txt'), 'b');
  git(created.path, 'add', '.');
  git(created.path, 'commit', '-qm', 'b');
  const result = await changes.removeWorktree(created.path, created.branch);
  assert.equal(result.removed, true);
  assert.equal(result.branchKept, true);
  assert.match(git(repo, 'branch', '--list', created.branch), /unmerged/);
  git(repo, 'branch', '-D', created.branch);
});

test('푸시만 한 브랜치는 남기고, 기준 브랜치에 병합된 뒤에만 지운다', async () => {
  const remote = path.join(base, 'remote.git');
  git(base, 'init', '-q', '--bare', '-b', 'main', 'remote.git');
  git(repo, 'remote', 'add', 'origin', remote);
  git(repo, 'push', '-q', '-u', 'origin', 'main');

  const pushed = await changes.createTaskWorktree(repo, 'pushed', id('7'));
  fs.writeFileSync(path.join(pushed.path, 'p.txt'), 'p');
  git(pushed.path, 'add', '.');
  git(pushed.path, 'commit', '-qm', 'p');
  git(pushed.path, 'push', '-q', '-u', 'origin', pushed.branch);
  const kept = await changes.removeWorktree(pushed.path, pushed.branch, false, 'main');
  assert.equal(kept.branchKept, true, 'upstream에만 있는 브랜치를 지우면 안 된다');
  assert.match(git(repo, 'branch', '--list', pushed.branch), /pushed/);

  const merged = await changes.createTaskWorktree(repo, 'merged', id('8'));
  fs.writeFileSync(path.join(merged.path, 'm.txt'), 'm');
  git(merged.path, 'add', '.');
  git(merged.path, 'commit', '-qm', 'm');
  git(repo, 'merge', '-q', '--ff-only', merged.branch);
  const deleted = await changes.removeWorktree(merged.path, merged.branch, false, 'main');
  assert.equal(deleted.branchDeleted, true);
  assert.equal(git(repo, 'branch', '--list', merged.branch).trim(), '');

  await assert.rejects(changes.removeWorktree(merged.path, merged.branch, false, 5), /올바르지 않습니다/);
  git(repo, 'branch', '-D', pushed.branch);
  git(repo, 'remote', 'remove', 'origin');
});

test('폴더를 직접 지웠거나 폴더만 남은 경우도 정리한다', async () => {
  const gone = await changes.createTaskWorktree(repo, 'gone', id('f'));
  fs.rmSync(gone.path, { recursive: true, force: true });
  assert.equal((await changes.removeWorktree(gone.path, gone.branch)).branchDeleted, true);
  assert.doesNotMatch(git(repo, 'worktree', 'list'), /gone-ffffffff/);

  const half = await changes.createTaskWorktree(repo, 'half', id('9'));
  git(repo, 'worktree', 'remove', '--force', half.path);
  fs.mkdirSync(half.path);
  fs.writeFileSync(path.join(half.path, 'left.txt'), 'x');
  assert.deepEqual(await changes.removeWorktree(half.path, half.branch), { dirty: 1 });
  assert.equal((await changes.removeWorktree(half.path, half.branch, true)).removed, true);
  assert.ok(!fs.existsSync(half.path));
});
