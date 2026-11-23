
const taskKey = 'agent-workbench-tasks-v1';
const taskWorktreeKey = 'agent-task-worktree';
let tasks;
try { tasks = JSON.parse(localStorage.getItem(taskKey) ?? '[]'); } catch { tasks = []; }
const runtimes = new Map();
const taskStatusLabels = new Map();
const openTasksKey = 'agent-open-tasks';
let openTasks;
try { openTasks = new Set(JSON.parse(localStorage.getItem(openTasksKey) ?? '[]')); }
catch { openTasks = new Set(); }
const closedTasksKey = 'agent-closed-tasks';
let closedTasks;
try { closedTasks = new Set(JSON.parse(localStorage.getItem(closedTasksKey) ?? '[]')); }
catch { closedTasks = new Set(); }
const foldedProjects = new Set();
const projectFoldersKey = 'agent-project-folders';
let projectFolders;
try { projectFolders = new Set(JSON.parse(localStorage.getItem(projectFoldersKey) ?? '[]')); }
catch { projectFolders = new Set(); }
let selectedTask = null;
let latestTaskId;
let priorTaskId;

function rememberTaskFocus(task) {
  if (!task || latestTaskId === task.id) return;
  priorTaskId = latestTaskId;
  latestTaskId = task.id;
}
let chosenFolder;
let pendingPanel;
const chatTemplate = byId('conversation').cloneNode(true);
let chosenPatch;
let gitEpoch = 0;
let gitReviewCwd;
let githubEpoch = 0;
let gitBusyFor;
let lastSnapshot;
let renderFrame;
let claudeLoginPane;
let claudeLoginTask;
let claudeLoginOpening = false;

function persist() {
  localStorage.setItem(taskKey, JSON.stringify(tasks));
  if (selectedTask) localStorage.setItem('agent-last-task', selectedTask.id);
}

function runtime(task) {
  if (!runtimes.has(task.id)) runtimes.set(task.id, {
    status: '연결 준비 중', items: new Map(), approvals: new Map(), draft: ''
  });
  return runtimes.get(task.id);
}

function agentName(task) {
  return task?.provider === 'claude' ? 'Claude Code' : 'Codex';
}

function setDrawer(show) {
  byId('terminal-drawer').hidden = !show;
  showTerminalDock(show);
  document.body.classList.toggle('terminal-visible', show);
  if (!show) {
    document.body.classList.remove('terminal-maximized');
    byId('expand-terminal').setAttribute('aria-pressed', 'false');
  }
  byId('toggle-terminal').setAttribute('aria-expanded', String(show));
  scheduleFit();
}

function setReview(mode) {
  byId('results-panel').dataset.review = mode;
  byId('review-title').textContent = { changes: '변경사항', results: '터미널 결과', planner: '플래너', github: 'GitHub', agents: '에이전트 현황' }[mode] ?? '';
  byId('review-changes').setAttribute('aria-pressed', String(mode === 'changes'));
  byId('review-results').setAttribute('aria-pressed', String(mode === 'results'));
  byId('review-planner').setAttribute('aria-pressed', String(mode === 'planner'));
  byId('review-github').setAttribute('aria-pressed', String(mode === 'github'));
  byId('review-agents').setAttribute('aria-pressed', String(mode === 'agents'));
  if (mode === 'changes') refreshGit();
  else document.body.classList.remove('diff-wide');
  if (mode === 'github') refreshGitHub();
  if (mode === 'agents') refreshAgentsView();
}

function openReview(mode) {
  if (byId('results-panel').dataset.collapsed === 'true') byId('toggle-results-panel').click();
  setReview(mode);
}

// 트레이 툴팁·메뉴에 보여 줄 작업 수(작업 중·승인/입력 대기). 상태가 바뀔 때 잠깐 모아서 보낸다.
let trayTimer = 0;
let lastTray = '';
function scheduleTrayState() {
  if (trayTimer) return;
  trayTimer = setTimeout(() => {
    trayTimer = 0;
    const states = tasks.map(task => runtimes.has(task.id) ? taskState(runtime(task)) : 'idle');
    const value = { working: states.filter(state => state === 'working').length, waiting: states.filter(state => state === 'waiting').length };
    const key = JSON.stringify(value);
    if (key !== lastTray) { lastTray = key; api.setTrayState(value).catch(() => {}); }
  }, 300);
}

function updateTaskStatus(task) {
  scheduleTrayState();
  const state = runtime(task);
  const badge = taskStatusLabels.get(task.id);
  const label = taskStatus(state);
  const kind = taskState(state);
  if (badge) {
    badge.textContent = label;
    badge.hidden = !label;
    badge.dataset.attention = String(!!state.approvals.size);
    badge.dataset.state = kind;
  }
  const tab = byId('workbench-tabs').querySelector('[data-task-id="' + CSS.escape(task.id) + '"]');
  if (tab) {
    tab.dataset.status = label;
    tab.querySelector('.state-glyph')?.replaceWith(stateGlyph(kind));
  }
  const row = byId('task-list').querySelector('[data-task-row="' + CSS.escape(task.id) + '"] .state-glyph');
  row?.replaceWith(stateGlyph(kind));
  if (byId('results-panel').dataset.review === 'agents') scheduleAgentsView();
}

// One glyph vocabulary everywhere (Orca's state indicators): working, waiting on you, done, failed.
function taskState(state) {
  if (state.authRequired || state.approvals.size || state.tuiState === 'waiting') return 'waiting';
  if (state.busy || state.connecting || state.tuiState === 'working') return 'working';
  if (state.terminalMode && state.tuiState === 'done') return 'done';
  if (state.outcome === '실패' || state.outcome === '중단됨') return 'failed';
  if (state.outcome === '완료') return 'done';
  return 'idle';
}
const stateTitles = { working: '작업 중', waiting: '입력·승인 대기', done: '완료', failed: '실패·중단', idle: '' };

// Orca's state indicators in a fixed 12px box: a spinner while working, a question mark when the agent
// needs you, and a 6px dot for done/failed. CSS draws the spinner and dots; only "waiting" needs an icon.
function stateGlyph(kind) {
  const glyph = document.createElement('span');
  glyph.className = 'state-glyph';
  glyph.dataset.state = kind;
  if (kind === 'waiting') setPanelIcon(glyph, 'question');
  glyph.title = stateTitles[kind];
  glyph.setAttribute('aria-label', stateTitles[kind]);
  glyph.hidden = kind === 'idle';
  return glyph;
}

// Agent brand mark (Claude starburst, OpenAI knot for Codex) on tabs, cards, chat and status bar.
function agentMark(provider) {
  const mark = document.createElement('span');
  mark.className = 'agent-mark';
  mark.dataset.provider = provider === 'claude' ? 'claude' : 'codex';
  mark.setAttribute('aria-hidden', 'true');
  setPanelIcon(mark, mark.dataset.provider === 'claude' ? 'claude-logo' : 'openai-logo');
  return mark;
}

// Compact age like Orca's sidebar: now, 5m, 3h, 2d, 6w. Empty when unknown (tasks made before this field existed).
function timeAgo(time) {
  if (!Number.isFinite(time)) return '';
  const minutes = Math.max(0, Math.floor((Date.now() - time) / 60000));
  if (minutes < 1) return '방금';
  if (minutes < 60) return minutes + 'm';
  if (minutes < 60 * 24) return Math.floor(minutes / 60) + 'h';
  if (minutes < 60 * 24 * 14) return Math.floor(minutes / 1440) + 'd';
  return Math.floor(minutes / 10080) + 'w';
}

function taskStatus(state) {
  if (state.terminalMode && state.tuiState) return { working: '터미널에서 작업 중', waiting: '터미널에서 입력 대기', done: '터미널 작업 완료' }[state.tuiState];
  return state.authRequired ? '로그인 필요' : state.approvals.size ? '승인 대기'
    : state.connecting ? '연결 중'
    : state.busy ? '실행 중'
    : state.outcome ?? (state.connected ? '대기' : '');
}

let agentsFrame;
function scheduleAgentsView() {
  if (!agentsFrame) agentsFrame = requestAnimationFrame(() => {
    agentsFrame = 0;
    refreshAgentsView();
  });
}

function refreshAgentsView() {
  const view = byId('agents-view');
  const live = tasks.filter(task => openTasks.has(task.id) || runtime(task).busy);
  const priority = status => ['승인 대기', '로그인 필요', '실패'].includes(status) ? 0 : status === '실행 중' ? 1 : 2;
  live.sort((first, second) => priority(taskStatus(runtime(first))) - priority(taskStatus(runtime(second))));
  const previousFocus = document.activeElement?.dataset.agentJump;
  const existing = new Map([...view.children].map(row => [row.dataset.agentJump, row]));
  for (const task of live) {
    const state = runtime(task);
    const label = taskStatus(state) || '대기';
    const row = existing.get(task.id) ?? button('', () => chooseTask(task));
    row.dataset.agentJump = task.id;
    row.dataset.status = label;
    row.className = 'agent-card';
    row.setAttribute('aria-current', String(task === selectedTask));
    const name = document.createElement('strong');
    name.textContent = task.name;
    const meta = document.createElement('small');
    meta.textContent = [agentName(task), label].join(' · ');
    row.replaceChildren(name, meta);
    view.append(row);
    existing.delete(task.id);
  }
  for (const row of existing.values()) row.remove();
  if (!live.length) view.textContent = '열린 에이전트 작업이 없습니다.';
  else for (const node of [...view.childNodes]) if (node.nodeType === Node.TEXT_NODE) node.remove();
  if (previousFocus) view.querySelector('[data-agent-jump="' + CSS.escape(previousFocus) + '"]')?.focus({ preventScroll: true });
}

function tasksSidebar() {
  const list = byId('task-list');
  list.replaceChildren();
  taskStatusLabels.clear();
  const projects = new Map([...projectFolders].map(folder => [folder, []]));
  const query = byId('project-search').value.trim().toLowerCase();
  for (const task of tasks) {
    const project = task.worktree?.root ?? task.cwd;
    if (!projects.has(project)) projects.set(project, []);
    projects.get(project).push(task);
  }
  for (const [folder, entries] of projects) {
    const matching = entries.filter(task => (folder + ' ' + task.name + ' ' + agentName(task) + ' ' + (task.worktree?.branch ?? '')).toLowerCase().includes(query));
    if (!matching.length && !folder.toLowerCase().includes(query)) continue;
    const group = document.createElement('section');
    group.className = 'group project-group';
    const header = document.createElement('div');
    header.className = 'project-heading';
    const folded = !query && foldedProjects.has(folder);
    const name = button('', () => {
      if (foldedProjects.has(folder)) foldedProjects.delete(folder);
      else foldedProjects.add(folder);
      tasksSidebar();
    });
    const chevron = document.createElement('span');
    chevron.className = 'project-chevron';
    setPanelIcon(chevron, 'chevron');
    const projectName = document.createElement('span');
    projectName.className = 'project-name';
    projectName.textContent = folder.split(/[\\/]/).filter(Boolean).at(-1) ?? folder;
    const tile = document.createElement('span');
    tile.className = 'project-avatar';
    tile.textContent = [...projectName.textContent][0]?.toUpperCase() ?? '?';
    tile.ariaHidden = 'true';
    name.append(chevron, tile, projectName);
    name.title = folder;
    name.setAttribute('aria-expanded', String(!folded));
    const add = button('', () => newShellTab(folder));
    add.className = 'icon-button';
    setPanelIcon(add, 'plus');
    add.title = add.ariaLabel = '이 폴더에 PowerShell 열기';
    header.append(name, add);
    group.append(header);
    const closed = document.createElement('details');
    closed.className = 'closed-project-tasks';
    for (const task of folded ? [] : matching) {
      const item = button('', () => chooseTask(task));
      item.className = 'tab task-tab';
      item.title = agentName(task) + ' · ' + (task.worktree ? task.worktree.branch + ' · ' : '') + task.cwd;
      item.setAttribute('aria-current', String(task === selectedTask));
      // Two-line card (Orca): agent, name and age on top; branch (or folder) and live state below.
      const title = document.createElement('span');
      title.className = 'task-tab-name';
      title.textContent = task.name;
      const age = document.createElement('span');
      age.className = 'task-tab-age';
      age.textContent = timeAgo(task.activeAt ?? task.createdAt);
      const top = document.createElement('span');
      top.className = 'task-tab-line';
      top.append(agentMark(task.provider), title, age);
      const whereIcon = document.createElement('span');
      setPanelIcon(whereIcon, task.worktree ? 'branch' : 'home');
      const where = document.createElement('span');
      where.className = 'task-tab-where';
      // The project row already names the folder; a task without a worktree works in the main checkout.
      where.textContent = task.worktree?.branch ?? '기본 체크아웃';
      const badge = document.createElement('span');
      badge.className = 'task-tab-status';
      const meta = document.createElement('span');
      meta.className = 'task-tab-meta';
      meta.append(whereIcon, where, stateGlyph(taskState(runtime(task))), badge);
      item.append(top, meta);
      taskStatusLabels.set(task.id, badge);
      updateTaskStatus(task);
      const row = document.createElement('div');
      row.className = 'project-task-row';
      row.dataset.taskRow = task.id;
      row.append(item);
      if (closedTasks.has(task.id)) {
        item.title = task.name + ' 다시 열기';
        closed.append(row);
      } else {
        const close = button('', () => requestCloseTask(task));
        close.className = 'icon-button task-close';
        close.title = close.ariaLabel = task.name + ' 닫기';
        setPanelIcon(close, 'close');
        row.append(close);
        group.append(row);
      }
    }
    if (closed.childElementCount) {
      const summary = document.createElement('summary');
      summary.textContent = `닫은 작업 (${closed.childElementCount})`;
      closed.prepend(summary);
      closed.open = !!query;
      group.append(closed);
    }
    list.append(group);
  }
}

function renderWorkTabs() {
  const strip = byId('workbench-tabs');
  strip.replaceChildren();
  for (const id of openTasks) {
    const task = tasks.find(entry => entry.id === id);
    if (!task) continue;
    const tab = document.createElement('div');
    tab.className = 'work-tab';
    tab.dataset.active = String(task === selectedTask && !primaryChatPanel.workArea.current);
    tab.dataset.provider = task.provider ?? 'codex';
    tab.dataset.taskId = task.id;
    tab.dataset.status = taskStatus(runtime(task));
    const select = button('', () => chooseTask(task));
    select.title = agentName(task) + ' · ' + task.name;
    select.setAttribute('aria-current', tab.dataset.active);
    const label = document.createElement('span');
    label.className = 'work-tab-label';
    label.textContent = task.name;
    select.append(agentMark(task.provider), label, stateGlyph(taskState(runtime(task))));
    registerTaskTabSplit(select, task);
    const close = button('', () => requestCloseTask(task));
    close.ariaLabel = task.name + ' 탭 닫기';
    setPanelIcon(close, 'close');
    tab.append(select, close);
    strip.append(tab);
  }
  appendWorkAreaTabs(strip, primaryChatPanel.workArea);
  revealActiveWorkTab(strip);
  localStorage.setItem(openTasksKey, JSON.stringify([...openTasks]));
}

// Split two task chats side by side: drag a task tab onto the chat area (drop on an edge), or
// right-click it. The task in front stays; the dragged one opens in a split panel.
function registerTaskTabSplit(element, task) {
  let dragged = false;
  let guide = null;
  const findDrop = event => {
    const target = document.elementFromPoint(event.clientX, event.clientY)?.closest('.workspace-panel');
    if (!target || !panelTree.contains(target) || target.chatTask === task) return null;
    if (task === selectedTask && target === primaryChatPanel) return null;
    return { target, direction: dropEdge(target, event) };
  };
  element.addEventListener('pointerdown', event => {
    dragged = false;
    if (event.button !== 0 || !event.isPrimary) return;
    trackPointer(event, next => {
      if (!dragged && Math.hypot(next.clientX - event.clientX, next.clientY - event.clientY) < 8) return;
      dragged = true;
      if (guide) delete guide.dataset.dropEdge;
      const drop = findDrop(next);
      guide = drop?.target ?? null;
      if (guide) guide.dataset.dropEdge = drop.direction;
    }, next => {
      if (guide) delete guide.dataset.dropEdge;
      guide = null;
      if (!dragged || !next) return;
      const drop = findDrop(next);
      if (drop) openSplitChat(task, drop.target, drop.direction);
    });
  });
  element.addEventListener('click', event => {
    if (dragged && event.detail) event.stopImmediatePropagation();
    dragged = false;
  }, true);
  element.addEventListener('contextmenu', event => {
    event.preventDefault();
    if (task === selectedTask || splitChats.has(task.id)) return;
    if (panelMenu.matches(':popover-open')) panelMenu.hidePopover();
    panelMenu.replaceChildren();
    for (const [direction, label] of [['right', '오른쪽에 분할로 열기'], ['down', '아래에 분할로 열기']]) {
      panelMenu.append(button(label, () => { panelMenu.hidePopover(); openSplitChat(task, primaryChatPanel, direction); }));
    }
    panelMenu.style.left = Math.max(4, Math.min(event.clientX, innerWidth - 278)) + 'px';
    panelMenu.style.top = Math.min(event.clientY + 4, innerHeight - 100) + 'px';
    panelMenu.showPopover();
    panelMenu.querySelector('button')?.focus();
  });
}

function appendWorkAreaTabs(strip, area) {
  for (const item of area.tabs) {
    if (!tabVisible(item)) continue;
    const tab = document.createElement('div');
    tab.className = 'work-tab work-content-tab';
    tab.dataset.active = String(item === area.current);
    const select = button('', () => activateWorkAreaTab(item));
    select.title = (item.panes ? item.activePane?.cwd ?? item.name : item.name) + ' · 끌어서 분할';
    select.setAttribute('aria-current', tab.dataset.active);
    const icon = document.createElement('span');
    setPanelIcon(icon, item.icon ?? 'terminal');
    const label = document.createElement('span');
    label.textContent = item.name;
    select.append(icon, label);
    select.ondblclick = () => {
      if (item.panes) { selectTab(item, false); byId('rename').click(); }
    };
    registerWorkAreaDrag(select, item);
    const close = button('', () => item.panes ? closeTab(item) : closeDocumentTab(item));
    close.ariaLabel = item.name + ' 탭 닫기';
    setPanelIcon(close, 'close');
    tab.append(select, close);
    strip.append(tab);
  }
}

function chooseTask(task) {
  if (closedTasks.delete(task.id)) localStorage.setItem(closedTasksKey, JSON.stringify([...closedTasks]));
  if (splitChats.has(task.id)) {
    const panel = splitChats.get(task.id);
    focusWorkspacePanel(panel);
    panel.getChatPart('chat-input').focus();
    return;
  }
  if (selectedTask) runtime(selectedTask).draft = byId('chat-input').value;
  selectedTask = task;
  rememberTaskFocus(task);
  showWorkAreaTab(null, primaryChatPanel.workArea);
  focusWorkspacePanel(primaryChatPanel);
  openTasks.add(task.id);
  byId('chat-input').value = runtime(task).draft;
  byId('chat-input').placeholder = agentName(task) + '에 작업을 요청하세요';
  byId('chat-input').setAttribute('aria-label', agentName(task) + '에 보낼 요청');
  renderPlanner();
  byId('task-title').textContent = task.name;
  byId('main-panel-label').textContent = task.name;
  byId('main-panel-label').title = agentName(task) + ' · ' + task.name + ' · 두 번 클릭해 이름 변경';
  byId('main-panel-folder').textContent = byId('task-folder').textContent = task.cwd;
  byId('main-panel-folder').title = byId('task-folder').title = task.cwd;
  byId('main-chat-panel').dataset.provider = task.provider;
  document.body.classList.add('task-visible');
  byId('composer').hidden = false;
  byId('chat-feed').replaceChildren();
  const sessionPane = runtime(task).terminalPane;
  if (sessionPane && panes.has(sessionPane.id)) {
    setDrawer(true);
    selectTab(sessionPane.tab, false);
    selectPane(sessionPane);
  }
  updateExportButtons();
  tasksSidebar();
  renderWorkTabs();
  persist();
  resetGit();
  // 작업을 열면 바로 연결한다. Codex는 앱 전체가 서버 하나를 같이 써서 thread만 열면 되고,
  // Claude는 저장된 기록과 로그인 상태를 바로 보여 준다. 사용자가 직접 끊은 작업은 다시 붙이지 않는다.
  const opened = runtime(task);
  if (!opened.connected && !opened.connecting && !opened.terminalMode && !opened.manualDisconnect) connectTask(task);
  applyTaskLayout();
  renderChat();
}

