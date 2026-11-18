const { app, BrowserWindow, ipcMain, dialog, clipboard, nativeTheme, shell, powerSaveBlocker } = require('electron');
const path = require('node:path');
const fs = require('node:fs/promises');
const pty = require('node-pty');

const { probe, serverCommand, claudeAuthStatus, CodexSession } = require('./agent.cjs');
const ClaudeSession = require('./claude.cjs');
const changes = require('./changes.cjs');
const resourceSnapshot = require('./resources.cjs');
const sessions = new Map();
const conversations = new Map();
let sleepMode = 'off';
let sleepBlocker;

function updateSleepBlocker() {
  const active = !!window && (sleepMode === 'always' || (sleepMode === 'terminal' && sessions.size > 0));
  if (active && sleepBlocker === undefined) sleepBlocker = powerSaveBlocker.start('prevent-app-suspension');
  if (!active && sleepBlocker !== undefined) {
    powerSaveBlocker.stop(sleepBlocker);
    sleepBlocker = undefined;
  }
  const state = { mode: sleepMode, active: sleepBlocker !== undefined };
  window?.webContents.send('sleep-state', state);
  return state;
}

function connected(id) {
  const session = conversations.get(id);
  if (!session?.threadId || session.closed) throw new Error('에이전트 세션을 연결하세요.');
  return session;
}
let window;
const shellExe = path.join(process.env.SystemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');

function handle(channel, action) {
  ipcMain.handle(channel, (event, ...args) => {
    if (event.sender !== window?.webContents || event.senderFrame !== window.webContents.mainFrame) {
      throw new Error('Unexpected request source.');
    }
    return action(...args);
  });
}

function close(id) {
  const session = sessions.get(id);
  if (!session) return;
  sessions.delete(id);
  updateSleepBlocker();
  session.kill();
}

app.whenReady().then(() => {
  nativeTheme.themeSource = 'dark';
  window = new BrowserWindow({
    title: 'Agent Workbench',
    autoHideMenuBar: true,
    titleBarStyle: 'hidden',
    titleBarOverlay: { color: '#141414', symbolColor: '#d4d4d4', height: 35 },
    icon: path.join(__dirname, 'assets', 'agent-workbench.ico'),
    width: 1320, height: 820, minWidth: 800, minHeight: 470, backgroundColor: '#181818',
    webPreferences: { preload: path.join(__dirname, 'preload.cjs'), sandbox: true }
  });
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  window.webContents.on('will-navigate', event => event.preventDefault());
  handle('sleep-mode', mode => {
    if (!['always', 'terminal', 'off'].includes(mode)) throw new Error('잘못된 절전 모드입니다.');
    sleepMode = mode;
    return updateSleepBlocker();
  });
  handle('resource-snapshot', async () => {
    const appPids = app.getAppMetrics().map(entry => entry.pid);
    const { app: own, terminals } = await resourceSnapshot(shellExe, appPids, sessions);
    return { appBytes: own.bytes, appProcesses: own.count, terminals };
  });


  handle('agent-probe', (tool, cwd, file) => probe(shellExe, tool, cwd, file));
  handle('claude-help', () => shell.openExternal('https://code.claude.com/docs/en/setup'));
  handle('claude-auth-status', async id => {
    const session = connected(id);
    if (!(session instanceof ClaudeSession)) throw new Error('Claude 작업을 선택하세요.');
    session.loggedIn = await claudeAuthStatus(session.file, session.cwd);
    return session.loggedIn;
  });
  handle('agent-browse', async () => {
    const result = await dialog.showOpenDialog(window, {
      properties: ['openFile'], filters: [{ name: 'Agent CLI', extensions: ['exe', 'cmd', 'ps1'] }]
    });
    return result.filePaths[0] ?? null;
  });
  handle('codex-usage', async () => {
    const cwd = app.getPath('home');
    const installed = await probe(shellExe, 'codex', cwd);
    if (!installed) return null;
    const [command, args] = await serverCommand(shellExe, installed.file);
    const session = new CodexSession(command, args, cwd, () => {});
    try {
      await session.request('initialize', { clientInfo: { name: 'powershell_workbench', title: 'Agent Workbench', version: app.getVersion() } });
      session.write({ method: 'initialized' });
      return await session.request('account/rateLimits/read');
    } finally {
      session.close();
    }
  });
  handle('chat-connect', async ({ id, cwd, threadId, provider = 'codex' }) => {
    if (conversations.has(id)) throw new Error('This task is already connected.');
    conversations.set(id, null);
    let session;
    try {
      const installed = await probe(shellExe, provider, cwd);
      if (!installed) throw new Error(provider === 'claude' ? 'Claude Code CLI를 찾지 못했습니다.' : 'Codex CLI를 찾지 못했습니다.');
      const emit = event => {
        if (conversations.get(id) === session) window?.webContents.send('chat-event', id, event);
      };
      if (provider === 'claude') {
        if (!/\.exe$/i.test(installed.file)) throw new Error('채팅 연동에는 Claude Code 네이티브 Windows 설치가 필요합니다.');
        if (!/^[0-9a-f-]{36}$/i.test(id)) throw new Error('잘못된 작업 ID입니다.');
        const directory = path.join(app.getPath('userData'), 'claude-history');
        await fs.mkdir(directory, { recursive: true });
        const historyFile = path.join(directory, id + '.json');
        let history = { items: [] };
        try { history = JSON.parse(await fs.readFile(historyFile, 'utf8')); }
        catch (error) { if (error.code !== 'ENOENT') throw error; }
        const loggedIn = await claudeAuthStatus(installed.file, cwd).catch(() => null);
        if (!conversations.has(id)) throw new Error('The task was closed.');
        session = new ClaudeSession(installed.file, cwd, historyFile, history, emit);
        session.loggedIn = loggedIn;
        conversations.set(id, session);
        return { threadId: session.threadId, model: 'Claude Code', turns: [history], loggedIn };
      }
      const [command, args] = await serverCommand(shellExe, installed.file);
      if (!conversations.has(id)) throw new Error('The task was closed.');
      session = new CodexSession(command, args, cwd, emit);
      conversations.set(id, session);
      await session.request('initialize', {
        clientInfo: { name: 'powershell_workbench', title: 'Agent Workbench', version: app.getVersion() }
      });
      session.write({ method: 'initialized' });
      const result = threadId
        ? await session.request('thread/resume', { threadId, cwd, excludeTurns: true })
        : await session.request('thread/start', { cwd });
      session.threadId = result.thread.id;
      const turns = threadId
        ? (await session.request('thread/turns/list', { threadId: session.threadId, limit: 30, sortDirection: 'desc', itemsView: 'full' })).data.reverse()
        : [];
      return { threadId: session.threadId, model: result.model, turns };
    } catch (error) {
      conversations.delete(id);
      session?.close();
      throw error;
    }
  });
  handle('chat-send', async (id, text, clientUserMessageId) => {
    const session = connected(id);
    if (session.turnId || session.sending) throw new Error('A turn is already active.');
    if (session instanceof ClaudeSession) {
      if (session.loggedIn === false) throw new Error('Claude Code에 먼저 로그인하세요.');
      return session.send(text, clientUserMessageId);
    }
    session.sending = true;
    try {
      const { turn } = await session.request('turn/start', {
        threadId: session.threadId, clientUserMessageId, input: [{ type: 'text', text, text_elements: [] }]
      });
      if (session.completedTurn !== turn.id) session.turnId = turn.id;
      return turn.id;
    } finally { session.sending = false; }
  });
  handle('chat-stop', id => {
    const session = connected(id);
    if (session instanceof ClaudeSession) return session.stop();
    if (session.turnId) return session.request('turn/interrupt', { threadId: session.threadId, turnId: session.turnId });
  });
  handle('chat-approve', (id, requestId, accept) => connected(id).resolve(requestId, accept));
  handle('chat-close', id => {
    const session = conversations.get(id);
    if (session?.turnId || session?.sending || session?.approvals.size) throw new Error('진행 중인 요청을 먼저 종료하세요.');
    conversations.delete(id);
    session?.close();
  });
  handle('git-status', cwd => changes.status(cwd));
  handle('git-diff', (cwd, name, kind) => changes.diff(cwd, name, kind));
  handle('github-pulls', (...args) => changes.pullRequests(...args));
  handle('github-pr-details', (...args) => changes.pullDetails(...args));
  handle('git-commit-details', (...args) => changes.commitDetails(...args));
  handle('git-worktrees', cwd => changes.worktrees(cwd));
  handle('git-create-worktree', (...args) => changes.createWorktree(...args));
  handle('open-local-preview', address => {
    const url = new URL(address);
    if (!['http:', 'https:'].includes(url.protocol) || !['localhost', '127.0.0.1'].includes(url.hostname) ||
        url.username || url.password) throw new Error('로컬 서버 주소를 입력하세요.');
    return shell.openExternal(url.href);
  });
  handle('git-file-history', (...args) => changes.fileHistory(...args));
  handle('git-line-blame', (...args) => changes.lineBlame(...args));
  handle('github-open', (repository, number) => {
    if (typeof repository !== 'string' || !/^[\w.-]+\/[\w.-]+$/.test(repository) ||
        repository.split('/').some(part => part === '.' || part === '..') ||
        (number !== undefined && (!Number.isSafeInteger(number) || number < 1))) {
      throw new Error('잘못된 GitHub 주소입니다.');
    }
    return shell.openExternal('https://github.com/' + repository + (number === undefined ? '' : '/pull/' + number));
  });

  handle('home', () => app.getPath('home'));
  handle('folder', async () => {
    const choice = await dialog.showOpenDialog(window, { properties: ['openDirectory'] });
    return choice.filePaths[0] ?? null;
  });
  handle('spawn', async (id, cwd, cols, rows, launcher = 'shell', executable, resumeId) => {
    if (sessions.has(id)) throw new Error('The terminal is already open.');
    if (!['shell', 'codex', 'claude', 'claude-login'].includes(launcher)) throw new Error('Unknown terminal launcher.');
    const login = launcher === 'claude-login';
    const args = ['-NoLogo'];
    if (resumeId === undefined && !login) args.push('-NoExit');
    args.push('-File', path.join(__dirname, 'prompt.ps1'));
    if (launcher !== 'shell') args.push('-WorkbenchStartup', login ? 'claude' : launcher);
    if (login) {
      const installed = await probe(shellExe, 'claude', cwd);
      if (!installed) throw new Error('Claude Code CLI를 찾지 못했습니다.');
      args.push('-WorkbenchExecutable', installed.file, '-WorkbenchLogin');
    }
    if (launcher !== 'shell' && !login && executable) args.push('-WorkbenchExecutable', executable);
    if (resumeId !== undefined) {
      if (launcher !== 'codex' || typeof resumeId !== 'string' ||
          !/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(resumeId)) {
        throw new Error('유효한 Codex 대화 ID가 필요합니다.');
      }
      args.push('-WorkbenchResumeId', resumeId);
    }
    const term = 'xterm-256color';
    const env = { ...process.env, TERM: term, COLORTERM: 'truecolor' };
    const session = pty.spawn(shellExe, args, { cwd, cols, rows, name: term, env });
    sessions.set(id, session);
    updateSleepBlocker();
    session.onData(data => window?.webContents.send('terminal-data', id, data));
    session.onExit(({ exitCode }) => {
      if (sessions.get(id) !== session) return;
      sessions.delete(id);
      updateSleepBlocker();
      window?.webContents.send('terminal-exit', id, exitCode);
    });
  });
  handle('input', (id, value) => sessions.get(id)?.write(value));
  handle('resize', (id, cols, rows) => sessions.get(id)?.resize(cols, rows));
  handle('close-terminal', close);
  handle('copy', text => clipboard.writeText(text));
  handle('save', async text => {
    const choice = await dialog.showSaveDialog(window, {
      defaultPath: 'powershell-results.txt', filters: [{ name: 'Text', extensions: ['txt'] }]
    });
    if (!choice.filePath) return false;
    await fs.writeFile(choice.filePath, text, 'utf8');
    return true;
  });
  const markdownFilters = [{ name: 'Markdown', extensions: ['md', 'markdown'] }];
  handle('open-markdown-note', async cwd => {
    const { filePaths, canceled } = await dialog.showOpenDialog(window, {
      defaultPath: typeof cwd === 'string' ? cwd : undefined,
      properties: ['openFile'], filters: markdownFilters
    });
    if (canceled || !filePaths[0]) return null;
    const file = filePaths[0];
    if (!/\.m(?:d|arkdown)$/i.test(file)) throw new Error('Markdown 파일을 선택하세요.');
    const handle = await fs.open(file);
    try {
      if (!(await handle.stat()).isFile()) throw new Error('Markdown 파일을 선택하세요.');
      const buffer = Buffer.alloc(512 * 1024 + 1);
      let length = 0;
      while (length < buffer.length) {
        const { bytesRead } = await handle.read(buffer, length, buffer.length - length);
        if (!bytesRead) break;
        length += bytesRead;
      }
      if (length === buffer.length) throw new Error('512KB 이하의 Markdown 파일을 선택하세요.');
      const text = new TextDecoder('utf-8', { fatal: true }).decode(buffer.subarray(0, length));
      return { file, name: path.basename(file), cwd: path.dirname(file), text };
    } finally { await handle.close(); }
  });
  handle('save-markdown-note', async (text, file, cwd) => {
    if (typeof text !== 'string' || Buffer.byteLength(text) > 512 * 1024) {
      throw new Error('Markdown 파일은 512KB까지 저장할 수 있습니다.');
    }
    const { filePath, canceled } = await dialog.showSaveDialog(window, {
      defaultPath: typeof file === 'string' ? file : path.join(typeof cwd === 'string' ? cwd : app.getPath('documents'), 'note.md'),
      filters: markdownFilters
    });
    if (canceled || !filePath) return null;
    if (!/\.m(?:d|arkdown)$/i.test(filePath)) throw new Error('파일 이름을 .md 또는 .markdown으로 지정하세요.');
    await fs.writeFile(filePath, text, 'utf8');
    return { file: filePath, name: path.basename(filePath), cwd: path.dirname(filePath) };
  });
  window.on('closed', () => {
    window = null;
    updateSleepBlocker();
    for (const id of sessions.keys()) close(id);
    for (const session of conversations.values()) session?.close();
    conversations.clear();
  });
  window.loadFile('index.html');
});

app.on('window-all-closed', () => app.quit());
