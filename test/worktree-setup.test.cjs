// worktree 환경 자동화(main/worktree-setup.cjs)와 정리 안전장치(changes.removeWorktree) 테스트.
// 임시 폴더에 진짜 Git 저장소와 정션을 만들어, 정리한 뒤에도 원본 쪽 파일이 남는지 확인한다.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const setup = require('../main/worktree-setup.cjs');
const changes = require('../changes.cjs');

let base;
let repo;
const git = (cwd, ...args) => execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8' });
const id = character => character.repeat(8) + '-2222-4222-8222-222222222222';
const write = (file, text) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, text); };

before(() => {
  base = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'hermit-wtsetup-')));
  repo = path.join(base, 'repo');
  fs.mkdirSync(repo);
  git(repo, 'init', '-q', '-b', 'main');
  git(repo, 'config', 'user.email', 'test@example.com');
  git(repo, 'config', 'user.name', 'test');
  git(repo, 'config', 'core.autocrlf', 'false');
  write(path.join(repo, '.gitignore'), 'node_modules/\n.env\n.env.local\nsecret/\nbig.bin\n');
  write(path.join(repo, '.worktreeinclude'), '.env\n.env.local\nconfig/*.local.json\nsecret/\nbig.bin\ntracked.txt\n');
  write(path.join(repo, 'tracked.txt'), 'tracked\n');
  write(path.join(repo, 'a.txt'), 'a\n');
  git(repo, 'add', '.');
  git(repo, 'commit', '-qm', 'init');
  write(path.join(repo, '.env'), 'TOKEN=1\n');
  write(path.join(repo, '.env.local'), 'LOCAL=1\n');
  write(path.join(repo, 'config', 'app.local.json'), '{}\n');
  write(path.join(repo, 'config', 'app.json'), '{}\n');
  write(path.join(repo, 'secret', 'inner.txt'), 'inner\n');
  write(path.join(repo, 'big.bin'), 'x'.repeat(2048));
  write(path.join(repo, 'node_modules', 'pkg', 'index.js'), 'module.exports = 1;\n');
});

after(() => fs.rmSync(base, { recursive: true, force: true }));

test('상대 경로 검사: 바깥·.git·드라이브·ADS를 거부한다', () => {
  assert.equal(setup.safeRelative('node_modules'), 'node_modules');
  assert.equal(setup.safeRelative('packages\\web\\node_modules\\'), 'packages/web/node_modules');
  for (const bad of ['', '../x', 'a/../b', 'C:/x', '/abs', '.git', 'a/.git/b', 'a:b', 'x\u0001', 'trail.', 42]) {
    assert.equal(setup.safeRelative(bad), null, String(bad));
  }
  assert.deepEqual(setup.normalizeShareDirs(['node_modules', 'Node_Modules', '../x', 'apps/web/node_modules']), ['node_modules', 'apps/web/node_modules']);
});

test('.worktreeinclude: 추적하지 않는 파일만 고르고 크기 제한을 지킨다', async () => {
  const plan = await setup.planInclude(repo, { maxFileBytes: 1024 });
  const names = plan.files.map(file => file.path).sort();
  assert.deepEqual(names, ['.env', '.env.local', 'config/app.local.json', 'secret/inner.txt']);
  assert.ok(!names.includes('tracked.txt'), '추적하는 파일은 복사하지 않는다(체크아웃에 이미 있음)');
  assert.ok(plan.skipped.some(entry => entry.path === 'big.bin' && /너무/.test(entry.reason)));
  const few = await setup.planInclude(repo, { maxFiles: 2 });
  assert.equal(few.files.length, 2);
  assert.equal(few.truncated, true);
  const none = await setup.planInclude(path.join(repo, 'config'));
  assert.equal(none.exists, false);
});

test('저장소 밖을 가리키는 링크를 통한 파일은 복사하지 않는다', async () => {
  const outside = path.join(base, 'outside');
  write(path.join(outside, '.env'), 'OUTSIDE=1\n');
  const linked = path.join(repo, 'secret', 'escape');
  fs.symlinkSync(outside, linked, 'junction');
  try {
    const plan = await setup.planInclude(repo);
    assert.ok(!plan.files.some(file => file.path.startsWith('secret/escape')), JSON.stringify(plan.files));
  } finally { fs.unlinkSync(linked); }
});

test('새 worktree로 복사하고, 이미 있는 파일은 덮어쓰지 않는다', async () => {
  const created = await changes.createTaskWorktree(repo, 'copy test', id('c'));
  try {
    write(path.join(created.path, '.env.local'), 'KEEP=1\n');
    const plan = await setup.planInclude(repo);
    const result = await setup.copyIncluded(repo, created.path, plan);
    assert.deepEqual(result.copied.sort(), ['.env', 'big.bin', 'config/app.local.json', 'secret/inner.txt']);
    assert.ok(result.skipped.some(entry => entry.path === '.env.local' && entry.reason === '이미 있음'));
    assert.equal(fs.readFileSync(path.join(created.path, '.env.local'), 'utf8'), 'KEEP=1\n');
    assert.equal(fs.readFileSync(path.join(created.path, '.env'), 'utf8'), 'TOKEN=1\n');
    assert.ok(!fs.existsSync(path.join(created.path, 'config', 'app.json')));
  } finally {
    await changes.removeWorktree(created.path, created.branch, true);
  }
});

