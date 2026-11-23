const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { randomUUID } = require('node:crypto');
const changes = require('../changes.cjs');

test('공통 기준 커밋, worktree별 파일과 검증 결과를 연결한다', async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'workbench-compare-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const root = path.join(dir, 'repo');
  await fs.mkdir(root);
  const git = (cwd, ...args) => execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8' }).trim();
  git(root, 'init', '-q');
  git(root, 'config', 'user.email', 'test@example.org');
  git(root, 'config', 'user.name', 'test');
  await fs.writeFile(path.join(root, 'file.txt'), 'original');
  await fs.writeFile(path.join(root, '.gitignore'), 'ignored.txt');
  git(root, 'add', '.');
  git(root, 'commit', '-qm', 'base');
  const a = await changes.createTaskWorktree(root, 'A', randomUUID());
  git(root, 'commit', '--allow-empty', '-qm', 'later');
  const b = await changes.createTaskWorktree(root, 'B', randomUUID(), a.head);
  assert.equal(a.head, b.head);
  await fs.writeFile(path.join(a.path, 'file.txt'), 'changed');
  git(a.path, 'commit', '-qam', 'tracked change');
  await fs.writeFile(path.join(a.path, 'new file.txt'), 'new');
  await fs.writeFile(path.join(a.path, 'ignored.txt'), 'ignored');
  assert.deepEqual((await changes.listFiles(a.path)).files.sort(), ['.gitignore', 'file.txt', 'new file.txt']);
  assert.equal((await changes.sourceFile(b.path, 'file.txt', true)).text, 'original');
  assert.equal((await changes.sourceFile(a.path, 'file.txt', true)).text, 'changed');
  await assert.rejects(changes.sourceFile(a.path, path.join(b.path, 'file.txt'), false));
  const report = await changes.treeReport(a.path, a.head, true);
  assert.deepEqual(report.files.map(file => file.name), ['file.txt', 'new file.txt']);
  assert.match(report.diff, /changed/);
  if (process.platform === 'win32') {
    const shell = path.join(process.env.SystemRoot, 'System32/WindowsPowerShell/v1.0/powershell.exe');
    const command = "if ((Get-Content file.txt) -eq 'changed') { exit 1 }";
    const [failed, passed, unknown] = await Promise.all([
      changes.verifyProfile(shell, a.path, command), changes.verifyProfile(shell, b.path, command),
      changes.verifyProfile(shell, a.path, 'Get-WorkbenchMissingCommand')
    ]);
    assert.deepEqual([failed.result, passed.result, unknown.result], ['실패', '통과', '판정 불가']);
    assert.equal(failed.tree, report.tree);
    await fs.writeFile(path.join(a.path, 'file.txt'), 'updated');
    assert.notEqual((await changes.treeReport(a.path)).tree, failed.tree);
    await assert.rejects(changes.verifyProfile(shell, a.path, command, failed.tree), /코드가 바뀌었습니다/);
    const selected = { name: 'file.txt', kind: 'unstaged' };
    const first = await changes.status(a.path, selected);
    await fs.writeFile(path.join(a.path, 'file.txt'), 'revised');
    const second = await changes.status(a.path, selected);
    assert.deepEqual(first.files, second.files);
    assert.notEqual(first.patch, second.patch);
  }
});
