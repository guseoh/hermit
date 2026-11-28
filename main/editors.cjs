// 외부 편집기 연동: VS Code·Cursor·Antigravity IDE를 찾아 파일을 해당 줄로 연다.
// .cmd 셸 스크립트를 거치지 않고 편집기 실행 파일과 cli.js를 직접 실행한다(경로가 셸에 해석되지 않도록).
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');

const known = [
  { id: 'code', name: 'VS Code', folder: 'Microsoft VS Code', exe: 'Code.exe', script: 'code.cmd' },
  { id: 'cursor', name: 'Cursor', folder: 'cursor', exe: 'Cursor.exe', script: 'cursor.cmd' },
  { id: 'antigravity', name: 'Antigravity', folder: 'antigravity', exe: 'Antigravity.exe', script: 'antigravity.cmd' }
];

// 설치 폴더에서 cli.js를 찾는다. VS Code는 버전 폴더(해시) 아래에 있고, bin\code.cmd가 쓰는 쪽을 고른다.
function findCli(root, script) {
  const direct = path.join(root, 'resources', 'app', 'out', 'cli.js');
  if (fs.existsSync(direct)) return direct;
  let pinned = null;
  try {
    const text = fs.readFileSync(path.join(root, 'bin', script), 'utf8');
    pinned = /%~dp0\.\.\\([^\\"]+)\\resources\\app\\out\\cli\.js/i.exec(text)?.[1] ?? null;
  } catch { /* 스크립트 없음 */ }
  const versions = [];
  try {
    for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
      const cli = path.join(root, entry.name, 'resources', 'app', 'out', 'cli.js');
      if (entry.isDirectory() && fs.existsSync(cli)) versions.push({ name: entry.name, cli, time: fs.statSync(cli).mtimeMs });
    }
  } catch { return null; }
  return (versions.find(version => version.name === pinned) ?? versions.sort((a, b) => b.time - a.time)[0])?.cli ?? null;
}

function findEditors(env = process.env) {
  const roots = [env.LOCALAPPDATA && path.join(env.LOCALAPPDATA, 'Programs'), env.ProgramFiles, env['ProgramFiles(x86)']].filter(Boolean);
  const found = [];
  for (const editor of known) {
    for (const base of roots) {
      const root = path.join(base, editor.folder);
      const exe = path.join(root, editor.exe);
      if (!fs.existsSync(exe)) continue;
      found.push({ id: editor.id, name: editor.name, exe, cli: findCli(root, editor.script) });
      break;
    }
  }
  return found;
}

// cli.js가 있으면 "-g 파일:줄"로 그 줄을 열고, 없으면 실행 파일에 파일 경로만 넘긴다.
function editorCommand(editor, file, line) {
  const target = Number.isSafeInteger(line) && line > 0 ? file + ':' + line : file;
  if (editor.cli) return { command: editor.exe, args: [editor.cli, '--goto', target], env: { ELECTRON_RUN_AS_NODE: '1' } };
  return { command: editor.exe, args: [file], env: {} };
}

function openInEditor(editor, file, line) {
  const { command, args, env } = editorCommand(editor, file, line);
  const child = spawn(command, args, { env: { ...process.env, ...env }, detached: true, stdio: 'ignore', windowsHide: false });
  child.on('error', () => {});
  child.unref();
}

module.exports = { findEditors, findCli, editorCommand, openInEditor };
