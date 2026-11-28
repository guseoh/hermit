// 추가 터미널 프로필: PowerShell 7(pwsh)과 WSL. 설치돼 있을 때만 새 탭 메뉴에 나온다.
// 기본 셸은 계속 Windows PowerShell 5.1이다. 렌더러는 실행 파일 경로를 넘기지 않고, 여기서 찾은 것만 실행한다.
// - pwsh: 5.1과 같은 prompt.ps1을 붙여 명령 기록(OSC 777)과 작업 폴더 표시가 그대로 동작한다.
// - WSL: 셸 통합 없이 배포판의 기본 셸을 연다(Docker Desktop 내부 배포판은 뺀다).
const fs = require('node:fs');
const path = require('node:path');
const { execFile } = require('node:child_process');

// 앱 실행 별칭(%LOCALAPPDATA%\Microsoft\WindowsApps\pwsh.exe)은 stat이 EACCES라 lstat으로 확인한다.
function present(file) {
  try {
    const entry = fs.lstatSync(file);
    return entry.isFile() || entry.isSymbolicLink();
  } catch { return false; }
}

// PATH에 있는 것을 먼저, 그다음 MSI 기본 위치와 Microsoft Store 별칭.
function pwshCandidates(env = process.env) {
  const list = [];
  for (const directory of String(env.PATH ?? env.Path ?? '').split(';')) {
    const trimmed = directory.trim().replace(/^"(.*)"$/, '$1');
    if (trimmed && path.isAbsolute(trimmed)) list.push(path.join(trimmed, 'pwsh.exe'));
  }
  for (const base of [env.ProgramFiles, env.ProgramW6432]) {
    if (!base) continue;
    list.push(path.join(base, 'PowerShell', '7', 'pwsh.exe'), path.join(base, 'PowerShell', '7-preview', 'pwsh.exe'));
  }
  if (env.LOCALAPPDATA) list.push(path.join(env.LOCALAPPDATA, 'Microsoft', 'WindowsApps', 'pwsh.exe'));
  const seen = new Set();
  return list.filter(file => {
    const key = file.toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

// "$PSVersionTable.PSVersion" 출력에서 7 이상만 받는다(PATH의 pwsh가 6 이하이면 쓰지 않는다).
function parsePwshVersion(text) {
  const match = /(\d+)\.(\d+)\.(\d+)(?:[-.][\w.]+)?/.exec(String(text ?? ''));
  return match && Number(match[1]) >= 7 ? match[0] : null;
}

// wsl.exe --list --quiet는 UTF-16LE로 이름을 한 줄씩 낸다. Docker Desktop 내부 배포판과 빈 줄은 뺀다.
function parseWslList(output) {
  const text = Buffer.isBuffer(output)
    ? (output.includes(0) ? output.toString('utf16le') : output.toString('utf8'))
    : String(output ?? '');
  return [...new Set(text.replace(/^\uFEFF/, '').replace(/\0/g, '').split(/\r?\n/)
    .map(line => line.trim())
    .filter(name => name && /^[\w.\-]{1,64}$/.test(name) && !/^docker-desktop(?:-data)?$/i.test(name)))];
}

function run(file, args, options = {}) {
  return new Promise(resolve => {
    execFile(file, args, { windowsHide: true, timeout: 10000, ...options }, (error, stdout) => resolve(error ? null : stdout));
  });
}

let cache = null;
async function detectShells({ refresh = false, env = process.env } = {}) {
  if (cache && !refresh) return cache;
  const pending = (async () => {
    let pwsh = null;
    for (const file of pwshCandidates(env)) {
      if (!present(file)) continue;
      const version = parsePwshVersion(await run(file, ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', '$PSVersionTable.PSVersion.ToString()']));
      if (version) { pwsh = { file, version }; break; }
    }
    let wsl = null;
    const wslFile = path.join(env.SystemRoot ?? 'C:\\Windows', 'System32', 'wsl.exe');
    if (present(wslFile)) {
      const listed = await run(wslFile, ['--list', '--quiet'], { encoding: 'buffer' });
      const distros = listed ? parseWslList(listed) : [];
      if (distros.length) wsl = { file: wslFile, distros };
    }
    return { pwsh, wsl };
  })();
  cache = pending;
  pending.catch(() => { if (cache === pending) cache = null; });
  return pending;
}

// 렌더러에 보낼 메뉴 항목(경로는 보내지 않는다).
function profileEntries(found) {
  const entries = [];
  if (found?.pwsh) entries.push({ launcher: 'pwsh', name: 'PowerShell 7', detail: found.pwsh.version });
  for (const distro of found?.wsl?.distros ?? []) entries.push({ launcher: 'wsl', name: 'WSL · ' + distro, detail: distro, option: distro });
  return entries;
}

// spawn에 넘길 실행 파일과 인자. option은 WSL 배포판 이름이고, 찾은 목록에 있어야 한다.
function launchSpec(launcher, option, promptScript, found) {
  if (launcher === 'pwsh') {
    if (!found?.pwsh) throw new Error('PowerShell 7(pwsh)을 찾지 못했습니다.');
    return { file: found.pwsh.file, args: ['-NoLogo', '-ExecutionPolicy', 'Bypass', '-NoExit', '-File', promptScript] };
  }
  if (launcher === 'wsl') {
    if (!found?.wsl) throw new Error('WSL 배포판을 찾지 못했습니다.');
    const distro = option ?? found.wsl.distros[0];
    if (typeof distro !== 'string' || !found.wsl.distros.includes(distro)) throw new Error('알 수 없는 WSL 배포판입니다.');
    return { file: found.wsl.file, args: ['-d', distro] };
  }
  throw new Error('Unknown terminal launcher.');
}

module.exports = { pwshCandidates, parsePwshVersion, parseWslList, detectShells, profileEntries, launchSpec, present };