// Model and reasoning-effort pickers. Codex lists its models over the App Server (model/list);
// the Claude Code CLI takes model aliases and --effort levels. '' means "the agent's default".
const claudeEfforts = ['low', 'medium', 'high', 'xhigh', 'max'];
const claudeModels = ['fable', 'opus', 'sonnet', 'haiku'].map(id => ({
  id, name: id[0].toUpperCase() + id.slice(1), efforts: claudeEfforts
}));
const effortLabels = { none: '없음', minimal: '최소', low: '낮음', medium: '보통', high: '높음', xhigh: '매우 높음', max: '최대' };

function fillPicker(select, options, value) {
  const key = JSON.stringify(options);
  if (select.dataset.key !== key) {
    select.dataset.key = key;
    select.replaceChildren(...options.map(([optionValue, label]) => new Option(label, optionValue)));
  }
  select.value = options.some(([optionValue]) => optionValue === value) ? value : '';
}

function renderModelPicker(task, get) {
  const state = runtime(task);
  const models = state.models ?? [];
  const modelSelect = get('chat-model');
  const effortSelect = get('chat-effort');
  modelSelect.hidden = effortSelect.hidden = !models.length;
  if (!models.length) return;
  const fallback = task.provider === 'claude' ? '기본 모델' : '기본 · ' + (models.find(model => model.id === state.model)?.name ?? state.model ?? '');
  fillPicker(modelSelect, [['', fallback], ...models.map(model => [model.id, model.name])], task.model ?? '');
  const chosen = models.find(model => model.id === (task.model || state.model)) ?? (task.provider === 'claude' ? { efforts: claudeEfforts } : null);
  const efforts = chosen?.efforts ?? [];
  const defaultEffort = task.model ? chosen?.defaultEffort : state.serverEffort ?? chosen?.defaultEffort;
  fillPicker(effortSelect, [['', '추론 기본' + (defaultEffort ? ' · ' + (effortLabels[defaultEffort] ?? defaultEffort) : '')],
    ...efforts.map(effort => [effort, '추론 ' + (effortLabels[effort] ?? effort)])], task.effort ?? '');
  effortSelect.hidden = !efforts.length;
  modelSelect.disabled = effortSelect.disabled = !!state.busy;
}

function bindModelPicker(currentTask, get) {
  get('chat-model').onchange = event => {
    const task = currentTask();
    if (!task) return;
    task.model = event.target.value || undefined;
    const models = runtime(task).models ?? [];
    const efforts = (models.find(model => model.id === task.model) ?? {}).efforts ?? (task.provider === 'claude' ? claudeEfforts : []);
    if (task.effort && !efforts.includes(task.effort)) task.effort = undefined;
    persist();
    scheduleChat();
  };
  get('chat-effort').onchange = event => {
    const task = currentTask();
    if (!task) return;
    task.effort = event.target.value || undefined;
    persist();
    scheduleChat();
  };
}
bindModelPicker(() => selectedTask, byId);

// 연결이 끊기면(에이전트 프로세스 종료·오류) 1·2·5·15초 간격으로 다시 붙인다. 네 번 실패하면 멈추고 버튼을 보여 준다.
const reconnectDelays = [1000, 2000, 5000, 15000];
function scheduleReconnect(task) {
  const state = runtime(task);
  clearTimeout(state.reconnectTimer);
  state.reconnectTimer = null;
  if (state.manualDisconnect || state.terminalMode || !tasks.includes(task) || !openTasks.has(task.id)) return;
  const attempt = state.reconnectAttempt ?? 0;
  if (attempt >= reconnectDelays.length) {
    state.status = '연결이 끊겼습니다. 다시 연결을 눌러 주세요.';
    updateTaskStatus(task);
    if (task === selectedTask || splitChats.has(task.id)) scheduleChat();
    return;
  }
  const delay = reconnectDelays[attempt];
  state.reconnectAttempt = attempt + 1;
  state.status = '연결이 끊겨 ' + Math.round(delay / 1000) + '초 뒤 다시 연결합니다…';
  updateTaskStatus(task);
  if (task === selectedTask || splitChats.has(task.id)) scheduleChat();
  state.reconnectTimer = setTimeout(async () => {
    state.reconnectTimer = null;
    if (state.connected || state.connecting || state.manualDisconnect || !tasks.includes(task)) return;
    await connectTask(task, { automatic: true });
    if (!state.connected) scheduleReconnect(task);
  }, delay);
}

async function connectTask(task, { automatic = false } = {}) {
  const state = runtime(task);
  if (state.connecting || state.connected || state.terminalMode) return;
  if (!automatic) {
    state.manualDisconnect = false;
    state.reconnectAttempt = 0;
    clearTimeout(state.reconnectTimer);
  state.reconnectTimer = null;
  }
  state.connecting = true;
  state.status = agentName(task) + ' 연결 중…';
  updateTaskStatus(task);
  if (task === selectedTask || splitChats.has(task.id)) renderChat();
  try {
    const result = await api.chatConnect({ id: task.id, cwd: task.cwd, threadId: task.threadId, provider: task.provider,
      executable: localStorage.getItem('agent-exe-' + (task.provider ?? 'codex')) ?? undefined });
    state.threadId = result.threadId;
    state.model = result.model;
    state.serverEffort = result.effort ?? null;
    state.models = task.provider === 'claude' ? claudeModels : (result.models ?? []);
    state.authRequired = result.loggedIn === false;
    state.items = new Map([...result.turns.flatMap(turn => turn.items ?? [])]
      .map(item => [item.id, item]));
    state.connected = true;
    state.reconnectAttempt = 0;
    setTimeout(() => flushQueue(task), 0);
    if (!state.busy) state.status = '준비됨';
    persist();
  } catch (error) {
    state.status = error.message;
  } finally {
    state.connecting = false;
    updateTaskStatus(task);
    if (task === selectedTask || splitChats.has(task.id)) renderChat();
  }
}

function itemText(item) {
  if (item.type === 'userMessage') return (item.content ?? []).map(value => value.text ?? '').join('\n');
  if (item.type === 'agentMessage') return item.text ?? '';
  if (item.type === 'commandExecution') return [item.command, item.aggregatedOutput].filter(Boolean).join('\n');
  if (item.type === 'fileChange') return (item.changes ?? []).map(value => value.path).join('\n');
  if (item.type === 'plan') return item.text ?? '';
  if (item.type === 'toolUse') {
    const input = item.input && Object.keys(item.input).length ? JSON.stringify(item.input, null, 2) : '';
    return [input && '입력\n' + input, item.output !== undefined && (item.isError ? '오류\n' : '결과\n') + (item.output || '(출력 없음)')]
      .filter(Boolean).join('\n\n') || '기록된 입력과 결과가 없습니다.';
  }
  return item.title ?? item.name ?? item.type;
}

// One readable line per tool step: what ran and on what, plus how it ended.
function toolTarget(input = {}) {
  const value = input.command ?? input.file_path ?? input.path ?? input.pattern ?? input.url ?? input.description ?? input.query;
  if (typeof value === 'string') return value.split('\n')[0].slice(0, 120);
  const text = JSON.stringify(input);
  return text === '{}' ? '' : text.slice(0, 120);
}

function itemSummary(item, running) {
  if (item.type === 'toolUse') {
    const state = running ? ' · 실행 중' : item.isError ? ' · 실패' : '';
    return (item.title ?? '도구') + (toolTarget(item.input) ? ' · ' + toolTarget(item.input) : '') + state;
  }
  if (item.type === 'commandExecution') {
    const exit = Number.isFinite(item.exitCode) ? (item.exitCode === 0 ? ' · 완료' : ' · 종료 코드 ' + item.exitCode) :
      item.status === 'inProgress' ? ' · 실행 중' : item.status === 'failed' || item.status === 'declined' ? ' · 실패' : '';
    return '명령 · ' + (item.command ?? '').split('\n')[0].slice(0, 120) + exit;
  }
  if (item.type === 'fileChange') {
    const paths = (item.changes ?? []).map(change => change.path.split(/[\\/]/).at(-1));
    return '파일 변경 · ' + (paths.length > 2 ? paths.slice(0, 2).join(', ') + ' 외 ' + (paths.length - 2) + '개' : paths.join(', '));
  }
  return { reasoning: '작업 진행' }[item.type] ?? item.type;
}


function appendMarkdownText(node, text) {
  const pattern = /(\x60[^\x60]+\x60|\*\*[^*]+\*\*|~~[^~]+~~|\*[^*]+\*)/g;
  for (const part of text.split(pattern)) {
    if (!part) continue;
    const delimiter = part.startsWith('**') || part.startsWith('~~') ? part.slice(0, 2) : part[0];
    const tag = { '**': 'strong', '~~': 'del', '*': 'em', '\x60': 'code' }[delimiter];
    if (!tag || part.length <= delimiter.length * 2 || !part.endsWith(delimiter)) {
      node.append(document.createTextNode(part));
      continue;
    }
    const inline = document.createElement(tag);
    inline.textContent = part.slice(delimiter.length, -delimiter.length);
    node.append(inline);
  }
}

function renderMessage(node, text) {
  if (node.dataset.source === text) return;
  node.dataset.source = text;
  const fragment = document.createDocumentFragment();
  const lines = text.split(/\r?\n/);
  let list;
  function append(parent, tag, content) {
    const element = document.createElement(tag);
    appendMarkdownText(element, content);
    parent.append(element);
    return element;
  }
  const cells = line => line.trim().replace(/^\||\|$/g, '').split('|').map(cell => cell.trim());

  for (let index = 0; index < lines.length; index++) {
    const line = lines[index];
    const item = /^\s*([-+*]|\d+\.)\s+(.+)$/.exec(line);
    if (item) {
      const tag = /\d/.test(item[1]) ? 'ol' : 'ul';
      if (list?.localName !== tag) {
        list = document.createElement(tag);
        fragment.append(list);
      }
      append(list, 'li', item[2]);
      continue;
    }
    list = undefined;
    if (!line.trim()) continue;
    if (/^\s*\x60{3}/.test(line)) {
      const code = document.createElement('code');
      const body = [];
      while (++index < lines.length && !/^\s*\x60{3}\s*$/.test(lines[index])) body.push(lines[index]);
      code.textContent = body.join('\n');
      const pre = document.createElement('pre');
      pre.append(code);
      fragment.append(pre);
      continue;
    }
    const separator = lines[index + 1];
    const headers = cells(line);
    if (headers.length > 1 && separator && cells(separator).length === headers.length &&
        cells(separator).every(cell => /^:?-{3,}:?$/.test(cell))) {
      const table = document.createElement('table');
      const head = table.createTHead().insertRow();
      for (const header of headers) append(head, 'th', header);
      const body = table.createTBody();
      index++;
      while (lines[index + 1]?.includes('|') && cells(lines[index + 1]).length === headers.length) {
        const row = body.insertRow();
        for (const cell of cells(lines[++index])) append(row, 'td', cell);
      }
      fragment.append(table);
      continue;
    }
    const heading = /^(#{1,6})\s+(.+)$/.exec(line);
    if (heading) append(fragment, 'h' + heading[1].length, heading[2]);
    else if (/^\s*>/.test(line)) append(fragment, 'blockquote', line.replace(/^\s*>\s?/, ''));
    else append(fragment, 'p', line);
  }
  node.replaceChildren(fragment);
}

function renderChat() {
  if (selectedTask) {
    const state = runtime(selectedTask);
    byId('switch-codex-view').hidden = true;
    renderTaskHeader(selectedTask, state);
    document.body.classList.toggle('codex-terminal-mode', !!state.terminalMode);
    renderChatView(selectedTask, byId);
  }
  for (const panel of splitChats.values()) renderChatView(panel.chatTask, panel.getChatPart);
}

// Empty chat: who you are talking to, where it works, and what you can type (Orca / Claude app style).
function chatEmptyState(task) {
  const box = document.createElement('div');
  box.className = 'chat-empty';
  const avatar = agentMark(task.provider);
  avatar.classList.add('chat-empty-avatar');
  const title = document.createElement('h2');
  title.textContent = agentName(task);
  const where = document.createElement('p');
  where.className = 'chat-empty-where';
  where.textContent = [task.worktree?.branch, task.cwd].filter(Boolean).join(' · ');
  where.title = task.cwd;
  const hints = document.createElement('ul');
  hints.className = 'chat-empty-hints';
  for (const [key, label] of [['@', '파일을 대화에 넣기'], ['/', '명령 쓰기'], ['Enter', '보내기 · Shift+Enter 줄바꿈']]) {
    const item = document.createElement('li');
    const kbd = document.createElement('kbd');
    kbd.textContent = key;
    item.append(kbd, label);
    hints.append(item);
  }
  box.append(avatar, title, where, hints);
  return box;
}

// Each answer starts with the agent's mark and name, so the transcript reads as a conversation.
function markAgentTurns(feed, task) {
  let previous = null;
  for (const node of feed.querySelectorAll(':scope > .chat-entry')) {
    const starts = !node.classList.contains('userMessage') && (!previous || previous.classList.contains('userMessage'));
    const head = node.querySelector(':scope > .chat-turn-head');
    if (starts && !head) {
      const line = document.createElement('div');
      line.className = 'chat-turn-head';
      const name = document.createElement('span');
      name.textContent = agentName(task);
      line.append(agentMark(task.provider), name);
      node.prepend(line);
    } else if (!starts && head) head.remove();
    previous = node;
  }
}

// The line under the composer: agent · folder · branch (Orca shows the same context under its input).
function renderComposerContext(element, task) {
  const key = [task.provider, task.cwd, task.worktree?.branch].join('|');
  if (element.dataset.key === key) return;
  element.dataset.key = key;
  const part = (icon, text, title) => {
    const span = document.createElement('span');
    const mark = document.createElement('span');
    setPanelIcon(mark, icon);
    span.append(mark, document.createTextNode(text));
    span.title = title ?? text;
    return span;
  };
  const agent = document.createElement('span');
  agent.append(agentMark(task.provider), document.createTextNode(agentName(task)));
  const folder = task.cwd.split(/[\\/]/).filter(Boolean).at(-1) ?? task.cwd;
  element.replaceChildren(agent, part('folder', folder, task.cwd),
    ...(task.worktree?.branch ? [part('branch', task.worktree.branch)] : []));
}

function renderChatView(task, get) {
  const state = runtime(task);
  const draft = get('chat-input').value;
  get('chat-markdown').hidden = !draft.trim();
  if (get('chat-markdown').open) renderMessage(get('chat-preview'), draft);
  const feed = get('chat-feed');
  const stick = feed.scrollHeight - feed.scrollTop - feed.clientHeight < 100;
  const context = get('composer-context');
  if (context) renderComposerContext(context, task);
  if (!state.items.size) {
    feed.replaceChildren(chatEmptyState(task));
  } else {
    feed.querySelector('.chat-empty')?.remove();
    const all = [...state.items.values()];
    const limit = state.visibleItems ?? chatWindow;
    const shown = all.length > limit ? all.slice(-limit) : all;
    const shownIds = new Set(shown.map(item => item.id));
    for (const child of [...feed.children]) {
      if (child.dataset.item !== undefined ? !shownIds.has(child.dataset.item) : !child.classList.contains('chat-more')) child.remove();
    }
    let more = feed.querySelector(':scope > .chat-more');
    const hiddenCount = all.length - shown.length;
    if (hiddenCount) {
      if (!more) {
        more = button('', () => {
          const height = feed.scrollHeight;
          state.visibleItems = (state.visibleItems ?? chatWindow) + chatWindow;
          renderChatView(task, get);
          feed.scrollTop += feed.scrollHeight - height;
        });
        more.className = 'chat-more';
        feed.prepend(more);
      }
      more.textContent = '이전 메시지 ' + hiddenCount + '개 더 보기';
    } else more?.remove();
    const rendered = new Map([...feed.children].filter(child => child.dataset.item !== undefined).map(child => [child.dataset.item, child]));
    for (const item of shown) {
      let node = rendered.get(item.id);
      const text = itemText(item);
      if (!node) {
        node = document.createElement('article');
        node.className = 'chat-entry ' + item.type;
        node.dataset.item = item.id;
        if (['userMessage', 'agentMessage', 'plan'].includes(item.type)) {
          const message = document.createElement('div'); message.className = 'chat-message'; node.append(message);
          if (item.type === 'userMessage') {
            const expand = button('전체 메시지 표시', () => {
              const expanded = node.classList.toggle('message-expanded');
              expand.textContent = expanded ? '접기' : '전체 메시지 표시';
              expand.setAttribute('aria-expanded', String(expanded));
            });
            expand.className = 'expand-message';
            expand.setAttribute('aria-expanded', 'false');
            expand.hidden = text.length < 720 && text.split('\n').length < 10;
            if (!expand.hidden) node.classList.add('message-long');
            node.append(expand);
            const undo = button('이 요청 전으로 되돌리기', () => restoreTurn(task, node.dataset.checkpoint));
            undo.className = 'checkpoint-restore';
            undo.title = '이 요청을 보내기 직전의 파일 상태로 되돌립니다. 지금 상태는 따로 저장되어 다시 되돌릴 수 있습니다.';
            undo.hidden = true;
            node.append(undo);
          }
        } else {
          const details = document.createElement('details');
          const summary = document.createElement('summary');
          details.append(summary, document.createElement('pre'));
          node.append(details);
        }
        feed.append(node);
      }
      const undo = node.querySelector(':scope > .checkpoint-restore');
      if (undo) {
        node.dataset.checkpoint = task.checkpoints?.[item.id] ?? '';
        undo.hidden = !node.dataset.checkpoint || !!state.busy || !!state.restoring;
      }
      const message = node.querySelector('.chat-message');
      if (message) renderMessage(message, text);
      else {
        const summary = node.querySelector('summary');
        // A tool step without a result is only "running" while its turn is still active; older
        // history saved before results were recorded simply has no output.
        const running = item.type === 'toolUse' ? item.output === undefined && !!state.busy : item.status === 'inProgress';
        const label = itemSummary(item, running);
        if (summary.textContent !== label) summary.textContent = label;
        summary.title = label;
        node.dataset.status = item.isError || item.status === 'failed' || (Number.isFinite(item.exitCode) && item.exitCode !== 0)
          ? 'failed' : running ? 'running' : 'done';
        const body = node.querySelector('pre');
        if (body.textContent !== text) body.textContent = text;
      }
    }
  }
  // 더 보기로 위쪽 항목을 붙이면 끝에 붙으므로, 순서가 어긋났을 때만 다시 줄 세운다.
  const ordered = [...feed.querySelectorAll(':scope > [data-item]')];
  const expected = [...state.items.keys()].filter(id => ordered.some(node => node.dataset.item === id));
  if (ordered.map(node => node.dataset.item).join('\n') !== expected.join('\n')) {
    const byId = new Map(ordered.map(node => [node.dataset.item, node]));
    for (const id of expected) feed.append(byId.get(id));
  }
  markAgentTurns(feed, task);
  if (stick) feed.scrollTop = feed.scrollHeight;
  const queue = get('chat-queue');
  queue.hidden = !state.queue?.length;
  queue.replaceChildren(...(state.queue ?? []).map((entry, index) => {
    const chip = document.createElement('span');
    chip.className = 'queue-chip';
    const label = document.createElement('span');
    label.textContent = (index + 1) + '. ' + entry.text.split('\n')[0];
    label.title = entry.text;
    const remove = button('', () => { state.queue = state.queue.filter(item => item !== entry); scheduleChat(); });
    remove.className = 'queue-remove';
    remove.title = remove.ariaLabel = '대기열에서 빼기';
    setPanelIcon(remove, 'close');
    chip.append(label, remove);
    return chip;
  }));
  const approvals = get('approval-list');
  if (approvals.dataset.key !== JSON.stringify([task.id, ...state.approvals.keys()])) {
    approvals.dataset.key = JSON.stringify([task.id, ...state.approvals.keys()]);
    approvals.replaceChildren();
    for (const request of state.approvals.values()) {
      const card = document.createElement('div');
      card.className = 'approval';
      const reason = document.createElement('p');
      reason.textContent = [
        { 'claude/approval': 'Claude 도구 실행 승인', 'item/commandExecution/requestApproval': '명령 실행 승인' }[request.method] ?? '파일 변경 승인',
        request.cwd, request.reason, request.grantRoot
      ].filter(Boolean).join(' · ');
      card.append(reason);
      if (request.command) {
        const details = document.createElement('pre');
        details.textContent = request.command;
        card.append(details);
      }
      card.append(...[true, false].map(accept => button(accept ? '이번만 승인' : '거절', async () => {
        await api.chatApprove(state.taskId, request.id, accept);
        state.approvals.delete(request.id);
        updateTaskStatus(task);
        renderChat();
      })));
      approvals.append(card);
    }
  }
  renderModelPicker(task, get);
  get('composer-note').textContent = get('chat-model').hidden ? [state.model, state.status].filter(Boolean).join(' · ') : state.status;
  const authBlocked = task.provider === 'claude' && state.authRequired;
  get('claude-login-banner').hidden = !authBlocked;
  const feedback = state.prFeedback;
  get('pr-feedback-banner').hidden = !feedback;
  if (feedback) {
    get('pr-feedback-text').textContent = 'PR #' + feedback.feedback.number + ' · ' + prFeedback.summary(feedback.items);
    get('pr-feedback-text').title = feedback.feedback.title;
    get('pr-feedback-send').disabled = !!state.prFeedbackSending;
    get('pr-feedback-send').onclick = () => sendPullRequestFeedback(task);
    get('pr-feedback-open').onclick = () => api.githubOpen(feedback.feedback.repository, feedback.feedback.number).catch(report);
    get('pr-feedback-dismiss').onclick = () => { state.prFeedback = null; scheduleChat(); };
  }
  get('claude-login-status').textContent = state.authMessage ?? 'Claude Code에 로그인해야 합니다.';
  get('claude-login').disabled = claudeLoginOpening || !!state.checkingAuth;
  get('claude-login-check').disabled = !!state.checkingAuth;
  get('reconnect-chat').hidden = state.connected || state.connecting || !!state.reconnectTimer;
  get('disconnect-chat').hidden = true;
  get('stop-chat').hidden = !state.busy || !state.connected;
  get('send-chat').disabled = !!state.switching || authBlocked || !draft.trim();
  get('send-chat').title = state.busy || state.connecting ? '대기열에 추가 (지금 턴이 끝나면 보냄)' : state.connected ? '보내기 (Enter)' : '연결하고 보내기 (Enter)';
}

const chatWindow = 150;

// 체크포인트로 파일 되돌리기. 되돌리기 전 상태도 저장되어, 토스트의 "되돌리기 취소"로 다시 돌아갈 수 있다.
async function restoreTurn(task, ref) {
  const state = runtime(task);
  if (!ref || state.busy || state.restoring) return;
  if (!confirm('이 요청을 보내기 직전의 파일 상태로 되돌립니다.\n그 뒤에 바뀐 파일은 되돌아가고 새로 생긴 파일은 지워집니다(.gitignore 대상은 그대로).\n지금 상태는 따로 저장해 두어 다시 되돌릴 수 있습니다. 계속할까요?')) return;
  state.restoring = true;
  scheduleChat();
  try {
    const result = await api.checkpointRestore(task.cwd, task.id, ref);
    toast('파일을 되돌렸습니다 · 복원 ' + result.restored + '개, 삭제 ' + result.deleted + '개', {
      kind: 'success',
      action: { label: '되돌리기 취소', run: async () => {
        const back = await api.checkpointRestore(task.cwd, task.id, result.backup);
        toast('되돌리기를 취소했습니다 · 복원 ' + back.restored + '개, 삭제 ' + back.deleted + '개', { kind: 'success' });
        refreshGit(true);
      } }
    });
    refreshGit(true);
  } catch (error) { report(error); }
  finally {
    state.restoring = false;
    scheduleChat();
  }
}

// ── 입력창 도우미: Enter로 보내기, @파일 자동완성, /명령 ─────────────────────────
const fileLists = new Map();
function projectFiles(cwd) {
  const cached = fileLists.get(cwd);
  if (cached && Date.now() - cached.at < 60000) return cached.files;
  const files = api.gitListFiles(cwd).then(result => result.files, () => []);
  fileLists.set(cwd, { at: Date.now(), files });
  return files;
}

function runComposerCommand(name, task, get) {
  const state = runtime(task);
  if (name === 'terminal') { chooseTask(task); return switchTaskView(task); }
  if (name === 'stop') return stopChat(task);
  if (name === 'changes') return openReview('changes');
  if (name === 'notes') { openReview('changes'); return byId('send-review-notes').onclick?.(); }
  if (name === 'model') return openChatPicker('chat-model');
  if (name === 'queue') { state.queue = []; scheduleChat(); }
}

function attachComposer(input, get, currentTask) {
  const box = get('chat-suggest');
  let options = [];
  let index = 0;
  let token = null;
  let request = 0;
  const close = () => { box.hidden = true; options = []; token = null; };
  const choose = choice => {
    const task = currentTask();
    if (!token || !task) return close();
    const applied = composerAssist.applyChoice(input.value, token, choice.value);
    input.value = applied.value;
    input.setSelectionRange(applied.caret, applied.caret);
    const kind = token.kind;
    close();
    input.dispatchEvent(new Event('input'));
    if (kind === 'command') Promise.resolve().then(() => runComposerCommand(choice.value, task, get)).catch(report);
  };
  const render = () => {
    box.hidden = !options.length;
    box.replaceChildren(...options.map((option, position) => {
      const row = document.createElement('button');
      row.type = 'button';
      row.className = 'suggest-row';
      row.setAttribute('role', 'option');
      row.setAttribute('aria-selected', String(position === index));
      const label = document.createElement('span');
      label.textContent = option.label;
      row.append(label);
      if (option.hint) {
        const hint = document.createElement('small');
        hint.textContent = option.hint;
        row.append(hint);
      }
      row.onmousedown = event => event.preventDefault();
      row.onclick = () => choose(option);
      return row;
    }));
    box.querySelector('[aria-selected=true]')?.scrollIntoView({ block: 'nearest' });
  };
  const update = async () => {
    const task = currentTask();
    token = task ? composerAssist.findToken(input.value, input.selectionStart) : null;
    if (!token) return close();
    const mine = ++request;
    if (token.kind === 'command') {
      options = composerAssist.matchCommands(token.query).map(command => ({ value: command.name, label: '/' + command.name + '  ' + command.label, hint: command.hint }));
    } else {
      const files = await projectFiles(task.cwd);
      if (mine !== request) return;
      options = composerAssist.rankFiles(files, token.query).map(file => ({ value: file, label: file }));
    }
    index = 0;
    render();
  };
  input.addEventListener('input', update);
  input.addEventListener('click', update);
  input.addEventListener('blur', () => setTimeout(close, 120));
  input.addEventListener('keydown', event => {
    if (event.isComposing || event.keyCode === 229) return;
    if (!box.hidden && options.length) {
      if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
        event.preventDefault();
        index = (index + (event.key === 'ArrowDown' ? 1 : options.length - 1)) % options.length;
        return render();
      }
      if (event.key === 'Enter' || event.key === 'Tab') { event.preventDefault(); return choose(options[index]); }
      if (event.key === 'Escape') { event.preventDefault(); return close(); }
    }
    // Enter: 보내기(일하는 중이면 대기열), Shift+Enter: 줄바꿈
    if (event.key === 'Enter' && !event.shiftKey && !event.ctrlKey && !event.altKey) {
      event.preventDefault();
      input.form?.requestSubmit();
    }
  });
}
attachComposer(byId('chat-input'), byId, () => selectedTask);

