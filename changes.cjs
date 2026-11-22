const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const fs = require('node:fs/promises');
const path = require('node:path');
const exec = promisify(execFile);
const limit = 2 * 1024 * 1024;

async function git(cwd, args, timeout = 10000) {
  return (await exec('git', ['--no-optional-locks', '-c', 'core.fsmonitor=false', '-C', cwd, ...args], {
    env: { ...process.env, GIT_LITERAL_PATHSPECS: '1' },
    windowsHide: true, timeout, maxBuffer: limit
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

const samePath = (first, second) => path.resolve(first).toLowerCase() === path.resolve(second).toLowerCase();
const gitMessage = error => (error.stderr || error.message || '').trim().split(/\r?\n/).at(-1);

function taskSlug(name) {
  const slug = String(name).normalize('NFKD').toLowerCase().replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '').slice(0, 32).replace(/-+$/, '');
  return slug || 'task';
}

// 작업 하나에 브랜치 하나와 worktree 하나를 만든다. 경로와 브랜치 이름은 렌더러가 아니라 여기서 정한다.
// 위치: <저장소 부모>/<저장소 이름>.worktrees/<slug>-<id 앞 8자>, 브랜치: agent/<slug>-<id 앞 8자>
async function createTaskWorktree(cwd, name, id) {
  if (typeof cwd !== 'string' || !path.isAbsolute(cwd)) throw new Error('작업 폴더가 올바르지 않습니다.');
  if (typeof name !== 'string' || !name.trim() || name.length > 80) throw new Error('작업 이름을 확인하세요.');
  if (typeof id !== 'string' || !/^[0-9a-f]{8}-[0-9a-f-]{27}$/i.test(id)) throw new Error('잘못된 작업 ID입니다.');
  let list;
  try { list = await worktrees(cwd); }
  catch (error) {
    if (/not a git repository/i.test(error.stderr ?? '')) throw new Error('Git 저장소가 아닌 폴더에서는 worktree를 만들 수 없습니다.');
    if (error.code === 'ENOENT') throw new Error('Git을 찾지 못했습니다.');
    throw error;
  }
  const main = list[0];
  if (!main?.path || main.bare) throw new Error('기본 worktree를 확인할 수 없습니다.');
  const root = path.resolve(main.path);
  const head = (await git(cwd, ['rev-parse', '--verify', '--quiet', 'HEAD^{commit}']).catch(() => '')).trim();
  if (!head) throw new Error('커밋이 하나 이상 있어야 worktree를 만들 수 있습니다.');
  const base = (await git(cwd, ['branch', '--show-current'])).trim() || head.slice(0, 8);
  const suffix = taskSlug(name) + '-' + id.slice(0, 8).toLowerCase();
  const branch = 'agent/' + suffix;
  const directory = path.join(path.dirname(root), path.basename(root) + '.worktrees', suffix);
  await git(cwd, ['check-ref-format', '--branch', branch]);
  if (list.some(entry => entry.branch === branch || (entry.path && samePath(entry.path, directory)))) {
    throw new Error('같은 이름의 worktree가 이미 있습니다.');
  }
  try { await fs.access(directory); throw new Error('worktree 폴더가 이미 있습니다: ' + directory); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  await fs.mkdir(path.dirname(directory), { recursive: true });
  try { await git(cwd, ['worktree', 'add', '-b', branch, '--', directory, head], 120000); }
  catch (error) { throw new Error('worktree를 만들지 못했습니다: ' + gitMessage(error)); }
  return { root, path: directory, branch, base, head };
}

// createTaskWorktree가 만든 worktree만 지운다. 변경이 남아 있으면 force 없이는 지우지 않는다.
// 브랜치는 병합된 경우에만 git branch -d로 지우고, 아니면 남겨 둔다.
async function removeWorktree(directory, branch, force = false) {
  if (typeof directory !== 'string' || !path.isAbsolute(directory) || typeof branch !== 'string' ||
      !/^agent\/[a-z0-9-]+-[0-9a-f]{8}$/.test(branch) || typeof force !== 'boolean') {
    throw new Error('정리할 worktree 정보가 올바르지 않습니다.');
  }
  const target = path.resolve(directory);
  const container = path.dirname(target);
  if (!container.toLowerCase().endsWith('.worktrees') || path.basename(target) !== branch.slice('agent/'.length)) {
    throw new Error('Workbench가 만든 worktree만 정리할 수 있습니다.');
  }
  const root = path.join(path.dirname(container), path.basename(container).slice(0, -'.worktrees'.length));
  const list = await worktrees(root);
  if (!list[0]?.path || !samePath(list[0].path, root)) throw new Error('원래 저장소를 찾지 못했습니다.');
  const entry = list.slice(1).find(item => item.path && samePath(item.path, target));
  let removed = false;
  const inUse = 'worktree 폴더를 사용 중입니다. 그 폴더의 터미널·편집기를 닫고 다시 시도하세요.';
  // 방금 닫은 터미널·에이전트 프로세스가 끝날 때까지 잠깐 잠길 수 있어 몇 번 다시 시도한다.
  const removeLeftover = async () => {
    try { await fs.rm(target, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 }); }
    catch (error) {
      throw new Error(['EBUSY', 'EPERM', 'EACCES', 'ENOTEMPTY'].includes(error.code) ? inUse : 'worktree 폴더를 지우지 못했습니다: ' + error.message);
    }
    removed = true;
  };
  if (!entry) {
    // git 목록에서는 빠졌지만 폴더가 남은 경우: 이전 정리가 잠긴 파일 때문에 중간에 멈춘 것이다.
    await git(root, ['worktree', 'prune']);
    const left = await fs.readdir(target).catch(error => { if (error.code === 'ENOENT') return null; throw error; });
    if (left?.length && !force) return { dirty: left.length };
    if (left) await removeLeftover();
  } else {
    if (entry.branch !== branch) throw new Error('worktree의 브랜치가 작업 정보와 다릅니다.');
    if (!entry.prunable) {
      const dirty = (await git(target, ['status', '--porcelain', '-z', '--untracked-files=normal']))
        .split('\0').filter(Boolean).length;
      if (dirty && !force) return { dirty };
    }
    try {
      await git(root, ['worktree', 'remove', ...(force ? ['--force'] : []), '--', target], 60000);
      removed = true;
    } catch (error) {
      const message = gitMessage(error);
      const listed = (await worktrees(root)).some(item => item.path && samePath(item.path, target));
      if (listed) {
        throw new Error(/permission denied|being used|busy|resource|invalid argument/i.test(message)
          ? inUse : 'worktree를 지우지 못했습니다: ' + message);
      }
      // git은 등록을 지웠지만 잠긴 파일 때문에 폴더만 남았다. 변경 확인은 위에서 끝났으니 남은 폴더를 지운다.
      await git(root, ['worktree', 'prune']);
      await removeLeftover();
    }
  }
  let branchDeleted = false;
  const exists = await git(root, ['show-ref', '--verify', '--quiet', 'refs/heads/' + branch]).then(() => true, () => false);
  if (exists) branchDeleted = await git(root, ['branch', '-d', '--', branch]).then(() => true, () => false);
  return { removed, branchDeleted, branchKept: exists && !branchDeleted, branch };
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
  let upstream = null;
  let ahead = 0;
  let behind = 0;
  const files = [];
  for (let index = 0; index < records.length; index++) {
    const record = records[index];
    if (record.startsWith('# branch.head ')) branch = record.slice(14);
    if (record.startsWith('# branch.upstream ')) upstream = record.slice(18);
    if (record.startsWith('# branch.ab ')) [ahead, behind] = record.slice(12).split(' ').map(value => Math.abs(Number(value)));
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
  // Added/removed line counts per file, as shown next to each entry in the changes list.
  const parseNumstat = output => {
    const counts = new Map();
    const tokens = output.split('\0');
    for (let index = 0; index < tokens.length; index++) {
      const [added, removed, path] = tokens[index].split('\t');
      if (removed === undefined) continue;
      const name = path || tokens[(index += 2)];
      if (name) counts.set(name, { added: added === '-' ? null : Number(added), removed: removed === '-' ? null : Number(removed) });
    }
    return counts;
  };
  if (files.some(file => file.kind === 'staged' || file.kind === 'unstaged')) {
    const [staged, unstaged] = await Promise.all([
      git(root, ['diff', '--cached', '--numstat', '-z', '--no-ext-diff', '--no-textconv']),
      git(root, ['diff', '--numstat', '-z', '--no-ext-diff', '--no-textconv'])
    ].map(promise => promise.then(parseNumstat, () => new Map())));
    for (const file of files) {
      const stat = (file.kind === 'staged' ? staged : file.kind === 'unstaged' ? unstaged : null)?.get(file.name);
      if (stat) Object.assign(file, stat);
    }
  }
  return { root, branch, upstream, ahead, behind, files };
}

// ── 스테이지·커밋·푸시·PR ─────────────────────────────────────────────
// 렌더러가 보낸 파일 이름은 지금 git status에 있는 항목과 맞을 때만 쓴다(임의 경로를 git에 넘기지 않는다).
async function chooseEntries(cwd, names, kinds) {
  if (!Array.isArray(names) || !names.length || names.length > 5000 || names.some(name => typeof name !== 'string')) {
    throw new Error('파일을 선택하세요.');
  }
  const snapshot = await status(cwd);
  if (!snapshot.root) throw new Error('Git 저장소가 아닙니다.');
  const chosen = new Set();
  for (const name of names) {
    const entries = snapshot.files.filter(file => file.name === name && kinds.includes(file.kind));
    if (!entries.length) throw new Error('변경 목록이 바뀌었습니다. 목록을 새로 고침하세요.');
    for (const entry of entries) { chosen.add(entry.name); if (entry.from) chosen.add(entry.from); }
  }
  return { root: snapshot.root, paths: [...chosen] };
}

async function stage(cwd, names) {
  const { root, paths } = await chooseEntries(cwd, names, ['unstaged', 'new', 'conflict']);
  await git(root, ['add', '-A', '--', ...paths], 60000);
}

async function unstage(cwd, names) {
  const { root, paths } = await chooseEntries(cwd, names, ['staged']);
  const hasHead = await git(root, ['rev-parse', '--verify', '--quiet', 'HEAD']).then(() => true, () => false);
  await git(root, hasHead ? ['restore', '--staged', '--', ...paths] : ['rm', '--cached', '-r', '-q', '--', ...paths], 60000);
}

async function stageAll(cwd) {
  const snapshot = await status(cwd);
  if (!snapshot.root) throw new Error('Git 저장소가 아닙니다.');
  await git(snapshot.root, ['add', '-A'], 60000);
}

const promptless = { ...process.env, GIT_LITERAL_PATHSPECS: '1', GIT_TERMINAL_PROMPT: '0', GCM_INTERACTIVE: 'never' };
async function gitLong(cwd, args, timeout = 120000) {
  return (await exec('git', ['-c', 'core.fsmonitor=false', '-C', cwd, ...args], {
    env: promptless, windowsHide: true, timeout, maxBuffer: limit
  }));
}
const lastLines = (error, count = 6) => ((error.stderr || '') + (error.stdout || '')).trim().split(/\r?\n/).slice(-count).join('\n');

async function commit(cwd, message) {
  if (typeof message !== 'string' || !message.trim() || message.length > 20000) throw new Error('커밋 메시지를 입력하세요.');
  const snapshot = await status(cwd);
  if (!snapshot.root) throw new Error('Git 저장소가 아닙니다.');
  if (!snapshot.files.some(file => file.kind === 'staged')) throw new Error('스테이지한 변경이 없습니다.');
  if (snapshot.files.some(file => file.kind === 'conflict')) throw new Error('충돌을 먼저 해결하세요.');
  try { await gitLong(snapshot.root, ['commit', '--cleanup=strip', '-m', message.replace(/\r\n/g, '\n')]); }
  catch (error) { throw new Error('커밋하지 못했습니다.\n' + lastLines(error)); }
  const [hash, subject] = (await git(snapshot.root, ['log', '-1', '--format=%h%x00%s'])).trimEnd().split('\0');
  return { hash, subject };
}

async function push(cwd) {
  const snapshot = await status(cwd);
  if (!snapshot.root) throw new Error('Git 저장소가 아닙니다.');
  const branch = snapshot.branch;
  if (!branch || branch === '(detached)') throw new Error('브랜치에서만 푸시할 수 있습니다.');
  await git(snapshot.root, ['check-ref-format', '--branch', branch]);
  const remotes = (await git(snapshot.root, ['remote'])).split(/\r?\n/);
  if (!remotes.includes('origin')) throw new Error('origin 원격 저장소가 없습니다.');
  const args = snapshot.upstream ? ['push'] : ['push', '--set-upstream', 'origin', '--', branch];
  try { await gitLong(snapshot.root, args, 180000); }
  catch (error) {
    if (/rejected|non-fast-forward|fetch first/i.test(lastLines(error))) {
      throw new Error('원격 브랜치에 새 커밋이 있어 푸시가 거부되었습니다. 먼저 pull 하세요.');
    }
    if (/authentication|could not read username|permission denied|403/i.test(lastLines(error))) {
      throw new Error('원격 저장소 인증에 실패했습니다. 터미널에서 git push로 한 번 로그인하세요.');
    }
    throw new Error('푸시하지 못했습니다.\n' + lastLines(error));
  }
  return { branch, upstream: snapshot.upstream ?? 'origin/' + branch };
}

// PR 만들기 전에 보여 줄 정보: 기본 브랜치, 이미 열린 PR, 제목·본문 초안(브랜치의 커밋 목록).
async function pullRequestDraft(cwd) {
  const snapshot = await status(cwd);
  if (!snapshot.root) throw new Error('Git 저장소가 아닙니다.');
  const repository = await githubRepository(snapshot.root);
  if (!repository) throw new Error('GitHub origin이 있는 저장소에서만 PR을 만들 수 있습니다.');
  let base = 'main';
  try { base = JSON.parse(await gh(snapshot.root, repository, ['repo', 'view', '--json', 'defaultBranchRef'])).defaultBranchRef.name || base; }
  catch (error) { if (error.code === 'ENOENT') throw new Error('GitHub CLI(gh)를 설치하면 PR을 만들 수 있습니다.'); }
  let existing = null;
  try {
    const found = JSON.parse(await gh(snapshot.root, repository, ['pr', 'list', '--head', snapshot.branch, '--state', 'open', '--json', 'number,url,title']));
    existing = found[0] ?? null;
  } catch { /* 조회 실패는 만들 때 다시 확인된다. */ }
  const range = 'origin/' + base + '..HEAD';
  const log = await git(snapshot.root, ['log', '--format=%s%x00%b%x01', '--max-count=50', range]).catch(() => '');
  const commits = log.split('\x01').map(entry => entry.trim()).filter(Boolean).map(entry => {
    const [subject, body] = entry.split('\0');
    return { subject: subject.trim(), body: (body ?? '').trim() };
  });
  const title = commits.length === 1 ? commits[0].subject : commits.at(-1)?.subject ?? snapshot.branch;
  const body = commits.length === 1 ? commits[0].body : commits.map(entry => '- ' + entry.subject).reverse().join('\n');
  return { repository, branch: snapshot.branch, base, existing, title, body, pushed: !!snapshot.upstream && !snapshot.ahead, ahead: snapshot.ahead };
}

async function createPullRequest(cwd, request) {
  const { title, body = '', base, draft = false } = request ?? {};
  if (typeof title !== 'string' || !title.trim() || title.length > 256) throw new Error('PR 제목을 입력하세요.');
  if (typeof body !== 'string' || body.length > 60000) throw new Error('PR 본문이 너무 깁니다.');
  if (typeof base !== 'string' || !base || base.startsWith('-') || typeof draft !== 'boolean') throw new Error('기준 브랜치를 확인하세요.');
  const snapshot = await status(cwd);
  if (!snapshot.root) throw new Error('Git 저장소가 아닙니다.');
  await git(snapshot.root, ['check-ref-format', '--branch', base]);
  if (snapshot.branch === base) throw new Error('기준 브랜치와 다른 브랜치에서 PR을 만드세요.');
  if (!snapshot.upstream || snapshot.ahead) throw new Error('먼저 브랜치를 푸시하세요.');
  const repository = await githubRepository(snapshot.root);
  if (!repository) throw new Error('GitHub origin을 확인할 수 없습니다.');
  const args = ['pr', 'create', '--title', title.trim(), '--body', body, '--base', base, '--head', snapshot.branch];
  if (draft) args.push('--draft');
  try {
    const output = await gh(snapshot.root, repository, args);
    const url = output.trim().split(/\r?\n/).findLast(line => /^https:\/\/github\.com\//.test(line));
    return { url: url ?? null, repository, number: Number(/\/pull\/(\d+)/.exec(url ?? '')?.[1]) || null };
  } catch (error) {
    if (error.code === 'ENOENT') throw new Error('GitHub CLI(gh)를 설치하면 PR을 만들 수 있습니다.');
    const message = lastLines(error);
    if (/already exists/i.test(message)) throw new Error('이 브랜치의 PR이 이미 있습니다.');
    if (/gh auth login|not logged|401|bad credentials/i.test(message)) throw new Error('터미널에서 gh auth login으로 로그인하세요.');
    throw new Error('PR을 만들지 못했습니다.\n' + message);
  }
}

// AI 커밋 메시지에 넘길 자료: staged diff(최대 60KB)와 최근 커밋 제목(형식·언어를 맞추기 위해).
async function commitContext(cwd) {
  const snapshot = await status(cwd);
  if (!snapshot.root) throw new Error('Git 저장소가 아닙니다.');
  if (!snapshot.files.some(file => file.kind === 'staged')) throw new Error('스테이지한 변경이 없습니다.');
  const stat = await git(snapshot.root, ['diff', '--cached', '--stat', '--no-color']);
  let diff = await git(snapshot.root, ['diff', '--cached', '--no-ext-diff', '--no-textconv', '--no-color', '-U2']);
  const maxDiff = 60000;
  const truncated = diff.length > maxDiff;
  if (truncated) diff = diff.slice(0, maxDiff);
  const recent = await git(snapshot.root, ['log', '-10', '--format=%s']).catch(() => '');
  return { root: snapshot.root, branch: snapshot.branch, stat, diff, truncated, recent: recent.trim() };
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

module.exports = { status, diff, pullRequests, pullDetails, fileHistory, lineBlame, commitDetails, worktrees, createWorktree,
  createTaskWorktree, removeWorktree, stage, unstage, stageAll, commit, push,
  pullRequestDraft, createPullRequest, commitContext };
