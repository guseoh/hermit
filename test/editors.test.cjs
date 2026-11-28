// 외부 편집기(main/editors.cjs) 테스트: 설치 위치 찾기, 버전 폴더 고르기, 실행 인자.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { findEditors, findCli, editorCommand } = require('../main/editors.cjs');

function install(base, folder, exe, versions = [], pinned) {
  const root = path.join(base, folder);
  fs.mkdirSync(path.join(root, 'bin'), { recursive: true });
  fs.writeFileSync(path.join(root, exe), '');
  for (const version of versions) {
    fs.mkdirSync(path.join(root, version, 'resources', 'app', 'out'), { recursive: true });
    fs.writeFileSync(path.join(root, version, 'resources', 'app', 'out', 'cli.js'), '');
  }
  if (pinned) fs.writeFileSync(path.join(root, 'bin', 'code.cmd'), '"%~dp0..\\Code.exe" "%~dp0..\\' + pinned + '\\resources\\app\\out\\cli.js" %*');
  return root;
}

test('설치된 편집기를 찾고, VS Code는 bin\\code.cmd가 쓰는 버전 폴더의 cli.js를 고른다', () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'hermit-editors-'));
  const programs = path.join(base, 'Programs');
  const code = install(programs, 'Microsoft VS Code', 'Code.exe', ['aaa111', 'bbb222'], 'aaa111');
  install(programs, 'antigravity', 'Antigravity.exe');
  const editors = findEditors({ LOCALAPPDATA: base });
  assert.deepEqual(editors.map(editor => [editor.id, path.basename(editor.exe)]), [['code', 'Code.exe'], ['antigravity', 'Antigravity.exe']]);
  assert.equal(editors[0].cli, path.join(code, 'aaa111', 'resources', 'app', 'out', 'cli.js'));
  assert.equal(editors[1].cli, null);
  assert.equal(findCli(path.join(base, 'none'), 'code.cmd'), null);
});

test('cli.js가 있으면 --goto 파일:줄, 없으면 파일만 넘긴다(셸을 거치지 않음)', () => {
  const withCli = editorCommand({ exe: 'C:\\Code.exe', cli: 'C:\\cli.js' }, 'C:\\repo\\a b.js', 12);
  assert.deepEqual(withCli, { command: 'C:\\Code.exe', args: ['C:\\cli.js', '--goto', 'C:\\repo\\a b.js:12'], env: { ELECTRON_RUN_AS_NODE: '1' } });
  assert.deepEqual(editorCommand({ exe: 'C:\\Code.exe', cli: 'C:\\cli.js' }, 'C:\\x.js').args, ['C:\\cli.js', '--goto', 'C:\\x.js']);
  assert.deepEqual(editorCommand({ exe: 'C:\\Antigravity.exe', cli: null }, 'C:\\x.js', 3), { command: 'C:\\Antigravity.exe', args: ['C:\\x.js'], env: {} });
});