function scheduleChat() {
  if (!renderFrame) renderFrame = requestAnimationFrame(() => { renderFrame = 0; renderChat(); });
}

// ── 터미널 에이전트(TUI) 상태: Claude hooks·Codex notify가 앱 파이프로 보낸 상태 ─────────
const hookLabels = { working: '작업 중', waiting: '입력 대기', done: '완료' };
api.onAgentHook((paneId, hookState) => {
  const pane = panes.get(paneId);
  if (!pane) return;
  pane.hookState = hookState;
  if (pane.badge) pane.badge.textContent = (pane.launcher === 'claude' ? 'Claude' : 'Codex') + ' · ' + hookLabels[hookState];
  const task = tasks.find(item => runtimes.get(item.id)?.terminalPane === pane);
  const label = (task?.name ?? pane.tab?.name ?? '터미널') + ' · ' + (pane.launcher === 'claude' ? 'Claude Code' : 'Codex');
  if (task) {
    const state = runtime(task);
    state.tuiState = hookState;
    updateTaskStatus(task);
    if (task === selectedTask) scheduleChat();
  }
  if (hookState === 'done') notifyTask(task ?? { id: undefined, name: label }, '터미널 작업 완료', '에이전트가 답을 마쳤습니다.');
  if (hookState === 'waiting') notifyTask(task ?? { id: undefined, name: label }, '입력 대기', '에이전트가 승인이나 입력을 기다립니다.');
});
// Codex는 턴 완료만 알려 주므로, 그 터미널에서 Enter를 누르면 작업 중으로 본다.
document.addEventListener('workbench-terminal-input', event => {
  const pane = panes.get(event.detail?.id);
  if (!pane || pane.launcher !== 'codex' || pane.agentState !== 'started' || !/\r/.test(event.detail.data)) return;
  pane.hookState = 'working';
  if (pane.badge) pane.badge.textContent = 'Codex · 작업 중';
  const task = tasks.find(item => runtimes.get(item.id)?.terminalPane === pane);
  if (task) { runtime(task).tuiState = 'working'; updateTaskStatus(task); }
});

// ── Windows 알림 ─────────────────────────────────────────────────────
// 메인 프로세스가 창이 포커스되지 않았을 때만 띄운다.
function notifyTask(task, label, body) {
  if (!chatPreferences.notifications || !label) return;
  api.notify({ title: (task.name + ' · ' + label).slice(0, 200), body: String(body ?? '').replace(/\s+/g, ' ').trim().slice(0, 300), ...(task.id ? { taskId: task.id } : {}) })
    .catch(() => {});
}

function lastAgentText(state) {
  return [...state.items.values()].reverse().find(item => item.type === 'agentMessage' && item.text)?.text ?? '';
}

api.onUpdateReady(version => {
  toast('새 버전' + (version ? ' ' + version : '') + '을 받았습니다. 다시 시작하면 설치됩니다.', {
    kind: 'success', timeout: 60000, action: { label: '다시 시작해 설치', run: () => api.installUpdate() }
  });
});

api.onNotificationOpen(taskId => {
  const task = tasks.find(item => item.id === taskId);
  if (task) chooseTask(task);
});

// ── PR 피드백 감시 ───────────────────────────────────────────────────
// 열린 작업의 현재 브랜치 PR을 주기적으로 확인한다. 새로 실패한 체크·리뷰·코멘트는 배너로 보여 주고,
// 사용자가 "에이전트에게 보내기"를 눌렀을 때만 대화로 보낸다. 본 항목은 task.prSeen에 저장한다.
const prWatchInterval = 90 * 1000;
let prWatchRunning = false;

async function checkPullRequestFeedback(task) {
  const state = runtime(task);
  let feedback;
  try { feedback = await api.githubPrFeedback(task.cwd); }
  catch { return; }
  if (!tasks.includes(task)) return;
  state.pullRequest = feedback ? { number: feedback.number, title: feedback.title, repository: feedback.repository } : null;
  if (task === selectedTask) scheduleChat();
  if (!feedback) return;
  prFeedback.updateFollowups(task.feedbackHistory, feedback);
  const { items, next, quiet } = prFeedback.diffFeedback(feedback, task.prSeen);
  task.prSeen = next;
  persist();
  if (!prFeedback.count(items)) return;
  const pending = state.prFeedback?.feedback.number === feedback.number ? state.prFeedback.items : null;
  state.prFeedback = { feedback, items: prFeedback.mergeItems(pending, items) };
  if (!quiet) notifyTask(task, 'PR #' + feedback.number + ' 피드백', prFeedback.summary(items));
  if (task === selectedTask || splitChats.has(task.id)) scheduleChat();
}

async function watchPullRequests() {
  if (prWatchRunning || !chatPreferences.watchPullRequests) return;
  prWatchRunning = true;
  try {
    for (const task of tasks.filter(item => openTasks.has(item.id) && item.cwd)) {
      if (!chatPreferences.watchPullRequests) break;
      await checkPullRequestFeedback(task);
    }
  } finally { prWatchRunning = false; }
}
setTimeout(watchPullRequests, 8000);
setInterval(watchPullRequests, prWatchInterval);

async function sendPullRequestFeedback(task) {
  const state = runtime(task);
  const pending = state.prFeedback;
  if (!pending || state.prFeedbackSending) return;
  if (state.busy || state.connecting || state.switching || state.authRequired) {
    state.status = '에이전트가 작업을 마친 뒤 PR 피드백을 보내세요.';
    scheduleChat();
    return;
  }
  state.prFeedbackSending = true;
  const previousStatus = state.status;
  const collecting = 'PR 피드백을 모으는 중…';
  state.status = collecting;
  scheduleChat();
  try {
    const logs = {};
    for (const check of pending.items.failedChecks.slice(0, 3)) {
      if (check.url) logs[check.url] = await api.githubCheckLog(task.cwd, check.url).catch(() => null);
    }
    const message = prFeedback.composeMessage(pending.feedback, pending.items, logs);
    if (state.status === collecting) state.status = previousStatus;
    if (state.prFeedback === pending) state.prFeedback = null;
    if (task !== selectedTask && !splitChats.has(task.id)) chooseTask(task);
    const input = taskChatInput(task);
    if (!input) return;
    input.value = message;
    if (await submitChat(task, input)) {
      const { head, number, repository } = pending.feedback;
      const { failedChecks, reviews, comments, reviewComments } = pending.items;
      task.feedbackHistory = [...(task.feedbackHistory ?? []), { head, number, repository,
        checks: failedChecks.map(({ workflow, name }) => ({ workflow, name })),
        reviews: [...reviews, ...comments, ...reviewComments].map(item => ({ label: (item.path || item.author) + ' · ' + item.body.slice(0, 120) }))
      }].slice(-20);
      persist();
    } else state.prFeedback ??= pending;
  } finally {
    state.prFeedbackSending = false;
    scheduleChat();
  }
}

api.onChat((id, { method, params }) => {
  const task = tasks.find(item => item.id === id);
  if (!task) return;
  const state = runtime(task);
  state.taskId = id;
  if (method === 'item/started' || method === 'item/completed') {
    const item = params.item;
    const key = item.type === 'userMessage' && item.clientId ? item.clientId : item.id;
    state.items.set(key, { ...item, id: key });
  } else if (method === 'item/agentMessage/delta' || method === 'item/commandExecution/outputDelta') {
    const agent = method === 'item/agentMessage/delta';
    const item = state.items.get(params.itemId) ?? { id: params.itemId, type: agent ? 'agentMessage' : 'commandExecution' };
    const field = agent ? 'text' : 'aggregatedOutput';
    item[field] = ((item[field] ?? '') + params.delta).slice(-500000);
    state.items.set(item.id, item);
  } else if (method === 'turn/started') {
    if (state.threadId && !task.threadId) {
      task.threadId = state.threadId;
      persist();
    }
    state.busy = true;
    state.status = '작업 중';
  } else if (method === 'turn/completed') {
    const start = state.requestStart;
    state.requestStart = null;
    if (start) {
      state.historyPending = api.treeReport(task.cwd, start.base, true).then(report => {
        const last = task.verification;
        const verification = last?.tree === report.tree ? last.profile + ' · ' + last.result : '';
        task.history = [...(task.history ?? []), { at: start.at, label: start.label, tree: report.tree,
          verification, files: report.files.slice(0, 200).map(file => file.name), diff: report.diff || '변경 없음' }].slice(-10);
        persist();
      }).catch(report);
    }
    state.busy = false;
    state.approvals.clear();
    state.status = { completed: '완료', interrupted: '중단됨', failed: '실패' }[params.turn.status] ?? params.turn.status;
    state.outcome = state.status;
    if (params.turn.authRequired) {
      state.authRequired = true;
      state.authMessage = 'Claude Code 로그인 세션이 만료됐습니다. 로그인 후 작성한 요청을 다시 보낼 수 있습니다.';
      const pending = state.inflight;
      if (pending) {
        const input = taskChatInput(task);
        if (input && !input.value) {
          input.value = pending.text;
          state.items.delete(pending.id);
        } else if (!input && !state.draft) {
          state.draft = pending.text;
          state.items.delete(pending.id);
        }
      }
    } else if (params.turn.error?.message) state.status += ' · ' + params.turn.error.message;
    state.inflight = null;
    if (params.turn.authRequired) notifyTask(task, '로그인 필요', 'Claude Code 로그인 세션이 만료됐습니다.');
    else notifyTask(task, state.outcome, lastAgentText(state) || state.status);
    if (task === actionTask()) refreshGit(!chosenPatch?.selected.size);
  } else if (method === 'approval') {
    state.approvals.set(params.id, params);
    notifyTask(task, '승인 요청', '에이전트가 명령 실행이나 파일 변경 승인을 기다립니다.');
  } else if (method === 'approval/cancelled') {
    state.approvals.delete(params.id);
  } else if (method === 'usage/claude') {
    updateClaudeUsage(params);
    return;
  } else if (method === 'account/rateLimits/updated') {
    showCodexUsage(params);
    return;
  } else if (method === 'disconnected') {
    state.connected = false;
    state.busy = false;
    state.approvals.clear();
    state.outcome = undefined;
    state.status = params.message;
    api.chatClose(id).catch(() => {}).finally(() => scheduleReconnect(task));
  } else if (method === 'notice' || method === 'error') {
    state.status = params.message ?? params.error?.message ?? agentName(task) + ' 오류';
  } else return;
  updateTaskStatus(task);
  if (task === selectedTask || splitChats.has(task.id)) scheduleChat();
  if (method === 'turn/completed') {
    if (params.turn?.status === 'completed') setTimeout(() => flushQueue(task), 0);
    else if (state.queue?.length) {
      state.status += ' · 대기열 ' + state.queue.length + '개는 보내지 않고 남겨 두었습니다.';
      if (task === selectedTask || splitChats.has(task.id)) scheduleChat();
    }
  }
});

let pendingPrompt = null;
async function newTask(provider, folder, panel, prompt) {
  const current = actionTask();
  pendingPrompt = typeof prompt === 'string' && prompt.trim() ? prompt.trim() : null;
  byId('task-first-prompt').hidden = !pendingPrompt;
  byId('task-first-prompt').textContent = pendingPrompt ? '첫 요청: ' + pendingPrompt : '';
  chosenFolder = folder ?? current?.worktree?.root ?? current?.cwd ?? currentPane()?.cwd ?? await api.home();
  pendingPanel = panel;
  byId('task-cwd').textContent = chosenFolder;
  byId('task-name').value = pendingPrompt ? pendingPrompt.split('\n')[0].slice(0, 80) : '';
  byId('task-worktree').checked = localStorage.getItem(taskWorktreeKey) !== 'off';
  byId('task-compare').checked = false;
  byId('task-worktree').disabled = false;
  byId('task-error').hidden = true;
  byId('task-dialog').querySelector('form').elements['task-provider'].value = provider ?? actionTask()?.provider ?? 'codex';
  byId('task-dialog').showModal();
}
byId('new-task').onclick = () => newShellTab().catch(report);
byId('add-workspace').onclick = async () => {
  try {
    const folder = await api.folder();
    if (!folder) return;
    projectFolders.add(folder);
    localStorage.setItem(projectFoldersKey, JSON.stringify([...projectFolders]));
    byId('project-search').value = '';
    tasksSidebar();
    renderSidebar();
  } catch (error) { report(error); }
};
byId('project-search').oninput = () => { tasksSidebar(); renderSidebar(); };
byId('choose-task-cwd').onclick = async () => {
  const folder = await api.folder();
  if (folder) { chosenFolder = folder; byId('task-cwd').textContent = folder; }
};
byId('cancel-task').onclick = () => byId('task-dialog').close();
byId('task-compare').onchange = () => {
  const compare = byId('task-compare').checked;
  if (compare) byId('task-worktree').checked = true;
  byId('task-worktree').disabled = compare;
};

