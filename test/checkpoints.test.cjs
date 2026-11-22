// 턴 체크포인트(checkpoints.cjs) 테스트. 임시 Git 저장소에서 만들기·되돌리기·되돌리기 취소를 확인한다.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const checkpoints = require('../checkpoints.cjs');

let base;
let repo;
const taskId = '0f0e0d0c-1111-4111-8111-111111111111';
const git = (...args) => execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8' });
const read = name => fs.readFileSync(path.join(repo, name), 'utf8');
const write = (name, text) => { fs.mkdirSync(path.dirname(path.join(repo, name)), { recursive: true }); fs.writeFileSync(path.join(repo, name), text); };

before(() => {
  base = fs.mkdtempSync(path.join(os.tmpdir(), 'workbench-checkpoint-'));
  repo = path.join(base, 'repo');
  fs.mkdirSync(repo);
  git('init', '-q', '-b', 'main');
  git('config', 'user.email', 'test@example.com');
  git('config', 'user.name', 'test');
  git('config', 'core.autocrlf', 'false');
  write('a.txt', 'a1\n');
  write('keep.txt', 'keep\n');
  write('.gitignore', 'ignored/\n');
  git('add', '.');
  git('commit', '-qm', 'init');
});

after(() => fs.rmSync(base, { recursive: true, force: true }));

test('Git 저장소가 아니면 체크포인트를 만들지 않고, 잘못된 입력은 거부한다', async () => {
  assert.equal(await checkpoints.createCheckpoint(fs.mkdtempSync(path.join(base, 'plain-')), taskId), null);
  await assert.rejects(checkpoints.createCheckpoint(repo, 'nope'), /작업 ID/);
  await assert.rejects(checkpoints.restoreCheckpoint(repo, taskId, 'refs/heads/main'), /잘못된 체크포인트/);
  await assert.rejects(checkpoints.restoreCheckpoint(repo, taskId, 'refs/workbench/checkpoints/' + taskId + '/1700000000000-abcd'), /찾지 못했습니다/);
});

test('요청 전 상태로 되돌린다: 고친 파일·지운 파일은 되살리고, 새 파일만 지운다. 인덱스와 무시 파일은 그대로', async () => {
  write('a.txt', 'a2 (요청 전 수정)\n');
  write('draft.txt', '요청 전에 만든 새 파일\n');
  git('add', 'draft.txt');
  const indexBefore = git('diff', '--cached', '--name-only');
  const checkpoint = await checkpoints.createCheckpoint(repo, taskId, '로그인 고쳐 줘');
  assert.match(checkpoint.ref, /^refs\/workbench\/checkpoints\/0f0e0d0c-1111-4111-8111-111111111111\/\d{13}-[0-9a-f]{4}$/);
  assert.equal(git('diff', '--cached', '--name-only'), indexBefore, '체크포인트를 만들어도 인덱스는 그대로');
  assert.equal(git('status', '--porcelain').includes('a.txt'), true, '작업 폴더도 그대로');

  // 에이전트가 한 일
  write('a.txt', 'a3 (에이전트 수정)\n');
  fs.rmSync(path.join(repo, 'keep.txt'));
  write('src/new/agent.txt', '에이전트가 만든 파일\n');
  write('ignored/cache.bin', 'x');

  const result = await checkpoints.restoreCheckpoint(repo, taskId, checkpoint.ref);
  assert.equal(read('a.txt'), 'a2 (요청 전 수정)\n');
  assert.equal(read('keep.txt'), 'keep\n');
  assert.equal(read('draft.txt'), '요청 전에 만든 새 파일\n');
  assert.equal(fs.existsSync(path.join(repo, 'src')), false, '새 파일과 비게 된 폴더를 지운다');
  assert.equal(fs.existsSync(path.join(repo, 'ignored', 'cache.bin')), true, '.gitignore 대상은 건드리지 않는다');
  assert.deepEqual({ restored: result.restored, deleted: result.deleted }, { restored: 2, deleted: 1 });
  assert.equal(git('diff', '--cached', '--name-only'), indexBefore, '되돌려도 인덱스는 그대로');

  // 되돌리기 취소: 되돌리기 전 상태(에이전트가 한 일)로
  await checkpoints.restoreCheckpoint(repo, taskId, result.backup);
  assert.equal(read('a.txt'), 'a3 (에이전트 수정)\n');
  assert.equal(fs.existsSync(path.join(repo, 'keep.txt')), false);
  assert.equal(read('src/new/agent.txt'), '에이전트가 만든 파일\n');
});

test('작업마다 최근 체크포인트만 남긴다', async () => {
  const other = '0f0e0d0c-2222-4222-8222-222222222222';
  for (let i = 0; i < checkpoints.keepPerTask + 3; i++) await checkpoints.createCheckpoint(repo, other, 'n' + i);
  const refs = git('for-each-ref', '--format=%(refname)', 'refs/workbench/checkpoints/' + other + '/').trim().split('\n');
  assert.equal(refs.length, checkpoints.keepPerTask);
  assert.ok(!git('branch', '--list').includes('workbench'), '브랜치를 만들지 않는다');
});

test('worktree 안에서도 체크포인트를 만들고 되돌리며, 작업을 정리하면 참조를 모두 지운다', async () => {
  const tree = path.join(base, 'tree');
  git('worktree', 'add', '-q', '-b', 'feature', tree);
  const taskInTree = '0f0e0d0c-3333-4333-8333-333333333333';
  fs.writeFileSync(path.join(tree, 'a.txt'), 'worktree 수정\n');
  const cp = await checkpoints.createCheckpoint(tree, taskInTree, 'wt');
  fs.writeFileSync(path.join(tree, 'a.txt'), 'agent\n');
  fs.writeFileSync(path.join(tree, 'b.txt'), 'new\n');
  await checkpoints.restoreCheckpoint(tree, taskInTree, cp.ref);
  assert.equal(fs.readFileSync(path.join(tree, 'a.txt'), 'utf8'), 'worktree 수정\n');
  assert.equal(fs.existsSync(path.join(tree, 'b.txt')), false);
  const before = git('for-each-ref', '--format=%(refname)', 'refs/workbench/checkpoints/' + taskInTree + '/').trim().split('\n').length;
  assert.ok(before >= 2, '체크포인트와 되돌리기 전 체크포인트');
  assert.equal(await checkpoints.clearCheckpoints(repo, taskInTree), before, '원래 저장소에서 지워도 같은 참조(worktree는 참조를 공유)');
  assert.equal(git('for-each-ref', 'refs/workbench/checkpoints/' + taskInTree + '/').trim(), '');
  await assert.rejects(checkpoints.clearCheckpoints(repo, 'bad'), /작업 ID/);
});
