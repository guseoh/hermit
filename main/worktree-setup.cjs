// 작업 worktree 환경 자동화: .worktreeinclude 파일 복사, 공유 폴더(node_modules 등) 정션 연결,
// 그리고 worktree를 지우기 전에 바깥을 가리키는 정션·심볼릭 링크를 링크만 떼어 내는 안전장치.
//
// 왜 떼어 내야 하나: Git for Windows 2.45의 `git worktree remove --force`는 정션을 따라 들어가
// 원본 폴더의 내용까지 지운다(임시 폴더로 확인함). 그래서 정리 전에 링크 자체만 unlink한다.
const { spawn, execFile } = require('node:child_process');
const fs = require('node:fs/promises');
const path = require('node:path');
const { promisify } = require('node:util');
const exec = promisify(execFile);

const limits = { maxFiles: 200, maxFileBytes: 5 * 1024 * 1024, maxTotalBytes: 20 * 1024 * 1024, maxScan: 2000, maxIncludeBytes: 64 * 1024 };
const maxShareDirs = 10;
const maxScanDirectories = 100000;

function git(cwd, args, timeout = 15000) {
  return exec('git', ['-C', cwd, ...args], { encoding: 'utf8', windowsHide: true, timeout, maxBuffer: 4 * 1024 * 1024,
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_OPTIONAL_LOCKS: '0' } }).then(result => result.stdout);
}

const lower = value => value.toLowerCase();
// a가 b와 같거나 b 안에 있는가(대소문자 무시, Windows 경로).
function within(child, parent) {
  const rel = path.relative(path.resolve(parent), path.resolve(child));
  return rel === '' || (!!rel && !rel.startsWith('..') && !path.isAbsolute(rel));
}

// 설정·패턴에서 온 상대 경로를 검사한다. 절대 경로, 드라이브, ..·.git 구성 요소, ADS(:), 제어 문자를 거부한다.
function safeRelative(value) {
  if (typeof value !== 'string') return null;
  const text = value.trim().replace(/\\/g, '/').replace(/\/+$/, '').replace(/^\.\//, '');
  if (!text || text.length > 260 || /[\x00-\x1f:*?"<>|]/.test(text) || text.startsWith('/')) return null;
  const parts = text.split('/');
  if (parts.some(part => !part || part === '.' || part === '..' || lower(part) === '.git' || /[. ]$/.test(part))) return null;
  return parts.join('/');
}

function normalizeShareDirs(list) {
  if (!Array.isArray(list)) return [];
  const seen = new Set();
  const result = [];
  for (const entry of list) {
    const rel = safeRelative(entry);
    if (!rel || seen.has(lower(rel))) continue;
    seen.add(lower(rel));
    result.push(rel);
    if (result.length >= maxShareDirs) break;
  }
  return result;
}

// 경로의 중간 폴더 중 링크(정션·심볼릭 링크)가 있으면 그 경로는 쓰지 않는다(링크를 타고 밖으로 나가는 것 방지).
async function linkFreeParents(base, rel) {
  let current = base;
  for (const part of rel.split('/').slice(0, -1)) {
    current = path.join(current, part);
    try {
      const info = await fs.lstat(current);
      if (info.isSymbolicLink() || !info.isDirectory()) return false;
    } catch (error) {
      if (error.code === 'ENOENT') return true;
      throw error;
    }
  }
  return true;
}

// .worktreeinclude에 맞고 Git이 추적하지 않는(무시·미추적) 파일 목록. 개수가 많으면 maxScan에서 멈춘다.
function untrackedMatches(root, includeFile, maxScan = limits.maxScan) {
  return new Promise((resolve, reject) => {
    const child = spawn('git', ['-C', root, 'ls-files', '-z', '--others', '--ignored', '--exclude-from=' + includeFile],
      { windowsHide: true, env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_OPTIONAL_LOCKS: '0' } });
    const names = [];
    let rest = '';
    let truncated = false;
    let error = '';
    const timer = setTimeout(() => { truncated = true; child.kill(); }, 15000);
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', chunk => {
      if (truncated) return;
      const parts = (rest + chunk).split('\0');
      rest = parts.pop();
      for (const name of parts) {
        if (!name) continue;
        if (names.length >= maxScan) { truncated = true; child.kill(); return; }
        names.push(name);
      }
    });
    child.stderr.on('data', chunk => { error += chunk; });
    child.on('error', reject);
    child.on('close', code => {
      clearTimeout(timer);
      if (code !== 0 && !truncated) return reject(new Error('.worktreeinclude 패턴을 확인하지 못했습니다: ' + error.trim().split(/\r?\n/).at(-1)));
      resolve({ names, truncated });
    });
  });
}