// 새 작업 만들기. 비교를 켜면 Codex·Claude 작업을 각자의 worktree로 하나씩 만들고 같은 첫 요청을 보낸다.
byId('task-dialog').querySelector('form').onsubmit = async event => {
  event.preventDefault();
  const form = event.currentTarget;
  const name = byId('task-name').value.trim();
  if (!name || byId('submit-task').disabled) return;
  const compare = byId('task-compare').checked;
  const providers = compare ? ['codex', 'claude'] : [form.elements['task-provider'].value];
  const useWorktree = compare || byId('task-worktree').checked;
  if (!compare) localStorage.setItem(taskWorktreeKey, useWorktree ? 'on' : 'off');
  const compareGroup = compare ? crypto.randomUUID() : undefined;
  const planned = providers.map(provider => ({ id: crypto.randomUUID(), provider,
    name: compare ? name + ' · ' + (provider === 'claude' ? 'Claude' : 'Codex') : name, cwd: chosenFolder }));
  if (useWorktree) {
    const submit = byId('submit-task');
    const label = submit.textContent;
    submit.disabled = true;
    submit.textContent = 'worktree 만드는 중…';
    byId('task-error').hidden = true;
    try {
      for (const entry of planned) {
        const created = await api.taskWorktreeCreate(chosenFolder, entry.name, entry.id, compare ? planned[0].worktree?.head : undefined);
        entry.worktree = { root: created.root, path: created.path, branch: created.branch, base: created.base, head: created.head };
        entry.cwd = created.path;
      }
    } catch (error) {
      for (const entry of planned.filter(item => item.worktree)) {
        api.taskWorktreeRemove(entry.id, entry.worktree.path, entry.worktree.branch, false, entry.worktree.base).catch(() => {});
      }
      byId('task-error').textContent = ipcMessage(error) + (compare ? '\n비교는 Git 저장소에서만 할 수 있습니다.' : '\n체크를 끄면 선택한 폴더에서 바로 작업합니다.');
      byId('task-error').hidden = false;
      return;
    } finally {
      submit.disabled = false;
      submit.textContent = label;
    }
    if (!byId('task-dialog').open) {
      for (const entry of planned) api.taskWorktreeRemove(entry.id, entry.worktree.path, entry.worktree.branch, false, entry.worktree.base).catch(report);
      return;
    }
  }
  const prompt = pendingPrompt;
  pendingPrompt = null;
  const created = planned.map(entry => ({ id: entry.id, name: entry.name, cwd: entry.cwd, provider: entry.provider, createdAt: Date.now(),
    ...(entry.worktree ? { worktree: entry.worktree } : {}), ...(compareGroup ? { compareGroup, comparePrompt: prompt ?? '' } : {}) }));
  tasks.push(...created);
  byId('task-dialog').close();
  if (pendingPanel && panelTree.contains(pendingPanel.anchor)) openSplitChat(created[0], pendingPanel.anchor, pendingPanel.direction);
  else chooseTask(created[0]);
  pendingPanel = null;
  if (compare) { tasksSidebar(); persist(); }
  for (const task of created) {
    connectTask(task).then(() => whenSettled(task)).then(() => {
      if (!prompt) return;
      return sendChatText(task, prompt, task === selectedTask ? taskChatInput(task) : null);
    }).catch(report);
  }
};

// ── 결과 비교: 같은 요청을 받은 Codex·Claude 작업의 변경을 나란히 본다 ──────────
const comparing = new Set();
async function openCompare(task) {
  const group = tasks.filter(item => item.compareGroup && item.compareGroup === task.compareGroup);
  if (group.length < 2) { status('비교할 작업이 하나만 남았습니다.'); return; }
  const dialog = byId('compare-dialog');
  byId('compare-prompt').textContent = task.comparePrompt ? '요청: ' + task.comparePrompt : '요청을 보낸 뒤 결과를 비교할 수 있습니다.';
  const columns = byId('compare-columns');
  const controls = byId('compare-tests');
  const profiles = loadToolSettings(runProfilesKey)[terminalFolderKey(task.worktree.root)] ?? [];
  const picker = toolElement('select');
  picker.setAttribute('aria-label', '공통 검증 프로필');
  for (const profile of profiles) picker.append(new Option(profile.name, profile.id));
  const busy = comparing.has(task.compareGroup);
  const run = button(busy ? '검증 중…' : '양쪽에서 실행', async () => {
    const profile = profiles.find(entry => entry.id === picker.value);
    if (!profile || comparing.has(task.compareGroup)) return;
    comparing.add(task.compareGroup);
    run.disabled = true;
    run.textContent = '검증 중…';
    try {
      await Promise.all(group.map(async item => {
        let result;
        try { result = await api.verifyProfile(item.cwd, profile.command); }
        catch (error) { result = { result: '판정 불가', output: ipcMessage(error) }; }
        item.verification = { ...result, profile: profile.name, command: profile.command };
        const last = item.history?.at(-1);
        if (last?.tree && last.tree === result.tree) last.verification = profile.name + ' · ' + result.result;
      }));
      persist();
    } finally {
      comparing.delete(task.compareGroup);
      if (dialog.open && dialog.dataset.group === task.compareGroup) openCompare(task).catch(report);
    }
  });
  run.disabled = busy || !profiles.length;
  dialog.dataset.group = task.compareGroup;
  controls.replaceChildren(picker, run, button('검증 상태 새로고침', () => openCompare(task)));
  if (!profiles.length) controls.append(button('공통 실행 프로필 설정', () => { dialog.close(); showRunProfiles(task.worktree.root); }));
  columns.replaceChildren(...group.map(item => {
    const column = document.createElement('section');
    column.className = 'compare-column';
    const head = document.createElement('header');
    const title = document.createElement('strong');
    title.textContent = agentName(item);
    const state = document.createElement('small');
    state.textContent = taskStatus(runtime(item)) || '대기';
    head.append(title, state);
    const files = document.createElement('div');
    files.className = 'compare-files';
    files.textContent = '변경을 확인하는 중…';
    const actions = document.createElement('div');
    actions.className = 'compare-actions';
    const open = button('이 작업 열기', () => { dialog.close(); chooseTask(item); });
    const keep = button('이 결과 남기기', async () => {
      dialog.close();
      for (const other of group.filter(entry => entry !== item)) await requestCloseTask(other);
      chooseTask(item);
    });
    keep.className = 'primary';
    actions.append(open, keep);
    column.append(head, files, actions);
    const verification = toolElement('details');
    const result = item.verification;
    const verdict = toolElement('summary', result ? result.profile + ' · ' + result.result +
      (Number.isFinite(result.duration) ? ' · ' + (result.duration / 1000).toFixed(1) + '초' : '') : '검증 전');
    verdict.className = 'verification-result';
    verdict.dataset.label = verdict.textContent;
    verification.append(verdict);
    if (result) verification.append(toolElement('code', result.command), toolElement('pre', result.output));
    column.insertBefore(verification, actions);
    const base = item.worktree.head;
    (base ? api.treeReport(item.cwd, base, true) : api.gitStatus(item.cwd)).then(snapshot => {
      if (result?.tree && snapshot.tree && result.tree !== snapshot.tree) verdict.append(' · 변경 후 재실행 필요');
      const changed = snapshot.files ?? [];
      const added = changed.reduce((sum, file) => sum + (file.added ?? 0), 0);
      const removed = changed.reduce((sum, file) => sum + (file.removed ?? 0), 0);
      const summary = document.createElement('p');
      summary.className = 'compare-summary';
      summary.textContent = changed.length ? '파일 ' + new Set(changed.map(file => file.name)).size + '개 · +' + added + ' −' + removed : '아직 바뀐 파일이 없습니다.';
      const list = document.createElement('ul');
      for (const file of changed.slice(0, 40)) {
        const row = document.createElement('li');
        row.textContent = file.name + (Number.isFinite(file.added) ? '  +' + file.added + ' −' + file.removed : file.kind === 'new' ? '  (새 파일)' : '');
        list.append(row);
      }
      files.replaceChildren(summary, list);
      if (base) {
        const diff = toolElement('details');
        diff.append(toolElement('summary', '기준 ' + base.slice(0, 8) + ' 대비 diff'), toolElement('pre', snapshot.diff));
        files.append(diff);
      } else files.prepend(toolElement('small', '시작 커밋 기록 없음 · 미커밋 변경'));
    }, () => { files.textContent = '변경을 읽지 못했습니다.'; });
    return column;
  }));
  if (!dialog.open) dialog.showModal();
  clearTimeout(dialog.verifyTimer);
  const refreshVerdicts = async () => {
    if (!dialog.open || dialog.dataset.group !== task.compareGroup) return;
    await Promise.all(group.map(async (item, index) => {
      const saved = item.verification;
      const summary = columns.children[index]?.querySelector('.verification-result');
      if (!saved?.tree || !summary) return;
      try {
        const { tree } = await api.treeReport(item.cwd);
        if (summary.isConnected) summary.textContent = summary.dataset.label + (tree === saved.tree ? '' : ' · 변경 후 재실행 필요');
      } catch { if (summary.isConnected) summary.textContent = summary.dataset.label + ' · 현재 상태 확인 불가'; }
    }));
    if (dialog.open && columns.firstChild === firstColumn) dialog.verifyTimer = setTimeout(refreshVerdicts, 30000);
  };
  const firstColumn = columns.firstChild;
  dialog.verifyTimer = setTimeout(refreshVerdicts, 30000);
}
// 연결 중이면 끝날 때까지 기다린다(작업을 열 때 자동 연결이 이미 시작됐을 수 있다).
async function whenSettled(task, limit = 60000) {
  const state = runtime(task);
  const start = Date.now();
  while (state.connecting && Date.now() - start < limit) await new Promise(resolve => setTimeout(resolve, 150));
}
byId('task-title').ondblclick = byId('main-panel-label').ondblclick = () => {
  const task = selectedTask;
  if (!task) return;
  editInline(byId('main-panel-label'), name => {
    task.name = name;
    byId('task-title').textContent = name;
    byId('main-panel-label').textContent = name;
    persist();
    tasksSidebar();
    renderWorkTabs();
  });
};
async function disconnectChat(task) {
  if (!task) return;
  const state = runtime(task);
  if (state.busy || state.switching) return;
  state.manualDisconnect = true;
  clearTimeout(state.reconnectTimer);
  state.reconnectTimer = null;
  try {
    await api.chatClose(task.id);
    state.connected = false;
    state.outcome = undefined;
    state.status = '연결 종료됨 · 다시 연결할 수 있습니다.';
    updateTaskStatus(task);
    renderChat();
  } catch (error) { state.status = error.message; renderChat(); }
}
byId('chat-input').oninput = scheduleChat;
byId('reconnect-chat').onclick = () => { if (selectedTask) connectTask(selectedTask); };
async function stopChat(task) {
  if (!task) return;
  try { await api.chatStop(task.id); }
  catch (error) { runtime(task).status = error.message; renderChat(); }
}

const queueLimit = 20;
async function submitChat(task, input) {
  if (!task) return;
  const state = runtime(task);
  const text = input.value.trim();
  if (!text || state.terminalMode || state.authRequired) return;
  if (state.busy || state.connecting || state.switching) {
    if ((state.queue ??= []).length >= queueLimit) { status('대기열은 ' + queueLimit + '개까지 쌓을 수 있습니다.', 'warn'); return; }
    state.queue.push({ id: crypto.randomUUID(), text });
    input.value = '';
    scheduleChat();
    return;
  }
  return sendChatText(task, text, input);
}

// 대기열의 다음 메시지를 보낸다. 턴이 끝났거나 연결된 직후에 부른다.
function flushQueue(task) {
  const state = runtime(task);
  if (!state.queue?.length || !state.connected || state.busy || state.connecting || state.switching ||
      state.terminalMode || state.authRequired) return;
  const next = state.queue.shift();
  sendChatText(task, next.text, null);
}

async function sendChatText(task, text, input) {
  const state = runtime(task);
  if (state.busy || state.connecting || state.switching || state.terminalMode || state.authRequired) return;
  // Connect on the first send instead of making the user press "연결" first; Codex starts an
  // app-server process per task, so it is only started once the task is actually used.
  if (!state.connected) {
    await connectTask(task);
    if (!state.connected || state.authRequired || state.busy) return;
  }
  state.busy = true;
  state.status = '요청 전송 중…';
  task.activeAt = Date.now();
  persist();
  updateTaskStatus(task);
  const clientId = crypto.randomUUID();
  if (task.provider === 'claude') state.inflight = { id: clientId, text };
  const pending = { id: clientId, type: 'userMessage', content: [{ text }] };
  state.items.set(clientId, pending);
  if (input && input.value.trim() === text) input.value = '';
  renderChat();
  // 턴 체크포인트: 에이전트가 파일을 바꾸기 전에 작업 폴더 상태를 저장한다(Git 저장소일 때만, 최대 8초 기다림).
  state.requestStart = null;
  await state.historyPending;
  const checkpoint = await Promise.race([
    api.checkpointCreate(task.cwd, task.id, text.slice(0, 80)).catch(() => null),
    new Promise(resolve => setTimeout(() => resolve(null), 8000))
  ]);
  if (checkpoint) {
    const entries = Object.entries({ ...(task.checkpoints ?? {}), [clientId]: checkpoint.ref }).slice(-30);
    task.checkpoints = Object.fromEntries(entries);
    if (task.worktree) state.requestStart = { base: checkpoint.tree, label: text.slice(0, 100), at: Date.now() };
    persist();
  }
  try { await api.chatSend(task.id, text, clientId, { model: task.model || undefined, effort: task.effort || undefined }); return true; }
  catch (error) {
    state.requestStart = null;
    state.inflight = null;
    if (state.items.get(clientId) === pending) state.items.delete(clientId);
    state.busy = false;
    state.status = error.message;
    state.outcome = '실패';
    updateTaskStatus(task);
    const currentInput = taskChatInput(task);
    if (currentInput && !currentInput.value) currentInput.value = text;
    else if (!currentInput && !state.draft) state.draft = text;
    renderChat();
  }
}

byId('disconnect-chat').onclick = () => disconnectChat(selectedTask);
byId('stop-chat').onclick = () => stopChat(selectedTask);
byId('composer').onsubmit = event => {
  event.preventDefault();
  submitChat(selectedTask, byId('chat-input'));
};

function taskChatInput(task) {
  return task === selectedTask ? byId('chat-input') : splitChats.get(task.id)?.getChatPart('chat-input');
}

function closeSplitChat(task) {
  const panel = splitChats.get(task.id);
  runtime(task).draft = panel.getChatPart('chat-input').value;
  splitChats.delete(task.id);
  detachWorkspacePanel(panel);
}

function openSplitChat(task, anchor, direction) {
  if (task === selectedTask || splitChats.has(task.id)) return chooseTask(task);
  const panel = makePanel(task.name, task.provider === 'claude' ? 'claude-logo' : 'openai-logo', () => requestCloseTask(task));
  const conversation = chatTemplate.cloneNode(true);
  conversation.removeAttribute('id');
  conversation.classList.add('split-conversation');
  const parts = new Map();
  for (const node of conversation.querySelectorAll('[id]')) {
    parts.set(node.id, node);
    node.dataset.chatPart = node.id;
    node.removeAttribute('id');
  }
  const get = id => parts.get(id);
  panel.chatTask = task;
  panel.getChatPart = get;
  panel.append(conversation);
  const input = get('chat-input');
  input.value = runtime(task).draft;
  input.placeholder = agentName(task) + '에 작업을 요청하세요';
  input.setAttribute('aria-label', agentName(task) + '에 보낼 요청');
  input.oninput = scheduleChat;
  attachComposer(input, get, () => task);
  get('chat-markdown').ontoggle = scheduleChat;
  get('composer').hidden = false;
  get('composer').onsubmit = event => { event.preventDefault(); submitChat(task, input); };
  get('reconnect-chat').onclick = () => connectTask(task);
  get('disconnect-chat').onclick = () => disconnectChat(task);
  get('stop-chat').onclick = () => stopChat(task);
  get('claude-login').onclick = () => openClaudeLogin(task);
  get('claude-login-check').onclick = () => checkClaudeLogin(task);
  bindModelPicker(() => task, get);
  splitChats.set(task.id, panel);
  openTasks.add(task.id);
  placeWorkspacePanel(panel, anchor, direction);
  tasksSidebar();
  renderWorkTabs();
  persist();
  renderChat();
  input.focus();
}

function ipcMessage(error) {
  return String(error?.message ?? error).replace(/^Error invoking remote method '[^']+': (?:Error: )?/, '');
}

function worktreePanes(task) {
  const key = terminalFolderKey(task.worktree.path);
  return [...panes.values()].filter(pane => {
    const paneKey = terminalFolderKey(pane.cwd);
    return !pane.exited && (paneKey === key || !!paneKey?.startsWith(key + '\\'));
  });
}

function askWorktreeClose(task, note, warning, removeLabel) {
  const dialog = byId('worktree-close-dialog');
  byId('worktree-close-branch').textContent = task.worktree.branch + (task.worktree.base ? '  (기준: ' + task.worktree.base + ')' : '');
  byId('worktree-close-path').textContent = task.worktree.path;
  byId('worktree-close-note').textContent = note;
  byId('worktree-close-warning').textContent = warning ?? '';
  byId('worktree-close-warning').hidden = !warning;
  byId('worktree-close-remove').textContent = removeLabel;
  byId('worktree-close-keep').hidden = !!warning;
  dialog.returnValue = 'cancel';
  // close 이벤트는 창이 가려져 있으면 늦게 올 수 있어, 버튼 submit과 Esc(cancel)로 바로 결정한다.
  return new Promise(resolve => {
    const form = dialog.querySelector('form');
    const finish = value => {
      form.removeEventListener('submit', onSubmit);
      dialog.removeEventListener('cancel', onCancel);
      dialog.removeEventListener('close', onClose);
      resolve(value);
    };
    const onSubmit = event => finish(event.submitter?.value || 'cancel');
    const onCancel = () => finish('cancel');
    const onClose = () => finish(dialog.returnValue || 'cancel');
    form.addEventListener('submit', onSubmit);
    dialog.addEventListener('cancel', onCancel);
    dialog.addEventListener('close', onClose);
    dialog.showModal();
  });
}

