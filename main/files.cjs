// 파일 탐색·내용 검색: 작업 폴더 안의 폴더 목록(펼칠 때마다 한 단계씩)과 텍스트 검색.
// 검색은 PATH의 rg → Codex에 들어 있는 rg.exe → git grep 순서로 쓴다. 작업 폴더 밖 경로는 받지 않는다.
const { execFile, spawn } = require('node:child_process');
const fs = require('node:fs/promises');
const fsSync = require('node:fs');
const path = require('node:path');
const { promisify } = require('node:util');
const exec = promisify(execFile);

const maxEntries = 2000;
const maxMatches = 500;
const searchTimeoutMs = 15000;

async function resolveRoot(root) {
  const real = await fs.realpath(path.resolve(String(root)));
  if (!(await fs.stat(real)).isDirectory()) throw new Error('작업 폴더를 찾을 수 없습니다.');
  return real;
}

function inside(root, relative) {
  const target = path.resolve(root, String(relative ?? ''));
  const rel = path.relative(root, target);
  if (rel === '..' || rel.startsWith('..' + path.sep) || path.isAbsolute(rel)) throw new Error('작업 폴더 밖의 경로입니다.');
  if (rel.split(path.sep).some(part => part.toLowerCase() === '.git')) throw new Error('.git 폴더는 열 수 없습니다.');
  return { target, rel };
}

// Git이 무시하는 항목을 표시한다(흐리게 보여 주려고). Git 저장소가 아니면 아무것도 표시하지 않는다.
async function ignoredSet(root, relatives) {
  if (!relatives.length) return new Set();
  return new Promise(resolve => {
    const child = execFile('git', ['-C', root, 'check-ignore', '--stdin', '-z'], { windowsHide: true, maxBuffer: 4 << 20, timeout: 8000 },
      (error, stdout) => resolve(new Set(String(stdout ?? '').split('\0').filter(Boolean).map(item => item.replace(/\\/g, '/')))));
    child.stdin.end(relatives.join('\0') + '\0');
  });
}

async function listDirectory(root, relative = '') {
  const base = await resolveRoot(root);
  const { target, rel } = inside(base, relative);
  const entries = (await fs.readdir(target, { withFileTypes: true }))
    .filter(entry => entry.name !== '.git' && (entry.isDirectory() || entry.isFile() || entry.isSymbolicLink()))
    .slice(0, maxEntries);
  const items = entries.map(entry => {
    const itemPath = (rel ? rel.split(path.sep).join('/') + '/' : '') + entry.name;
    return { name: entry.name, path: itemPath, dir: entry.isDirectory() };
  });
  const ignored = await ignoredSet(base, items.map(item => item.path + (item.dir ? '/' : '')));
  for (const item of items) item.ignored = ignored.has(item.path) || ignored.has(item.path + '/');
  items.sort((a, b) => Number(b.dir) - Number(a.dir) || a.name.localeCompare(b.name, 'ko', { numeric: true, sensitivity: 'base' }));
  return { path: rel.split(path.sep).join('/'), entries: items, truncated: entries.length >= maxEntries };
}

let rgPath;
function findRipgrep() {
  if (rgPath !== undefined) return rgPath;
  rgPath = null;
  const dirs = String(process.env.PATH ?? '').split(path.delimiter).filter(Boolean);
  for (const dir of dirs) {
    const candidate = path.join(dir, process.platform === 'win32' ? 'rg.exe' : 'rg');
    if (fsSync.existsSync(candidate)) return (rgPath = candidate);
  }
  // Codex CLI(npm 전역 설치)에 함께 들어 있는 rg.exe
  if (process.platform === 'win32') {
    const roots = [process.env.APPDATA && path.join(process.env.APPDATA, 'npm', 'node_modules', '@openai', 'codex', 'node_modules', '@openai')].filter(Boolean);
    for (const scope of roots) {
      let packages = [];
      try { packages = fsSync.readdirSync(scope).filter(name => name.startsWith('codex-win32')); } catch { continue; }
      for (const name of packages) {
        const vendor = path.join(scope, name, 'vendor');
        let triples = [];
        try { triples = fsSync.readdirSync(vendor); } catch { continue; }
        for (const triple of triples) {
          const candidate = path.join(vendor, triple, 'codex-path', 'rg.exe');
          if (fsSync.existsSync(candidate)) return (rgPath = candidate);
        }
      }
    }
  }
  return rgPath;
}

