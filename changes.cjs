const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const fs = require('node:fs/promises');
const path = require('node:path');
const exec = promisify(execFile);
const limit = 2 * 1024 * 1024;

async function git(cwd, args) {
  return (await exec('git', ['--no-optional-locks', '-c', 'core.fsmonitor=false', '-C', cwd, ...args], {
    env: { ...process.env, GIT_LITERAL_PATHSPECS: '1' },
    windowsHide: true, timeout: 10000, maxBuffer: limit
  })).stdout;
}

async function status(cwd) {
  let root;
  try { root = (await git(cwd, ['rev-parse', '--show-toplevel'])).trimEnd(); }
  catch (error) {
    if (/not a git repository/i.test(error.stderr ?? '')) return { root: null, files: [] };
    throw error;
  }
  const records = (await git(root, ['status', '--porcelain=v2', '--branch', '-z', '--untracked-files=all'])).split('\0');
  let branch = '';
  const files = [];
  for (let index = 0; index < records.length; index++) {
    const record = records[index];
    if (record.startsWith('# branch.head ')) branch = record.slice(14);
    if (record.startsWith('? ')) files.push({ name: record.slice(2), kind: 'new' });
    const type = record[0];
    if (!['1', '2', 'u'].includes(type)) continue;
    const columns = type === '1' ? 8 : type === '2' ? 9 : 10;
    const parts = record.split(' ', columns);
    const name = record.slice(parts.join(' ').length + 1);
    const from = type === '2' ? records[++index] : undefined;
    const [staged, unstaged] = parts[1];
    if (type === 'u') files.push({ name, kind: 'conflict' });
    else {
      if (staged !== '.') files.push({ name, from, kind: 'staged', code: staged });
      if (unstaged !== '.') files.push({ name, from, kind: 'unstaged', code: unstaged });
    }
  }
  return { root, branch, files };
}

async function diff(cwd, name, kind) {
  const { root, files } = await status(cwd);
  const entry = files.find(item => item.name === name && item.kind === kind);
  if (!entry) throw new Error('변경 목록이 바뀌었습니다. 목록을 새로 고침하세요.');
  if (kind === 'new') {
    const file = path.resolve(root, name);
    const [actual, realRoot] = await Promise.all([fs.realpath(file), fs.realpath(root)]);
    const relative = path.relative(realRoot, actual);
    if (relative === '..' || relative.startsWith('..' + path.sep) || path.isAbsolute(relative) ||
        path.relative(file, actual) || !(await fs.lstat(file)).isFile()) return '이 파일의 텍스트 미리보기를 제공할 수 없습니다.';
    if ((await fs.stat(actual)).size > limit) return '파일이 미리보기 한도를 초과했습니다.';
    const buffer = await fs.readFile(actual);
    if (buffer.includes(0)) return '바이너리 파일';
    const lines = buffer.toString('utf8').split(/\r?\n/);
    if (lines.at(-1) === '') lines.pop();
    return ['@@ -0,0 +1,' + lines.length + ' @@', ...lines.map(line => '+' + line)].join('\n');
  }
  const args = ['diff', '--no-ext-diff', '--no-textconv', '--no-color'];
  if (kind === 'staged') args.push('--cached');
  args.push('--', ...new Set(entry.from ? [entry.from, name] : [name]));
  return await git(root, args);
}

module.exports = { status, diff };
