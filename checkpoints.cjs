// 턴 체크포인트: 에이전트에게 요청을 보내기 직전의 작업 폴더 상태를 git 객체로 저장하고, 나중에 그 상태로 되돌린다.
// - 사용자의 인덱스(스테이지)와 브랜치는 건드리지 않는다. 임시 인덱스 파일로 작업 폴더 전체(새 파일 포함,
//   .gitignore 대상 제외)를 트리로 만들고, refs/workbench/checkpoints/<작업 ID>/<시각>에 커밋으로 남긴다.
// - 되돌릴 때는 바뀐 파일만 다시 쓰고, 그 뒤에 새로 생긴 파일만 지운다. 되돌리기 전 상태도 체크포인트로 남겨
//   되돌리기를 다시 되돌릴 수 있게 한다.
const { execFile, spawn } = require('node:child_process');
const { promisify } = require('node:util');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const exec = promisify(execFile);

const keepPerTask = 30;
const taskPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const identity = { GIT_AUTHOR_NAME: 'Agent Workbench', GIT_AUTHOR_EMAIL: 'workbench@localhost',
  GIT_COMMITTER_NAME: 'Agent Workbench', GIT_COMMITTER_EMAIL: 'workbench@localhost' };

async function git(cwd, args, { env = {}, input, timeout = 60000 } = {}) {
  const options = { env: { ...process.env, GIT_LITERAL_PATHSPECS: '1', ...env }, windowsHide: true, timeout, maxBuffer: 16 * 1024 * 1024 };
  if (input === undefined) return (await exec('git', ['-c', 'core.fsmonitor=false', '-C', cwd, ...args], options)).stdout;
  return new Promise((resolve, reject) => {
    const child = spawn('git', ['-c', 'core.fsmonitor=false', '-C', cwd, ...args], { ...options, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.stderr.on('data', chunk => { stderr += chunk; });
    child.on('error', reject);
    child.on('close', code => code === 0 ? resolve(stdout) : reject(Object.assign(new Error(stderr.trim() || 'git 실패'), { stderr })));
    child.stdin.end(input);
  });
}

async function repositoryRoot(cwd) {
  if (typeof cwd !== 'string' || !path.isAbsolute(cwd)) throw new Error('작업 폴더가 올바르지 않습니다.');
  try { return (await git(cwd, ['rev-parse', '--show-toplevel'], { timeout: 10000 })).trim(); }
  catch { return null; }
}

// 임시 인덱스로 작업 폴더 전체를 트리로 만든다(사용자 인덱스는 그대로).
async function snapshotTree(root) {
  const index = path.join(os.tmpdir(), 'workbench-index-' + randomUUID());
  const env = { GIT_INDEX_FILE: index };
  try {
    const hasHead = await git(root, ['rev-parse', '--verify', '--quiet', 'HEAD'], { timeout: 10000 }).then(() => true, () => false);
    if (hasHead) await git(root, ['read-tree', 'HEAD'], { env });
    await git(root, ['add', '-A', '--', '.'], { env, timeout: 120000 });
    return { tree: (await git(root, ['write-tree'], { env })).trim(), hasHead };
  } finally {
    await fs.rm(index, { force: true });
  }
}

async function createCheckpoint(cwd, taskId, label = '') {
  if (typeof taskId !== 'string' || !taskPattern.test(taskId)) throw new Error('잘못된 작업 ID입니다.');
  const root = await repositoryRoot(cwd);
  if (!root) return null;
  const { tree, hasHead } = await snapshotTree(root);
  const message = 'workbench checkpoint: ' + String(label).replace(/\s+/g, ' ').slice(0, 120);
  const commit = (await git(root, ['commit-tree', tree, ...(hasHead ? ['-p', 'HEAD'] : []), '-m', message], { env: identity })).trim();
  const ref = 'refs/workbench/checkpoints/' + taskId.toLowerCase() + '/' + Date.now() + '-' + randomUUID().slice(0, 4);
  await git(root, ['update-ref', ref, commit]);
  await prune(root, taskId);
  return { ref, commit, tree, root, at: Date.now() };
}

// 작업마다 최근 30개만 남긴다.
async function prune(root, taskId) {
  const prefix = 'refs/workbench/checkpoints/' + taskId.toLowerCase() + '/';
  const refs = (await git(root, ['for-each-ref', '--format=%(refname)', prefix])).split(/\r?\n/).filter(Boolean).sort();
  for (const ref of refs.slice(0, Math.max(0, refs.length - keepPerTask))) await git(root, ['update-ref', '-d', ref]);
}

function validRef(taskId, ref) {
  return typeof taskId === 'string' && taskPattern.test(taskId) && typeof ref === 'string' &&
    new RegExp('^refs/workbench/checkpoints/' + taskId.toLowerCase() + '/\\d{13}-[0-9a-f]{4}$').test(ref);
}

async function restoreCheckpoint(cwd, taskId, ref) {
  if (!validRef(taskId, ref)) throw new Error('잘못된 체크포인트입니다.');
  const root = await repositoryRoot(cwd);
  if (!root) throw new Error('Git 저장소가 아닙니다.');
  let target;
  try { target = (await git(root, ['rev-parse', '--verify', ref + '^{tree}'], { timeout: 10000 })).trim(); }
  catch { throw new Error('체크포인트를 찾지 못했습니다.'); }
  const backup = await createCheckpoint(root, taskId, '되돌리기 전');
  // target → 지금: A(지금 새로 생김)는 지우고, 그 밖(M·D·T)은 target 내용으로 다시 쓴다.
  const changes = (await git(root, ['diff-tree', '-r', '-z', '--no-renames', '--name-status', target, backup.tree])).split('\0').filter(Boolean);
  const added = [];
  const restore = [];
  for (let index = 0; index < changes.length; index += 2) (changes[index] === 'A' ? added : restore).push(changes[index + 1]);
  const inside = file => {
    const full = path.resolve(root, file);
    const relative = path.relative(root, full);
    return relative && !relative.startsWith('..') && !path.isAbsolute(relative) ? full : null;
  };
  for (const file of added) {
    const full = inside(file);
    if (full) await fs.rm(full, { force: true });
  }
  if (restore.length) {
    const index = path.join(os.tmpdir(), 'workbench-index-' + randomUUID());
    try {
      await git(root, ['read-tree', target], { env: { GIT_INDEX_FILE: index } });
      await git(root, ['checkout-index', '-f', '-z', '--stdin'], { env: { GIT_INDEX_FILE: index }, input: restore.join('\0') + '\0' });
    } finally { await fs.rm(index, { force: true }); }
  }
  // 파일을 지워 비게 된 폴더 정리(지운 파일이 있던 폴더만, 위로 올라가며)
  for (const file of added) {
    let directory = path.dirname(inside(file) ?? root);
    while (directory.length > root.length && inside(path.relative(root, directory))) {
      try { await fs.rmdir(directory); } catch { break; }
      directory = path.dirname(directory);
    }
  }
  return { restored: restore.length, deleted: added.length, backup: backup.ref };
}

module.exports = { createCheckpoint, restoreCheckpoint, snapshotTree, validRef, keepPerTask };
