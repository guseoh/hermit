const { app, BrowserWindow, ipcMain, dialog, clipboard, nativeTheme, shell } = require('electron');
const path = require('node:path');
const fs = require('node:fs/promises');
const pty = require('node-pty');

const { probe, serverCommand, CodexSession } = require('./agent.cjs');
const changes = require('./changes.cjs');
const sessions = new Map();
const conversations = new Map();

function connected(id) {
  const session = conversations.get(id);
  if (!session?.threadId || session.closed) throw new Error('Codex 세션을 연결하세요.');
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
  session.kill();
}

app.whenReady().then(() => {
  nativeTheme.themeSource = 'dark';
  window = new BrowserWindow({
    icon: path.join(__dirname, 'assets', 'workbench.ico'),
    width: 1320, height: 820, minWidth: 800, minHeight: 470, backgroundColor: '#101010',
    webPreferences: { preload: path.join(__dirname, 'preload.cjs'), sandbox: true }
  });
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  window.webContents.on('will-navigate', event => event.preventDefault());


  handle('agent-probe', (tool, cwd, file) => probe(shellExe, tool, cwd, file));
  handle('claude-help', () => shell.openExternal('https://code.claude.com/docs/en/setup'));
  handle('agent-browse', async () => {
    const result = await dialog.showOpenDialog(window, {
      properties: ['openFile'], filters: [{ name: 'Agent CLI', extensions: ['exe', 'cmd', 'ps1'] }]
    });
    return result.filePaths[0] ?? null;
  });
  handle('chat-connect', async ({ id, cwd, threadId }) => {
    if (conversations.has(id)) throw new Error('This task is already connected.');
    conversations.set(id, null);
    let session;
    try {
      const installed = await probe(shellExe, 'codex', cwd);
      if (!installed) throw new Error('Codex CLI를 찾지 못했습니다.');
      const [command, args] = await serverCommand(shellExe, installed.file);
      if (!conversations.has(id)) throw new Error('The task was closed.');
      session = new CodexSession(command, args, cwd, event => {
        if (conversations.get(id) === session) window?.webContents.send('chat-event', id, event);
      });
      conversations.set(id, session);
      await session.request('initialize', {
        clientInfo: { name: 'powershell_workbench', title: 'PowerShell Workbench', version: app.getVersion() }
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
    if (session.turnId) return session.request('turn/interrupt', { threadId: session.threadId, turnId: session.turnId });
  });
  handle('chat-approve', (id, requestId, accept) => connected(id).resolve(requestId, accept));
  handle('chat-close', id => {
    const session = conversations.get(id);
    conversations.delete(id);
    session?.close();
  });
  handle('git-status', cwd => changes.status(cwd));
  handle('git-diff', (cwd, name, kind) => changes.diff(cwd, name, kind));

  handle('home', () => app.getPath('home'));
  handle('folder', async () => {
    const choice = await dialog.showOpenDialog(window, { properties: ['openDirectory'] });
    return choice.filePaths[0] ?? null;
  });
  handle('spawn', (id, cwd, cols, rows, launcher = 'shell', executable) => {
    if (sessions.has(id)) throw new Error('The terminal is already open.');
    if (!['shell', 'codex', 'claude'].includes(launcher)) throw new Error('Unknown terminal launcher.');
    const args = [
      '-NoLogo', '-NoExit', '-File', path.join(__dirname, 'prompt.ps1')
    ];
    if (launcher !== 'shell') args.push('-WorkbenchStartup', launcher);
    if (launcher !== 'shell' && executable) args.push('-WorkbenchExecutable', executable);
    const term = 'xterm-256color';
    const env = { ...process.env, TERM: term, COLORTERM: 'truecolor' };
    const session = pty.spawn(shellExe, args, { cwd, cols, rows, name: term, env });
    sessions.set(id, session);
    session.onData(data => window?.webContents.send('terminal-data', id, data));
    session.onExit(({ exitCode }) => {
      if (sessions.get(id) !== session) return;
      sessions.delete(id);
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
  window.on('closed', () => {
    window = null;
    for (const id of sessions.keys()) close(id);
    for (const session of conversations.values()) session?.close();
    conversations.clear();
  });
  window.loadFile('index.html');
});

app.on('window-all-closed', () => app.quit());
