const { app, BrowserWindow, ipcMain, dialog, clipboard, nativeTheme, shell, powerSaveBlocker, Notification, Tray, Menu, powerMonitor } = require('electron');
const { script } = require('./paths.cjs');
const path = require('node:path');
const fs = require('node:fs/promises');
const pty = require('node-pty');

const { probe, useProbeCache, serverCommand, codexCommand, claudeAuthStatus } = require('./agent.cjs');
const ClaudeSession = require('./claude.cjs');
const claudeHistory = require('./main/claude-history-sync.cjs');
const attachments = require('./main/attachments.cjs');
const files = require('./main/files.cjs');
const reviewNotes = require('./review-notes.js');
const editors = require('./main/editors.cjs');
const attachmentDirectory = () => path.join(app.getPath('userData'), 'attachments');
const { CodexHost } = require('./codex-host.cjs');
const changes = require('./changes.cjs');
const commitMessage = require('./commit-message.cjs');
const checkpoints = require('./checkpoints.cjs');
const { createHookServer } = require('./agent-hooks.cjs');
let agentHooks = null;
const { createGitWatcher } = require('./git-watch.cjs');
const gitWatcher = createGitWatcher(changes.repositoryPaths, root => window?.webContents.send('git-changed', root));
const generatingMessages = new Set();
// 에이전트 CLI 확인(agent-probe.ps1)은 몇 초씩 걸려서, AI 커밋 메시지용으로는 한 번 찾은 결과를 다시 쓴다.
const agentCache = new Map();
async function findAgent(provider, cwd) {
  if (agentCache.has(provider)) return agentCache.get(provider);
  let installed;
  try { installed = await probe(shellExe, provider, cwd); }
  catch { throw new Error('에이전트 CLI를 확인하는 데 시간이 너무 걸렸습니다. 잠시 뒤 다시 시도하세요.'); }
  if (installed) agentCache.set(provider, installed);
  return installed;
}
const state = require('./state.cjs');
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

function trusted(event) {
  return event.sender === window?.webContents && event.senderFrame === window.webContents.mainFrame;
}

function handle(channel, action) {
  ipcMain.handle(channel, (event, ...args) => {
    if (!trusted(event)) throw new Error('Unexpected request source.');
    return action(...args);
  });
}

// 상태 파일: 시작할 때와 창을 닫을 때는 렌더러가 기다려야 하므로 동기 IPC를 쓴다.
const stateFile = () => path.join(app.getPath('userData'), 'workbench-state.json');
ipcMain.on('state-read', event => {
  try { event.returnValue = trusted(event) ? state.read(stateFile()) : null; }
  catch { event.returnValue = null; }
});
ipcMain.on('state-flush', (event, values) => {
  try { event.returnValue = trusted(event) ? state.write(stateFile(), values) : false; }
  catch { event.returnValue = false; }
});

function close(id) {
  const session = sessions.get(id);
  if (!session) return;
  sessions.delete(id);
  updateSleepBlocker();
  session.kill();
}

// Windows 알림(토스트)은 앱 사용자 모델 ID가 있어야 개발 실행(electron.exe)에서도 뜬다.
if (process.platform === 'win32') app.setAppUserModelId('com.guseoh.agent-workbench');

// 창이 포커스되어 있지 않을 때만 알림을 띄운다. 누르면 창을 앞으로 가져오고 해당 작업을 연다.
const notifications = new Set();
function notify({ title, body, taskId } = {}) {
  if (typeof title !== 'string' || !title.trim() || title.length > 200 || typeof body !== 'string' || body.length > 1000 ||
      (taskId !== undefined && (typeof taskId !== 'string' || !/^[0-9a-f-]{36}$/i.test(taskId)))) {
    throw new Error('잘못된 알림입니다.');
  }
  if (!window || window.isFocused() || !Notification.isSupported()) return false;
  const notice = new Notification({ title, body, icon: path.join(__dirname, 'assets', 'hermit.ico') });
  notifications.add(notice);
  const forget = () => notifications.delete(notice);
  notice.on('click', () => {
    forget();
    if (!window) return;
    if (window.isMinimized()) window.restore();
    window.show();
    window.focus();
    if (taskId) window.webContents.send('notification-open', taskId);
  });
  notice.on('close', forget);
  notice.on('failed', forget);
  notice.show();
  return true;
}