// 원본 체크아웃에서 복사할 파일을 고른다. 파일을 실제로 복사하지는 않는다(작업 런처의 미리보기에도 쓴다).
async function planInclude(root, options = {}) {
  const limit = { ...limits, ...options };
  const includeFile = path.join(root, '.worktreeinclude');
  let info;
  try { info = await fs.lstat(includeFile); }
  catch (error) { if (error.code === 'ENOENT') return { exists: false, files: [], skipped: [], truncated: false, totalBytes: 0 }; throw error; }
  if (!info.isFile()) return { exists: true, files: [], skipped: [{ path: '.worktreeinclude', reason: '일반 파일이 아닙니다' }], truncated: false, totalBytes: 0 };
  if (info.size > limit.maxIncludeBytes) return { exists: true, files: [], skipped: [{ path: '.worktreeinclude', reason: '파일이 너무 큽니다' }], truncated: false, totalBytes: 0 };
  const realRoot = await fs.realpath(root);
  const { names, truncated: scanTruncated } = await untrackedMatches(root, includeFile, limit.maxScan);
  const files = [];
  const skipped = [];
  let totalBytes = 0;
  let truncated = scanTruncated;
  for (const name of names) {
    const rel = safeRelative(name);
    if (!rel) { skipped.push({ path: name, reason: '쓸 수 없는 경로' }); continue; }
    if (files.length >= limit.maxFiles) { truncated = true; break; }
    const source = path.join(root, ...rel.split('/'));
    if (!(await linkFreeParents(root, rel))) { skipped.push({ path: rel, reason: '링크를 거치는 경로' }); continue; }
    let stat;
    try { stat = await fs.lstat(source); } catch { continue; }
    if (stat.isSymbolicLink() || !stat.isFile()) { skipped.push({ path: rel, reason: stat.isSymbolicLink() ? '심볼릭 링크' : '일반 파일이 아님' }); continue; }
    const real = await fs.realpath(source).catch(() => null);
    if (!real || !within(real, realRoot)) { skipped.push({ path: rel, reason: '저장소 밖을 가리킴' }); continue; }
    if (stat.size > limit.maxFileBytes) { skipped.push({ path: rel, reason: '파일이 너무 큼' }); continue; }
    if (totalBytes + stat.size > limit.maxTotalBytes) { truncated = true; skipped.push({ path: rel, reason: '전체 크기 제한' }); continue; }
    totalBytes += stat.size;
    files.push({ path: rel, size: stat.size });
  }
  return { exists: true, files, skipped, truncated, totalBytes };
}

// 계획한 파일을 새 worktree로 복사한다. 이미 있으면 덮어쓰지 않는다.
async function copyIncluded(root, worktree, plan) {
  const realWorktree = await fs.realpath(worktree);
  const copied = [];
  const skipped = [...plan.skipped];
  for (const file of plan.files) {
    const destination = path.join(worktree, ...file.path.split('/'));
    if (!(await linkFreeParents(worktree, file.path))) { skipped.push({ path: file.path, reason: '대상 경로에 링크가 있음' }); continue; }
    const exists = await fs.lstat(destination).then(() => true, error => { if (error.code === 'ENOENT') return false; throw error; });
    if (exists) { skipped.push({ path: file.path, reason: '이미 있음' }); continue; }
    await fs.mkdir(path.dirname(destination), { recursive: true });
    const parent = await fs.realpath(path.dirname(destination));
    if (!within(parent, realWorktree)) { skipped.push({ path: file.path, reason: '대상이 worktree 밖' }); continue; }
    try {
      await fs.copyFile(path.join(root, ...file.path.split('/')), destination, fs.constants.COPYFILE_EXCL);
      copied.push(file.path);
    } catch (error) {
      skipped.push({ path: file.path, reason: error.code === 'EEXIST' ? '이미 있음' : '복사 실패: ' + error.code });
    }
  }
  return { copied, skipped };
}