const finishingTasks = new Set();
// worktree 작업: 탭만 닫거나(나중에 다시 열 수 있음), worktree와 병합된 브랜치를 지우고 작업을 끝낸다.
async function requestCloseTask(task) {
  if (!task.worktree) return closeWorkTab(task);
  if (finishingTasks.has(task.id) || byId('worktree-close-dialog').open) return;
  finishingTasks.add(task.id);
  try {
    const state = runtime(task);
    const count = worktreePanes(task).length;
    const note = 'worktree 폴더를 지우고, 브랜치는 ' + (task.worktree.base || '기준 브랜치') + '에 병합된 경우에만 지웁니다. 푸시만 했거나 병합되지 않은 브랜치는 남겨 둡니다.' +
      (count ? '\n이 폴더에서 열린 터미널 ' + count + '개도 닫습니다.' : '');
    const choice = await askWorktreeClose(task, note, null, 'worktree 정리 후 종료');
    if (choice === 'keep') return closeWorkTab(task);
    if (choice !== 'remove') return;
    if (state.busy || state.approvals.size) {
      status('진행 중인 에이전트 요청을 먼저 멈추세요.');
      return;
    }
    const terminals = worktreePanes(task);
    if (terminals.some(pane => pane.resumeId)) {
      status('Codex에서 /exit를 입력한 뒤 다시 정리하세요.');
      return;
    }
    for (const pane of terminals) closePane(pane);
    if (terminals.length) await new Promise(resolve => setTimeout(resolve, 600));
    let result = await api.taskWorktreeRemove(task.id, task.worktree.path, task.worktree.branch, false, task.worktree.base);
    state.connected = false;
    state.outcome = undefined;
    state.status = '연결 종료됨';
    updateTaskStatus(task);
    if (result.dirty) {
      const again = await askWorktreeClose(task, '변경을 커밋하거나 다른 곳에 옮긴 뒤 정리하는 것이 안전합니다.',
        '커밋하지 않은 변경 ' + result.dirty + '개가 있습니다. 계속하면 이 변경은 사라집니다.', '변경을 버리고 정리');
      if (again !== 'remove') {
        state.status = '연결 종료됨 · worktree를 남겨 두었습니다. 다시 연결할 수 있습니다.';
        if (task === selectedTask || splitChats.has(task.id)) renderChat();
        return;
      }
      result = await api.taskWorktreeRemove(task.id, task.worktree.path, task.worktree.branch, true, task.worktree.base);
    }
    closeWorkTab(task);
    tasks = tasks.filter(entry => entry !== task);
    closedTasks.delete(task.id);
    localStorage.setItem(closedTasksKey, JSON.stringify([...closedTasks]));
    runtimes.delete(task.id);
    persist();
    tasksSidebar();
    api.checkpointClear(task.worktree.root, task.id).catch(() => {});
    status(result.branchKept
      ? 'worktree를 정리했습니다. ' + task.worktree.branch + ' 브랜치는 ' + (task.worktree.base || '기준 브랜치') + '에 병합되지 않아 남겨 두었습니다.'
      : 'worktree와 ' + task.worktree.branch + ' 브랜치를 정리했습니다.', 'success');
  } catch (error) {
    status(ipcMessage(error), 'error');
    if (task === selectedTask || splitChats.has(task.id)) renderChat();
  } finally { finishingTasks.delete(task.id); }
}

function closeWorkTab(task) {
  if (splitChats.has(task.id)) closeSplitChat(task);
  openTasks.delete(task.id);
  closedTasks.add(task.id);
  localStorage.setItem(closedTasksKey, JSON.stringify([...closedTasks]));
  const wasLastTask = localStorage.getItem('agent-last-task') === task.id;
  if (wasLastTask) localStorage.removeItem('agent-last-task');
  if (task !== selectedTask) {
    tasksSidebar();
    renderWorkTabs();
    return;
  }
  const next = tasks.find(entry => entry.id === [...openTasks].filter(id => !splitChats.has(id)).at(-1));
  if (next && !primaryChatPanel.workArea.current) { chooseTask(next); return; }
  runtime(selectedTask).draft = byId('chat-input').value;
  selectedTask = null;
  document.body.classList.remove('task-visible');
  byId('task-title').textContent = '에이전트 작업공간';
  byId('main-panel-label').textContent = '대화';
  byId('main-panel-label').title = '';
  byId('main-panel-folder').textContent = byId('task-folder').textContent = '';
  delete byId('main-chat-panel').dataset.provider;
  byId('composer').hidden = true;
  byId('switch-codex-view').hidden = true;
  document.body.classList.remove('codex-terminal-mode');
  renderPlanner();
  byId('approval-list').replaceChildren();
  delete byId('approval-list').dataset.key;
  renderEmptyTask();
  tasksSidebar();
  renderWorkTabs();
  applyTaskLayout();
  updateExportButtons();
  resetGit();
}
// Orca's chord: open the floating terminal, focus it if it is open elsewhere, close it if focused.
async function toggleTerminalPanel() {
  const panel = byId('floating-terminal');
  if (!panel.hidden) {
    if (panel.contains(document.activeElement)) { setDrawer(false); return; }
    const pane = dockPane();
    if (pane) { selectTab(pane.tab, true); return; }
  }
  setDrawer(true);
  const tab = active && !active.workArea ? active : dockTabs().at(-1);
  if (tab) { selectTab(tab); return; }
  // No shells yet: show the quick-action empty state (new terminal, notes, preview) like Orca.
  byId('open-workspace-shell').focus();
}
byId('toggle-terminal').onclick = () => toggleTerminalPanel().catch(report);
async function openWorkspaceShell(createNew = false) {
  try {
    const match = createNew ? null : dockTabs().at(-1)?.activePane;
    if (match) {
      selectTab(match.tab, false);
      selectPane(match, true);
    } else {
      await newDockTerminal();
    }
  } catch (error) { report(error); }
}
byId('open-workspace-shell').onclick = () => openWorkspaceShell();
byId('window-project-toggle').onclick = () => byId('toggle-workspaces-panel').click();
// Orca: maximizing the floating window moves its terminal into a main tab. Only a task's Codex/Claude
// TUI (terminal mode) still covers the editor area, because it belongs to that task's chat.
byId('expand-terminal').onclick = () => {
  if (selectedTask && runtime(selectedTask).terminalMode) {
    const expanded = document.body.classList.toggle('terminal-maximized');
    byId('expand-terminal').setAttribute('aria-pressed', String(expanded));
    scheduleFit();
    return;
  }
  const tab = active && !active.workArea ? active : dockTabs().at(-1);
  setDrawer(false);
  if (!tab) { newShellTab(undefined, workArea(primaryChatPanel)).catch(report); return; }
  attachWorkAreaTab(tab, workArea(primaryChatPanel));
  activateWorkAreaTab(tab);
};
byId('minimize-terminal').onclick = byId('terminal-minimize-empty').onclick = () => {
  if (selectedTask && runtime(selectedTask).terminalMode) return;
  setDrawer(false);
};

const tabMenu = byId('new-tab-menu');
const tabSearch = byId('new-tab-search');
const menuTrigger = byId('new-task-top');
const chatSettings = byId('chat-settings');
const chatSettingsForm = chatSettings.querySelector('form');
const chatSettingsKey = 'workbench-chat-settings-v1';
let storedChatSettings;
try { storedChatSettings = JSON.parse(localStorage.getItem(chatSettingsKey)); }
catch { storedChatSettings = null; }
// v2부터 "채팅 UI 사용" 설정을 없애고 에이전트 기본 모드를 채팅으로 바꿨다.
// v1에 저장된 'cli'는 대부분 직접 고른 값이 아니라 예전 기본값이 함께 저장된 것이라 채팅으로 되돌린다.
const chatSettingsVersion = 2;
const launchMode = value => (storedChatSettings?.version >= chatSettingsVersion && value === 'cli') ? 'cli' : 'chat';
const chatPreferences = {
  version: chatSettingsVersion,
  codex: launchMode(storedChatSettings?.codex),
  claude: launchMode(storedChatSettings?.claude),
  matchTerminal: storedChatSettings?.matchTerminal === true,
  notifications: storedChatSettings?.notifications !== false,
  watchPullRequests: storedChatSettings?.watchPullRequests !== false,
  closeToTray: storedChatSettings?.closeToTray !== false,
  autoUpdate: storedChatSettings?.autoUpdate !== false,
  contrast: Number.isInteger(storedChatSettings?.contrast) && storedChatSettings.contrast >= 70 && storedChatSettings.contrast <= 130
    ? storedChatSettings.contrast : 100
};

function applyChatPreferences() {
  const fields = chatSettingsForm.elements;
  fields['codex-mode'].value = chatPreferences.codex;
  fields['claude-mode'].value = chatPreferences.claude;
  fields['match-terminal'].checked = chatPreferences.matchTerminal;
  fields['notifications'].checked = chatPreferences.notifications;
  fields['watch-pull-requests'].checked = chatPreferences.watchPullRequests;
  fields['close-to-tray'].checked = chatPreferences.closeToTray;
  api.setCloseToTray(chatPreferences.closeToTray).catch(() => {});
  fields['auto-update'].checked = chatPreferences.autoUpdate;
  api.setAutoUpdate(chatPreferences.autoUpdate).catch(() => {});
  fields['chat-contrast'].value = chatPreferences.contrast;
  byId('chat-contrast-value').value = chatPreferences.contrast + '%';
  document.body.classList.toggle('chat-match-terminal', chatPreferences.matchTerminal);
  document.body.style.setProperty('--chat-contrast-mix', ((chatPreferences.contrast - 70) / 60) * 100 + '%');
  for (const provider of ['codex', 'claude']) {
    const chat = chatPreferences[provider] === 'chat';
    byId('menu-' + provider).querySelector('.menu-arrow').textContent = chat ? '채팅' : '터미널';
    byId('menu-' + provider).title = (provider === 'claude' ? 'Claude Code' : 'Codex') + (chat ? ' 채팅 열기' : ' 터미널에서 실행');
    const alternative = byId('menu-' + provider + '-alt');
    alternative.textContent = chat ? '터미널' : '채팅';
    alternative.title = (provider === 'claude' ? 'Claude Code' : 'Codex') + (chat ? ' 터미널에서 실행' : ' 채팅 열기');
  }
}

byId('open-chat-settings').onclick = () => chatSettings.showModal();
chatSettingsForm.oninput = () => {
  const fields = chatSettingsForm.elements;
  chatPreferences.codex = fields['codex-mode'].value;
  chatPreferences.claude = fields['claude-mode'].value;
  chatPreferences.matchTerminal = fields['match-terminal'].checked;
  chatPreferences.notifications = fields['notifications'].checked;
  chatPreferences.watchPullRequests = fields['watch-pull-requests'].checked;
  chatPreferences.closeToTray = fields['close-to-tray'].checked;
  chatPreferences.autoUpdate = fields['auto-update'].checked;
  chatPreferences.contrast = fields['chat-contrast'].valueAsNumber;
  localStorage.setItem(chatSettingsKey, JSON.stringify(chatPreferences));
  applyChatPreferences();
};
applyChatPreferences();

function filterTabMenu() {
  const query = tabSearch.value.trim().toLowerCase();
  let matches = 0;
  for (const group of tabMenu.querySelectorAll('.tab-menu-group')) {
    const entries = [...group.querySelectorAll('button')];
    for (const entry of entries) {
      entry.hidden = !(entry.textContent + ' ' + (entry.dataset.search ?? '')).toLowerCase().includes(query);
      entry.dataset.forced = '';
      if (!entry.hidden) matches++;
    }
    // 검색어가 다른 항목과 맞지 않으면, 그 글을 첫 요청으로 에이전트 작업을 시작할 수 있게 에이전트 항목은 남긴다.
    if (group.id === 'agent-launch-menu' && query) {
      for (const entry of entries) if (entry.hidden) { entry.hidden = false; entry.dataset.forced = 'true'; }
    }
    group.hidden = entries.every(entry => entry.hidden);
  }
  const typed = tabSearch.value.trim();
  const hint = byId('new-tab-prompt-hint');
  hint.hidden = !typed;
  hint.textContent = typed ? '에이전트를 고르면 “' + (typed.length > 40 ? typed.slice(0, 40) + '…' : typed) + '”를 첫 요청으로 새 작업을 엽니다.' : '';
  byId('new-tab-no-results').hidden = matches > 0 || !!typed;
}
tabSearch.oninput = filterTabMenu;
tabSearch.onkeydown = event => {
  if (event.key !== 'Enter' && event.key !== 'ArrowDown') return;
  event.preventDefault();
  // 검색어와 실제로 맞는 항목을 먼저, 없으면 첫 에이전트(검색어를 첫 요청으로)
  const first = tabMenu.querySelector('.tab-menu-group:not([hidden]) button:not([hidden]):not([data-forced=true])') ??
    tabMenu.querySelector('.tab-menu-group:not([hidden]) button:not([hidden])');
  if (event.key === 'Enter') first?.click();
  else first?.focus();
};
let tabMenuArea;
function openNewTabMenu(trigger = menuTrigger, panel = primaryChatPanel) {
  if (tabMenu.matches(':popover-open')) { tabMenu.hidePopover(); return; }
  tabMenuArea = workAreaFor(panel);
  tabSearch.value = '';
  filterTabMenu();
  const anchor = trigger.getBoundingClientRect();
  tabMenu.style.left = Math.max(4, Math.min(anchor.left, window.innerWidth - 318)) + 'px';
  tabMenu.style.top = anchor.bottom + 4 + 'px';
  tabMenu.showPopover();
  tabSearch.focus();
}
menuTrigger.onclick = () => openNewTabMenu();
tabMenu.addEventListener('toggle', () => menuTrigger.setAttribute('aria-expanded', String(tabMenu.matches(':popover-open'))));
// New terminals open as editor-area tabs (Orca style). The bottom panel is the VS Code-style
// place for Ctrl+` / Ctrl+Shift+` and the panel's own buttons.
async function newDockTerminal(folder) {
  // The floating terminal is task-independent, so new shells start in the home folder (Orca's default).
  const cwd = folder ?? await api.home();
  setDrawer(true);
  return openWorkspace(cwd);
}

async function newShellTab(folder, area = workAreaFor()) {
  const cwd = folder ?? area.current?.activePane?.cwd ?? area.current?.cwd ?? actionTask()?.cwd ?? currentPane()?.cwd ?? await api.home();
  if (!panelTree.contains(area.panel)) area = workArea(primaryChatPanel);
  return openWorkspace(cwd, 'shell', undefined, undefined, area);
}
// 새 탭 메뉴의 에이전트: 채팅이면 새 작업 창, 터미널이면 PowerShell에서 에이전트 TUI를 바로 실행한다.
// alternative가 참이면 기본 모드의 반대쪽으로 연다(행 오른쪽의 작은 버튼).
async function launchAgentFromMenu(provider, alternative = false) {
  const chat = (chatPreferences[provider] === 'chat') !== alternative;
  if (chat) return newTask(provider, undefined, undefined, tabSearch.value);
  const area = tabMenuArea && panelTree.contains(tabMenuArea.panel) ? tabMenuArea : workArea(primaryChatPanel);
  const cwd = area.current?.activePane?.cwd ?? area.current?.cwd ?? actionTask()?.cwd ?? currentPane()?.cwd ?? await api.home();
  return openWorkspace(cwd, provider, undefined, localStorage.getItem('agent-exe-' + provider) || undefined, area);
}
function showPlanner() {
  openReview('planner');
  if (actionTask()) byId('planner-input').focus();
  else return newTask();
}
// Orca's floating-terminal empty state: the quick actions that used to live in the corner popover.
byId('floating-new-note').onclick = () => Promise.resolve().then(() => newNote()).catch(report);
byId('floating-open-note').onclick = () => Promise.resolve().then(() => showMarkdownNotes()).catch(report);
byId('floating-preview').onclick = () => Promise.resolve().then(() => openPreviewPanel()).catch(report);
byId('quick-tools-trigger').onclick = () => toggleTerminalPanel().catch(report);
for (const [id, action, keywords] of [
  ['menu-shell', () => newShellTab(undefined, tabMenuArea), 'powershell terminal'],
  ['menu-planner', showPlanner, 'markdown note'],
  ['menu-codex', () => launchAgentFromMenu('codex'), 'codex agent chat cli terminal 에이전트 채팅 터미널'],
  ['menu-claude', () => launchAgentFromMenu('claude'), 'claude agent chat cli terminal 에이전트 채팅 터미널'],
  ['menu-codex-alt', () => launchAgentFromMenu('codex', true), 'codex agent chat cli terminal 에이전트 채팅 터미널'],
  ['menu-claude-alt', () => launchAgentFromMenu('claude', true), 'claude agent chat cli terminal 에이전트 채팅 터미널']
]) {
  const entry = byId(id);
  entry.dataset.search = keywords;
  entry.onclick = () => { tabMenu.hidePopover(); Promise.resolve().then(action).catch(report); };
}
// New-tab request for the keybinding registry: from the "+" menu it lands in that menu's area.
function newTabFromShortcut() {
  const fromMenu = tabMenu.matches(':popover-open');
  if (fromMenu) tabMenu.hidePopover();
  return newShellTab(undefined, fromMenu ? tabMenuArea : undefined);
}

async function checkClaudeLogin(task) {
  if (!task) return;
  const state = runtime(task);
  if (!state.connected || state.checkingAuth) return;
  state.checkingAuth = true;
  state.authMessage = '로그인 상태를 확인하는 중…';
  if (task === selectedTask || splitChats.has(task.id)) renderChat();
  try {
    const loggedIn = await api.claudeAuthStatus(task.id);
    if (loggedIn === null) throw new Error('로그인 상태를 확인하지 못했습니다.');
    state.authRequired = !loggedIn;
    state.authMessage = loggedIn ? undefined : '로그인이 완료되지 않았습니다. Claude 로그인에서 다시 시도하세요.';
    if (loggedIn) {
      state.status = '로그인됨 · 요청을 보낼 수 있습니다.';
      state.outcome = undefined;
      updateTaskStatus(task);
    }
  } catch (error) {
    state.authMessage = error.message;
  } finally {
    state.checkingAuth = false;
    if (task === selectedTask || splitChats.has(task.id)) renderChat();
  }
}

byId('claude-login-check').onclick = () => checkClaudeLogin(selectedTask);
byId('claude-login').onclick = () => openClaudeLogin(selectedTask);
async function openClaudeLogin(task) {
  if (!task || task.provider !== 'claude' || claudeLoginOpening) return;
  const state = runtime(task);
  setDrawer(true);
  if (claudeLoginPane && panes.has(claudeLoginPane.id) && !claudeLoginPane.exited) {
    selectTab(claudeLoginPane.tab, false);
    selectPane(claudeLoginPane, true);
    return;
  }
  claudeLoginOpening = true;
  state.authMessage = 'Claude 로그인 화면을 여는 중…';
  renderChat();
  try {
    claudeLoginTask = task;
    claudeLoginPane = await openWorkspace(task.cwd, 'claude-login');
    state.authMessage = '브라우저와 아래 터미널의 로그인 안내를 따르세요.';
    if (claudeLoginPane?.exited) await checkClaudeLogin(task);
  } finally {
    claudeLoginOpening = false;
    if (task === selectedTask || splitChats.has(task.id)) renderChat();
  }
}
// When "claude auth login" exits, confirm the login (the CLI can take a moment to report it)
// and close the finished login terminal so the user lands back on a usable chat.
document.addEventListener('workbench-terminal-ended', async event => {
  if (event.detail !== claudeLoginPane?.id) return;
  const task = claudeLoginTask;
  const pane = claudeLoginPane;
  claudeLoginPane = null;
  claudeLoginTask = null;
  if (task && !runtime(task).connected) await connectTask(task);
  await checkClaudeLogin(task);
  if (task && runtime(task).authRequired) {
    await new Promise(resolve => setTimeout(resolve, 2000));
    await checkClaudeLogin(task);
  }
  if (selectedTask?.provider === 'claude' && selectedTask !== task) checkClaudeLogin(selectedTask);
  if (task && !runtime(task).authRequired && panes.has(pane.id)) {
    if (pane.tab.panes.length === 1) closeTab(pane.tab);
    else closePane(pane);
  }
});
byId('show-changes').onclick = () => {
  const panel = byId('results-panel');
  if (panel.dataset.collapsed === 'false' && panel.dataset.review === 'changes') byId('toggle-results-panel').click();
  else openReview('changes');
};
byId('show-terminal-results').onclick = () => openReview('results');
byId('review-changes').onclick = () => setReview('changes');
byId('review-results').onclick = () => setReview('results');
byId('review-planner').onclick = () => setReview('planner');
byId('review-github').onclick = () => setReview('github');
byId('review-agents').onclick = () => setReview('agents');
byId('show-agents').onclick = () => openReview('agents');
setInterval(() => {
  for (const row of byId('task-list').querySelectorAll('[data-task-row]')) {
    const task = tasks.find(entry => entry.id === row.dataset.taskRow);
    const age = row.querySelector('.task-tab-age');
    if (task && age) age.textContent = timeAgo(task.activeAt ?? task.createdAt);
  }
}, 60000);
byId('nav-new-task').onclick = byId('nav-new-task-plus').onclick = () => newTask().catch(report);
byId('nav-floating-terminal').onclick = () => byId('toggle-terminal').click();
byId('refresh-github').onclick = refreshGitHub;
byId('github-state').onchange = byId('github-scope').onchange = refreshGitHub;
byId('chat-markdown').ontoggle = scheduleChat;
byId('planner-input').oninput = () => {
  const task = actionTask();
  if (!task) return;
  task.planner = byId('planner-input').value;
  persist();
  renderMessage(byId('planner-preview'), task.planner);
};

