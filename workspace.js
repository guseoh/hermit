
const taskKey = 'agent-workbench-tasks-v1';
const taskWorktreeKey = 'agent-task-worktree';
let tasks;
try { tasks = JSON.parse(localStorage.getItem(taskKey) ?? '[]'); } catch { tasks = []; }
for (const task of tasks) {
  if (['waiting', 'preparing'].includes(task.handoffSchedule?.state)) task.handoffSchedule.state = 'paused';
}
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
const removedProjectsKey = 'agent-removed-projects';
let removedProjects;
try { removedProjects = new Set(JSON.parse(localStorage.getItem(removedProjectsKey) ?? '[]')); }
catch { removedProjects = new Set(); }
const projectKey = folder => folder.replace(/\//g, '\\').replace(/\\+$/, '').toLowerCase();

function setProjectRemoved(key, removed) {
  if (removed === removedProjects.has(key)) return;
  if (removed) removedProjects.add(key);
  else removedProjects.delete(key);
  localStorage.setItem(removedProjectsKey, JSON.stringify([...removedProjects]));
}

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
  const focused = panelTask(focusedPanel);
  if (focused) localStorage.setItem('agent-last-task', focused.id);
}

function runtime(task) {
  if (!runtimes.has(task.id)) runtimes.set(task.id, {
    status: '연결 준비 중', items: new Map(), approvals: new Map(), draft: task.draft ?? '',
    queue: (task.queue ?? []).map(entry => ({ ...entry, status: entry.status === 'sending' ? 'failed' : entry.status }))
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
  scheduleFit();
}

function setReview(mode) {
  byId('results-panel').dataset.review = mode;
  byId('review-title').textContent = { changes: '변경사항', results: '터미널 결과', planner: '플래너', github: 'GitHub' }[mode] ?? '';
  byId('review-changes').setAttribute('aria-pressed', String(mode === 'changes'));
  byId('review-results').setAttribute('aria-pressed', String(mode === 'results'));
  byId('review-planner').setAttribute('aria-pressed', String(mode === 'planner'));
  byId('review-github').setAttribute('aria-pressed', String(mode === 'github'));
  if (mode === 'changes') refreshGit();
  else document.body.classList.remove('diff-wide');
  if (mode === 'github') refreshGitHub();
}

function openReview(mode) {
  // 에이전트 현황은 검토 패널이 아니라 메인 작업 영역의 탭으로 연다.
  if (mode === 'agents') return openAgentsBoard();
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
  const tab = panelTree.querySelector('[data-task-id="' + CSS.escape(task.id) + '"]')
    ?? byId('workbench-tabs').querySelector('[data-task-id="' + CSS.escape(task.id) + '"]');
  if (tab) {
    tab.dataset.status = label;
    tab.querySelector('.state-glyph')?.replaceWith(stateGlyph(kind));
  }
  const row = byId('task-list').querySelector('[data-task-row="' + CSS.escape(task.id) + '"] .state-glyph');
  row?.replaceWith(stateGlyph(kind));
  window.scheduleAgentsBoard?.();
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

// 채팅 승인 카드와 에이전트 현황판이 함께 쓰는 승인·거절.
// decision: true·'accept'(이번만), 'session'(이 세션 동안), false·'decline'(거절).
// Codex는 세션 허용을 서버가 기억하고(acceptForSession), Claude는 Hermit이 작업별로 기억해 같은 요청을 자동 허용한다.
async function answerApproval(task, request, decision) {
  const state = runtime(task);
  if (!state.approvals.has(request.id)) return;
  const value = decision === true ? 'accept' : decision === false ? 'decline' : decision;
  await api.chatApprove(state.taskId, request.id, value);
  state.approvals.delete(request.id);
  if (value === 'session' && task.provider === 'claude') {
    const key = approvalPolicy.sessionKey(approvalPolicy.approvalSubject(request));
    (state.sessionAllow ??= new Set()).add(key);
    for (const other of [...state.approvals.values()]) {
      if (approvalPolicy.sessionKey(approvalPolicy.approvalSubject(other)) === key) await answerApproval(task, other, 'accept');
    }
  }
  updateTaskStatus(task);
  renderChat();
}

// ── 승인 규칙: 전역·프로젝트별 명령 접두사 허용·거부 목록(거부 우선) ──────────────────
const approvalPolicyKey = 'agent-approval-policy-v1';
function loadApprovalPolicy() {
  return approvalPolicy.parsePolicy(localStorage.getItem(approvalPolicyKey) ?? 'null');
}
function saveApprovalPolicy(policy) {
  for (const [key, entry] of Object.entries(policy.projects)) if (!entry.allow.length && !entry.deny.length) delete policy.projects[key];
  localStorage.setItem(approvalPolicyKey, JSON.stringify(policy));
}
function taskProjectKey(task) {
  return projectKey(task.worktree?.root ?? task.handoffRoot ?? task.cwd);
}
function addApprovalRule(task, list, rule) {
  const policy = loadApprovalPolicy();
  const entry = policy.projects[taskProjectKey(task)] ??= { allow: [], deny: [] };
  if (!entry[list].includes(rule)) entry[list].push(rule);
  saveApprovalPolicy(policy);
}

// 규칙이나 이 세션 허용에 걸리면 묻지 않고 바로 답한다.
function autoApproval(task, request) {
  const subject = approvalPolicy.approvalSubject(request);
  const ruled = approvalPolicy.decide(loadApprovalPolicy(), taskProjectKey(task), subject);
  if (ruled) return ruled;
  if (task.provider === 'claude' && runtime(task).sessionAllow?.has(approvalPolicy.sessionKey(subject))) {
    return { action: 'allow', rule: '이 세션 허용', scope: '세션' };
  }
  return null;
}

function applyAutoApproval(task, request, decision) {
  const state = runtime(task);
  const subject = approvalPolicy.approvalSubject(request);
  const target = subject.command ?? subject.tool ?? subject.label;
  api.chatApprove(state.taskId, request.id, decision.action === 'deny' ? 'decline' : 'accept').catch(report);
  if (decision.action === 'deny') {
    state.status = decision.scope + ' 규칙으로 거절: ' + target;
    toast(agentName(task) + ' 요청을 ' + decision.scope + ' 규칙(' + decision.rule + ')으로 거절했습니다: ' + target, { kind: 'warn' });
  } else state.status = decision.scope + ' 규칙으로 허용: ' + target;
}

// 승인 카드의 단축키: 입력 중이 아니고 터미널 밖일 때 Y(이번만)·A(이 세션)·N(거절)이 현재 작업의 첫 승인에 답한다.
function approvalKeysActive() {
  const active = document.activeElement;
  if (active?.closest?.('.terminal-pane') || active?.matches?.('input, textarea, select, [contenteditable=""], [contenteditable="true"]')) return false;
  return !!actionTask() && runtime(actionTask()).approvals.size > 0;
}
function answerFirstApproval(decision) {
  const task = actionTask();
  const request = task && runtime(task).approvals.values().next().value;
  if (request) return answerApproval(task, request, decision);
}

function tasksSidebar() {
  const list = byId('task-list');
  list.replaceChildren();
  taskStatusLabels.clear();
  const projects = new Map([...projectFolders].map(folder => [projectKey(folder), { folder, entries: [] }]));
  const query = byId('project-search').value.trim().toLowerCase();
  for (const task of tasks) {
    const folder = task.worktree?.root ?? task.handoffRoot ?? task.cwd;
    const key = projectKey(folder);
    if (!projects.has(key)) projects.set(key, { folder, entries: [] });
    projects.get(key).entries.push(task);
  }
  for (const [key, { folder, entries }] of projects) {
    if (removedProjects.has(key)) continue;
    const matching = entries.filter(task => (folder + ' ' + task.name + ' ' + agentName(task) + ' ' + (task.worktree?.branch ?? '')).toLowerCase().includes(query));
    if (!matching.length && !folder.toLowerCase().includes(query)) continue;
    const group = document.createElement('section');
    group.className = 'group project-group';
    const header = document.createElement('div');
    header.className = 'project-heading';
    const folded = !query && foldedProjects.has(key);
    const name = button('', () => {
      if (foldedProjects.has(key)) foldedProjects.delete(key);
      else foldedProjects.add(key);
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
    const add = button('', () => newTask(undefined, folder).catch(report));
    add.className = 'icon-button';
    setPanelIcon(add, 'plus');
    add.title = add.ariaLabel = '이 폴더에서 새 작업 (Ctrl+N)';
    const remove = button('', () => {
      setProjectRemoved(key, true);
      foldedProjects.delete(key);
      tasksSidebar();
      byId('add-workspace').focus();
      toast(projectName.textContent + ' 프로젝트를 목록에서 제거했습니다.', {
        action: { label: '실행 취소', run: () => { setProjectRemoved(key, false); tasksSidebar(); } }
      });
    });
    remove.className = 'icon-button project-remove';
    setPanelIcon(remove, 'close');
    remove.title = remove.ariaLabel = projectName.textContent + ' 프로젝트를 목록에서 제거';
    const shell = button('', () => newShellTab(folder).catch(report));
    shell.className = 'icon-button';
    setPanelIcon(shell, 'terminal');
    shell.title = shell.ariaLabel = '이 폴더에 PowerShell 열기';
    header.append(name, shell, add, remove);
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
  appendWorkAreaTabs(strip, primaryChatPanel.workArea);
  arrangeWorkTabStrip(primaryChatPanel.workArea);
  revealActiveWorkTab(strip);
  localStorage.setItem(openTasksKey, JSON.stringify([...openTasks]));
}

function registerChatTabMenu(element, task) {
  element.addEventListener('contextmenu', event => {
    event.preventDefault();
    if (panelMenu.matches(':popover-open')) panelMenu.hidePopover();
    panelMenu.replaceChildren();
    const anchor = splitChats.get(task.id)?.workArea.panel ?? primaryChatPanel;
    for (const [direction, label] of [['right', '오른쪽에 분할로 열기'], ['down', '아래에 분할로 열기']]) {
      panelMenu.append(button(label, () => { panelMenu.hidePopover(); openSplitChat(task, anchor, direction); }));
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
    tab.workspaceTab = item;
    tab.dataset.active = String(item === area.current);
    const select = button('', () => activateWorkAreaTab(item));
    select.title = (item.panes ? item.activePane?.cwd ?? item.name : item.name) + ' · 끌어서 분할';
    select.setAttribute('aria-current', tab.dataset.active);
    const icon = item.chatTask ? agentMark(item.chatTask.provider) : document.createElement('span');
    if (!item.chatTask) setPanelIcon(icon, item.icon ?? 'terminal');
    const label = document.createElement('span');
    label.textContent = item.chatTask?.name ?? item.name;
    select.append(icon, label);
    if (item.chatTask) {
      label.className = 'work-tab-label';
      tab.dataset.taskId = item.chatTask.id;
      tab.dataset.status = taskStatus(runtime(item.chatTask));
      select.append(stateGlyph(taskState(runtime(item.chatTask))));
      registerChatTabMenu(select, item.chatTask);
    }
    select.ondblclick = () => {
      if (item.panes) { selectTab(item, false); byId('rename').click(); }
    };
    registerWorkAreaDrag(select, item);
    const close = button('', () => item.chatTask ? requestCloseTask(item.chatTask) : item.panes ? closeTab(item) : closeDocumentTab(item));
    close.ariaLabel = label.textContent + ' 탭 닫기';
    setPanelIcon(close, 'close');
    tab.append(select, close);
    strip.append(tab);
  }
}

function chooseTask(task) {
  if (closedTasks.delete(task.id)) localStorage.setItem(closedTasksKey, JSON.stringify([...closedTasks]));
  let tab = splitChats.get(task.id);
  if (!tab) {
    tab = createDockedChat(task);
    attachWorkAreaTab(tab, primaryChatPanel.workArea, false);
  }
  activateWorkAreaTab(tab);
}

// Both CLIs advertise the models and the effort steps that they accept.
const effortLabels = { none: '없음', minimal: '최소', low: '낮음', medium: '보통', high: '높음', xhigh: '매우 높음', max: '최대' };

function applyClaudeCatalog(task, catalog) {
  if (!catalog) return;
  const state = runtime(task);
  if (catalog.cliVersion) state.cliVersion = catalog.cliVersion;
  if (catalog.models?.length) state.models = catalog.models;
  if (catalog.defaultModel) state.defaultModel = catalog.defaultModel;
  // Older Hermit versions stored the family alias for Fable.
  if (task.model === 'fable' && state.models?.length && !state.models.some(model => model.id === task.model)) {
    const replacement = state.models.find(model => /^claude-fable-/.test(model.id));
    if (replacement) task.model = replacement.id;
  }
}

function modelForEffort(task) {
  const state = runtime(task);
  const id = task.model || state.model;
  return task.model ? state.models?.find(model => model.id === id)
    : state.defaultModel ?? state.models?.find(model => model.id === id || model.isDefault);
}

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
  modelSelect.hidden = !models.length;
  modelSelect.title = state.cliVersion ? '모델 · Claude Code ' + state.cliVersion : '모델';
  const defaultName = state.defaultModel?.resolved
    ? models.find(model => model.resolved === state.defaultModel.resolved)?.name ?? state.defaultModel.resolved
    : models.find(model => model.id === state.model || model.isDefault)?.name ?? state.model;
  const options = [['', defaultName ? '기본 모델 · ' + defaultName : '기본 모델'], ...models.map(model => [model.id, model.name])];
  if (task.model && !options.some(([id]) => id === task.model)) options.push([task.model, task.model + ' · 저장된 설정']);
  fillPicker(modelSelect, options, task.model ?? '');
  const chosen = modelForEffort(task);
  const efforts = chosen?.efforts ?? [];
  const defaultEffort = task.model ? chosen?.defaultEffort : state.serverEffort ?? chosen?.defaultEffort;
  const selected = efforts.includes(task.effort) ? efforts.indexOf(task.effort) + 1 : 0;
  const label = selected ? (effortLabels[task.effort] ?? task.effort)
    : '기본' + (defaultEffort ? ' · ' + (effortLabels[defaultEffort] ?? defaultEffort) : '');
  effortSelect.max = efforts.length;
  effortSelect.value = selected;
  effortSelect.setAttribute('aria-valuetext', label);
  get('chat-effort-label').textContent = '추론 ' + label;
  get('chat-effort-control').hidden = !efforts.length;
  modelSelect.disabled = effortSelect.disabled = !!state.busy;
}

function bindModelPicker(currentTask, get) {
  get('chat-model').onchange = event => {
    const task = currentTask();
    if (!task) return;
    task.model = event.target.value || undefined;
    const efforts = modelForEffort(task)?.efforts ?? [];
    if (task.effort && !efforts.includes(task.effort)) task.effort = undefined;
    persist();
    scheduleChat();
  };
  get('chat-effort').oninput = event => {
    const task = currentTask();
    if (!task) return;
    task.effort = modelForEffort(task)?.efforts?.[Number(event.target.value) - 1];
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
    if (task.provider === 'claude' && result.turns.some(turn => turn.sessionId)) task.threadId = result.threadId;
    state.model = result.model;
    state.serverEffort = result.effort ?? null;
    state.models = result.models ?? [];
    if (task.provider === 'claude') applyClaudeCatalog(task, result.catalog);
    state.authRequired = result.loggedIn === false;
    state.items = new Map([...result.turns.flatMap(turn => turn.items ?? [])]
      .map(item => [item.id, item]));
    state.connected = true;
    state.reconnectAttempt = 0;
    setTimeout(() => flushQueue(task), 0);
    if (!state.busy) state.status = task.provider !== 'claude' ? '준비됨'
      : result.loggedIn === false ? '로그인 필요'
      : result.loggedIn !== true ? '로그인 상태 확인 불가'
      : result.catalog ? '연결 확인 · 첫 요청 대기' : '로그인됨 · 초기화 확인 실패';
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
  if (item.type === 'reasoning') return reasoningText(item) || '(생각 내용이 기록되지 않았습니다)';
  return item.title ?? item.name ?? item.type;
}

// Codex는 요약(summary)과 원문(content)을, Claude는 thinking 원문을 준다. 스트리밍 중에는 text에 쌓인다.
function reasoningText(item) {
  const summary = (item.summary ?? []).filter(Boolean).join('\n\n');
  const content = (item.content ?? []).filter(Boolean).join('\n\n');
  return (summary || content || item.text || '').trim();
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
  if (item.type === 'reasoning') {
    // 첫 줄(Codex 요약의 **제목**)을 한 줄로 보여 준다.
    const first = reasoningText(item).split('\n').find(line => line.trim())?.replace(/[*_`#]/g, '').trim() ?? '';
    return '생각' + (first ? ' · ' + first.slice(0, 100) : '') + (running ? ' · 진행 중' : '');
  }
  return item.type;
}


// 마크다운 렌더링은 renderer/chat/markdown.mjs가 맡는다(블록 단위 증분 렌더, 코드 복사·구문 강조, 링크).
function renderMessage(node, text) {
  markdown.renderMarkdown(node, text ?? '');
}

function renderChat() {
  const primary = panelTask(primaryChatPanel);
  if (primary) {
    byId('main-panel-label').textContent = primary.name;
    byId('main-panel-folder').textContent = primary.cwd;
    renderTaskHeader(primary, runtime(primary));
  }
  if (selectedTask) {
    const state = runtime(selectedTask);
    document.body.classList.toggle('codex-terminal-mode', !!state.terminalMode);
  }
  for (const panel of splitChats.values()) {
    renderChatView(panel.chatTask, panel.getChatPart);
    renderTaskHeader(panel.chatTask, runtime(panel.chatTask), panel.getChatPart);
  }
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
  for (const [key, label] of [['@', '파일·터미널·작업·노트 넣기'], ['/', '명령 쓰기'], ['Enter', '보내기 · Shift+Enter 줄바꿈']]) {
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

// 파일을 읽거나 찾기만 하는 도구 단계. 세 개 이상 이어지면 한 줄로 접는다.
const readOnlyTools = new Set(['read', 'grep', 'glob', 'ls', 'webfetch', 'websearch', 'notebookread', 'todoread', 'listmcpresourcestool', 'readmcpresourcetool']);
function readOnlyStep(item) {
  if (item.type === 'toolUse') return readOnlyTools.has(String(item.title ?? '').toLowerCase()) && !item.isError;
  if (item.type === 'commandExecution') {
    const actions = item.commandActions ?? [];
    return actions.length > 0 && actions.every(action => ['read', 'listFiles', 'search'].includes(action.type)) &&
      !(Number.isFinite(item.exitCode) && item.exitCode !== 0);
  }
  return false;
}

// 노드는 옮기지 않고 클래스만 붙인다(항목별 노드 재사용을 깨지 않도록). 묶음의 첫 노드에 펼치기 버튼을 둔다.
function foldReadSteps(feed, task) {
  const state = runtime(task);
  const runs = [];
  let run = [];
  for (const node of feed.querySelectorAll(':scope > [data-item]')) {
    if (node.dataset.readonly === 'true' && node.dataset.status !== 'running') run.push(node);
    else { if (run.length) runs.push(run); run = []; }
  }
  if (run.length) runs.push(run);
  for (const group of runs) {
    const folded = group.length >= 3;
    const key = group[0].dataset.item;
    const open = !!state.openReadGroups?.has(key);
    group.forEach((node, index) => {
      node.classList.toggle('read-step-hidden', folded && !open && index > 0);
      node.classList.toggle('read-step-collapsed', folded && !open && index === 0);
      if (index > 0 || !folded) node.querySelector(':scope > .read-group-toggle')?.remove();
    });
    if (!folded) continue;
    let toggle = group[0].querySelector(':scope > .read-group-toggle');
    if (!toggle) {
      toggle = button('', () => {
        const groups = state.openReadGroups ??= new Set();
        if (!groups.delete(key)) groups.add(key);
        // 누른 즉시 다시 그린다(가려진 창에서는 requestAnimationFrame이 멈춘다).
        renderChat();
      });
      toggle.className = 'read-group-toggle';
      group[0].prepend(toggle);
    }
    toggle.textContent = (open ? '접기 · ' : '') + '파일 읽기·검색 ' + group.length + '단계';
    toggle.setAttribute('aria-expanded', String(open));
  }
}

// 메시지 동작: 복사, 여기서 분기(이 지점까지의 대화를 맥락으로 담아 작업 런처를 연다).
function branchPrompt(task, itemId) {
  const state = runtime(task);
  const entries = [...state.items.values()].filter(item => ['userMessage', 'agentMessage'].includes(item.type));
  const index = entries.findIndex(item => item.id === itemId);
  if (index < 0) return '';
  const target = entries[index];
  const history = entries.slice(Math.max(0, index - 8), target.type === 'userMessage' ? index : index + 1)
    .map(item => (item.type === 'userMessage' ? '사용자' : agentName(task)) + ': ' + clip(itemText(item), 1500));
  return [
    '다음은 작업 "' + task.name + '" (' + agentName(task) + ', ' + task.cwd + ')의 대화에서 이어지는 새 작업입니다.',
    history.length ? '이전 대화:\n' + history.join('\n\n') : '',
    target.type === 'userMessage' ? '요청:\n' + itemText(target) : '위 답변을 바탕으로 이어서 진행하세요.'
  ].filter(Boolean).join('\n\n');
}

function messageActions(task, itemId) {
  const bar = document.createElement('div');
  bar.className = 'message-actions';
  const copy = button('복사', async () => {
    const item = runtime(task).items.get(itemId);
    try {
      await api.copy(item ? itemText(item) : '');
      copy.textContent = '복사됨';
    } catch { copy.textContent = '복사 실패'; }
    setTimeout(() => { copy.textContent = '복사'; }, 1500);
  });
  copy.title = '메시지 원문 복사';
  const branch = button('여기서 분기', () => {
    const root = task.worktree?.root ?? task.handoffRoot ?? task.cwd;
    newTask(task.provider, root, undefined, branchPrompt(task, itemId))
      .then(() => { byId('task-name').value = '분기 · ' + task.name; }).catch(report);
  });
  branch.title = '이 지점까지의 대화를 담아 새 작업을 시작합니다';
  bar.append(copy, branch);
  return bar;
}

function planFromTodos(todos) {
  return todos.map(todo => ({
    step: todo.status === 'in_progress' ? todo.activeForm || todo.content : todo.content,
    status: { in_progress: 'inProgress', completed: 'completed' }[todo.status] ?? 'pending'
  }));
}

// 라이브 체크리스트: 에이전트가 세운 계획을 입력창 위에 진행도와 함께 붙여 둔다. 펼치면 단계 전체를 본다.
function renderPlanBar(task, get) {
  const bar = get('chat-plan');
  if (!bar) return;
  const state = runtime(task);
  const plan = Array.isArray(state.plan) ? state.plan.filter(entry => entry?.step) : [];
  bar.hidden = !plan.length;
  if (!plan.length) return;
  const done = plan.filter(entry => entry.status === 'completed').length;
  const current = plan.find(entry => entry.status === 'inProgress');
  const key = JSON.stringify(plan.map(entry => [entry.step, entry.status]));
  if (bar.dataset.key === key) return;
  bar.dataset.key = key;
  bar.dataset.complete = String(done === plan.length);
  const summary = bar.querySelector('summary');
  const meter = document.createElement('progress');
  meter.max = plan.length;
  meter.value = done;
  meter.setAttribute('aria-label', '계획 진행 ' + done + '/' + plan.length);
  const label = document.createElement('span');
  label.className = 'chat-plan-label';
  label.textContent = done === plan.length ? '계획 완료' : current ? current.step : '다음 단계 대기';
  const count = document.createElement('span');
  count.className = 'chat-plan-count';
  count.textContent = done + '/' + plan.length;
  summary.replaceChildren(meter, label, count);
  bar.querySelector('ol').replaceChildren(...plan.map(entry => {
    const row = document.createElement('li');
    row.dataset.status = entry.status;
    row.textContent = entry.step;
    return row;
  }));
}

function renderChatView(task, get) {
  const state = runtime(task);
  renderPlanBar(task, get);
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
          if (item.type !== 'plan') node.append(messageActions(task, item.id));
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
        node.dataset.readonly = String(readOnlyStep(item));
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
  foldReadSteps(feed, task);
  markAgentTurns(feed, task);
  if (stick) feed.scrollTop = feed.scrollHeight;
  const queue = get('chat-queue');
  queue.hidden = !state.queue?.length;
  queue.replaceChildren(...(state.queue ?? []).map((entry, index) => {
    const chip = document.createElement('span');
    chip.className = 'queue-chip';
    const label = document.createElement('span');
    label.textContent = (entry.status === 'failed' ? '전송 실패 · ' : entry.status === 'sending' ? '전송 중 · ' : (index + 1) + '. ') + entry.text.split('\n')[0];
    label.title = entry.text;
    const remove = button('', () => { state.queue = state.queue.filter(item => item !== entry); saveTaskInput(task); scheduleChat(); });
    remove.className = 'queue-remove';
    remove.title = remove.ariaLabel = '대기열에서 빼기';
    setPanelIcon(remove, 'close');
    remove.disabled = entry.status === 'sending';
    chip.append(label);
    if (entry.status === 'failed') chip.append(button('재시도', () => {
      entry.status = 'queued';
      saveTaskInput(task);
      scheduleChat();
      if (!state.connected) return connectTask(task);
      return flushQueue(task);
    }));
    chip.append(remove);
    return chip;
  }));
  const approvals = get('approval-list');
  if (approvals.dataset.key !== JSON.stringify([task.id, ...state.approvals.keys()])) {
    approvals.dataset.key = JSON.stringify([task.id, ...state.approvals.keys()]);
    approvals.replaceChildren();
    [...state.approvals.values()].forEach((request, index) => {
      const subject = approvalPolicy.approvalSubject(request);
      const risk = approvalPolicy.riskOf(subject);
      const card = document.createElement('div');
      card.className = 'approval';
      if (risk) card.dataset.risk = risk.level;
      const reason = document.createElement('p');
      reason.textContent = [subject.label + ' 승인', request.cwd, request.method === 'claude/approval' ? null : request.reason, request.grantRoot]
        .filter(Boolean).join(' · ');
      if (risk) {
        const badge = document.createElement('span');
        badge.className = 'approval-risk';
        badge.textContent = risk.label;
        reason.prepend(badge);
      }
      card.append(reason);
      const shown = subject.kind === 'command' ? subject.command : request.command;
      if (shown) {
        const details = document.createElement('pre');
        details.textContent = shown;
        card.append(details);
      }
      // 단축키는 첫 번째 승인 카드에만 붙는다.
      const keyed = (label, key) => {
        const node = document.createElement('span');
        node.textContent = label;
        if (index === 0) {
          const hint = document.createElement('kbd');
          hint.textContent = key;
          node.append(' ', hint);
        }
        return node;
      };
      const once = button('', () => answerApproval(task, request, 'accept').catch(report));
      once.className = 'primary';
      once.append(keyed('이번만 허용', 'Y'));
      const session = button('', () => answerApproval(task, request, 'session').catch(report));
      session.append(keyed('이 세션 허용', 'A'));
      session.title = task.provider === 'claude' ? '이 작업이 열려 있는 동안 같은 요청을 다시 묻지 않습니다' : '이 Codex 세션 동안 같은 요청을 다시 묻지 않습니다';
      const actions = [once, session];
      const rule = subject.kind === 'command' ? approvalPolicy.suggestPrefix(subject.command) : subject.kind === 'tool' ? 'tool:' + subject.tool : '';
      // 되돌리기 어려운 명령은 실수로 영구 허용하지 않도록 "항상 허용"을 내놓지 않는다.
      if (rule && risk?.level !== 'danger') {
        const always = button('항상 허용: ' + rule, () => {
          addApprovalRule(task, 'allow', rule);
          toast('이 프로젝트 허용 규칙에 추가했습니다: ' + rule, { kind: 'success', action: { label: '규칙 보기', run: () => showApprovalRules(task) } });
          return answerApproval(task, request, 'accept').catch(report);
        });
        always.title = '이 프로젝트에서 "' + rule + '"로 시작하는 명령을 앞으로 묻지 않고 허용합니다';
        actions.push(always);
      }
      const decline = button('', () => answerApproval(task, request, 'decline').catch(report));
      decline.className = 'ghost';
      decline.append(keyed('거절', 'N'));
      actions.push(decline);
      const row = document.createElement('div');
      row.className = 'approval-actions';
      row.append(...actions);
      card.append(row);
      approvals.append(card);
    });
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
  get('handoff-chat').disabled = !!(state.connecting || state.terminalMode || (state.busy && !state.activeTurnId));
  get('handoff-chat').textContent = { waiting: '이어받기 예약됨', preparing: '이어받기 전송 중', paused: '이어받기 보류됨' }[task.handoffSchedule?.state] ?? '이어받기';
  get('send-chat').disabled = !!state.restoring || !!state.switching || authBlocked || !draft.trim();
  get('send-chat').title = state.busy || state.connecting ? '대기열에 추가 (지금 턴이 끝나면 보냄)' : state.connected ? '보내기 (Enter)' : '연결하고 보내기 (Enter)';
}

const chatWindow = 150;

// 체크포인트로 파일 되돌리기. 되돌리기 전 상태도 저장되어, 토스트의 "되돌리기 취소"로 다시 돌아갈 수 있다.
async function restoreTurn(task, ref, undo = false) {
  const state = runtime(task);
  if (!ref || state.busy || state.connecting || state.restoring) return;
  if (!undo) {
    // 확인하는 동안에도 대기열 전송이 끼어들지 않도록 복원 중으로 표시해 둔다.
    state.restoring = true;
    scheduleChat();
    const accepted = await confirmAction({
      title: '파일을 체크포인트로 되돌릴까요?',
      target: task.name + '\n' + task.cwd,
      result: '이 요청을 보내기 직전 상태로 되돌립니다. 그 뒤에 바뀐 파일은 되돌아가고 새로 생긴 파일은 지워집니다.',
      note: '.gitignore 대상은 그대로 둡니다. 지금 상태는 따로 저장되어 토스트의 "되돌리기 취소"로 다시 돌아갈 수 있습니다.',
      confirmLabel: '되돌리기', danger: true
    });
    if (!accepted || state.busy || state.connecting) {
      state.restoring = false;
      scheduleChat();
      return;
    }
  }
  state.restoring = true;
  scheduleChat();
  try {
    const result = await api.checkpointRestore(task.cwd, task.id, ref);
    const message = (undo ? '되돌리기를 취소했습니다' : '파일을 되돌렸습니다') +
      ' · 복원 ' + result.restored + '개, 삭제 ' + result.deleted + '개';
    toast(message, { kind: 'success', action: undo ? undefined :
      { label: '되돌리기 취소', run: () => restoreTurn(task, result.backup, true) } });
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
  if (name === 'queue') { state.queue = state.queue.filter(entry => entry.status === 'sending'); saveTaskInput(task); scheduleChat(); }
}

// @ 멘션의 맥락 후보: 이 작업 폴더의 터미널 최근 출력, 다른 작업의 최근 답변, Markdown 노트, 프로젝트 규칙 파일.
// 터미널·작업·노트는 고르는 순간의 내용을 블록으로 넣고, 규칙 파일은 @경로로 넣어 에이전트가 직접 읽게 한다.
const ruleFilePattern = /(^|\/)(?:AGENTS|CLAUDE|GEMINI)\.md$|^\.agents\/|^\.claude\/(?:rules|commands|agents)\//i;
function clip(text, limit) {
  const value = String(text ?? '').trim();
  return value.length > limit ? '…' + value.slice(-limit) : value;
}
function mentionEntries(task, files) {
  const entries = [];
  const root = terminalFolderKey(task.cwd);
  for (const pane of panes.values()) {
    const where = terminalFolderKey(pane.promptDirectory || pane.cwd || pane.tab.cwd || '');
    if (pane.tab.owner !== task.id && !where.startsWith(root)) continue;
    const name = pane.tab.name + (pane.tab.panes.length > 1 ? ' · 패널 ' + (pane.tab.panes.indexOf(pane) + 1) : '');
    entries.push({ category: 'terminal', name, label: '터미널 · ' + name, hint: '최근 출력을 넣습니다',
      block: () => '[터미널 "' + name + '"의 최근 출력]\n```text\n' + clip(recentContext(pane).text, 6000) + '\n```' });
  }
  for (const other of tasks) {
    if (other === task || closedTasks.has(other.id)) continue;
    entries.push({ category: 'task', name: other.name, label: '작업 · ' + other.name, hint: agentName(other) + ' · 최근 답변을 넣습니다',
      block: () => '[다른 작업 "' + other.name + '" (' + agentName(other) + ', ' + (other.worktree?.branch ?? other.cwd) + ')의 최근 답변]\n'
        + (clip(lastAgentText(runtime(other)), 4000) || '(아직 답변이 없습니다)') });
  }
  for (const note of Object.values(notes)) {
    entries.push({ category: 'note', name: note.name, label: '노트 · ' + note.name, hint: '노트 내용을 넣습니다',
      // 리치 편집기가 끝에 남긴 빈 줄·&nbsp;는 맥락에 넣지 않는다.
      block: () => '[노트 "' + note.name + '"]\n' + clip(String(note.text ?? '').replace(/(?:\s|&nbsp;)+$/, ''), 6000) });
  }
  for (const file of files.filter(path => ruleFilePattern.test(path)).slice(0, 20)) {
    entries.push({ category: 'rule', name: file, label: '규칙 · ' + file, hint: '에이전트가 이 파일을 읽습니다', value: file });
  }
  return entries;
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
    const applied = choice.block ? composerAssist.insertBlock(input.value, token, choice.block())
      : composerAssist.applyChoice(input.value, token, choice.value);
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
      const mentions = composerAssist.rankMentions(mentionEntries(task, files), token.query, 5)
        .map(entry => ({ value: entry.value, block: entry.block, label: entry.label, hint: entry.hint }));
      const fileOptions = composerAssist.rankFiles(files, token.query).filter(file => !mentions.some(option => option.value === file))
        .map(file => ({ value: file, label: file }));
      options = [...mentions, ...fileOptions].slice(0, 10);
    }
    index = 0;
    render();
  };
  input.addEventListener('input', () => {
    const task = currentTask();
    if (task) saveTaskInput(task, input);
    update();
  });
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
    // 목록에서는 Enter로 이어 쓰고 Ctrl+Enter로 전송한다.
    if (event.key === 'Enter' && event.ctrlKey && !event.shiftKey && !event.altKey) {
      event.preventDefault();
      input.form?.requestSubmit();
    }
    if (event.key === 'Enter' && !event.shiftKey && !event.ctrlKey && !event.altKey) {
      event.preventDefault();
      const edit = composerAssist.continueList(input.value, input.selectionStart, input.selectionEnd);
      if (edit) {
        input.setRangeText(edit.text, edit.start, edit.end, 'end');
        input.dispatchEvent(new Event('input', { bubbles: true }));
        return;
      }
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
  toast('새 버전' + (version ? ' ' + version : '') + '을 받았습니다. 에이전트 작업이 없고 10분간 자리를 비우면 자동으로 설치하고 다시 시작합니다.', {
    kind: 'success', timeout: 60000, action: { label: '지금 설치', run: () => api.installUpdate() }
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

async function checkPullRequestFeedback(task, lookup = api.githubPrFeedback) {
  const state = runtime(task);
  let feedback;
  try { feedback = await lookup(task.cwd); }
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
  if (document.hidden || prWatchRunning || !chatPreferences.watchPullRequests) return;
  prWatchRunning = true;
  try {
    const requests = new Map();
    function lookup(cwd) {
      const key = terminalFolderKey(cwd);
      if (!requests.has(key)) requests.set(key, api.githubPrFeedback(cwd));
      return requests.get(key);
    }
    for (const task of tasks.filter(item => openTasks.has(item.id) && item.cwd)) {
      if (document.hidden || !chatPreferences.watchPullRequests) break;
      await checkPullRequestFeedback(task, lookup);
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
  if (method === 'claude/initialized') {
    applyClaudeCatalog(task, params);
    state.status = state.busy ? '작업 중' : '준비됨';
    persist();
  } else if (method === 'item/started' || method === 'item/completed') {
    const item = params.item;
    const key = item.type === 'userMessage' && item.clientId ? item.clientId : item.id;
    state.items.set(key, { ...item, id: key });
    // Claude의 할 일 목록(TodoWrite)을 Codex 계획과 같은 형태로 맞춰 체크리스트·현황판에 쓴다.
    if (item.type === 'toolUse' && /^TodoWrite$/i.test(item.title ?? '') && Array.isArray(item.input?.todos)) state.plan = planFromTodos(item.input.todos);
  } else if (method === 'item/reasoning/textDelta' || method === 'item/reasoning/summaryTextDelta') {
    const item = state.items.get(params.itemId) ?? { id: params.itemId, type: 'reasoning', text: '' };
    item.text = ((item.text ?? '') + (params.delta ?? '')).slice(-200000);
    state.items.set(item.id, item);
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
    state.activeTurnId = params.turn.id;
    state.turnStartedAt = Date.now();
    state.plan = null;
    state.status = '작업 중';
  } else if (method === 'turn/plan/updated') {
    state.plan = Array.isArray(params.plan) ? params.plan : null;
  } else if (method === 'turn/completed') {
    state.turnStartedAt = null;
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
      if (pending && !pending.queued) {
        const input = taskChatInput(task);
        if (input && !input.value) {
          input.value = pending.text;
          state.items.delete(pending.id);
        } else if (!input && !state.draft) {
          state.draft = pending.text;
          state.items.delete(pending.id);
        } else state.queue.unshift({ id: pending.id, text: pending.text, status: 'failed' });
      }
    } else if (params.turn.error?.message) state.status += ' · ' + params.turn.error.message;
    if (state.inflight?.queued && params.turn.status === 'failed' && !state.queue.some(entry => entry.id === state.inflight.id)) {
      state.queue.unshift({ id: state.inflight.id, text: state.inflight.text, status: 'failed' });
    }
    if (state.inflight && params.turn.status === 'failed') saveTaskInput(task);
    state.inflight = null;
    if (params.turn.authRequired) notifyTask(task, '로그인 필요', 'Claude Code 로그인 세션이 만료됐습니다.');
    else notifyTask(task, state.outcome, lastAgentText(state) || state.status);
    if (task === actionTask()) refreshGit(!chosenPatch?.selected.size);
  } else if (method === 'approval') {
    const decision = autoApproval(task, params);
    if (decision) applyAutoApproval(task, params, decision);
    else {
      state.approvals.set(params.id, params);
      notifyTask(task, '승인 요청', '에이전트가 명령 실행이나 파일 변경 승인을 기다립니다.');
    }
  } else if (method === 'approval/cancelled') {
    state.approvals.delete(params.id);
  } else if (method === 'usage/claude') {
    updateClaudeUsage(params, task);
    return;
  } else if (method === 'thread/tokenUsage/updated') {
    const usage = params.tokenUsage?.last;
    if (usage && Number.isFinite(usage.totalTokens)) {
      codexTokens = { task: task.name, total: usage.totalTokens, cached: usage.cachedInputTokens };
      renderCodexUsageDetail();
    }
    recordCodexUsage(params, task);
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
    if (task.handoffSchedule?.state === 'waiting') {
      task.handoffSchedule.state = 'paused';
      persist();
    }
    api.chatClose(id).catch(() => {}).finally(() => scheduleReconnect(task));
  } else if (method === 'notice' || method === 'error') {
    state.status = params.message ?? params.error?.message ?? agentName(task) + ' 오류';
  } else return;
  updateTaskStatus(task);
  if (task === selectedTask || splitChats.has(task.id)) scheduleChat();
  if (method === 'turn/completed') {
    state.activeTurnId = null;
    if (task.handoffSchedule?.state === 'waiting' && task.handoffSchedule.turnId === params.turn.id) runScheduledHandoff(task, params.turn.status).catch(report);
    else if (params.turn?.status === 'completed') setTimeout(() => flushQueue(task), 0);
    else if (state.queue?.length) {
      state.status += ' · 대기열 ' + state.queue.length + '개는 보내지 않고 남겨 두었습니다.';
      if (task === selectedTask || splitChats.has(task.id)) scheduleChat();
    }
  }
});

// 요청 첫 줄에서 작업 이름을 만든다. 마크다운 기호·명령 접두사를 걷어 내고 40자 안에서 단어 경계로 자른다.
function taskNameFromPrompt(text) {
  const line = String(text ?? '').split('\n').map(item => item.trim()).find(Boolean) ?? '';
  const clean = line.replace(/^(?:[#>*\-+]+|\d+[.)]|\/\w+)\s*/, '').replace(/[`*_~]/g, '').replace(/\s+/g, ' ').trim();
  if ([...clean].length <= 40) return clean;
  const cut = [...clean].slice(0, 40).join('');
  const space = cut.lastIndexOf(' ');
  return (space >= 20 ? cut.slice(0, space) : cut).trimEnd() + '…';
}

function uniqueTaskName(name) {
  const taken = new Set(tasks.map(task => task.name));
  if (!taken.has(name)) return name;
  let index = 2;
  while (taken.has(name + ' ' + index)) index++;
  return name + ' ' + index;
}

function updateTaskNamePreview() {
  byId('task-name').placeholder = taskNameFromPrompt(byId('task-prompt').value) || '예: 로그인 오류 수정';
}

async function newTask(provider, folder, panel, prompt) {
  const current = actionTask();
  chosenFolder = folder ?? current?.worktree?.root ?? current?.cwd ?? currentPane()?.cwd ?? await api.home();
  pendingPanel = panel;
  byId('task-cwd').textContent = chosenFolder;
  byId('task-prompt').value = typeof prompt === 'string' ? prompt.trim() : '';
  byId('task-name').value = '';
  updateTaskNamePreview();
  byId('task-worktree').checked = localStorage.getItem(taskWorktreeKey) !== 'off';
  byId('task-compare').checked = false;
  byId('task-roles').hidden = true;
  byId('task-codex-role').value = byId('task-claude-role').value = '';
  byId('task-worktree').disabled = false;
  byId('task-error').hidden = true;
  byId('task-dialog').querySelector('form').elements['task-provider'].value = provider ?? actionTask()?.provider ?? 'codex';
  byId('task-dialog').showModal();
  byId('task-prompt').focus();
}
byId('task-prompt').oninput = () => { updateTaskNamePreview(); byId('task-error').hidden = true; };
// Enter로 바로 시작, Shift+Enter는 줄바꿈. 한글 조합 중인 Enter는 무시한다.
byId('task-prompt').addEventListener('keydown', event => {
  if (event.key !== 'Enter' || event.shiftKey || event.isComposing || event.keyCode === 229) return;
  event.preventDefault();
  byId('task-dialog').querySelector('form').requestSubmit();
});
byId('add-workspace').onclick = async () => {
  try {
    const folder = await api.folder();
    if (!folder) return;
    const key = projectKey(folder);
    if (![...projectFolders].some(saved => projectKey(saved) === key)) projectFolders.add(folder);
    localStorage.setItem(projectFoldersKey, JSON.stringify([...projectFolders]));
    setProjectRemoved(key, false);
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
  byId('task-roles').hidden = !compare;
  byId('task-worktree').disabled = compare;
};

// 새 작업 만들기. 비교를 켜면 Codex·Claude 작업을 각자의 worktree로 하나씩 만들고 같은 첫 요청을 보낸다.
byId('task-dialog').querySelector('form').onsubmit = async event => {
  event.preventDefault();
  const form = event.currentTarget;
  if (byId('submit-task').disabled) return;
  const prompt = byId('task-prompt').value.trim() || null;
  const typed = byId('task-name').value.trim();
  if (!prompt && !typed) {
    byId('task-error').textContent = '요청이나 작업 이름을 입력하세요.';
    byId('task-error').hidden = false;
    byId('task-prompt').focus();
    return;
  }
  const name = typed || uniqueTaskName(taskNameFromPrompt(prompt));
  const compare = byId('task-compare').checked;
  const providers = compare ? ['codex', 'claude'] : [form.elements['task-provider'].value];
  const useWorktree = compare || byId('task-worktree').checked;
  if (!compare) localStorage.setItem(taskWorktreeKey, useWorktree ? 'on' : 'off');
  const compareGroup = compare ? crypto.randomUUID() : undefined;
  const roles = compare ? Object.fromEntries(providers.map(provider => [provider, byId('task-' + provider + '-role').value.trim()])) : {};
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
  const created = planned.map(entry => ({ id: entry.id, name: entry.name, cwd: entry.cwd, provider: entry.provider, createdAt: Date.now(),
    ...(entry.worktree ? { worktree: entry.worktree } : {}), ...(compareGroup ? { compareGroup, comparePrompt: prompt ?? '', compareRole: roles[entry.provider] } : {}) }));
  for (const task of created) setProjectRemoved(projectKey(task.worktree?.root ?? task.cwd), false);
  tasks.push(...created);
  byId('task-dialog').close();
  if (pendingPanel && panelTree.contains(pendingPanel.anchor)) {
    if (pendingPanel.direction) openSplitChat(created[0], pendingPanel.anchor, pendingPanel.direction);
    else activateWorkAreaTabInPanel(created[0], pendingPanel.anchor);
  } else chooseTask(created[0]);
  pendingPanel = null;
  if (compare) { tasksSidebar(); persist(); }
  for (const task of created) {
    connectTask(task).then(() => whenSettled(task)).then(() => {
      const request = [prompt, task.compareRole].filter(Boolean).join('\n\n');
      if (!request) return;
      return sendChatText(task, request, task === selectedTask ? taskChatInput(task) : null);
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
function saveTaskInput(task, input = taskChatInput(task)) {
  const state = runtime(task);
  if (input) state.draft = input.value;
  task.draft = state.draft || undefined;
  task.queue = state.queue.length ? state.queue : undefined;
  persist();
}

async function submitChat(task, input) {
  if (!task) return;
  const state = runtime(task);
  const text = input.value.trim();
  if (!text || state.terminalMode || state.authRequired) return;
  if (state.busy || state.connecting || state.switching) {
    if ((state.queue ??= []).length >= queueLimit) { status('대기열은 ' + queueLimit + '개까지 쌓을 수 있습니다.', 'warn'); return; }
    state.queue.push({ id: crypto.randomUUID(), text, status: 'queued' });
    input.value = '';
    saveTaskInput(task, input);
    scheduleChat();
    return;
  }
  return sendChatText(task, text, input);
}

// 대기열의 다음 메시지를 보낸다. 턴이 끝났거나 연결된 직후에 부른다.
async function flushQueue(task) {
  const state = runtime(task);
  if (!state.connected || state.restoring || state.busy || state.connecting || state.switching || state.queue.some(entry => entry.status === 'sending') ||
      state.terminalMode || state.authRequired) return;
  const next = state.queue[0];
  if (!next || next.status === 'failed') return;
  next.status = 'sending';
  saveTaskInput(task);
  try {
    if (await sendChatText(task, next.text, null, next.id)) state.queue = state.queue.filter(entry => entry !== next);
    else next.status = 'failed';
  } catch (error) {
    next.status = 'failed';
    report(error);
  }
  saveTaskInput(task);
  scheduleChat();
  if (next.status !== 'failed' && !state.busy && state.outcome === '완료') flushQueue(task);
}

async function sendChatText(task, text, input, queuedId) {
  const state = runtime(task);
  if (state.restoring || state.busy || state.connecting || state.switching || state.terminalMode || state.authRequired) return;
  // Connect on the first send instead of making the user press "연결" first; Codex starts an
  // app-server process per task, so it is only started once the task is actually used.
  if (!state.connected) {
    await connectTask(task);
    if (!state.connected || state.authRequired || state.busy || state.restoring) return;
  }
  if (tasks.some(other => other !== task && (other.handoffGroup || task.handoffGroup) &&
      terminalFolderKey(other.cwd) === terminalFolderKey(task.cwd) && (runtime(other).busy || runtime(other).terminalMode))) {
    status('이 작업 폴더를 사용하는 다른 에이전트를 먼저 멈추세요.', 'warn');
    return;
  }
  state.busy = true;
  state.status = '요청 전송 중…';
  task.activeAt = Date.now();
  persist();
  updateTaskStatus(task);
  const clientId = queuedId ?? crypto.randomUUID();
  if (task.provider === 'claude') state.inflight = { id: clientId, text, queued: !!queuedId };
  const pending = { id: clientId, type: 'userMessage', content: [{ text }] };
  state.items.set(clientId, pending);
  if (input && input.value.trim() === text) input.value = '';
  if (input) saveTaskInput(task, input);
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
    if (!queuedId) {
      const currentInput = taskChatInput(task);
      if (currentInput && !currentInput.value) currentInput.value = text;
      else if (!currentInput && !state.draft) state.draft = text;
      else state.queue.unshift({ id: clientId, text, status: 'failed' });
      saveTaskInput(task);
    }
    renderChat();
  }
}

byId('disconnect-chat').onclick = () => disconnectChat(selectedTask);
byId('stop-chat').onclick = () => stopChat(selectedTask);
byId('handoff-chat').onclick = () => openHandoff(selectedTask).catch(report);
byId('composer').onsubmit = event => {
  event.preventDefault();
  submitChat(selectedTask, byId('chat-input'));
};

function taskChatInput(task) {
  return splitChats.get(task.id)?.getChatPart('chat-input');
}

function closeSplitChat(task) {
  const tab = splitChats.get(task.id);
  runtime(task).draft = tab.getChatPart('chat-input').value;
  splitChats.delete(task.id);
  removeWorkAreaTab(tab);
}

function createDockedChat(task) {
  const conversation = chatTemplate.cloneNode(true);
  conversation.removeAttribute('id');
  conversation.classList.add('split-conversation');
  // 기본 패널 머리줄의 브랜치·비교·PR·터미널·[채팅|터미널] 요소를 복제해 이 패널 전용 머리줄을 만든다.
  const header = document.createElement('div');
  header.className = 'split-task-header';
  const spacer = document.createElement('span');
  spacer.className = 'panel-bar-spacer';
  header.append(...['task-branch', 'task-compare-open', 'task-pr'].map(id => byId(id).cloneNode(true)), spacer,
    ...['task-shell', 'task-view-switch'].map(id => byId(id).cloneNode(true)));
  conversation.prepend(header);
  const parts = new Map();
  for (const node of conversation.querySelectorAll('[id]')) {
    parts.set(node.id, node);
    node.dataset.chatPart = node.id;
    node.removeAttribute('id');
  }
  const get = id => parts.get(id);
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
  get('handoff-chat').onclick = () => openHandoff(task).catch(report);
  get('claude-login').onclick = () => openClaudeLogin(task);
  get('claude-login-check').onclick = () => checkClaudeLogin(task);
  bindModelPicker(() => task, get);
  const tab = { name: task.name, cwd: task.cwd, host: conversation, owner: null, chatTask: task, getChatPart: get };
  splitChats.set(task.id, tab);
  openTasks.add(task.id);
  return tab;
}

function activateDockedChat(task) {
  selectedTask = task;
  rememberTaskFocus(task);
  localStorage.setItem('agent-last-task', task.id);
  byId('task-title').textContent = task.name;
  byId('main-panel-label').textContent = task.name;
  byId('main-panel-folder').textContent = byId('task-folder').textContent = task.cwd;
  document.body.classList.add('task-visible');
  const state = runtime(task);
  if (!state.connected && !state.connecting && !state.terminalMode && !state.manualDisconnect) connectTask(task);
  tasksSidebar();
  renderWorkTabs();
  applyTaskLayout();
  renderPlanner();
  resetGit();
  renderChat();
  saveChatLayout();
}

function openSplitChat(task, anchor, direction) {
  const tab = splitChats.get(task.id) ?? createDockedChat(task);
  moveWorkAreaTab(tab, anchor, direction);
}

function activateWorkAreaTabInPanel(task, panel) {
  const tab = createDockedChat(task);
  attachWorkAreaTab(tab, workArea(panel));
  activateWorkAreaTab(tab);
}

async function openHandoff(task) {
  if (!task) return;
  const state = runtime(task);
  const dialog = byId('handoff-dialog');
  if (dialog.open || state.connecting || state.terminalMode) return;
  const turnId = state.activeTurnId;
  const provider = task.provider === 'claude' ? 'codex' : 'claude';
  const targetName = agentName({ provider });
  byId('handoff-context').textContent = `${agentName(task)} → ${targetName} · ${task.cwd}`;
  const input = byId('handoff-text');
  const conversation = [...state.items.values()].filter(item => ['userMessage', 'agentMessage', 'plan'].includes(item.type));
  const original = conversation.find(item => item.type === 'userMessage');
  const history = conversation.slice(-10).map(item => `${item.type === 'userMessage' ? '사용자' : agentName(task)}: ${itemText(item).slice(0, 1600)}`);
  const snapshot = await api.gitStatus(task.cwd).catch(() => null);
  if (dialog.open || !tasks.includes(task)) return;
  input.value = [
    `같은 작업 폴더에서 ${task.name} 작업을 이어서 진행하세요. 현재 변경 사항을 검토한 뒤 남은 작업을 수행하세요.`,
    `작업 폴더: ${task.cwd}`,
    snapshot?.branch && `브랜치: ${snapshot.branch}`,
    original && `원래 요청:\n${itemText(original).slice(0, 4000)}`,
    history.length && `최근 대화:\n${history.join('\n\n')}`,
    snapshot?.files?.length && '현재 변경 파일:\n' + snapshot.files.slice(0, 80).map(file => '- ' + file.name).join('\n'),
    task.verification && `기록된 검증: ${task.verification.profile ?? ''} ${task.verification.result ?? ''}`,
    task.planner && `작업 메모 및 남은 일:\n${task.planner.slice(0, 3000)}`,
    state.draft && `전송하지 않은 초안:\n${state.draft.slice(0, 2000)}`
  ].filter(Boolean).join('\n\n');
  if (['waiting', 'paused'].includes(task.handoffSchedule?.state)) input.value = task.handoffSchedule.text;
  byId('handoff-prepare').hidden = state.busy;
  byId('handoff-schedule').hidden = !state.busy || !turnId;
  byId('handoff-disarm').hidden = !task.handoffSchedule || ['submitted', 'draft'].includes(task.handoffSchedule.state);
  dialog.querySelector('form').onsubmit = event => {
    const action = event.submitter?.value;
    if (!['prepare', 'schedule', 'disarm'].includes(action)) return;
    event.preventDefault();
    if (action === 'disarm') {
      delete task.handoffSchedule;
      persist();
      dialog.close();
      scheduleChat();
      return;
    }
    if (action === 'schedule') {
      if (!input.value.trim() || !state.busy || state.activeTurnId !== turnId) {
        status('현재 턴이 끝났습니다. 새 채팅에 넣는 방식으로 이어받으세요.', 'warn');
        dialog.close();
        return;
      }
      task.handoffSchedule = { state: 'waiting', turnId, text: input.value };
      persist();
      dialog.close();
      scheduleChat();
      status(`${targetName} 이어받기를 예약했습니다. 현재 턴 성공 후 전송합니다.`);
      return;
    }
    if (!input.value.trim() || state.busy || state.approvals.size || state.terminalMode) {
      status('원본 작업을 멈춘 뒤 이어받으세요.', 'warn');
      return;
    }
    const next = createHandoffTask(task, input.value);
    dialog.close();
    chooseTask(next);
    taskChatInput(next)?.focus();
    persist();
  };
  dialog.showModal();
}

function createHandoffTask(task, draft) {
  const provider = task.provider === 'claude' ? 'codex' : 'claude';
  task.handoffGroup ??= task.id;
  const next = { id: crypto.randomUUID(), name: task.name + ' · ' + agentName({ provider }), provider, cwd: task.cwd,
    createdAt: Date.now(), handoffGroup: task.handoffGroup,
    handoffRoot: task.worktree?.root ?? task.handoffRoot ?? task.cwd, draft };
  tasks.push(next);
  return next;
}

async function runScheduledHandoff(task, outcome) {
  const schedule = task.handoffSchedule;
  schedule.state = outcome === 'completed' ? 'preparing' : 'paused';
  persist();
  if (outcome !== 'completed') { status('원본 턴이 완료되지 않아 이어받기 전송을 보류했습니다.'); return; }
  const snapshot = await api.gitStatus(task.cwd).catch(() => null);
  if (task.handoffSchedule !== schedule || !tasks.includes(task)) return;
  const result = lastAgentText(runtime(task));
  const draft = [schedule.text, result && '완료된 턴 결과:\n' + result.slice(0, 8000),
    snapshot?.files?.length && '완료 시점 변경 파일:\n' + snapshot.files.slice(0, 80).map(file => '- ' + file.name).join('\n')]
    .filter(Boolean).join('\n\n');
  const next = createHandoffTask(task, draft);
  schedule.targetId = next.id;
  const source = splitChats.get(task.id);
  const tab = createDockedChat(next);
  attachWorkAreaTab(tab, source?.workArea ?? workArea(primaryChatPanel), false);
  tasksSidebar();
  renderWorkArea(tab.workArea);
  persist();
  try {
    if (await sendChatText(next, draft, taskChatInput(next))) {
      schedule.state = 'submitted';
      status('다음 에이전트에 이어받기 요청을 전송했습니다.', 'success');
    } else {
      schedule.state = 'draft';
      status('자동 전송을 완료하지 못해 이어받기 초안을 남겼습니다.', 'warn');
    }
  } catch (error) {
    schedule.state = 'draft';
    report(error);
  } finally { persist(); scheduleChat(); }
}

const workspaceLayoutKey = 'agent-workspace-layout-v2';
let restoringChatLayout = false;

function saveChatLayout() {
  if (restoringChatLayout || document.readyState === 'loading') return;
  function describeTab(tab) {
    if (tab.chatTask) return { type: 'chat', id: tab.chatTask.id };
    if (tab.panes) {
      const tree = tabLayout(tab, tab.host.firstElementChild, tab.activePane);
      return tree ? { type: 'shell', tree, name: tab.name, owner: tab.owner } : null;
    }
    if (tab.icon === 'note') return { type: 'note', id: tab.id, view: tab.host.dataset.view, owner: tab.owner };
    if (tab.icon === 'web') return { type: 'preview', cwd: tab.cwd, address: tab.previewAddress, owner: tab.owner };
    if (tab.agentsBoard) return { type: 'agents' };
    if (tab.diffEntry) return { type: 'diff', ...tab.diffEntry, owner: tab.owner };
    return null;
  }

  function describe(node) {
    if (!node) return null;
    if (node.matches('.workspace-split')) {
      const first = describe(node.firstElementChild);
      const last = describe(node.lastElementChild);
      if (!first || !last) return first ?? last;
      return { first, last, axis: node.dataset.axis, ratio: Number.parseFloat(node.style.getPropertyValue('--panel-ratio')) || 50 };
    }
    const area = node.workArea;
    const ordered = [...new Set([...(area?.tabOrder ?? []), ...(area?.tabs ?? [])])];
    const entries = ordered.map(tab => ({ tab, saved: describeTab(tab) })).filter(entry => entry.saved);
    const main = node === primaryChatPanel;
    return main || entries.length ? { main, focused: node === focusedPanel,
      tabs: entries.map(entry => entry.saved), active: entries.findIndex(entry => entry.tab === area.current) } : null;
  }
  localStorage.setItem(workspaceLayoutKey, JSON.stringify(describe(panelTree.firstElementChild)));
}

async function restoreChatLayout(previousTask) {
  let layout;
  try { layout = JSON.parse(localStorage.getItem(workspaceLayoutKey) ?? localStorage.getItem('agent-chat-layout-v1') ?? 'null'); } catch { layout = null; }
  const available = new Map(tasks.filter(task => openTasks.has(task.id) && !closedTasks.has(task.id)).map(task => [task.id, task]));
  restoringChatLayout = true;
  let focused;
  let restoredTabs = 0;
  try {
    async function build(node, depth = 0) {
      if (!node || typeof node !== 'object' || depth > 32) return null;
      if (node.first || node.last) {
        const first = await build(node.first, depth + 1);
        const last = await build(node.last, depth + 1);
        if (!first || !last) return first ?? last;
        const { split, divider } = createWorkspaceSplit(node.axis === 'horizontal');
        split.append(first, divider, last);
        split.dataset.resized = 'true';
        setWorkspaceRatio(split, Math.max(15, Math.min(85, Number(node.ratio) || 50)));
        return split;
      }
      const entries = Array.isArray(node.tabs) ? node.tabs : (node.order ?? node.docked ?? []).map(id => ({ type: 'chat', id }));
      if (!node.main && !entries.length) return null;
      const panel = node.main ? primaryChatPanel : document.createElement('section');
      panel.classList.add('workspace-panel');
      const area = workArea(panel);
      const restored = [];
      for (const entry of entries) {
        if (++restoredTabs > 120) break;
        let tab;
        try {
          if (entry.type === 'chat') {
            if (!available.has(entry.id) || splitChats.has(entry.id)) { restored.push(null); continue; }
            tab = createDockedChat(available.get(entry.id));
            attachWorkAreaTab(tab, area, false);
          } else tab = await restoreContentTab(entry, area);
        } catch (error) { report(error); }
        restored.push(tab);
      }
      if (!node.main && !area.tabs.size) return null;
      const current = restored[node.active] ?? splitChats.get(node.active) ?? restored.find(Boolean);
      if (current?.workArea === area) showWorkAreaTab(current, area);
      if (node.focused) focused = panel;
      renderWorkArea(area);
      return panel;
    }
    const tree = await build(layout);
    if (tree && (tree === primaryChatPanel || tree.contains(primaryChatPanel))) panelTree.replaceChildren(tree);
    for (const [id, task] of available) {
      if (!splitChats.has(id)) attachWorkAreaTab(createDockedChat(task), workArea(primaryChatPanel), false);
    }
    if (focused && panelTree.contains(focused) && focused.workArea?.current) activateWorkAreaTab(focused.workArea.current, false);
    else if (previousTask && available.has(previousTask.id)) chooseTask(previousTask);
    else if (!primaryChatPanel.workArea.current) renderEmptyTask();
    renderWorkTabs();
    renderChat();
    persist();
  } finally { restoringChatLayout = false; }
  saveChatLayout();
}

onChatLayoutChanged = saveChatLayout;

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
  if (task.handoffGroup && tasks.some(other => other !== task && other.handoffGroup === task.handoffGroup &&
      (openTasks.has(other.id) || runtime(other).busy || runtime(other).terminalMode))) {
    closeWorkTab(task);
    status('이어받기 작업이 있어 원본 탭만 닫았습니다.');
    return;
  }
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
  openTasks.delete(task.id);
  closedTasks.add(task.id);
  localStorage.setItem(closedTasksKey, JSON.stringify([...closedTasks]));
  if (localStorage.getItem('agent-last-task') === task.id) localStorage.removeItem('agent-last-task');
  if (splitChats.has(task.id)) closeSplitChat(task);
  if (selectedTask === task) selectedTask = panelTask(focusedPanel);
  if (!splitChats.size) {
    document.body.classList.remove('task-visible', 'codex-terminal-mode');
    byId('task-title').textContent = '에이전트 작업공간';
    byId('main-panel-label').textContent = '대화';
    byId('main-panel-folder').textContent = byId('task-folder').textContent = '';
    renderEmptyTask();
  }
  tasksSidebar();
  renderWorkTabs();
  renderPlanner();
  renderChat();
  resetGit();
  saveChatLayout();
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
byId('open-approval-rules').onclick = () => { chatSettings.close(); showApprovalRules(); };
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
  const area = tabMenuArea && panelTree.contains(tabMenuArea.panel) ? tabMenuArea : workArea(primaryChatPanel);
  if (chat) return newTask(provider, undefined, area.panel !== primaryChatPanel ? { anchor: area.panel } : undefined, tabSearch.value);
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
    const { loggedIn, catalog } = await api.claudeAuthStatus(task.id);
    if (loggedIn === null) throw new Error('로그인 상태를 확인하지 못했습니다.');
    state.authRequired = !loggedIn;
    state.authMessage = loggedIn ? undefined : '로그인이 완료되지 않았습니다. Claude 로그인에서 다시 시도하세요.';
    if (loggedIn) {
      applyClaudeCatalog(task, catalog);
      state.status = catalog ? '연결 확인 · 첫 요청 대기' : '로그인됨 · 초기화 확인 실패';
      state.outcome = undefined;
      persist();
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
byId('show-agents').onclick = () => openAgentsBoard();
setInterval(() => {
  for (const row of byId('task-list').querySelectorAll('[data-task-row]')) {
    const task = tasks.find(entry => entry.id === row.dataset.taskRow);
    const age = row.querySelector('.task-tab-age');
    if (task && age) age.textContent = timeAgo(task.activeAt ?? task.createdAt);
  }
}, 60000);
byId('nav-new-task').onclick = byId('nav-new-task-plus').onclick = () => newTask().catch(report);
byId('nav-floating-terminal').onclick = () => toggleTerminalPanel().catch(report);
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
// get은 패널별 요소 조회 함수다. 기본 패널은 byId, 분할 채팅은 그 패널의 getChatPart를 쓰므로
// 버튼은 항상 자기 패널의 task만 조작한다.
function renderTaskHeader(task, state, get = byId) {
  const view = get('task-view-switch');
  view.hidden = get('task-shell').hidden = !task;
  if (!task) { get('task-branch').hidden = get('task-pr').hidden = get('task-compare-open').hidden = true; return; }
  const terminal = !!state.terminalMode;
  get('view-chat').setAttribute('aria-pressed', String(!terminal));
  get('view-terminal').setAttribute('aria-pressed', String(terminal));
  const blocked = !!state.switching || (!terminal && (state.busy || state.connecting || state.approvals.size > 0));
  get('view-chat').disabled = blocked;
  get('view-terminal').disabled = blocked;
  get('view-terminal').title = (task.provider === 'claude' ? 'Claude Code' : 'Codex') + ' TUI에서 같은 대화를 이어 갑니다';
  get('view-chat').title = terminal ? agentName(task) + ' TUI를 종료하고 같은 대화를 채팅으로 이어 갑니다' : '채팅 보기';
  get('view-terminal').onclick = () => { if (!runtime(task).terminalMode) switchTaskView(task); };
  get('view-chat').onclick = () => { if (runtime(task).terminalMode) switchTaskView(task); };
  get('task-shell').onclick = () => newShellTab(task.cwd, taskWorkArea(task)).catch(report);
  const branch = get('task-branch');
  branch.textContent = state.branch ?? '';
  branch.title = state.branch ? '브랜치 ' + state.branch : '';
  branch.hidden = !state.branch;
  if (!state.branchChecked) {
    state.branchChecked = true;
    api.gitStatus(task.cwd).then(snapshot => {
      state.branch = snapshot.root && snapshot.branch && snapshot.branch !== '(detached)' ? snapshot.branch : null;
      if (task === selectedTask || splitChats.has(task.id)) scheduleChat();
    }, () => {});
  }
  const compareButton = get('task-compare-open');
  compareButton.hidden = !task.compareGroup || tasks.filter(item => item.compareGroup === task.compareGroup).length < 2;
  compareButton.onclick = () => openCompare(task).catch(report);
  const pr = get('task-pr');
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
// 터미널의 에이전트 TUI를 버튼 한 번으로 끝낸다. 입력 중이던 줄을 지우고(Ctrl+U) /exit를 보낸 뒤
// PowerShell 복귀(또는 터미널 종료) 신호를 기다린다. 응답이 없으면 확인을 받아 터미널을 강제로 닫는다.
// 대화 기록은 CLI가 세션 파일에 이미 써 두므로 채팅으로 돌아오면 그대로 복원된다.
const agentExitSignals = ['workbench-agent-returned', 'workbench-terminal-ended'];
function waitAgentExit(pane, limit, send) {
  return new Promise(resolve => {
    const done = event => { if (event.detail === pane.id) finish(true); };
    const finish = value => {
      clearTimeout(timer);
      for (const name of agentExitSignals) document.removeEventListener(name, done);
      resolve(value || !!pane.exited || pane.agentState === 'returned');
    };
    for (const name of agentExitSignals) document.addEventListener(name, done);
    const timer = setTimeout(() => finish(false), limit);
    send().catch(() => finish(false));
  });
}

async function exitAgentTerminal(task, pane) {
  const state = runtime(task);
  if (state.switching) return;
  state.switching = true;
  state.status = agentName(task) + ' TUI를 종료하는 중…';
  scheduleChat();
  let ended;
  try {
    // 한 번에 보내면 TUI가 붙여넣기로 받아 Enter를 줄바꿈으로 넣을 수 있어, 키를 나눠 보낸다.
    const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
    ended = await waitAgentExit(pane, agentExitTimeout, async () => {
      await api.input(pane.id, '\x15');
      await pause(60);
      await api.input(pane.id, '/exit');
      await pause(200);
      await api.input(pane.id, '\r');
      // Codex는 시작 직후(로딩 중) Enter를 무시하므로, 아직 안 끝났으면 한 번 더 누른다.
      await pause(3000);
      if (panes.has(pane.id) && !pane.exited && pane.agentState !== 'returned') await api.input(pane.id, '\r');
    });
    if (!ended) {
      state.switching = false;
      scheduleChat();
      const force = await confirmAction({
        title: agentName(task) + ' TUI가 종료되지 않았습니다',
        target: task.name + '\n' + task.cwd,
        result: '터미널을 강제로 닫고 채팅으로 돌아갑니다. 진행 중인 응답은 중단됩니다.',
        note: '에이전트가 응답하는 중이면 /exit가 처리되지 않을 수 있습니다. 취소하면 터미널을 그대로 둡니다.',
        confirmLabel: '강제 종료', danger: true
      });
      if (!force || !state.terminalMode || state.terminalPane !== pane) {
        if (!force && panes.has(pane.id)) { selectTab(pane.tab, false); selectPane(pane, true); }
        state.status = force ? state.status : '터미널의 ' + agentName(task) + '를 그대로 두었습니다.';
        scheduleChat();
        return;
      }
      state.switching = true;
      scheduleChat();
      // close는 세션을 먼저 지워 종료 신호가 오지 않으므로, 끝난 패널로 직접 표시한다.
      await api.close(pane.id);
      pane.running = false;
      pane.exited = true;
      pane.badge.textContent = '강제 종료';
      ended = true;
    }
  } finally { state.switching = false; }
  // 복귀 신호를 처리하는 리스너는 switching 동안 건너뛰므로, 아직 터미널 모드면 여기서 채팅으로 돌린다.
  if (ended && state.terminalMode && state.terminalPane === pane) {
    state.status = agentName(task) + ' TUI를 종료했습니다. 채팅으로 돌아왔습니다.';
    return switchTaskView(task);
  }
  if (!ended) { state.status = '터미널을 닫지 못했습니다. 터미널 탭에서 직접 종료하세요.'; scheduleChat(); }
}
let agentExitTimeout = 10000;

// 작업이 보이는 패널의 작업 영역. 분할 채팅이면 그 패널, 아니면 기본 패널.
function taskWorkArea(task) {
  const panel = splitChats.get(task.id)?.workArea?.panel;
  return panel && panelTree.contains(panel) ? workArea(panel) : workArea(primaryChatPanel);
}
function taskShown(task) {
  return task === selectedTask || splitChats.has(task.id) || panelTask(primaryChatPanel) === task;
}

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
    if (pane && !pane.exited && pane.agentState !== 'returned') return exitAgentTerminal(task, pane);
    state.terminalMode = false;
    state.terminalPane = null;
    state.tuiState = undefined;
    if (pane && panes.has(pane.id)) closePane(pane);
    setDrawer(false);
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
    if (!taskShown(task)) return;
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
    if (!taskShown(task)) return;
    state.terminalMode = true;
    setDrawer(true);
    updateExportButtons();
    const conversation = provider === 'claude' ? { taskId: task.id } : task.threadId;
    state.terminalPane = await openWorkspace(task.cwd, provider, conversation, installed.file, splitChats.has(task.id) ? taskWorkArea(task) : undefined);
    if (task === selectedTask && state.terminalPane?.running) {
      status(agentName(task) + '를 터미널에서 이어 갑니다. [채팅] 버튼이나 /exit로 끝내면 채팅으로 돌아옵니다.');
    }
  } catch (error) {
    state.terminalMode = false;
    state.status = error.message;
    // 터미널로 못 넘겼으면 끊어 둔 채팅을 다시 붙인다.
    if (!state.connected && !state.connecting) setTimeout(() => connectTask(task).then(() => { state.status = error.message; scheduleChat(); }), 0);
  } finally {
    state.switching = false;
    if (state.terminalMode && state.terminalPane?.exited) return switchTaskView(task);
    if (task === selectedTask || splitChats.has(task.id)) renderChat();
  }
};
document.addEventListener('workbench-terminal-ended', scheduleChat);

function reviewCwd() {
  return focusedPanel.terminalTab?.activePane?.cwd ?? focusedPanel.previewCwd ?? actionTask()?.cwd ?? currentPane()?.cwd;
}

function actionTask() {
  return panelTask(focusedPanel) ?? tasks.find(task => task.id === focusedPanel.workArea?.current?.owner)
    ?? panelTask(lastChatPanel) ?? selectedTask;
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
  const step = !branch ? '브랜치 확인' : staged || unstaged ? (staged ? '2. 커밋' : '1. 변경 검토')
    : !snapshot.upstream || snapshot.ahead ? '3. 푸시' : '4. PR';
  byId('git-workflow-step').textContent = '현재 단계 · ' + step;
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

async function runGitAction(cwd, action, done, step) {
  if (commitBusy) return;
  commitBusy = true;
  updateCommitButtons();
  try {
    const result = await action();
    done?.(result);
  } catch (error) {
    if (commitState?.cwd === cwd) setCommitStatus((step ? step + ' 실패 · ' : '') + ipcMessage(error), true);
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
  }, '커밋');
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
byId('push-button').onclick = async () => {
  const cwd = commitState?.cwd;
  const branch = commitState?.snapshot.branch;
  if (!cwd) return;
  if (['main', 'master'].includes(branch)) {
    const { upstream, ahead } = commitState.snapshot;
    const accepted = await confirmAction({
      title: branch + ' 브랜치에 바로 푸시할까요?',
      target: cwd + '\n' + branch + ' → ' + (upstream || '새 원격 브랜치'),
      result: '리뷰 없이 기본 브랜치에 ' + (upstream ? '커밋 ' + ahead + '개를 올립니다.' : '브랜치를 게시합니다.'),
      confirmLabel: '푸시', danger: true
    });
    // 확인하는 사이 다른 작업으로 바뀌었으면 엉뚱한 저장소에 푸시하지 않는다.
    if (!accepted || commitState?.cwd !== cwd || commitState.snapshot.branch !== branch) return;
  }
  setCommitStatus('푸시하는 중…');
  runGitAction(cwd, () => api.gitPush(cwd), result => setCommitStatus(result.branch + ' → ' + result.upstream + ' 푸시했습니다.'), '푸시');
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

byId('clear-review-notes').onclick = async () => {
  const root = notesRoot();
  const count = notesFor(root).length;
  if (root && count && await confirmAction({
    title: '리뷰 노트를 모두 지울까요?',
    target: root,
    result: '리뷰 노트 ' + count + '개를 삭제합니다. 되돌릴 수 없습니다.',
    confirmLabel: '모두 지우기', danger: true
  })) saveReviewNotes(root, []);
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
  if (diffEditorTab) {
    diffEditorTab.name = 'diff · ' + entry.name.split('/').at(-1);
    diffEditorTab.diffEntry = { cwd, name: entry.name, kind: entry.kind };
    renderWorkArea(diffEditorTab.workArea);
    saveChatLayout();
  }
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
  saveTaskInput(task, input);
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
      diffEntry: chosenPatch && { cwd: chosenPatch.cwd, name: chosenPatch.name, kind: chosenPatch.kind },
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
  const focused = panelTask(focusedPanel);
  if (focused) selectedTask = focused;
  rememberTaskFocus(actionTask());
  renderPlanner();
  renderChat();
  resetGit();
  updateExportButtons();
};
tasksSidebar();
const previousTask = tasks.find(task => task.id === localStorage.getItem('agent-last-task'));
document.addEventListener('DOMContentLoaded', () => restoreChatLayout(previousTask).catch(report), { once: true });

// 작업이 없을 때의 첫 화면: 시작하기 체크리스트와 바로 할 수 있는 행동.
// Nothing selected. With tasks already made, a light home (recent tasks); the setup checklist is only for
// the first run, or when the CLI check finds a problem.
function renderEmptyTask(refresh = false, checklist = false) {
  if (!checklist && tasks.length) { renderHome(refresh); return; }
  const feed = byId('chat-feed');
  const card = document.createElement('section');
  card.className = 'onboarding';
  const title = document.createElement('h2');
  title.textContent = 'Hermit 시작하기';
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
  const start = button('새 작업 · Ctrl+N', () => newTask().catch(report));
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
let codexLimitDetail = 'Codex 한도를 조회하면 표시됩니다.';
let codexTokens;
const usageLedgerKey = 'agent-observed-usage-v1';
let usageLedger;
try { usageLedger = JSON.parse(localStorage.getItem(usageLedgerKey) ?? '{}'); } catch { usageLedger = {}; }
if (!usageLedger || typeof usageLedger !== 'object') usageLedger = {};
usageLedger.days ??= {};
usageLedger.codex ??= {};
usageLedger.claude ??= {};

function usageDay(time = Date.now()) {
  const date = new Date(time);
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

function recordUsage(provider, total, cached) {
  if (!Number.isFinite(total) || total < 0) return;
  const day = usageLedger.days[usageDay()] ??= {};
  const bucket = day[provider] ??= { total: 0, cached: 0, samples: 0 };
  bucket.total += total;
  bucket.cached += Number.isFinite(cached) ? Math.max(0, cached) : 0;
  bucket.samples++;
  const cutoff = usageDay(Date.now() - 35 * 86400000);
  for (const key of Object.keys(usageLedger.days)) if (key < cutoff) delete usageLedger.days[key];
  for (const records of [usageLedger.codex, usageLedger.claude]) {
    for (const [key, entry] of Object.entries(records)) if (entry.day < cutoff) delete records[key];
  }
  localStorage.setItem(usageLedgerKey, JSON.stringify(usageLedger));
  if (byId('agent-usage-dialog').open) renderUsageTotals();
}

function recordCodexUsage(params, task) {
  const thread = params.threadId ?? runtime(task).threadId;
  const totals = params.tokenUsage?.total;
  const recent = params.tokenUsage?.last;
  if (!thread || !Number.isFinite(totals?.totalTokens)) return;
  const key = 'thread-' + thread;
  const cached = Number(totals.cachedInputTokens) || 0;
  const previous = usageLedger.codex[key];
  if (previous?.total === totals.totalTokens && previous?.cached === cached) return;
  const increasing = previous && totals.totalTokens >= previous.total;
  usageLedger.codex[key] = { day: usageDay(), total: totals.totalTokens, cached };
  recordUsage('codex', increasing ? totals.totalTokens - previous.total : recent?.totalTokens ?? 0,
    increasing ? cached - previous.cached : recent?.cachedInputTokens);
}

function renderUsageTotals() {
  const days = Number(byId('usage-period').value);
  const cutoffDate = new Date();
  cutoffDate.setDate(cutoffDate.getDate() - days + 1);
  const entries = Object.entries(usageLedger.days).filter(([day]) => day >= usageDay(cutoffDate));
  byId('usage-totals').textContent = ['codex', 'claude'].map(provider => {
    const totals = entries.reduce((sum, [, day]) => {
      sum.total += day[provider]?.total ?? 0;
      sum.cached += day[provider]?.cached ?? 0;
      sum.samples += day[provider]?.samples ?? 0;
      return sum;
    }, { total: 0, cached: 0, samples: 0 });
    const name = agentName({ provider });
    return !totals.samples ? `${name} · 관측 기록 없음` :
      `${name} · ${totals.total.toLocaleString('ko-KR')} 토큰 · 캐시 ${totals.cached.toLocaleString('ko-KR')}`;
  }).join('\n');
}

function renderCodexUsageDetail() {
  const tokens = codexTokens && `최근 관측 요청 · ${codexTokens.task} · ${codexTokens.total.toLocaleString('ko-KR')} 토큰` +
    (Number.isFinite(codexTokens.cached) ? ` · 캐시 ${codexTokens.cached.toLocaleString('ko-KR')}` : '');
  byId('codex-usage-detail').textContent = [codexLimitDetail, tokens || '아직 받은 요청별 토큰 정보가 없습니다.'].join('\n');
}

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
  codexLimitDetail = output.title + (windows.length ? '\n갱신 ' + new Date().toLocaleString('ko-KR') : '');
  renderCodexUsageDetail();
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
function updateClaudeUsage({ limit, tokens, turnId }, task) {
  if (limit) claudeLimit = limit;
  // Cache reads re-use earlier context and dwarf the new work, so they are reported apart.
  if (tokens) claudeTokens = {
    used: (tokens.input_tokens ?? 0) + (tokens.output_tokens ?? 0) + (tokens.cache_creation_input_tokens ?? 0),
    cached: tokens.cache_read_input_tokens ?? 0,
    task: task?.name
  };
  if (tokens && turnId && task && !usageLedger.claude['turn-' + turnId]) {
    usageLedger.claude['turn-' + turnId] = { day: usageDay() };
    recordUsage('claude', claudeTokens.used + claudeTokens.cached, claudeTokens.cached);
  }
  const label = [];
  if (Number.isFinite(claudeLimit?.utilization)) {
    label.push(Math.round(claudeLimit.utilization * 100) + '% 사용' + resetTime(claudeLimit.resetsAt));
  } else if (claudeLimit?.status === 'rejected') {
    label.push('한도 도달' + resetTime(claudeLimit.resetsAt));
  } else if (claudeLimit?.status === 'allowed_warning') {
    label.push('한도 임박' + resetTime(claudeLimit.resetsAt));
  }
  if (claudeTokens) label.push('최근 요청 · ' + (claudeTokens.task ? claudeTokens.task + ' · ' : '') + claudeTokens.used.toLocaleString('ko-KR') + ' 토큰' +
    (claudeTokens.cached ? ' (캐시 재사용 ' + claudeTokens.cached.toLocaleString('ko-KR') + ' 별도)' : ''));
  byId('claude-usage').textContent = label.length ? (Number.isFinite(claudeLimit?.utilization)
    ? remainingLabel(claudeLimit.utilization * 100, claudeLimit.resetsAt) : label[0]) : '–';
  byId('claude-usage').title = label.join(' / ');
  updateUsageMeter('claude-meter', claudeLimit?.utilization * 100);
  byId('claude-usage-detail').textContent = (label.join('\n') || '아직 받은 한도 정보가 없습니다.') + '\n갱신 ' + new Date().toLocaleString('ko-KR');
}

byId('open-agent-usage').onclick = () => { renderUsageTotals(); byId('agent-usage-dialog').showModal(); };
byId('usage-period').onchange = renderUsageTotals;
for (const trigger of document.querySelectorAll('#agent-usage .usage-segment')) trigger.onclick = byId('open-agent-usage').onclick;
byId('refresh-usage-detail').onclick = refreshCodexUsage;
renderCodexUsageDetail();
byId('claude-usage-detail').textContent = 'Claude 응답에서 한도 또는 토큰 정보를 받으면 표시됩니다.';
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