let codexExecutable = null;
const codexHost = new CodexHost({
  home: require('node:os').homedir(),
  clientInfo: { name: 'powershell_workbench', title: 'Hermit', version: app.getVersion() },
  start: async () => {
    const installed = codexExecutable ? { file: codexExecutable } : await probe(shellExe, 'codex', require('node:os').homedir());
    if (!installed) throw new Error('Codex CLI를 찾지 못했습니다.');
    return serverCommand(shellExe, installed.file);
  },
  // 사용량 한도처럼 특정 작업에 속하지 않는 이벤트는 연결된 Codex 작업 하나로 보낸다(렌더러는 작업 ID로 받는다).
  broadcast: event => {
    for (const [id, session] of conversations) {
      if (session && !(session instanceof ClaudeSession)) { window?.webContents.send('chat-event', id, event); break; }
    }
  }
});

// package.json에 productName("Hermit")을 넣으면 Electron의 데이터 폴더 이름도 바뀐다.
// 기존 작업·설정·상태 파일이 그대로 보이도록 예전 폴더(%APPDATA%\powershell-workbench)를 계속 쓴다.
// 개발·자동 시험용: AGENT_WORKBENCH_PROFILE을 주면 그 폴더를 데이터 폴더로 쓴다(실제 작업·설정과 분리되고,
// 설치본이 켜져 있어도 단일 실행 잠금이 겹치지 않는다). 설치본은 이 값을 쓰지 않는다.
const profileOverride = !app.isPackaged && process.env.AGENT_WORKBENCH_PROFILE;
app.setPath('userData', profileOverride ? path.resolve(profileOverride) : path.join(app.getPath('appData'), 'powershell-workbench'));

const singleInstance = app.requestSingleInstanceLock();
if (!singleInstance) app.quit();
app.on('second-instance', () => showWindow());

// ── 트레이 상주 ──────────────────────────────────────────────────────────
// 창을 닫아도(설정이 켜져 있으면) 앱은 트레이에 남아 에이전트 작업을 계속한다. 종료는 트레이 메뉴에서.
let tray = null;
let quitting = false;
let closeToTray = true;
let trayState = { working: 0, waiting: 0 };
let trayHintShown = false;
function showWindow() {
  if (!window) return;
  if (window.isMinimized()) window.restore();
  window.show();
  window.focus();
}
function updateTray() {
  if (!tray) return;
  const parts = [trayState.working && '작업 중 ' + trayState.working, trayState.waiting && '승인·입력 대기 ' + trayState.waiting].filter(Boolean);
  tray.setToolTip('Hermit' + (parts.length ? ' · ' + parts.join(' · ') : ''));
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: 'Hermit 열기', click: showWindow },
    { type: 'separator' },
    { label: parts.length ? parts.join(' · ') : '진행 중인 에이전트 작업 없음', enabled: false },
    ...(pendingUpdate ? [{ type: 'separator' }, { label: '업데이트 설치 후 다시 시작 (v' + pendingUpdate + ')', click: installUpdateNow }] : []),
    { type: 'separator' },
    { label: '종료', click: () => { quitting = true; app.quit(); } }
  ]));
}
function createTray() {
  if (tray) return;
  tray = new Tray(path.join(__dirname, 'assets', 'hermit.ico'));
  tray.on('click', showWindow);
  updateTray();
}
app.on('before-quit', () => { quitting = true; });

// ── 자동 업데이트(설치본에서만) ─────────────────────────────────────────────
// GitHub Releases에서 새 버전을 확인해 받아 두고, 렌더러가 "다시 시작해 설치"를 누르면 설치한다.
// 누르지 않으면 앱을 끌 때 설치된다. 개발 실행(electron .)에서는 하지 않는다.
let autoUpdate = true;
let updater = null;
let updateTimer = null;
let pendingUpdate = '';
let idleInstallTimer = null;