function renderPlanner() {
  const input = byId('planner-input');
  const task = actionTask();
  input.disabled = !task;
  input.value = task?.planner ?? '';
  renderMessage(byId('planner-preview'), input.value);
}

// ── 작업 머리줄: 브랜치·PR 칩과 [채팅 | 터미널] 전환 ─────────────────────────
function renderTaskHeader(task, state) {
  const view = byId('task-view-switch');
  view.hidden = !task;
  if (!task) { byId('task-branch').hidden = byId('task-pr').hidden = true; return; }
  const terminal = !!state.terminalMode;
  byId('view-chat').setAttribute('aria-pressed', String(!terminal));
  byId('view-terminal').setAttribute('aria-pressed', String(terminal));
  const blocked = !!state.switching || (!terminal && (state.busy || state.connecting || state.approvals.size > 0));
  byId('view-chat').disabled = blocked;
  byId('view-terminal').disabled = blocked;
  byId('view-terminal').title = (task.provider === 'claude' ? 'Claude Code' : 'Codex') + ' TUI에서 같은 대화를 이어 갑니다';
  byId('view-chat').title = terminal ? '터미널의 에이전트를 끝내고(/exit) 채팅으로 돌아갑니다' : '채팅 보기';
  const branch = byId('task-branch');
  branch.textContent = state.branch ?? '';
  branch.title = state.branch ? '브랜치 ' + state.branch : '';
  branch.hidden = !state.branch;
  if (!state.branchChecked) {
    state.branchChecked = true;
    api.gitStatus(task.cwd).then(snapshot => {
      state.branch = snapshot.root && snapshot.branch && snapshot.branch !== '(detached)' ? snapshot.branch : null;
      if (task === selectedTask) renderTaskHeader(task, state);
    }, () => {});
  }
  const compareButton = byId('task-compare-open');
  compareButton.hidden = !task.compareGroup || tasks.filter(item => item.compareGroup === task.compareGroup).length < 2;
  compareButton.onclick = () => openCompare(task).catch(report);
  const pr = byId('task-pr');
  const info = state.pullRequest;
  pr.hidden = !info;
  if (info) {
    const pending = state.prFeedback;
    pr.dataset.state = pending?.items.failedChecks.length ? 'failed' : pending ? 'feedback' : 'ok';
    pr.textContent = 'PR #' + info.number + (pending ? ' · ' + prFeedback.summary(pending.items) : '');
    pr.title = info.title + ' (GitHub에서 열기)';
    pr.onclick = () => api.githubOpen(info.repository, info.number).catch(report);
  }
}
byId('view-terminal').onclick = () => { if (selectedTask && !runtime(selectedTask).terminalMode) switchTaskView(selectedTask); };
byId('view-chat').onclick = () => { if (selectedTask && runtime(selectedTask).terminalMode) switchTaskView(selectedTask); };

// 터미널의 에이전트 TUI가 끝나면(/exit, 탭 닫기) 자동으로 채팅으로 돌아간다.
// 이어 열기(resume)는 PowerShell도 함께 끝나고, 새로 연 TUI는 PowerShell로 돌아왔다는 신호가 온다.
for (const name of ['workbench-terminal-ended', 'workbench-agent-returned']) {
  document.addEventListener(name, event => {
    for (const task of tasks) {
      const state = runtimes.get(task.id);
      if (state?.terminalMode && state.terminalPane?.id === event.detail && !state.switching) switchTaskView(task);
    }
  });
}

// 채팅 ↔ 터미널(TUI) 전환. 같은 대화를 한쪽에서만 조작한다: 터미널로 가면 채팅 세션을 끊고
// codex resume <thread> / claude --resume <session>을 열고, TUI가 끝나면 채팅을 다시 붙여 그사이 대화를 불러온다.
async function switchTaskView(task) {
  const state = runtime(task);
  if (state.switching) return;
  if (state.terminalMode) {
    const pane = state.terminalPane;
    if (pane && !pane.exited && pane.agentState !== 'returned') {
      setDrawer(true);
      selectTab(pane.tab, false);
      selectPane(pane, true);
      status('채팅으로 돌아가려면 터미널의 ' + agentName(task) + '에서 /exit를 입력하세요.');
      return;
    }
    state.terminalMode = false;
    state.terminalPane = null;
    state.tuiState = undefined;
    if (pane && panes.has(pane.id)) closePane(pane);
    setDrawer(false);
    state.items = new Map();
    await connectTask(task);
    return;
  }
  if (state.busy || state.connecting || state.approvals.size) return;
  const provider = task.provider === 'claude' ? 'claude' : 'codex';
  // Codex는 thread가 있어야 이어 열 수 있다. Claude는 첫 대화 전이면 새 세션으로 연다.
  if (provider === 'codex' && !task.threadId) { status('첫 요청을 보낸 뒤 터미널로 이어 열 수 있습니다.'); return; }
  state.switching = true;
  renderChat();
  try {
    const installed = await api.agentProbe(provider, task.cwd);
    if (!installed) throw new Error(agentName(task) + ' CLI를 찾지 못했습니다.');
    if (task !== selectedTask) return;
    state.manualDisconnect = true;
    clearTimeout(state.reconnectTimer);
  state.reconnectTimer = null;
    await api.chatClose(task.id);
    state.connected = false;
    if (provider === 'codex') {
      state.status = '공용 Codex 서버가 이 대화를 놓기를 기다리는 중…';
      scheduleChat();
      const released = await api.codexReleaseFolder(task.cwd).catch(() => 'none');
      if (released === 'timeout') throw new Error('다른 Codex 작업이 실행 중이라 이 대화를 아직 넘길 수 없습니다. 잠시 뒤 다시 시도하세요.');
    }
    if (task !== selectedTask) return;
    state.terminalMode = true;
    setDrawer(true);
    updateExportButtons();
    state.terminalPane = await openWorkspace(task.cwd, provider, task.threadId || undefined, installed.file);
    if (task === selectedTask && state.terminalPane?.running) {
      status(agentName(task) + '를 터미널에서 이어 갑니다. /exit로 끝내면 채팅으로 돌아옵니다.');
    }
  } catch (error) {
    state.terminalMode = false;
    state.status = error.message;
    // 터미널로 못 넘겼으면 끊어 둔 채팅을 다시 붙인다.
    if (!state.connected && !state.connecting) setTimeout(() => connectTask(task).then(() => { state.status = error.message; scheduleChat(); }), 0);
  } finally {
    state.switching = false;
    if (task === selectedTask || splitChats.has(task.id)) renderChat();
  }
};
byId('switch-codex-view').onclick = () => { if (selectedTask) switchTaskView(selectedTask); };
document.addEventListener('workbench-terminal-ended', scheduleChat);

function reviewCwd() {
  return focusedPanel.terminalTab?.activePane?.cwd ?? focusedPanel.previewCwd ?? actionTask()?.cwd ?? currentPane()?.cwd;
}

function actionTask() {
  return lastChatPanel.chatTask ?? selectedTask;
}

function resetGit() {
  gitReviewCwd = reviewCwd();
  gitEpoch++;
  chosenPatch = undefined;
  lastSnapshot = undefined;
  byId('patch-review').hidden = true;
  byId('changes-list').replaceChildren();
  byId('git-branch').textContent = '';
  byId('commit-box').hidden = true;
  refreshGit();
  if (byId('results-panel').dataset.review === 'github') refreshGitHub();
}

async function refreshGitHub() {
  const epoch = ++githubEpoch;
  const list = byId('github-pulls');
  const link = byId('github-repository');
  const refresh = byId('refresh-github');
  link.hidden = true;
  refresh.disabled = true;
  list.textContent = 'GitHub PR 확인 중…';
  try {
    const cwd = reviewCwd();
    const result = await api.githubPulls(cwd, byId('github-state').value, byId('github-scope').value);
    if (epoch !== githubEpoch) return;
    if (!result) {
      list.textContent = 'GitHub origin이 있는 작업 폴더를 선택하세요.';
      return;
    }
    link.textContent = result.repository + ' ↗';
    link.title = result.repository;
    link.onclick = () => api.githubOpen(result.repository).catch(report);
    link.hidden = false;
    list.textContent = result.error ?? (result.pulls.length ? '' : '선택한 조건의 PR이 없습니다.');
    for (const pr of result.pulls ?? []) {
      const row = button('#' + pr.number + ' ' + pr.title, () => showPullDetails(cwd, result.repository, pr));
      row.className = 'github-pr';
      const detail = document.createElement('small');
      const state = pr.isDraft && pr.state === 'OPEN' ? '초안' : ({ OPEN: '열림', CLOSED: '닫힘', MERGED: '병합' })[pr.state];
      const review = ({ APPROVED: '승인됨', CHANGES_REQUESTED: '수정 요청', REVIEW_REQUIRED: '검토 대기' })[pr.reviewDecision];
      detail.textContent = [state, pr.author?.login, pr.headRefName, review, pr.updatedAt?.slice(0, 10)].filter(Boolean).join(' · ');
      row.dataset.state = pr.state;
      row.append(detail);
      list.append(row);
    }
  } catch {
    if (epoch === githubEpoch) list.textContent = '저장소 정보를 읽지 못했습니다.';
  } finally {
    if (epoch === githubEpoch) refresh.disabled = false;
  }
}

function noteChanges(message) {
  const note = document.createElement('p');
  note.className = 'empty';
  note.textContent = message;
  byId('changes-list').replaceChildren(note);
}

// 변경 패널은 파일 감시(git-watch)로 갱신한다. 감시할 수 없을 때(저장소가 아님, 감시 실패)만 짧은 주기로 확인한다.
let gitWatchedCwd;
let gitWatching = false;
let gitRefreshAgain = false;
function ensureGitWatch(cwd) {
  if (cwd === gitWatchedCwd) return;
  gitWatchedCwd = cwd;
  gitWatching = false;
  api.gitWatch(cwd ?? null).then(result => { if (gitWatchedCwd === cwd) gitWatching = !!result?.watching; }, () => {});
}
api.onGitChanged(() => {
  if (gitBusyFor) gitRefreshAgain = true;
  else refreshGit();
});

async function refreshGit(force = false) {
  const cwd = reviewCwd();
  if (!cwd || byId('results-panel').dataset.review !== 'changes' ||
      byId('results-panel').dataset.collapsed === 'true') return;
  ensureGitWatch(cwd);
  if (gitBusyFor === cwd) { gitRefreshAgain = true; return; }
  const epoch = gitEpoch;
  gitBusyFor = cwd;
  try {
    const visible = chosenPatch;
    const target = visible?.content !== undefined ? { name: visible.name, kind: visible.kind } : undefined;
    const { patch: content, ...snapshot } = await api.gitStatus(cwd, target);
    if (epoch !== gitEpoch || cwd !== reviewCwd()) return;
    const key = JSON.stringify(snapshot);
    let preserve = !!chosenPatch && (!!chosenPatch.selected.size || !!openNoteEditor);
    if (target && chosenPatch === visible) {
      const entry = snapshot.files.find(file => file.name === visible.name && file.kind === visible.kind);
      if (content !== visible.content && preserve) byId('reload-patch').hidden = false;
      else if (entry && content !== visible.content && !force) await openPatch(cwd, entry, byId('changes-list').querySelector('[aria-current=true]'), content);
    }
    if (!force && key === lastSnapshot) return;
    lastSnapshot = key;
    const fileCount = new Set(snapshot.files.map(file => file.name)).size;
    byId('git-branch').textContent = snapshot.root ? (snapshot.branch ?? '') + ' · 파일 ' + fileCount + '개' +
      (snapshot.files.length > fileCount ? ' · 변경 ' + snapshot.files.length + '건' : '') : '작업 폴더';
    renderCommitBox(cwd, snapshot);
    if (selectedTask && terminalFolderKey(selectedTask.cwd) === terminalFolderKey(cwd)) {
      const header = runtime(selectedTask);
      const branch = snapshot.root && snapshot.branch && snapshot.branch !== '(detached)' ? snapshot.branch : null;
      if (header.branch !== branch) { header.branch = branch; header.branchChecked = true; scheduleChat(); }
    }
    renderReviewNotes();
    if (!snapshot.root) { noteChanges('Git 저장소가 아닙니다.'); return; }
    if (!snapshot.files.length) noteChanges('변경된 파일이 없습니다.');
    else {
      const list = byId('changes-list');
      list.replaceChildren();
      // Grouped like a source-control view, so a file changed in both index and work tree reads clearly.
      for (const [kind, title] of [['conflict', '충돌'], ['staged', '스테이징됨'], ['unstaged', '작업 트리 변경'], ['new', '새 파일']]) {
        const entries = snapshot.files.filter(entry => entry.kind === kind);
        if (!entries.length) continue;
        const heading = document.createElement('div');
        heading.className = 'change-group';
        heading.dataset.kind = kind;
        heading.textContent = title + ' ' + entries.length;
        list.append(heading);
        for (const entry of entries) {
          const row = button('', () => openPatch(cwd, entry, row));
          row.className = 'change-file';
          row.dataset.kind = kind;
          row.dataset.file = entry.name;
          row.title = (entry.from ? entry.from + ' → ' : '') + entry.name;
          const slash = entry.name.lastIndexOf('/');
          const name = document.createElement('span');
          name.className = 'change-name';
          name.textContent = entry.name.slice(slash + 1);
          const folder = document.createElement('span');
          folder.className = 'change-folder';
          folder.textContent = slash > 0 ? entry.name.slice(0, slash) : '';
          const stat = document.createElement('span');
          stat.className = 'change-stat';
          if (Number.isFinite(entry.added)) {
            const added = document.createElement('ins');
            added.textContent = '+' + entry.added;
            const removed = document.createElement('del');
            removed.textContent = '−' + entry.removed;
            stat.append(added, removed);
          } else if (entry.added === null) stat.textContent = '바이너리';
          row.append(name, folder, stat);
          row.setAttribute('aria-current', String(chosenPatch?.name === entry.name && chosenPatch?.kind === entry.kind));
          const staged = kind === 'staged';
          const toggle = button(staged ? '−' : '+', () => runGitAction(cwd,
            () => staged ? api.gitUnstage(cwd, [entry.name]) : api.gitStage(cwd, [entry.name])));
          toggle.className = 'stage-toggle';
        setPanelIcon(toggle, staged ? 'minus' : 'plus');
          toggle.title = toggle.ariaLabel = entry.name + (staged ? ' 스테이지 취소' : ' 스테이지');
          const line = document.createElement('div');
          line.className = 'change-row';
          line.append(row, toggle);
          list.append(line);
        }
      }
    }
    if (!preserve && chosenPatch && !snapshot.files.some(file => file.name === chosenPatch.name && file.kind === chosenPatch.kind)) {
      chosenPatch = undefined;
      byId('patch-review').hidden = true;
    }
    if (force && chosenPatch && !preserve && chosenPatch === visible) await openPatch(cwd, chosenPatch, byId('changes-list').querySelector('[aria-current=true]'), content);
  } catch (error) {
    if (epoch === gitEpoch && cwd === reviewCwd()) noteChanges(error.message);
  } finally {
    if (gitBusyFor === cwd) gitBusyFor = undefined;
    if (gitRefreshAgain) { gitRefreshAgain = false; setTimeout(() => refreshGit(), 0); }
  }
}

// ── 커밋 상자: 스테이지, AI 커밋 메시지, 커밋, 푸시, PR ──────────────────
const commitDrafts = new Map();
let commitState = null;
let commitBusy = false;

function setCommitStatus(message, error = false) {
  byId('commit-status').textContent = message ?? '';
  byId('commit-status').dataset.error = String(!!error);
}

function updateCommitButtons() {
  const snapshot = commitState?.snapshot;
  const staged = snapshot?.files.some(file => file.kind === 'staged');
  const unstaged = snapshot?.files.some(file => file.kind !== 'staged');
  const branch = snapshot?.branch && snapshot.branch !== '(detached)';
  byId('stage-all').disabled = commitBusy || !unstaged;
  byId('ai-commit-message').disabled = commitBusy || !staged;
  byId('commit-button').disabled = commitBusy || !staged || !byId('commit-message').value.trim();
  byId('push-button').disabled = commitBusy || !branch || (!!snapshot.upstream && !snapshot.ahead);
  byId('pr-button').disabled = commitBusy || !branch || !snapshot.upstream;
  // One main action, picked like Orca: commit what is staged, else publish/push, else open a PR.
  const action = commitPrimaryAction();
  const primary = byId('commit-primary');
  primary.dataset.action = action.kind;
  primary.disabled = action.disabled;
  primary.title = action.title;
  byId('commit-primary-label').textContent = action.label;
  setPanelIcon(primary.querySelector('.commit-primary-icon'), commitBusy ? 'loader' : action.icon);
  primary.classList.toggle('busy', commitBusy);
  byId('commit-more').disabled = commitBusy;
}

function commitPrimaryAction() {
  const snapshot = commitState?.snapshot;
  const staged = snapshot?.files.some(file => file.kind === 'staged');
  const message = byId('commit-message').value.trim();
  if (staged || !snapshot) return { kind: 'commit', label: '커밋', icon: 'check', disabled: byId('commit-button').disabled,
    title: !staged ? '스테이지한 변경이 없습니다' : !message ? '커밋 메시지를 입력하세요' : '스테이지한 변경을 커밋 (Ctrl+Enter)' };
  if (!byId('push-button').disabled) return snapshot.upstream
    ? { kind: 'push', label: '푸시 ' + snapshot.ahead, icon: 'arrow-up', disabled: false, title: snapshot.branch + ' → ' + snapshot.upstream }
    : { kind: 'push', label: '브랜치 게시', icon: 'upload', disabled: false, title: snapshot.branch + '을 원격에 올립니다' };
  if (!byId('pr-button').disabled) return { kind: 'pr', label: 'PR 만들기', icon: 'pull-request', disabled: false, title: 'GitHub Pull Request 만들기' };
  return { kind: 'commit', label: '커밋', icon: 'check', disabled: true,
    title: snapshot.files.length ? '먼저 변경을 스테이지하세요' : '커밋할 변경이 없습니다' };
}

// The commit menu (▾): every git action, each with its icon and whether it can run now.
const commitMenu = document.createElement('div');
commitMenu.popover = 'auto';
commitMenu.className = 'record-menu commit-menu';
commitMenu.setAttribute('role', 'menu');
document.body.append(commitMenu);
function showCommitMenu(trigger) {
  const pushable = !byId('push-button').disabled;
  const entries = [
    ['check', '커밋', byId('commit-button').disabled, () => commitNow()],
    ['upload', '커밋 후 푸시', byId('commit-button').disabled, () => commitNow(true)],
    null,
    ['arrow-up', commitState?.snapshot.upstream ? '푸시' : '브랜치 게시', !pushable, () => byId('push-button').click()],
    ['pull-request', 'PR 만들기', byId('pr-button').disabled, () => byId('pr-button').click()],
    null,
    ['plus-square', '변경을 모두 스테이지', byId('stage-all').disabled, () => byId('stage-all').click()],
    ['sparkles', 'AI로 커밋 메시지 쓰기', byId('ai-commit-message').disabled, () => byId('ai-commit-message').click()]
  ];
  commitMenu.replaceChildren(...entries.map(entry => {
    if (!entry) return document.createElement('hr');
    const [icon, label, disabled, run] = entry;
    const item = button('', () => { commitMenu.hidePopover(); run(); });
    item.setAttribute('role', 'menuitem');
    const mark = document.createElement('span');
    setPanelIcon(mark, icon);
    const text = document.createElement('span');
    text.textContent = label;
    item.append(mark, text);
    item.disabled = disabled;
    return item;
  }));
  const rect = trigger.getBoundingClientRect();
  commitMenu.style.left = Math.max(4, Math.min(rect.right - 240, innerWidth - 248)) + 'px';
  commitMenu.style.top = Math.max(4, rect.top - 8 - entries.length * 31) + 'px';
  commitMenu.showPopover();
  commitMenu.querySelector('button:not(:disabled)')?.focus();
}