// 원본의 공유 폴더를 새 worktree에 디렉터리 정션으로 연결한다(관리자 권한 불필요).
// Git이 무시하지 않는 경로는 연결하지 않는다(정션이 커밋 대상에 섞이지 않게).
async function linkShared(root, worktree, dirs) {
  const linked = [];
  const skipped = [];
  for (const rel of normalizeShareDirs(dirs)) {
    const source = path.join(root, ...rel.split('/'));
    const destination = path.join(worktree, ...rel.split('/'));
    const sourceInfo = await fs.stat(source).catch(() => null);
    if (!sourceInfo?.isDirectory()) { skipped.push({ path: rel, reason: '원본 폴더가 없음' }); continue; }
    if (!(await linkFreeParents(root, rel)) || !(await linkFreeParents(worktree, rel))) { skipped.push({ path: rel, reason: '링크를 거치는 경로' }); continue; }
    const exists = await fs.lstat(destination).then(() => true, error => { if (error.code === 'ENOENT') return false; throw error; });
    if (exists) { skipped.push({ path: rel, reason: '이미 있음' }); continue; }
    const ignored = await git(worktree, ['check-ignore', '-q', '--no-index', '--', rel + '/']).then(() => true, () => false);
    if (!ignored) { skipped.push({ path: rel, reason: 'Git이 무시하지 않는 경로(.gitignore에 추가하세요)' }); continue; }
    await fs.mkdir(path.dirname(destination), { recursive: true });
    try {
      await fs.symlink(source, destination, 'junction');
      linked.push(rel);
    } catch (error) { skipped.push({ path: rel, reason: '연결 실패: ' + error.code }); }
  }
  return { linked, skipped };
}

// worktree 안에서 폴더 밖을 가리키는 디렉터리 링크(정션·심볼릭 링크)를 찾는다. 링크 안으로는 들어가지 않는다.
async function findOuterLinks(worktree) {
  const top = path.resolve(worktree);
  const found = [];
  const queue = [top];
  let scanned = 0;
  let incomplete = false;
  while (queue.length) {
    const directory = queue.shift();
    if (++scanned > maxScanDirectories) { incomplete = true; break; }
    let entries;
    try { entries = await fs.readdir(directory, { withFileTypes: true }); }
    catch (error) { if (['ENOENT', 'ENOTDIR'].includes(error.code)) continue; throw error; }
    for (const entry of entries) {
      const full = path.join(directory, entry.name);
      if (directory === top && lower(entry.name) === '.git') continue;
      if (!entry.isSymbolicLink() && !entry.isDirectory()) continue;
      // Dirent가 정션을 폴더로 보고하는 환경도 있을 수 있어 lstat으로 다시 확인한다.
      const info = await fs.lstat(full).catch(() => null);
      if (!info) continue;
      if (!info.isSymbolicLink()) { if (info.isDirectory()) queue.push(full); continue; }
      let target = null;
      try { target = path.resolve(directory, (await fs.readlink(full)).replace(/^\\\\\?\\/, '')); } catch { /* 읽지 못하면 바깥으로 본다 */ }
      const pointsToDirectory = await fs.stat(full).then(stat => stat.isDirectory(), () => true);
      if (pointsToDirectory && (!target || !within(target, top))) found.push({ path: full, target, relative: path.relative(top, full).split(path.sep).join('/') });
    }
  }
  return { links: found, incomplete };
}

// 링크만 해제한다(대상 폴더는 건드리지 않는다). 떼어 낸 목록을 돌려줘 실패 시 되돌릴 수 있게 한다.
async function detachOuterLinks(worktree) {
  const { links, incomplete } = await findOuterLinks(worktree);
  const detached = [];
  for (const link of links) {
    try { await fs.unlink(link.path); }
    catch (error) {
      if (error.code === 'ENOENT') continue;
      // 일부 환경에서 디렉터리 심볼릭 링크는 rmdir로만 지워진다. rmdir은 링크만 지우고 대상은 따라가지 않는다.
      await fs.rmdir(link.path);
    }
    const still = await fs.lstat(link.path).then(() => true, () => false);
    if (still) throw new Error('링크를 해제하지 못했습니다: ' + link.path);
    detached.push(link);
  }
  return { detached, incomplete };
}

async function restoreLinks(detached) {
  for (const link of detached) {
    if (!link.target) continue;
    await fs.symlink(link.target, link.path, 'junction').catch(() => {});
  }
}

// git status --porcelain -z 항목에서 링크 경로(예: "?? node_modules/")를 뺀다.
function withoutLinks(entries, links) {
  const names = new Set(links.map(link => lower(link.relative)));
  return entries.filter(entry => !names.has(lower(entry.slice(3).replace(/\/$/, ''))));
}

module.exports = { limits, safeRelative, normalizeShareDirs, planInclude, copyIncluded, linkShared,
  findOuterLinks, detachOuterLinks, restoreLinks, withoutLinks, within };