// A downloaded update installs itself when nobody is using the app: no agent working or waiting
// for the user, and the computer idle for 10 minutes. The app restarts on the new version and
// reopens the last task. Busy agents postpone it; the tray menu and the toast install right away.
const IDLE_INSTALL_SECONDS = 10 * 60;
function installUpdateNow() {
  if (!updater || !pendingUpdate) return false;
  quitting = true;
  updater.quitAndInstall(true, true);
  return true;
}
function scheduleIdleInstall() {
  if (idleInstallTimer || !pendingUpdate) return;
  idleInstallTimer = setInterval(() => {
    if (!autoUpdate || !pendingUpdate) return;
    if (trayState.working || trayState.waiting) return;
    if (powerMonitor.getSystemIdleTime() < IDLE_INSTALL_SECONDS) return;
    clearInterval(idleInstallTimer);
    idleInstallTimer = null;
    installUpdateNow();
  }, 60 * 1000);
}
function startAutoUpdate() {
  if (!app.isPackaged || !autoUpdate || updater) return;
  try { ({ autoUpdater: updater } = require('electron-updater')); } catch { return; }
  updater.autoDownload = true;
  updater.autoInstallOnAppQuit = true;
  updater.on('update-downloaded', info => {
    pendingUpdate = String(info?.version ?? '');
    window?.webContents.send('update-ready', pendingUpdate);
    updateTray();
    scheduleIdleInstall();
  });
  updater.on('error', () => {});
  const check = () => { if (autoUpdate) updater.checkForUpdates().catch(() => {}); };
  setTimeout(check, 10000);
  updateTimer = setInterval(check, 6 * 60 * 60 * 1000);
}