function renderCommitBox(cwd, snapshot) {
  const box = byId('commit-box');
  box.hidden = !snapshot.root;
  if (commitState?.cwd !== cwd) {
    if (commitState) commitDrafts.set(commitState.cwd, byId('commit-message').value);
    byId('commit-message').value = commitDrafts.get(cwd) ?? '';
    setCommitStatus('');
  }
  commitState = { cwd, snapshot };
  if (!snapshot.root) return;
  const staged = snapshot.files.filter(file => file.kind === 'staged').length;
  const sync = !snapshot.branch || snapshot.branch === '(detached)' ? '브랜치 없음(detached)'
    : !snapshot.upstream ? '원격에 없는 브랜치'
    : [snapshot.ahead ? '↑' + snapshot.ahead : '', snapshot.behind ? '↓' + snapshot.behind : ''].filter(Boolean).join(' ') || '원격과 같음';
  // Branch · remote state · staged count, each with its icon (Orca's source control header).
  const piece = (icon, text, className) => {
    const span = document.createElement('span');
    if (className) span.className = className;
    const mark = document.createElement('span');
    setPanelIcon(mark, icon);
    span.append(mark, document.createTextNode(text));
    return span;
  };
  const detached = !snapshot.branch || snapshot.branch === '(detached)';
  const remote = detached ? piece('alert', 'detached', 'commit-sync-warn')
    : !snapshot.upstream ? piece('cloud-off', '원격 없음')
    : snapshot.ahead || snapshot.behind
      ? piece(snapshot.ahead ? 'arrow-up' : 'arrow-down', [snapshot.ahead ? '↑' + snapshot.ahead : '', snapshot.behind ? '↓' + snapshot.behind : ''].filter(Boolean).join(' '))
      : piece('cloud-check', '최신');
  byId('commit-sync').replaceChildren(piece('branch', detached ? 'HEAD' : snapshot.branch, 'commit-sync-branch'), remote,
    piece('check', '스테이지 ' + staged));
  byId('commit-sync').title = (snapshot.upstream ? snapshot.branch + ' → ' + snapshot.upstream : snapshot.branch) + ' · ' + sync;
  updateCommitButtons();
}

async function runGitAction(cwd, action, done) {
  if (commitBusy) return;
  commitBusy = true;
  updateCommitButtons();
  try {
    const result = await action();
    done?.(result);
  } catch (error) {
    if (commitState?.cwd === cwd) setCommitStatus(ipcMessage(error), true);
  } finally {
    commitBusy = false;
    if (commitState?.cwd === cwd) updateCommitButtons();
    await refreshGit(true);
  }
}

byId('commit-message').oninput = updateCommitButtons;
byId('commit-message').onkeydown = event => {
  if (event.key === 'Enter' && event.ctrlKey && !byId('commit-button').disabled) {
    event.preventDefault();
    byId('commit-box').requestSubmit();
  }
};
byId('stage-all').onclick = () => {
  const cwd = commitState?.cwd;
  if (cwd) runGitAction(cwd, () => api.gitStageAll(cwd), () => setCommitStatus('모든 변경을 스테이지했습니다.'));
};
byId('ai-commit-message').onclick = () => {
  const cwd = commitState?.cwd;
  if (!cwd) return;
  const provider = actionTask()?.provider ?? 'codex';
  setCommitStatus((provider === 'claude' ? 'Claude Code' : 'Codex') + '가 커밋 메시지를 쓰는 중… (최대 몇 분)');
  const ai = byId('ai-commit-message');
  ai.classList.add('generating');
  setPanelIcon(ai, 'loader');
  runGitAction(cwd, () => api.aiCommitMessage(cwd, provider), message => {
    if (commitState?.cwd === cwd) {
      byId('commit-message').value = message;
      setCommitStatus('AI가 쓴 메시지입니다. 확인하고 고친 뒤 커밋하세요.');
    } else commitDrafts.set(cwd, message);
  }).finally(() => {
    ai.classList.remove('generating');
    setPanelIcon(ai, 'sparkles');
  });
};
async function commitNow(thenPush = false) {
  const cwd = commitState?.cwd;
  const message = byId('commit-message').value;
  if (!cwd || !message.trim()) return;
  setCommitStatus('커밋하는 중…');
  let committed = false;
  await runGitAction(cwd, () => api.gitCommit(cwd, message), result => {
    committed = true;
    commitDrafts.delete(cwd);
    if (commitState?.cwd === cwd) byId('commit-message').value = '';
    setCommitStatus('커밋했습니다: ' + result.hash + ' ' + result.subject);
  });
  if (thenPush && committed && commitState?.cwd === cwd && !byId('push-button').disabled) byId('push-button').click();
}
byId('commit-box').onsubmit = event => {
  event.preventDefault();
  commitNow();
};
byId('commit-primary').onclick = () => {
  const kind = byId('commit-primary').dataset.action;
  if (kind === 'push') byId('push-button').click();
  else if (kind === 'pr') byId('pr-button').click();
  else commitNow();
};
byId('commit-more').onclick = event => showCommitMenu(event.currentTarget);
byId('push-button').onclick = () => {
  const cwd = commitState?.cwd;
  const branch = commitState?.snapshot.branch;
  if (!cwd) return;
  if (['main', 'master'].includes(branch) && !confirm(branch + ' 브랜치에 바로 푸시합니다. 계속할까요?')) return;
  setCommitStatus('푸시하는 중…');
  runGitAction(cwd, () => api.gitPush(cwd), result => setCommitStatus(result.branch + ' → ' + result.upstream + ' 푸시했습니다.'));
};
byId('pr-button').onclick = () => {
  const cwd = commitState?.cwd;
  if (!cwd) return;
  setCommitStatus('PR 정보를 확인하는 중…');
  runGitAction(cwd, () => api.githubPrDraft(cwd), draft => {
    setCommitStatus('');
    if (draft.existing) {
      setCommitStatus('이 브랜치의 PR이 이미 있습니다: #' + draft.existing.number + ' ' + draft.existing.title);
      api.githubOpen(draft.repository, draft.existing.number).catch(report);
      return;
    }
    openPullRequestDialog(cwd, draft);
  });
};

function openPullRequestDialog(cwd, draft) {
  const dialog = byId('pr-dialog');
  byId('pr-target').textContent = draft.repository + ' · ' + draft.branch + ' → ' + draft.base +
    (draft.pushed ? '' : '\n푸시하지 않은 커밋이 ' + draft.ahead + '개 있습니다. 먼저 푸시하세요.');
  byId('pr-title').value = draft.title;
  byId('pr-body').value = draft.body;
  byId('pr-base').value = draft.base;
  byId('pr-draft').checked = false;
  byId('pr-error').hidden = true;
  byId('pr-create').disabled = false;
  const form = dialog.querySelector('form');
  form.onsubmit = async event => {
    if (event.submitter?.value !== 'create') return;
    event.preventDefault();
    byId('pr-create').disabled = true;
    byId('pr-error').hidden = true;
    try {
      const result = await api.githubPrCreate(cwd, {
        title: byId('pr-title').value, body: byId('pr-body').value,
        base: byId('pr-base').value.trim(), draft: byId('pr-draft').checked
      });
      dialog.close();
      setCommitStatus('PR을 만들었습니다' + (result.number ? ': #' + result.number : '') + (result.url ? '\n' + result.url : ''));
      if (result.number) api.githubOpen(result.repository, result.number).catch(report);
      if (byId('results-panel').dataset.review === 'github') refreshGitHub();
    } catch (error) {
      byId('pr-error').textContent = ipcMessage(error);
      byId('pr-error').hidden = false;
      byId('pr-create').disabled = false;
    }
  };
  dialog.showModal();
}

// ── diff 줄별 리뷰 노트 ───────────────────────────────────────────────
// 저장소(root)별로 노트를 모은다. 'workbench-' 키라서 상태 파일에도 저장된다.
const reviewNotesKey = 'workbench-review-notes-v1';
let reviewNoteStore = reviewNotes.load(localStorage.getItem(reviewNotesKey));
let reviewNotesSending = false;

function notesRoot() {
  return commitState?.snapshot?.root || null;
}

function notesFor(root = notesRoot()) {
  return root ? reviewNoteStore[root] ?? [] : [];
}

function saveReviewNotes(root, notes) {
  if (notes.length) reviewNoteStore[root] = notes;
  else delete reviewNoteStore[root];
  localStorage.setItem(reviewNotesKey, JSON.stringify(reviewNoteStore));
  renderReviewNotes();
  if (chosenPatch) renderInlineNotes(chosenPatch);
}

function renderReviewNotes() {
  const root = notesRoot();
  const notes = reviewNotes.sortNotes(notesFor(root));
  const panel = byId('review-notes');
  panel.hidden = !notes.length;
  if (!notes.length) return;
  byId('review-notes-count').textContent = '리뷰 노트 ' + notes.length + '개';
  const list = byId('review-notes-list');
  list.replaceChildren();
  for (const note of notes) {
    const item = button(reviewNotes.location(note), () => revealReviewNote(note));
    const preview = document.createElement('small');
    preview.textContent = note.body.split('\n')[0];
    item.append(preview);
    item.title = reviewNotes.location(note) + '\n' + note.body;
    list.append(item);
    if (note.status) {
      item.append(document.createTextNode(' · ' + note.status));
      const original = document.createElement('details');
      original.append(toolElement('summary', '원래 코드'), toolElement('pre', note.lines.map(line => line.text).join('\n')));
      list.append(original);
      const setStatus = value => saveReviewNotes(root, notesFor(root).map(entry => entry.id === note.id ? { ...entry, status: value } : entry));
      if (note.status !== '해결') list.append(button('해결', () => setStatus('해결')));
      list.append(button('재요청 준비', () => setStatus(null)));
    }
  }
  const task = actionTask();
  byId('review-notes-target').textContent = task ? '받는 작업: ' + task.name : '받을 에이전트 작업을 여세요';
  byId('send-review-notes').disabled = !task || reviewNotesSending || !notes.some(note => !note.status);
}

function revealReviewNote(note) {
  const cwd = commitState?.cwd;
  const entry = commitState?.snapshot.files.find(file => file.name === note.file && file.kind === note.kind)
    ?? commitState?.snapshot.files.find(file => file.name === note.file);
  if (cwd && !entry && note.lines.some(line => line.side === 'new')) {
    return showSource(cwd, note.file, reviewNotes.anchor(note).line, null, true).catch(report);
  }
  if (!cwd || !entry) { status(note.file + '은(는) 지금 변경 목록에 없습니다.'); return; }
  const row = [...byId('changes-list').querySelectorAll('.change-file')]
    .find(element => element.dataset.file === entry.name && element.dataset.kind === entry.kind);
  openPatch(cwd, entry, row).then(() => {
    const target = byId('patch-lines').querySelector('[data-note-id="' + CSS.escape(note.id) + '"]');
    target?.scrollIntoView({ block: 'center' });
  });
}

function renderInlineNotes(patch) {
  const area = byId('patch-lines');
  for (const node of area.querySelectorAll('.review-note-card')) node.remove();
  if (chosenPatch !== patch) return;
  for (const note of notesFor().filter(item => item.file === patch.name && item.kind === patch.kind)) {
    const spot = reviewNotes.anchor(note);
    const row = patch.rows.get(spot.side + ':' + spot.line);
    const first = note.lines.find(item => item.side === spot.side && item.line === spot.line);
    const card = reviewNoteCard(note, !row || row.querySelector('.patch-code')?.textContent !== first?.text);
    if (row) row.after(card);
    else area.append(card);
  }
}

function reviewNoteCard(note, moved) {
  const card = document.createElement('div');
  card.className = 'review-note-card';
  card.dataset.noteId = note.id;
  card.dataset.moved = String(moved);
  const header = document.createElement('header');
  const where = document.createElement('span');
  where.textContent = '리뷰 노트 · ' + reviewNotes.location(note);
  const actions = document.createElement('span');
  actions.append(
    button('고치기', () => editReviewNote(card, note)),
    button('지우기', () => saveReviewNotes(notesRoot(), notesFor().filter(item => item.id !== note.id)))
  );
  header.append(where, actions);
  const body = document.createElement('div');
  body.textContent = note.body;
  card.append(header, body);
  return card;
}

// 노트 입력칸. after 뒤에 끼워 넣고, 저장하면 onSave(본문)를 부른다.
// 입력칸은 한 번에 하나만 열고, 닫힐 때(저장·취소·다른 입력칸으로 바뀜) onClose를 부른다.
let openNoteEditor = null;
function reviewNoteEditor(after, initial, onSave, onClose) {
  openNoteEditor?.close();
  const editor = document.createElement('div');
  editor.className = 'review-note-editor';
  const input = document.createElement('textarea');
  input.maxLength = 4000;
  input.placeholder = '이 줄에 대한 리뷰 노트 (Ctrl+Enter로 저장, Esc로 취소)';
  input.value = initial;
  const error = document.createElement('small');
  const handle = {
    close() {
      if (openNoteEditor === handle) openNoteEditor = null;
      editor.remove();
      onClose?.();
    }
  };
  const save = () => {
    try { onSave(input.value); handle.close(); }
    catch (problem) { error.textContent = problem.message; }
  };
  input.onkeydown = event => {
    if (event.key === 'Enter' && event.ctrlKey) { event.preventDefault(); save(); }
    if (event.key === 'Escape') { event.preventDefault(); handle.close(); }
  };
  const actions = document.createElement('div');
  actions.append(button('취소', () => handle.close()), button('저장', save));
  editor.append(input, error, actions);
  after.after(editor);
  openNoteEditor = handle;
  input.focus();
  return handle;
}

function editReviewNote(card, note) {
  // 앞서 연 입력칸이 닫히면서(같은 카드면) 카드를 다시 보이게 하므로, 숨기기는 새 입력칸을 연 뒤에 한다.
  reviewNoteEditor(card, note.body, body => {
    const updated = reviewNotes.createNote({ ...note, body, now: note.at });
    saveReviewNotes(notesRoot(), notesFor().map(item => item.id === note.id ? updated : item));
  }, () => { card.hidden = false; });
  card.hidden = true;
}

byId('add-review-note').onclick = () => {
  const patch = chosenPatch;
  const root = notesRoot();
  if (!patch?.selected.size) return;
  if (!root) { status('Git 저장소에서만 리뷰 노트를 달 수 있습니다.'); return; }
  const selected = [...patch.selected].sort((a, b) => a[0] - b[0]).map(([, value]) => value);
  reviewNoteEditor(selected.at(-1).row, '', body => {
    const note = reviewNotes.createNote({ file: patch.name, kind: patch.kind, lines: selected, body });
    saveReviewNotes(root, reviewNotes.addNote(notesFor(root), note));
    for (const value of selected) value.row.setAttribute('aria-pressed', 'false');
    patch.selected.clear();
    byId('attach-diff').disabled = true;
    byId('add-review-note').disabled = true;
  });
};

byId('clear-review-notes').onclick = () => {
  const root = notesRoot();
  const count = notesFor(root).length;
  if (root && count && confirm('리뷰 노트 ' + count + '개를 모두 지울까요?')) saveReviewNotes(root, []);
};

byId('send-review-notes').onclick = async () => {
  const root = notesRoot();
  const notes = notesFor(root).filter(note => !note.status);
  const task = actionTask();
  if (!root || !notes.length || !task || reviewNotesSending) return;
  const state = runtime(task);
  if (state.busy || state.connecting || state.switching || state.authRequired) {
    status('에이전트가 작업을 마친 뒤 리뷰 노트를 보내세요.');
    return;
  }
  const message = reviewNotes.composeMessage(notes);
  reviewNotesSending = true;
  renderReviewNotes();
  try {
    if (task !== selectedTask && !splitChats.has(task.id)) chooseTask(task);
    const input = taskChatInput(task);
    if (!input) return;
    input.value = message;
    const delivered = await submitChat(task, input);
    // 보내기에 실패하면 submitChat이 입력창에 글을 되돌려 놓는다. 그때는 노트를 남긴다.
    if (delivered) {
      const sent = new Set(notes.map(note => note.id));
      saveReviewNotes(root, notesFor(root).map(note => sent.has(note.id) ? { ...note, status: '확인 대기' } : note));
      status('리뷰 노트 ' + notes.length + '개를 ' + task.name + '에 보냈습니다.', 'success');
    }
  } finally {
    reviewNotesSending = false;
    renderReviewNotes();
  }
};

byId('reload-patch').onclick = () => {
  openNoteEditor?.close();
  chosenPatch?.selected.clear();
  refreshGit(true);
};

async function openPatch(cwd, entry, row, currentContent) {
  openNoteEditor?.close();
  byId('reload-patch').hidden = true;
  const patch = { ...entry, cwd, selected: new Map(), rows: new Map() };
  chosenPatch = patch;
  const area = byId('patch-lines');
  area.replaceChildren();
  byId('patch-title').textContent = entry.name;
  byId('patch-review').hidden = false;
  byId('file-history').open = false;
  byId('file-commits').replaceChildren();
  byId('line-attribution').textContent = '';
  byId('attach-diff').disabled = true;
  byId('add-review-note').disabled = true;
  for (const file of byId('changes-list').querySelectorAll('.change-file')) file.setAttribute('aria-current', String(file === row));
  byId('patch-title').textContent = entry.name + ' · ' + ({ staged: '스테이징됨', unstaged: '작업 트리', new: '새 파일', conflict: '충돌' }[entry.kind] ?? '');
  if (diffEditorTab) { diffEditorTab.name = 'diff · ' + entry.name.split('/').at(-1); renderWorkArea(diffEditorTab.workArea); }
  let content;
  try { content = currentContent ?? await api.gitDiff(cwd, entry.name, entry.kind); patch.content = content; }
  catch (error) { if (chosenPatch === patch) area.textContent = error.message; return; }
  if (chosenPatch !== patch || cwd !== reviewCwd()) return;
  if (!/^@@ /m.test(content)) {
    area.textContent = content.trim() || '표시할 텍스트 변경이 없습니다.';
    return;
  }
  let oldLine, newLine;
  const fragment = document.createDocumentFragment();
  const lines = content.split(/\r?\n/);
  for (const [index, text] of lines.slice(0, 2500).entries()) {
    if (text === '') continue; // only the split after the final newline; diff context lines start with a space
    const hunk = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@(.*)$/.exec(text);
    const code = text[0];
    let number, oldNumber = '', newNumber = '';
    if (hunk) {
      oldLine = Number(hunk[1]);
      newLine = Number(hunk[2]);
    } else if (oldLine === undefined) {
      continue; // "diff --git", "index", "---", "+++" headers repeat what the title already says.
    } else {
      if (code === '-') { number = '−' + oldLine; oldNumber = oldLine++; }
      if (code === '+') { number = '+' + newLine; newNumber = newLine++; }
      if (code === ' ') { number = String(newLine); oldNumber = oldLine++; newNumber = newLine++; }
    }
    const line = document.createElement(number ? 'button' : 'div');
    line.className = 'patch-row' + (hunk ? ' hunk' : number && code === '+' ? ' add' : number && code === '-' ? ' remove' : '');
    const before = document.createElement('span');
    before.className = 'patch-number';
    before.textContent = oldNumber;
    const after = document.createElement('span');
    after.className = 'patch-number';
    after.textContent = newNumber;
    const body = document.createElement('span');
    body.className = 'patch-code';
    body.textContent = hunk ? '@@ ' + (hunk[3].trim() || '변경 구간 ' + hunk[2] + '행부터') : text;
    line.append(before, after, body);
    if (number) {
      line.type = 'button';
      line.setAttribute('aria-pressed', 'false');
      const side = code === '-' ? 'old' : 'new';
      const lineNumber = side === 'old' ? oldNumber : newNumber;
      line.dataset.noteKey = side + ':' + lineNumber;
      patch.rows.set(line.dataset.noteKey, line);
      line.onclick = () => {
        if (patch.selected.has(index)) patch.selected.delete(index);
        else patch.selected.set(index, { label: number + '  ' + text, side, line: lineNumber, text, row: line });
        line.setAttribute('aria-pressed', String(patch.selected.has(index)));
        byId('attach-diff').disabled = !actionTask() || !patch.selected.size;
        byId('add-review-note').disabled = !patch.selected.size;
        inspectPatchLine(patch, number, code);
      };
    }
    fragment.append(line);
  }
  if (lines.length > 2500) {
    const note = document.createElement('p');
    note.textContent = '처음 2,500줄을 표시합니다.';
    fragment.append(note);
  }
  area.append(fragment);
  renderInlineNotes(patch);
}