test('정션 공유: Git이 무시하는 폴더만 연결하고, 이미 있으면 건드리지 않는다', async () => {
  const created = await changes.createTaskWorktree(repo, 'link test', id('d'));
  try {
    write(path.join(repo, 'tracked-dir', 'x.txt'), 'x');
    const result = await setup.linkShared(repo, created.path, ['node_modules', 'tracked-dir', 'missing', '../escape']);
    assert.deepEqual(result.linked, ['node_modules']);
    assert.ok(result.skipped.some(entry => entry.path === 'tracked-dir' && /무시하지 않는/.test(entry.reason)));
    assert.ok(result.skipped.some(entry => entry.path === 'missing'));
    const link = path.join(created.path, 'node_modules');
    assert.ok(fs.lstatSync(link).isSymbolicLink(), '정션으로 연결된다');
    assert.equal(fs.readFileSync(path.join(link, 'pkg', 'index.js'), 'utf8'), 'module.exports = 1;\n');
    const again = await setup.linkShared(repo, created.path, ['node_modules']);
    assert.deepEqual(again.linked, []);
    assert.equal(again.skipped[0].reason, '이미 있음');
  } finally {
    fs.rmSync(path.join(repo, 'tracked-dir'), { recursive: true, force: true });
    await changes.removeWorktree(created.path, created.branch, true);
  }
  assert.ok(fs.existsSync(path.join(repo, 'node_modules', 'pkg', 'index.js')), '정리 후에도 원본 node_modules가 남는다');
});

test('안전: worktree 정리(일반·강제)는 정션을 따라가 원본을 지우지 않는다', async () => {
  const original = path.join(repo, 'node_modules', 'pkg', 'index.js');
  for (const [letter, force] of [['e', false], ['f', true]]) {
    const created = await changes.createTaskWorktree(repo, 'safety ' + letter, id(letter));
    await setup.linkShared(repo, created.path, ['node_modules']);
    // 중첩 위치의 정션(모노레포 등)도 확인한다. 무시되지 않는 경로라도 직접 만든 경우를 가정한다.
    fs.mkdirSync(path.join(created.path, 'apps', 'web'), { recursive: true });
    fs.symlinkSync(path.join(repo, 'node_modules'), path.join(created.path, 'apps', 'web', 'node_modules'), 'junction');
    if (force) write(path.join(created.path, 'dirty.txt'), 'dirty');
    const { links } = await setup.findOuterLinks(created.path);
    assert.deepEqual(links.map(link => link.relative).sort(), ['apps/web/node_modules', 'node_modules']);
    const result = await changes.removeWorktree(created.path, created.branch, force);
    if (!force) {
      // 정션만 있는 worktree는 깨끗한 것으로 본다(앞의 apps 폴더는 정션만 담고 있다).
      assert.equal(result.removed, true, JSON.stringify(result));
    } else assert.equal(result.removed, true);
    assert.ok(!fs.existsSync(created.path), 'worktree 폴더가 지워진다');
    assert.ok(fs.existsSync(original), '원본 node_modules 파일이 남아 있다 (' + (force ? '강제' : '일반') + ' 정리)');
  }
});

test('안전: git 목록에서 빠지고 폴더만 남은 경우에도 정션을 먼저 뗀다', async () => {
  const original = path.join(repo, 'node_modules', 'pkg', 'index.js');
  const created = await changes.createTaskWorktree(repo, 'leftover', id('9'));
  await setup.linkShared(repo, created.path, ['node_modules']);
  // git 등록만 지운 상태를 흉내 낸다: .git 파일을 지우고 prune.
  fs.rmSync(path.join(created.path, '.git'), { force: true });
  git(repo, 'worktree', 'prune');
  write(path.join(created.path, 'left.txt'), 'x');
  const result = await changes.removeWorktree(created.path, created.branch, true);
  assert.equal(result.removed, true);
  assert.ok(!fs.existsSync(created.path));
  assert.ok(fs.existsSync(original), '남은 폴더 정리 후에도 원본이 남는다');
});

test('변경 확인에서 공유 정션 항목은 빼고 센다', () => {
  const entries = ['?? node_modules/', ' M a.txt', '?? apps/web/node_modules/'];
  const links = [{ relative: 'node_modules' }, { relative: 'apps/web/node_modules' }];
  assert.deepEqual(setup.withoutLinks(entries, links), [' M a.txt']);
});