app.whenReady().then(() => {
  if (!singleInstance) return;
  createTray();
  useProbeCache(path.join(app.getPath('userData'), 'agents.json'));
  setTimeout(() => attachments.pruneAttachments(attachmentDirectory()), 30000);
  // 터미널 에이전트(TUI) 상태 알림을 받는 파이프. 받은 상태는 렌더러로 보낸다.
  try {
    agentHooks = createHookServer({
      directory: path.join(app.getPath('userData'), 'agent-hooks'),
      script: script('agent-hook.ps1'),
      isPane: id => sessions.has(id),
      onEvent: (paneId, state, event) => window?.webContents.send('agent-hook', paneId, state, event)
    });
  } catch { agentHooks = null; }
  nativeTheme.themeSource = 'dark';
  window = new BrowserWindow({
    title: 'Hermit',
    autoHideMenuBar: true,
    titleBarStyle: 'hidden',
    titleBarOverlay: { color: '#171717', symbolColor: '#acacac', height: 36 },
    icon: path.join(__dirname, 'assets', 'hermit.ico'),
    width: 1320, height: 820, minWidth: 800, minHeight: 470, backgroundColor: '#0f0f0f',
    webPreferences: { preload: path.join(__dirname, 'preload.cjs'), sandbox: true }
  });
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  window.webContents.on('will-navigate', event => event.preventDefault());
  // Electron's hidden default menu turns Ctrl+R into "reload", which steals PowerShell's history search.
  // No app menu at all; the development run (npm start) reloads with F5 / Ctrl+Shift+R and opens DevTools
  // with Ctrl+Shift+I, keys the terminal does not use. The installed app has neither.
  Menu.setApplicationMenu(null);
  if (!app.isPackaged) {
    window.webContents.on('before-input-event', (event, input) => {
      if (input.type !== 'keyDown') return;
      const key = input.key.toLowerCase();
      if (input.key === 'F5' || (input.control && input.shift && key === 'r')) {
        event.preventDefault();
        window.webContents.reloadIgnoringCache();
      } else if (input.control && input.shift && key === 'i') {
        event.preventDefault();
        window.webContents.toggleDevTools();
      }
    });
  }
  handle('sleep-mode', mode => {
    if (!['always', 'terminal', 'off'].includes(mode)) throw new Error('잘못된 절전 모드입니다.');
    sleepMode = mode;
    return updateSleepBlocker();
  });
  handle('resource-snapshot', () => resourceSnapshot(shellExe, app.getAppMetrics(), sessions));


  handle('agent-probe', (tool, cwd, file, refresh) => probe(shellExe, tool, cwd, file, { refresh: refresh === true }));
  handle('claude-help', () => shell.openExternal('https://code.claude.com/docs/en/setup'));
  handle('claude-auth-status', async id => {
    const session = connected(id);
    if (!(session instanceof ClaudeSession)) throw new Error('Claude 작업을 선택하세요.');
    session.loggedIn = await claudeAuthStatus(session.file, session.cwd);
    const catalog = session.loggedIn === true ? await ClaudeSession.probeModels(session.file, session.cwd).catch(() => null) : null;
    return { loggedIn: session.loggedIn, catalog };
  });
  handle('agent-browse', async () => {
    const result = await dialog.showOpenDialog(window, {
      properties: ['openFile'], filters: [{ name: 'Agent CLI', extensions: ['exe', 'cmd', 'ps1'] }]
    });
    return result.filePaths[0] ?? null;
  });
  // 사용량은 공용 Codex 서버에 묻는다(조회용 서버를 따로 띄우지 않는다).
  handle('codex-usage', async () => {
    const installed = await probe(shellExe, 'codex', app.getPath('home'));
    if (!installed) return null;
    codexExecutable ??= installed.file;
    return codexHost.request('account/rateLimits/read');
  });
  handle('chat-connect', async ({ id, cwd, threadId, provider = 'codex', executable }) => {
    if (conversations.has(id)) throw new Error('This task is already connected.');
    conversations.set(id, null);
    let session;
    try {
      // A user-chosen CLI path (picked in the terminal launcher) wins; otherwise search PATH.
      const chosen = typeof executable === 'string' && executable ? await probe(shellExe, provider, cwd, executable).catch(() => null) : null;
      const installed = chosen ?? await probe(shellExe, provider, cwd);
      if (!installed) throw new Error(provider === 'claude' ? 'Claude Code CLI를 찾지 못했습니다.' : 'Codex CLI를 찾지 못했습니다.');
      const emit = event => {
        if (conversations.get(id) === session) window?.webContents.send('chat-event', id, event);
      };
      if (provider === 'claude') {
        if (!/\.exe$/i.test(installed.file)) throw new Error('채팅 연동에는 Claude Code 네이티브 Windows 설치가 필요합니다.');
        const historyFile = claudeHistory.historyPath(path.join(app.getPath('userData'), 'claude-history'), id);
        const history = await claudeHistory.syncHistory(historyFile, cwd);
        const loggedIn = await claudeAuthStatus(installed.file, cwd).catch(() => null);
        if (!conversations.has(id)) throw new Error('The task was closed.');
        session = new ClaudeSession(installed.file, cwd, historyFile, history, emit);
        session.loggedIn = loggedIn;
        conversations.set(id, session);
        const catalog = loggedIn === true ? await ClaudeSession.probeModels(installed.file, cwd).catch(() => null) : null;
        if (conversations.get(id) !== session) throw new Error('The task was closed.');
        return { threadId: session.threadId, turns: [history], loggedIn, catalog };
      }
      codexExecutable ??= installed.file;
      if (!conversations.has(id)) throw new Error('The task was closed.');
      // 공용 서버에 이 작업의 채널을 연다. 서버가 이미 떠 있으면 thread만 열면 된다.
      session = await codexHost.open(id, emit);
      if (!conversations.has(id)) throw new Error('The task was closed.');
      conversations.set(id, session);
      const result = threadId
        ? await session.request('thread/resume', { threadId, cwd, excludeTurns: true })
        : await session.request('thread/start', { cwd });
      session.bind(result.thread.id, cwd);
      const turns = threadId
        ? (await session.request('thread/turns/list', { threadId: session.threadId, limit: 30, sortDirection: 'desc', itemsView: 'full' })).data.reverse()
        : [];
      // The picker lists what this Codex account can use; a failure only hides the picker.
      const models = await session.request('model/list', {}).then(page => page.data.filter(model => !model.hidden).map(model => ({
        id: model.model, name: model.displayName || model.model, isDefault: model.isDefault,
        efforts: model.supportedReasoningEfforts.map(option => option.reasoningEffort), defaultEffort: model.defaultReasoningEffort
      })), () => []);
      return { threadId: session.threadId, model: result.model, effort: result.reasoningEffort, models, turns };
    } catch (error) {
      conversations.delete(id);
      session?.close();
      throw error;
    }
  });
  handle('attachment-save', (bytes, mime) => attachments.saveAttachment(attachmentDirectory(), bytes, mime));
  handle('chat-send', async (id, text, clientUserMessageId, options = {}) => {
    const pick = value => typeof value === 'string' && /^[\w.:\-\[\]]{1,80}$/.test(value) ? value : undefined;
    const model = pick(options?.model);
    const effort = pick(options?.effort);
    const session = connected(id);
    if (session.turnId || session.sending) throw new Error('A turn is already active.');
    const images = attachments.checkedImages(attachmentDirectory(), options?.images);
    if (session instanceof ClaudeSession) {
      if (session.loggedIn === false) throw new Error('Claude Code에 먼저 로그인하세요.');
      return session.send(text, clientUserMessageId, { model, effort, images });
    }
    session.sending = true;
    try {
      const { turn } = await session.request('turn/start', {
        threadId: session.threadId, clientUserMessageId,
        input: [{ type: 'text', text, text_elements: [] }, ...images.map(image => ({ type: 'localImage', path: image.path }))],
        ...(model ? { model } : {}), ...(effort ? { effort } : {})
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
    return session?.close();
  });
  handle('source-file', (cwd, name, fromRoot) => changes.sourceFile(cwd, name, fromRoot));
  handle('files-list', (root, relative) => files.listDirectory(root, relative));
  handle('github-review-target', cwd => changes.reviewTarget(cwd));
  handle('github-review-publish', (cwd, number, notes) => {
    if (!Array.isArray(notes) || !notes.length || notes.length > 200) throw new Error('올릴 리뷰 노트가 없습니다.');
    return changes.reviewTarget(cwd).then(target => {
      if (target.number !== number) throw new Error('PR이 바뀌었습니다. 다시 시도하세요.');
      return changes.publishReview(cwd, number, reviewNotes.pullReviewPayload(notes, target.headRefOid), reviewNotes.pullReviewSummary(notes));
    });
  });
  handle('files-search', (root, query, options) => files.searchText(root, query, options));
  handle('files-read', (root, relative) => files.readText(root, relative));
  handle('editors-list', () => editors.findEditors().map(({ id, name }) => ({ id, name })));
  // 파일을 외부 편집기의 그 줄로 연다. gitRoot면 root를 Git 루트로 바꿔 diff 경로(루트 기준)를 해석한다. 편집기가 없으면 기본 앱으로 연다.
  handle('editor-open', async (editorId, root, relative, line, gitRoot) => {
    let base = root;
    if (gitRoot === true) base = (await changes.repositoryPaths(root))?.root ?? root;
    const file = await files.resolveFile(base, relative);
    const found = editors.findEditors();
    const editor = found.find(item => item.id === editorId) ?? found[0];
    if (!editor) { const failure = await shell.openPath(file); if (failure) throw new Error(failure); return { editor: null }; }
    editors.openInEditor(editor, file, Number.isSafeInteger(line) ? line : undefined);
    return { editor: editor.name };
  });
  handle('tree-report', (cwd, base, patch) => changes.treeReport(cwd, base, patch));
  handle('verify-profile', (cwd, command, expected) => changes.verifyProfile(shellExe, cwd, command, expected));
  handle('git-status', (cwd, selected) => changes.status(cwd, selected));
  handle('git-watch', cwd => gitWatcher.watch(cwd));
  handle('git-list-files', cwd => changes.listFiles(cwd));
  // 같은 Codex 대화를 터미널 TUI로 넘기기 전에, 공용 서버가 그 작업 폴더의 thread를 놓게 한다.
  handle('codex-release-folder', cwd => typeof cwd === 'string' && path.isAbsolute(cwd) ? codexHost.releaseFolder(cwd) : 'none');
  // 첫 실행 안내: 에이전트 CLI 설치, Claude 로그인, GitHub CLI 로그인 상태. 확인 결과는 1분 동안 다시 쓴다.
  let onboardingCache = null;
  handle('onboarding-status', async refresh => {
    if (onboardingCache && !refresh && Date.now() - onboardingCache.at < 60000) return onboardingCache.value;
    const home = app.getPath('home');
    const [codex, claude] = await Promise.all(['codex', 'claude'].map(tool => probe(shellExe, tool, home, undefined, { refresh: refresh === true }).catch(() => null)));
    const claudeLogin = claude ? await claudeAuthStatus(claude.file, home).catch(() => null) : null;
    const github = await new Promise(resolve => {
      require('node:child_process').execFile('gh', ['auth', 'status', '--hostname', 'github.com'], { windowsHide: true, timeout: 15000 },
        (error, stdout, stderr) => resolve(error?.code === 'ENOENT' ? { installed: false, loggedIn: false }
          : { installed: true, loggedIn: !error, user: /account\s+(\S+)/.exec(stdout + stderr)?.[1] ?? null }));
    });
    const value = {
      codex: codex ? { installed: true, version: codex.version } : { installed: false },
      claude: claude ? { installed: true, version: claude.version, loggedIn: claudeLogin } : { installed: false },
      github
    };
    onboardingCache = { at: Date.now(), value };
    return value;
  });
  handle('checkpoint-create', (cwd, taskId, label) => checkpoints.createCheckpoint(cwd, taskId, typeof label === 'string' ? label : ''));
  handle('checkpoint-restore', (cwd, taskId, ref) => checkpoints.restoreCheckpoint(cwd, taskId, ref));
  handle('checkpoint-clear', (cwd, taskId) => checkpoints.clearCheckpoints(cwd, taskId));
  handle('git-diff', (cwd, name, kind) => changes.diff(cwd, name, kind));
  handle('github-pulls', (...args) => changes.pullRequests(...args));
  handle('github-pr-details', (...args) => changes.pullDetails(...args));
  handle('git-commit-details', (...args) => changes.commitDetails(...args));
  handle('git-worktrees', cwd => changes.worktrees(cwd));
  handle('git-create-worktree', (...args) => changes.createWorktree(...args));
  handle('state-write', values => state.write(stateFile(), values));
  handle('notify', notification => notify(notification));
  handle('github-pr-feedback', cwd => changes.pullRequestFeedback(cwd));
  handle('github-check-log', (cwd, detailsUrl) => changes.failedCheckLog(cwd, detailsUrl));
  handle('git-stage', (cwd, names) => changes.stage(cwd, names));
  handle('git-unstage', (cwd, names) => changes.unstage(cwd, names));
  handle('git-stage-all', cwd => changes.stageAll(cwd));
  handle('git-commit', (cwd, message) => changes.commit(cwd, message));
  handle('git-push', cwd => changes.push(cwd));
  handle('github-pr-draft', cwd => changes.pullRequestDraft(cwd));
  handle('github-pr-create', (cwd, request) => changes.createPullRequest(cwd, request));
  handle('ai-pr-draft', async (cwd, provider, base) => {
    if (!['codex', 'claude'].includes(provider)) throw new Error('알 수 없는 에이전트입니다.');
    const context = await changes.pullRequestContext(cwd, base);
    if (generatingMessages.has(context.root)) throw new Error('이미 AI 글을 만드는 중입니다.');
    generatingMessages.add(context.root);
    try {
      const installed = await findAgent(provider, context.root);
      if (!installed) throw new Error(provider === 'claude' ? 'Claude Code CLI를 찾지 못했습니다.' : 'Codex CLI를 찾지 못했습니다.');
      const options = { provider, context, prompt: commitMessage.buildPullRequestPrompt(context), finish: commitMessage.parsePullRequestDraft };
      if (provider === 'claude') {
        if (!/\.exe$/i.test(installed.file)) throw new Error('Claude Code 네이티브 Windows 설치가 필요합니다.');
        return await commitMessage.generate({ ...options, file: installed.file });
      }
      const [command, args] = await codexCommand(installed.file);
      return await commitMessage.generate({ ...options, command, args });
    } catch (error) {
      if (error.code === 'ENOENT') agentCache.delete(provider);
      if (/not logged in|login|auth/i.test(error.stderr ?? '')) throw new Error((provider === 'claude' ? 'Claude Code' : 'Codex') + '에 먼저 로그인하세요.');
      throw error;
    } finally { generatingMessages.delete(context.root); }
  });
  handle('ai-commit-message', async (cwd, provider) => {
    if (!['codex', 'claude'].includes(provider)) throw new Error('알 수 없는 에이전트입니다.');
    const context = await changes.commitContext(cwd);
    if (generatingMessages.has(context.root)) throw new Error('이미 커밋 메시지를 만드는 중입니다.');
    generatingMessages.add(context.root);
    try {
      const installed = await findAgent(provider, context.root);
      if (!installed) throw new Error(provider === 'claude' ? 'Claude Code CLI를 찾지 못했습니다.' : 'Codex CLI를 찾지 못했습니다.');
      if (provider === 'claude') {
        if (!/\.exe$/i.test(installed.file)) throw new Error('Claude Code 네이티브 Windows 설치가 필요합니다.');
        return await commitMessage.generate({ provider, file: installed.file, context });
      }
      const [command, args] = await codexCommand(installed.file);
      return await commitMessage.generate({ provider, command, args, context });
    } catch (error) {
      if (error.code === 'ENOENT') agentCache.delete(provider);
      if (/not logged in|login|auth/i.test(error.stderr ?? '')) {
        throw new Error((provider === 'claude' ? 'Claude Code' : 'Codex') + '에 먼저 로그인하세요.');
      }
      const detail = error.stderr?.trim().split(/\r?\n/).at(-1);
      throw detail ? new Error(error.message + ': ' + detail.slice(0, 300)) : error;
    } finally { generatingMessages.delete(context.root); }
  });
  handle('task-worktree-create', (cwd, name, id, start) => changes.createTaskWorktree(cwd, name, id, start));
  handle('task-worktree-remove', async (id, directory, branch, force, base) => {
    const session = conversations.get(id);
    if (session?.turnId || session?.sending || session?.approvals?.size) throw new Error('진행 중인 요청을 먼저 종료하세요.');
    if (conversations.has(id)) {
      conversations.delete(id);
      const child = session?.child;
      const exited = child && child.exitCode === null && child.signalCode === null
        ? new Promise(resolve => { child.once('exit', resolve); setTimeout(resolve, 3000); }) : null;
      await session?.close();
      await exited;
    }
    // 공용 Codex 서버에 이 폴더의 thread가 남아 있으면 서버를 다시 시작해 폴더 잠금을 푼다.
    if (typeof directory === 'string') await codexHost.releaseFolder(directory);

    return changes.removeWorktree(directory, branch, force, base);
  });
  handle('open-local-preview', address => {
    const url = new URL(address);
    if (!['http:', 'https:'].includes(url.protocol) || !['localhost', '127.0.0.1'].includes(url.hostname) ||
        url.username || url.password) throw new Error('로컬 서버 주소를 입력하세요.');
    return shell.openExternal(url.href);
  });
  // 채팅 마크다운의 링크: http·https만, 자격 증명이 든 주소는 열지 않는다.
  handle('open-link', address => {
    const url = new URL(address);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new Error('http·https 링크만 열 수 있습니다.');
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
    if (!['shell', 'codex', 'claude', 'agy', 'claude-login'].includes(launcher)) throw new Error('Unknown terminal launcher.');
    const login = launcher === 'claude-login';
    // 실행 정책이 Restricted/AllSigned여도 앱 스크립트(prompt.ps1)가 막히지 않게 이 프로세스에만 Bypass를 준다.
    // 그룹 정책(MachinePolicy/UserPolicy)으로 정한 정책은 이 옵션보다 우선한다.
    const args = ['-NoLogo', '-ExecutionPolicy', 'Bypass'];
    if (resumeId === undefined && !login) args.push('-NoExit');
    args.push('-File', script('prompt.ps1'));
    if (launcher !== 'shell') args.push('-WorkbenchStartup', login ? 'claude' : launcher);
    if (login) {
      const installed = await probe(shellExe, 'claude', cwd);
      if (!installed) throw new Error('Claude Code CLI를 찾지 못했습니다.');
      args.push('-WorkbenchExecutable', installed.file, '-WorkbenchLogin');
    }
    if (launcher !== 'shell' && !login && executable) args.push('-WorkbenchExecutable', executable);
    if (launcher !== 'shell' && !login && agentHooks) args.push('-WorkbenchHookSettings', agentHooks.settingsFile);
    if (resumeId !== undefined) {
      if (launcher === 'claude' && resumeId?.taskId) {
        const file = claudeHistory.historyPath(path.join(app.getPath('userData'), 'claude-history'), resumeId.taskId);
        const launch = await claudeHistory.prepareTerminal(file, cwd);
        resumeId = launch.sessionId;
        if (!launch.resume) args.push('-WorkbenchNewSession');
      }
      if (!['codex', 'claude'].includes(launcher) || typeof resumeId !== 'string' ||
          !/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(resumeId)) {
        throw new Error('유효한 에이전트 대화 ID가 필요합니다.');
      }
      args.push('-WorkbenchResumeId', resumeId);
    }
    const term = 'xterm-256color';
    const env = { ...process.env, TERM: term, COLORTERM: 'truecolor',
      ...(launcher !== 'shell' && !login && agentHooks ? agentHooks.env(id) : {}) };
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
  // 창 닫기 → 트레이로 숨김(설정이 켜져 있을 때). 처음 한 번은 알림으로 알려 준다.
  // Windows 종료·로그오프·다시 시작 때는 창 닫기를 막지 않는다(막으면 "종료를 막는 앱"이 된다).
  window.on('query-session-end', () => { quitting = true; });
  window.on('session-end', () => { quitting = true; });
  powerMonitor.on('shutdown', () => { quitting = true; });
  window.on('close', event => {
    if (quitting || !closeToTray || !tray) return;
    event.preventDefault();
    window.hide();
    if (!trayHintShown && Notification.isSupported()) {
      trayHintShown = true;
      new Notification({ title: 'Hermit은 계속 실행 중입니다', body: '트레이 아이콘에서 다시 열거나 종료할 수 있습니다. 설정에서 바꿀 수 있습니다.' }).show();
    }
  });
  handle('tray-state', state => {
    const count = value => Number.isInteger(value) && value >= 0 && value < 1000 ? value : 0;
    trayState = { working: count(state?.working), waiting: count(state?.waiting) };
    updateTray();
  });
  handle('close-to-tray', enabled => { closeToTray = enabled === true; });
  handle('auto-update', enabled => { autoUpdate = enabled === true; if (autoUpdate) startAutoUpdate(); return app.isPackaged; });
  handle('update-install', () => installUpdateNow());
  window.on('closed', () => {
    window = null;
    gitWatcher.stop();
    updateSleepBlocker();
    for (const id of sessions.keys()) close(id);
    for (const session of conversations.values()) session?.close();
    codexHost.shutdown();
    conversations.clear();
  });
  // 도메인별 IPC(main/ipc/*.cjs). 새 기능은 main.cjs 대신 여기에 파일을 더한다.
  require('./main/ipc/index.cjs').registerAll({
    handle, app, shell, dialog, shellExe, changes, files, probe,
    getWindow: () => window,
    send: (channel, ...args) => window?.webContents.send(channel, ...args)
  });
  window.loadFile('index.html');
});

app.on('window-all-closed', () => app.quit());
app.on('quit', () => { tray?.destroy(); tray = null; clearInterval(updateTimer); });