async function inspectPatchLine(patch, number, code) {
  const output = byId('line-attribution');
  const request = Symbol();
  patch.blameRequest = request;
  if (patch.kind !== 'unstaged' || code === '-') {
    output.textContent = '이 줄은 파일 커밋 이력에서 확인할 수 있습니다.';
    return;
  }
  output.textContent = '줄 이력 확인 중…';
  try {
    const entry = await api.gitLineBlame(patch.cwd, patch.name, Number(number));
    if (chosenPatch !== patch || patch.blameRequest !== request) return;
    output.textContent = '아직 커밋되지 않은 줄입니다.';
    if (entry) {
      const summary = [entry.hash, entry.author, new Date(entry.time * 1000).toLocaleDateString('ko-KR'), entry.subject].join(' · ');
      output.replaceChildren(button(summary, () => showCommitDetails(patch.cwd, entry.hash)));
    }
  } catch {
    if (chosenPatch === patch && patch.blameRequest === request) output.textContent = '이 줄의 커밋 정보가 없습니다.';
  }
}

byId('file-history').ontoggle = async () => {
  const patch = chosenPatch;
  if (!byId('file-history').open || !patch || patch.loadingHistory) return;
  const output = byId('file-commits');
  patch.loadingHistory = true;
  output.textContent = '파일 이력 확인 중…';
  try {
    const entries = await api.gitFileHistory(patch.cwd, patch.name);
    if (chosenPatch !== patch) return;
    output.textContent = entries.length ? '' : '이 파일의 커밋 이력이 없습니다.';
    for (const entry of entries) {
      const row = button('', () => showCommitDetails(patch.cwd, entry.hash));
      row.className = 'file-commit';
      const summary = document.createElement('strong');
      summary.textContent = entry.subject;
      const detail = document.createElement('small');
      detail.textContent = [entry.hash, entry.author, entry.date].join(' · ');
      row.append(summary, detail);
      output.append(row);
    }
  } catch {
    if (chosenPatch === patch) output.textContent = '파일 이력을 읽지 못했습니다.';
  } finally { patch.loadingHistory = false; }
};

function appendToDraft(text) {
  const task = actionTask();
  const input = task && taskChatInput(task);
  if (!input) return;
  input.value += (input.value.trim() ? '\n\n' : '') + text;
  input.focus();
  input.setSelectionRange(input.value.length, input.value.length);
  scheduleChat();
}

function canAttachTerminalResults() {
  const task = actionTask();
  return !!task && !runtime(task).terminalMode &&
    terminalFolderKey(currentPane()?.cwd) === terminalFolderKey(task.cwd);
}

byId('attach-terminal-results').onclick = () => {
  if (!canAttachTerminalResults()) return;
  const text = selectedText();
  if (!text) return;
  appendToDraft('터미널 명령 결과\n\n' + text.replace(/\r\n/g, '\n') + '\n\n요청: ');
};

byId('attach-diff').onclick = () => {
  if (!actionTask() || !chosenPatch?.selected.size) return;
  const excerpt = [...chosenPatch.selected].sort((a, b) => a[0] - b[0]).map(([, line]) => line.label).join('\n');
  const kind = { staged: '스테이징됨', unstaged: '작업 트리', new: '새 파일', conflict: '충돌' }[chosenPatch.kind];
  appendToDraft('검토 대상: ' + chosenPatch.name + (kind ? ' (' + kind + ')' : '') + '\n' + excerpt + '\n\n검토 메모: ');
};

// The diff can move into an editor-area tab for a full-width read and back to the side panel.
let diffEditorTab = null;
function setDiffInEditor(open) {
  const review = byId('patch-review');
  const toggle = byId('expand-diff');
  if (open && !diffEditorTab) {
    const host = document.createElement('section');
    host.className = 'work-document diff-document';
    host.append(review);
    diffEditorTab = {
      name: 'diff · ' + (chosenPatch?.name.split('/').at(-1) ?? '변경사항'), icon: 'branch', host, cwd: reviewCwd(),
      onClose: () => setDiffInEditor(false)
    };
    attachWorkAreaTab(diffEditorTab, workArea(primaryChatPanel));
    activateWorkAreaTab(diffEditorTab);
  } else if (!open && diffEditorTab) {
    const tab = diffEditorTab;
    diffEditorTab = null;
    byId('changes-view').append(review);
    if (tab.workArea) closeDocumentTab(tab);
  }
  document.body.classList.toggle('diff-in-editor', !!diffEditorTab);
  toggle.setAttribute('aria-pressed', String(!!diffEditorTab));
  toggle.title = toggle.ariaLabel = diffEditorTab ? 'diff를 검토 패널로 되돌리기' : '편집 영역에서 diff 크게 보기';
}
byId('expand-diff').onclick = () => setDiffInEditor(!diffEditorTab);
byId('refresh-git').onclick = () => refreshGit(true);
// 감시 중이면 30초마다(놓친 변경 대비), 감시할 수 없으면 5초마다 확인한다. 창이 안 보이면 건너뛴다.
let gitPollAt = 0;
setInterval(() => {
  if (document.hidden) return;
  const now = Date.now();
  if (now - gitPollAt < (gitWatching ? 30000 : 5000)) return;
  gitPollAt = now;
  refreshGit();
}, 1000);
document.addEventListener('visibilitychange', () => { if (!document.hidden) refreshGit(); });
onWorkspacePanelFocus = () => {
  if (reviewCwd() !== gitReviewCwd) resetGit();
};
onChatPanelFocus = () => {
  rememberTaskFocus(actionTask());
  renderPlanner();
  resetGit();
  updateExportButtons();
};
tasksSidebar();
const previousTask = tasks.find(task => task.id === localStorage.getItem('agent-last-task'));
// Orca: reopen what you were working on. Only that task connects at startup. chooseTask waits for
// DOMContentLoaded, which fires after every deferred script (tools, palette) has run.
if (previousTask && !closedTasks.has(previousTask.id)) {
  openTasks.add(previousTask.id);
  document.addEventListener('DOMContentLoaded', () => { if (!selectedTask) chooseTask(previousTask); }, { once: true });
} else renderEmptyTask();
renderWorkTabs();
renderPlanner();

// 작업이 없을 때의 첫 화면: 시작하기 체크리스트와 바로 할 수 있는 행동.
// Nothing selected. With tasks already made, a light home (recent tasks); the setup checklist is only for
// the first run, or when the CLI check finds a problem.
function renderEmptyTask(refresh = false, checklist = false) {
  if (!checklist && tasks.length) { renderHome(refresh); return; }
  const feed = byId('chat-feed');
  const card = document.createElement('section');
  card.className = 'onboarding';
  const title = document.createElement('h2');
  title.textContent = 'Agent Workbench 시작하기';
  const lead = document.createElement('p');
  lead.className = 'onboarding-lead';
  lead.textContent = '작업마다 브랜치와 worktree를 만들고, Codex나 Claude Code에 맡긴 뒤 변경을 검토하고 PR까지 보냅니다.';
  const list = document.createElement('ul');
  list.className = 'onboarding-checks';
  const row = (label, state, detail, action) => {
    const item = document.createElement('li');
    item.dataset.state = state;
    const mark = document.createElement('span');
    mark.className = 'onboarding-mark';
    setPanelIcon(mark, { ok: 'check', todo: 'alert', wait: 'loader', off: 'minus' }[state]);
    const text = document.createElement('span');
    const strong = document.createElement('strong');
    strong.textContent = label;
    const small = document.createElement('small');
    small.textContent = detail;
    text.append(strong, small);
    item.append(mark, text);
    if (action) item.append(action);
    return item;
  };
  list.append(row('에이전트 CLI', 'wait', '확인하는 중…'));
  const actions = document.createElement('div');
  actions.className = 'onboarding-actions';
  const start = button('새 작업', () => openNewTabMenu());
  start.className = 'primary';
  actions.append(start, button('폴더 열기', () => byId('add-workspace').click()), button('PowerShell 열기', () => newShellTab()));
  const recheck = button('다시 확인', () => renderEmptyTask(true));
  recheck.className = 'ghost onboarding-recheck';
  card.append(title, lead, list, actions, recheck);
  feed.replaceChildren(card);
  // 시작 중에도 불리므로 파일 아래쪽 let 대신 함수에 기록한다(선언 전 접근 오류 방지).
  const epoch = renderEmptyTask.epoch = (renderEmptyTask.epoch ?? 0) + 1;
  api.onboardingStatus(refresh).then(status => {
    if (epoch !== renderEmptyTask.epoch || !card.isConnected) return;
    const help = (label, url) => { const link = button(label, () => api.claudeHelp && url === 'claude' ? api.claudeHelp() : null); link.className = 'ghost'; return link; };
    list.replaceChildren(
      row('Codex CLI', status.codex.installed ? 'ok' : 'todo', status.codex.installed ? status.codex.version : '설치하면 Codex로 작업할 수 있습니다: npm install -g @openai/codex'),
      row('Claude Code', !status.claude.installed ? 'todo' : status.claude.loggedIn === false ? 'todo' : 'ok',
        !status.claude.installed ? '설치하면 Claude Code로 작업할 수 있습니다' : status.claude.loggedIn === false ? '로그인이 필요합니다(작업을 열면 로그인 버튼이 보입니다)' : status.claude.version,
        !status.claude.installed ? help('설치 안내', 'claude') : null),
      row('GitHub CLI', !status.github.installed ? 'off' : status.github.loggedIn ? 'ok' : 'todo',
        !status.github.installed ? '선택: 설치하면 PR 만들기와 PR 피드백을 쓸 수 있습니다' : status.github.loggedIn ? (status.github.user ? status.github.user + ' 로그인됨' : '로그인됨') : '터미널에서 gh auth login으로 로그인하세요')
    );
    if (!status.codex.installed && !status.claude.installed) start.disabled = true;
  }, () => { if (epoch === renderEmptyTask.epoch) list.replaceChildren(row('에이전트 CLI', 'todo', '상태를 확인하지 못했습니다')); });
}

function renderHome(refresh = false) {
  const feed = byId('chat-feed');
  const card = document.createElement('section');
  card.className = 'onboarding home';
  const title = document.createElement('h2');
  title.textContent = '이어서 작업하기';
  const list = document.createElement('ul');
  list.className = 'home-recent';
  const recent = [...tasks].sort((a, b) => (b.activeAt ?? b.createdAt ?? 0) - (a.activeAt ?? a.createdAt ?? 0)).slice(0, 6);
  for (const task of recent) {
    const item = document.createElement('li');
    const open = button('', () => chooseTask(task));
    const name = document.createElement('span');
    name.className = 'home-recent-name';
    name.textContent = task.name;
    const where = document.createElement('span');
    where.className = 'home-recent-where';
    where.textContent = (task.worktree?.branch ?? '기본 체크아웃') + ' · ' + (task.cwd.split(/[\\/]/).filter(Boolean).at(-1) ?? task.cwd);
    const age = document.createElement('span');
    age.className = 'home-recent-age';
    age.textContent = timeAgo(task.activeAt ?? task.createdAt);
    open.append(agentMark(task.provider), name, where, age);
    item.append(open);
    list.append(item);
  }
  const actions = document.createElement('div');
  actions.className = 'onboarding-actions';
  const start = button('새 에이전트 작업', () => newTask().catch(report));
  start.className = 'primary';
  actions.append(start, button('폴더 열기', () => byId('add-workspace').click()), button('PowerShell 열기', () => newShellTab()));
  card.append(title, list, actions);
  feed.replaceChildren(card);
  // The checklist comes back on its own if an agent CLI went missing or logged out.
  const epoch = renderEmptyTask.epoch = (renderEmptyTask.epoch ?? 0) + 1;
  api.onboardingStatus(refresh).then(status => {
    if (epoch !== renderEmptyTask.epoch || !card.isConnected) return;
    const claudeReady = status.claude.installed && status.claude.loggedIn !== false;
    const problem = !status.codex.installed && !claudeReady;
    if (problem) renderEmptyTask(false, true);
  }, () => {});
}

function resetTime(seconds) {
  if (!Number.isFinite(seconds) || seconds <= 0) return '';
  const time = new Date(seconds * 1000);
  if (Number.isNaN(time.getTime())) return '';
  return ' · ' + time.toLocaleString('ko-KR', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' }) + ' 초기화';
}

// state: undefined = data arrived, 'missing' = Codex CLI not found, 'failed' = query error.
function showCodexUsage(data, state) {
  const bucket = data?.rateLimitsByLimitId?.codex ?? data?.rateLimits;
  const windows = [bucket?.primary, bucket?.secondary].filter(window => Number.isFinite(window?.usedPercent));
  const labels = windows.map(window => {
    const hours = window.windowDurationMins / 60;
    return (hours === 168 ? '7일 ' : Number.isFinite(hours) ? hours + '시간 ' : '') +
      Math.round(window.usedPercent) + '% 사용' + resetTime(window.resetsAt);
  });
  const output = byId('codex-usage');
  // Orca's status bar: what is left in each window and how long until it resets.
  output.textContent = windows.length ? windows.map(entry => remainingLabel(entry.usedPercent, entry.resetsAt)).join(' · ')
    : state === 'missing' ? 'CLI 없음' : state === 'failed' ? '조회 실패' : '한도 정보 없음';
  output.title = windows.length ? labels.join(' / ') : state === 'missing' ? 'Codex CLI를 찾지 못했습니다.'
    : state === 'failed' ? 'Codex 한도를 조회하지 못했습니다. 새로 고침으로 다시 시도하세요.' : 'Codex가 한도 정보를 보내지 않았습니다.';
  updateUsageMeter('codex-meter', windows[0]?.usedPercent);
}

function untilReset(seconds) {
  if (!Number.isFinite(seconds)) return '';
  const minutes = Math.max(0, Math.round((seconds * 1000 - Date.now()) / 60000));
  if (minutes >= 1440) return Math.floor(minutes / 1440) + 'd ' + Math.floor(minutes % 1440 / 60) + 'h';
  if (minutes >= 60) return Math.floor(minutes / 60) + 'h ' + minutes % 60 + 'm';
  return minutes + 'm';
}

function remainingLabel(usedPercent, resetsAt) {
  return [Math.max(0, Math.round(100 - usedPercent)) + '%', untilReset(resetsAt)].filter(Boolean).join(' ');
}

// The meter shows what is left (full = plenty), like Orca.
function updateUsageMeter(id, usedPercent) {
  const meter = byId(id);
  meter.hidden = !Number.isFinite(usedPercent);
  if (!meter.hidden) meter.value = Math.min(100, Math.max(0, 100 - usedPercent));
}

async function refreshCodexUsage() {
  const button = byId('refresh-codex-usage');
  if (button.disabled) return;
  button.disabled = true;
  try {
    const data = await api.codexUsage();
    showCodexUsage(data, data === null ? 'missing' : undefined);
  } catch { showCodexUsage(null, 'failed'); }
  finally { button.disabled = false; }
}

let claudeLimit;
let claudeTokens;
function updateClaudeUsage({ limit, tokens }) {
  if (limit) claudeLimit = limit;
  // Cache reads re-use earlier context and dwarf the new work, so they are reported apart.
  if (tokens) claudeTokens = {
    used: (tokens.input_tokens ?? 0) + (tokens.output_tokens ?? 0) + (tokens.cache_creation_input_tokens ?? 0),
    cached: tokens.cache_read_input_tokens ?? 0
  };
  const label = [];
  if (Number.isFinite(claudeLimit?.utilization)) {
    label.push(Math.round(claudeLimit.utilization * 100) + '% 사용' + resetTime(claudeLimit.resetsAt));
  } else if (claudeLimit?.status === 'rejected') {
    label.push('한도 도달' + resetTime(claudeLimit.resetsAt));
  } else if (claudeLimit?.status === 'allowed_warning') {
    label.push('한도 임박' + resetTime(claudeLimit.resetsAt));
  }
  if (claudeTokens) label.push('최근 요청 ' + claudeTokens.used.toLocaleString('ko-KR') + ' 토큰' +
    (claudeTokens.cached ? ' (캐시 재사용 ' + claudeTokens.cached.toLocaleString('ko-KR') + ' 별도)' : ''));
  byId('claude-usage').textContent = label.length ? (Number.isFinite(claudeLimit?.utilization)
    ? remainingLabel(claudeLimit.utilization * 100, claudeLimit.resetsAt) : label[0]) : '–';
  byId('claude-usage').title = label.join(' / ');
  updateUsageMeter('claude-meter', claudeLimit?.utilization * 100);
}

byId('refresh-codex-usage').onclick = refreshCodexUsage;
setPanelIcon(byId('refresh-codex-usage'), 'refresh');
setPanelIcon(byId('sleep-icon'), 'power');
setPanelIcon(byId('resource-icon'), 'resource');

function showSleepState(state) {
  const label = byId('sleep-label');
  label.textContent = state.mode === 'off' ? '절전 허용'
    : state.active ? '절전 방지 중' : '터미널 대기';
  byId('sleep-button').dataset.active = String(state.active);
  for (const option of byId('sleep-menu').querySelectorAll('[data-sleep]')) {
    option.setAttribute('aria-pressed', String(option.dataset.sleep === state.mode));
  }
}

api.onSleepState(showSleepState);
async function setSleepMode(mode) {
  const state = await api.sleepMode(mode);
  showSleepState(state);
  localStorage.setItem('workbench-sleep-mode', mode);
}
for (const option of byId('sleep-menu').querySelectorAll('[data-sleep]')) {
  option.onclick = () => {
    byId('sleep-menu').hidePopover();
    setSleepMode(option.dataset.sleep).catch(report);
  };
}
const sleepPreference = localStorage.getItem('workbench-sleep-mode');
setSleepMode(['always', 'terminal'].includes(sleepPreference) ? sleepPreference : 'off').catch(report);

async function refreshResources() {
  const summary = byId('resource-summary');
  const refresh = byId('refresh-resources');
  if (refresh.disabled) return;
  refresh.disabled = true;
  summary.textContent = '메모리 확인 중…';
  try {
    const snapshot = await api.resources();
    const rows = byId('resource-rows');
    rows.replaceChildren();
    const memory = bytes => Number.isFinite(bytes) ? (bytes / 1048576).toFixed(1) + ' MiB' : '—';
    const add = (name, bytes) => {
      const row = rows.insertRow();
      row.insertCell().textContent = name;
      row.insertCell().textContent = memory(bytes);
    };
    add('Workbench · 프로세스 ' + snapshot.appProcesses + '개', snapshot.appBytes);
    let total = snapshot.appBytes;
    for (const terminal of snapshot.terminals) {
      const pane = panes.get(terminal.id);
      if (!pane) continue;
      add(pane.tab.name + (pane.tab.panes.length > 1 ? ' · 패널 ' + (pane.tab.panes.indexOf(pane) + 1) : '')
        + ' · 프로세스 ' + terminal.count + '개', terminal.bytes);
      total += terminal.bytes ?? 0;
    }
    add('합계', total);
    rows.lastElementChild.className = 'resource-total';
    summary.textContent = '터미널 ' + snapshot.terminals.length + '개 · 작업 관리자 "메모리"와 같은 고유 메모리 기준';
  } catch {
    byId('resource-rows').replaceChildren();
    summary.textContent = '메모리 정보를 읽지 못했습니다.';
  } finally { refresh.disabled = false; }
}
byId('refresh-resources').onclick = refreshResources;
byId('resource-menu').addEventListener('toggle', event => {
  if (event.newState === 'open') refreshResources();
});