function runLines(command, args, cwd, onLine) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let buffer = '';
    let stopped = false;
    let stderr = '';
    let received = 0;
    const stop = () => { if (!stopped) { stopped = true; child.kill(); } };
    const timer = setTimeout(stop, searchTimeoutMs);
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', chunk => {
      buffer += chunk;
      let index;
      while ((index = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, index).replace(/\r$/, '');
        buffer = buffer.slice(index + 1);
        received++;
        if (!stopped && onLine(line) === false) stop();
      }
    });
    child.stderr.on('data', chunk => { stderr += chunk; });
    child.on('error', error => { clearTimeout(timer); reject(error); });
    child.on('close', code => {
      clearTimeout(timer);
      if (!stopped && buffer && onLine(buffer.replace(/\r$/, '')) === false) stopped = true;
      // rg·git grep은 일치가 없으면 1로 끝난다. 잠긴 파일처럼 일부만 못 읽으면 2로 끝나도 찾은 결과는 쓴다.
      if (!stopped && code !== 0 && code !== 1 && !received) reject(new Error(stderr.trim() || '검색하지 못했습니다.'));
      else resolve({ stopped, warning: code !== 0 && code !== 1 && !stopped ? stderr.trim().split('\n')[0] : undefined });
    });
  });
}

async function searchText(root, query, options = {}) {
  const base = await resolveRoot(root);
  const text = String(query ?? '');
  if (!text.trim()) return { engine: null, matches: [], truncated: false };
  if (text.length > 500) throw new Error('검색어가 너무 깁니다.');
  const regex = options.regex === true;
  const caseSensitive = options.caseSensitive === true;
  const matches = [];
  const add = match => {
    matches.push({ ...match, text: match.text.length > 300 ? match.text.slice(0, 300) + '…' : match.text });
    return matches.length < maxMatches;
  };
  const rg = options.engine === 'git' ? null : findRipgrep();
  if (rg) {
    const args = ['--json', '--max-count', '100', '--max-columns', '400', '--max-filesize', '2M', caseSensitive ? '--case-sensitive' : '--ignore-case'];
    if (!regex) args.push('--fixed-strings');
    args.push('--', text, '.');
    const result = await runLines(rg, args, base, line => {
      let event;
      try { event = JSON.parse(line); } catch { return true; }
      if (event.type !== 'match') return true;
      const data = event.data;
      const file = String(data.path?.text ?? '').replace(/^\.[\\/]/, '').replace(/\\/g, '/');
      const lineText = String(data.lines?.text ?? '').replace(/\r?\n$/, '');
      const column = (data.submatches?.[0]?.start ?? 0) + 1;
      return add({ path: file, line: data.line_number, column, text: lineText });
    });
    return { engine: 'rg', matches, truncated: result.stopped, warning: result.warning };
  }
  const parseGitLine = line => {
    const match = /^(.+?):(\d+):(\d+):(.*)$/.exec(line);
    if (!match) return true;
    return add({ path: match[1].replace(/\\/g, '/'), line: Number(match[2]), column: Number(match[3]), text: match[4] });
  };
  const runGit = noIndex => {
    const args = ['-C', base, 'grep', '-n', '--column', '-I', ...(noIndex ? ['--no-index'] : ['--untracked', '--full-name']), '--no-color', regex ? '-E' : '-F'];
    if (!caseSensitive) args.push('-i');
    args.push('-e', text);
    return runLines('git', args, base, parseGitLine);
  };
  let result;
  try {
    result = await runGit(false);
  } catch (error) {
    if (!/not a git repository/i.test(String(error?.message ?? ''))) throw error;
    matches.length = 0;
    result = await runGit(true);
  }
  return { engine: 'git', matches, truncated: result.stopped, warning: result.warning };
}

// 소스 탭에 띄울 텍스트 파일(2MB 이하, 바이너리 아님).
async function readText(root, relative) {
  const base = await resolveRoot(root);
  const { target, rel } = inside(base, relative);
  const real = await fs.realpath(target);
  inside(base, path.relative(base, real));
  const stat = await fs.stat(real);
  if (!stat.isFile() || stat.size > 2 * 1024 * 1024) throw new Error('2MB 이하 텍스트 파일만 열 수 있습니다.');
  const bytes = await fs.readFile(real);
  if (bytes.includes(0)) throw new Error('바이너리 파일입니다.');
  return { path: rel.split(path.sep).join('/'), text: bytes.toString('utf8') };
}

// 외부 편집기로 열 파일의 절대 경로(작업 폴더 안만).
async function resolveFile(root, relative) {
  const base = await resolveRoot(root);
  const { target } = inside(base, relative);
  const real = await fs.realpath(target);
  inside(base, path.relative(base, real));
  if (!(await fs.stat(real)).isFile()) throw new Error('파일을 찾을 수 없습니다.');
  return real;
}

module.exports = { listDirectory, searchText, readText, resolveFile, findRipgrep, maxMatches };
