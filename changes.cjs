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

async function githubRepository(cwd) {
  if (!cwd) return null;
  let origin;
  try { origin = (await git(cwd, ['remote', 'get-url', 'origin'])).trim(); }
  catch (error) {
    if (/not a git repository|no such remote/i.test(error.stderr ?? '')) return null;
    throw error;
  }
  const match = /^(?:https:\/\/github\.com\/|git@github\.com:|ssh:\/\/git@github\.com\/)([\w.-]+)\/([\w.-]+?)(?:\.git)?\/?$/i.exec(origin);
  if (!match) return null;
  return match[1] + '/' + match[2];
}

async function gh(cwd, repository, args) {
  return (await exec('gh', [...args, '--repo', 'github.com/' + repository], {
    cwd, windowsHide: true, timeout: 15000, maxBuffer: limit,
    env: { ...process.env, GH_PROMPT_DISABLED: '1' }
  })).stdout;
}

async function pullRequests(cwd, state = 'open', scope = 'all') {
  if (!['open', 'closed', 'merged', 'all'].includes(state) ||
      !['all', 'mine', 'branch', 'review'].includes(scope)) throw new Error('잘못된 PR 필터입니다.');
  const repository = await githubRepository(cwd);
  if (!repository) return null;
  try {
    const args = ['pr', 'list', '--state', state, '--limit', '30', '--json',
      'number,title,headRefName,isDraft,state,author,reviewDecision,updatedAt'];
    if (scope === 'mine') args.push('--author', '@me');
    if (scope === 'review') args.push('--search', 'review-requested:@me');
    if (scope === 'branch') {
      const branch = (await git(cwd, ['branch', '--show-current'])).trim();
      if (!branch) return { repository, pulls: [], error: '현재 작업 폴더에서 브랜치를 확인할 수 없습니다.' };
      args.push('--head=' + branch);
    }
    return { repository, pulls: JSON.parse(await gh(cwd, repository, args)) };
  } catch (error) {
    if (error.code === 'ENOENT') return { repository, error: 'GitHub CLI(gh)를 설치하면 PR을 조회할 수 있습니다.' };
    if (/gh auth login|not logged|401|bad credentials/i.test(error.stderr ?? '')) {
      return { repository, error: '터미널에서 gh auth login으로 로그인한 뒤 새로고침하세요.' };
    }
    return { repository, error: 'PR을 가져오지 못했습니다. 저장소 접근 권한과 네트워크를 확인하세요.' };
  }
}

async function pullDetails(cwd, number, patch = false) {
  if (!Number.isSafeInteger(number) || number < 1) throw new Error('잘못된 PR 번호입니다.');
  const repository = await githubRepository(cwd);
  if (!repository) throw new Error('GitHub origin을 확인할 수 없습니다.');
  const args = patch ? ['pr', 'diff', String(number), '--patch', '--color', 'never'] :
    ['pr', 'view', String(number), '--json',
      'title,body,author,baseRefName,headRefName,state,reviewDecision,files,reviews,statusCheckRollup'];
  try {
    const output = await gh(cwd, repository, args);
    return patch ? output : JSON.parse(output);
  } catch (error) {
    if (error.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER') throw new Error('PR이 표시할 수 있는 크기를 초과했습니다.');
    throw new Error('PR 상세 정보를 가져오지 못했습니다. GitHub 로그인과 저장소 접근 권한을 확인하세요.');
  }
}

async function commitDetails(cwd, hash) {
  if (typeof hash !== 'string' || !/^[a-f\d]{7,64}$/i.test(hash)) throw new Error('잘못된 커밋 해시입니다.');
  return git(cwd, ['show', '--format=fuller', '--stat', '--no-ext-diff', '--no-textconv', hash, '--']);
}

async function worktrees(cwd) {
  const output = await git(cwd, ['worktree', 'list', '--porcelain', '-z']);
  return output.split('\0\0').filter(Boolean).map(block => {
    const fields = block.split('\0');
    const read = key => fields.find(field => field.startsWith(key + ' '))?.slice(key.length + 1);
    return { path: read('worktree'), branch: read('branch')?.replace(/^refs\/heads\//, ''),
      head: read('HEAD'), bare: fields.includes('bare'), prunable: fields.some(field => /^prunable(?: |$)/.test(field)) };
  });
}

async function createWorktree(cwd, directory, branch) {
  if (typeof directory !== 'string' || !/^(?:[a-z]:[\\/]|[\\/]{2}[^\\/]+[\\/][^\\/]+)/i.test(directory) ||
      typeof branch !== 'string' || !branch || branch.startsWith('-') || branch.includes('@{')) {
    throw new Error('절대 경로와 새 브랜치 이름을 입력하세요.');
  }
  await git(cwd, ['check-ref-format', '--branch', branch]);
  const destination = path.resolve(directory);
  await git(cwd, ['worktree', 'add', '-b', branch, '--', destination, 'HEAD']);
  return destination;
}

async function fileHistory(cwd, name) {
  const root = (await git(cwd, ['rev-parse', '--show-toplevel'])).trimEnd();
  const output = await git(root, ['log', '--follow', '--max-count=20', '--format=%h%x00%an%x00%as%x00%s', '--', name]);
  return output.trimEnd().split('\n').filter(Boolean).map(line => {
    const [hash, author, date, subject] = line.split('\0');
    return { hash, author, date, subject };
  });
}

async function lineBlame(cwd, name, line) {
  if (!Number.isSafeInteger(line) || line < 1 || line > 10000000) throw new Error('잘못된 줄 번호입니다.');
  const root = (await git(cwd, ['rev-parse', '--show-toplevel'])).trimEnd();
  const output = (await git(root, ['blame', '--line-porcelain', '-L', line + ',' + line, '--', name])).split(/\r?\n/);
  const hash = output[0].split(' ')[0];
  if (/^0+$/.test(hash)) return null;
  const find = key => output.find(value => value.startsWith(key + ' '))?.slice(key.length + 1);
  return { hash: hash.slice(0, 8), author: find('author'), time: Number(find('author-time')), subject: find('summary') };
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

module.exports = { status, diff, pullRequests, pullDetails, fileHistory, lineBlame, commitDetails, worktrees, createWorktree };
