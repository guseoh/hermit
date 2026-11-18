
const taskKey = 'agent-workbench-tasks-v1';
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
    status: '요청을 보내면 연결합니다', items: new Map(), approvals: new Map(), draft: ''
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

function updateTaskStatus(task) {
  const state = runtime(task);
  const badge = taskStatusLabels.get(task.id);
  const label = taskStatus(state);
  if (badge) {
    badge.textContent = label;
    badge.hidden = !label;
    badge.dataset.attention = String(!!state.approvals.size);
  }
  const tab = byId('workbench-tabs').querySelector('[data-task-id="' + CSS.escape(task.id) + '"]');
  if (tab) tab.dataset.status = label;
  if (byId('results-panel').dataset.review === 'agents') scheduleAgentsView();
}

function taskStatus(state) {
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
    if (!projects.has(task.cwd)) projects.set(task.cwd, []);
    projects.get(task.cwd).push(task);
  }
  for (const [folder, entries] of projects) {
    const matching = entries.filter(task => (folder + ' ' + task.name + ' ' + agentName(task)).toLowerCase().includes(query));
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
    name.append(chevron, projectName);
    name.title = folder;
    name.setAttribute('aria-expanded', String(!folded));
    const add = button('＋', () => newShellTab(folder));
    add.className = 'icon-button';
    add.title = add.ariaLabel = '이 폴더에 PowerShell 열기';
    header.append(name, add);
    group.append(header);
    const closed = document.createElement('details');
    closed.className = 'closed-project-tasks';
    for (const task of folded ? [] : matching) {
      const item = button('', () => chooseTask(task));
      item.className = 'tab task-tab';
      item.title = agentName(task) + ' · ' + task.cwd;
      item.setAttribute('aria-current', String(task === selectedTask));
      const title = document.createElement('span');
      title.className = 'task-tab-name';
      title.textContent = task.name;
      const badge = document.createElement('span');
      badge.className = 'task-tab-status';
      const dot = document.createElement('span');
      dot.className = 'project-task-dot ' + (task.provider === 'claude' ? 'claude-dot' : 'codex-dot');
      dot.ariaHidden = 'true';
      item.append(dot, title, badge);
      taskStatusLabels.set(task.id, badge);
      updateTaskStatus(task);
      const row = document.createElement('div');
      row.className = 'project-task-row';
      row.append(item);
      if (closedTasks.has(task.id)) {
        item.title = task.name + ' 다시 열기';
        closed.append(row);
      } else {
        const close = button('', () => closeWorkTab(task));
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
    const select = button(task.name, () => chooseTask(task));
    select.title = agentName(task) + ' · ' + task.name;
    select.setAttribute('aria-current', tab.dataset.active);
    const close = button('×', () => closeWorkTab(task));
    close.ariaLabel = task.name + ' 탭 닫기';
    setPanelIcon(close, 'close');
    tab.append(select, close);
    strip.append(tab);
  }
  appendWorkAreaTabs(strip, primaryChatPanel.workArea);
  revealActiveWorkTab(strip);
  localStorage.setItem(openTasksKey, JSON.stringify([...openTasks]));
}

function appendWorkAreaTabs(strip, area) {
  for (const item of area.tabs) {
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
  const pane = currentPane();
  if (sessionPane && panes.has(sessionPane.id)) {
    setDrawer(true);
    selectTab(sessionPane.tab, false);
    selectPane(sessionPane);
  } else if (!active?.workArea || terminalFolderKey(pane?.cwd) !== terminalFolderKey(task.cwd)) {
    const match = findFolderPane(task.cwd, true);
    selectTab(match?.tab, false);
    if (match) selectPane(match);
  }
  updateExportButtons();
  tasksSidebar();
  renderWorkTabs();
  persist();
  resetGit();
  // Claude keeps no process between requests, so connecting on open is cheap and shows its
  // saved history and login state right away. Codex connects on the first send instead.
  const opened = runtime(task);
  if (task.provider === 'claude' && !opened.connected && !opened.connecting && !opened.terminalMode) connectTask(task);
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

async function connectTask(task) {
  const state = runtime(task);
  if (state.connecting || state.connected || state.terminalMode) return;
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
    if (!state.busy) state.status = '요청을 보낼 수 있습니다.';
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
    const mode = byId('switch-codex-view');
    mode.hidden = selectedTask.provider === 'claude';
    mode.textContent = state.terminalMode && state.terminalPane?.exited ? '채팅으로 돌아가기' : 'Codex 터미널';
    mode.disabled = !!state.switching || (!state.terminalMode &&
      (!selectedTask.threadId || state.busy || state.connecting || state.approvals.size > 0));
    mode.title = selectedTask.threadId ? '같은 Codex 대화 전환' : '첫 요청이 저장되면 전환할 수 있습니다.';
    document.body.classList.toggle('codex-terminal-mode', !!state.terminalMode);
    renderChatView(selectedTask, byId);
  }
  for (const panel of splitChats.values()) renderChatView(panel.chatTask, panel.getChatPart);
}

function renderChatView(task, get) {
  const state = runtime(task);
  const draft = get('chat-input').value;
  get('chat-markdown').hidden = !draft.trim();
  if (get('chat-markdown').open) renderMessage(get('chat-preview'), draft);
  const feed = get('chat-feed');
  const stick = feed.scrollHeight - feed.scrollTop - feed.clientHeight < 100;
  if (!state.items.size) {
    feed.replaceChildren();
    const message = document.createElement('p');
    message.className = 'chat-empty';
    message.textContent = agentName(task) + '에 작업을 요청하세요. 변경한 파일은 오른쪽에서 검토할 수 있습니다.';
    feed.append(message);
  } else {
    feed.querySelector('.chat-empty')?.remove();
    for (const child of [...feed.children]) {
      if (!state.items.has(child.dataset.item)) child.remove();
    }
    const rendered = new Map([...feed.children].map(child => [child.dataset.item, child]));
    for (const item of state.items.values()) {
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
          }
        } else {
          const details = document.createElement('details');
          const summary = document.createElement('summary');
          details.append(summary, document.createElement('pre'));
          node.append(details);
        }
        feed.append(node);
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
  if (stick) feed.scrollTop = feed.scrollHeight;
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
  get('claude-login-status').textContent = state.authMessage ?? 'Claude Code에 로그인해야 합니다.';
  get('claude-login').disabled = claudeLoginOpening || !!state.checkingAuth;
  get('claude-login-check').disabled = !!state.checkingAuth;
  get('reconnect-chat').hidden = state.connected || state.connecting;
  get('disconnect-chat').hidden = !state.connected || !!state.busy || !!state.switching;
  get('stop-chat').hidden = !state.busy || !state.connected;
  get('send-chat').disabled = !!state.connecting || !!state.busy || !!state.switching || authBlocked || !draft.trim();
  get('send-chat').title = state.connected ? '보내기' : '연결하고 보내기';
}

function scheduleChat() {
  if (!renderFrame) renderFrame = requestAnimationFrame(() => { renderFrame = 0; renderChat(); });
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
    if (task === actionTask()) refreshGit(!chosenPatch?.selected.size);
  } else if (method === 'approval') {
    state.approvals.set(params.id, params);
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
    api.chatClose(id).catch(report);
  } else if (method === 'notice' || method === 'error') {
    state.status = params.message ?? params.error?.message ?? agentName(task) + ' 오류';
  } else return;
  updateTaskStatus(task);
  if (task === selectedTask || splitChats.has(task.id)) scheduleChat();
});

async function newTask(provider, folder, panel) {
  chosenFolder = folder ?? actionTask()?.cwd ?? currentPane()?.cwd ?? await api.home();
  pendingPanel = panel;
  byId('task-cwd').textContent = chosenFolder;
  byId('task-name').value = '';
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
byId('task-dialog').querySelector('form').onsubmit = event => {
  event.preventDefault();
  const name = byId('task-name').value.trim();
  if (!name) return;
  const provider = event.currentTarget.elements['task-provider'].value;
  const task = { id: crypto.randomUUID(), name, cwd: chosenFolder, provider };
  tasks.push(task);
  byId('task-dialog').close();
  if (pendingPanel && panelTree.contains(pendingPanel.anchor)) {
    openSplitChat(task, pendingPanel.anchor, pendingPanel.direction);
  } else chooseTask(task);
  pendingPanel = null;
  connectTask(task);
};
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

async function submitChat(task, input) {
  if (!task) return;
  const state = runtime(task);
  const text = input.value.trim();
  if (!text || state.busy || state.connecting || state.switching || state.terminalMode || state.authRequired) return;
  // Connect on the first send instead of making the user press "연결" first; Codex starts an
  // app-server process per task, so it is only started once the task is actually used.
  if (!state.connected) {
    await connectTask(task);
    if (!state.connected || state.authRequired || state.busy) return;
  }
  state.busy = true;
  state.status = '요청 전송 중…';
  updateTaskStatus(task);
  const clientId = crypto.randomUUID();
  if (task.provider === 'claude') state.inflight = { id: clientId, text };
  const pending = { id: clientId, type: 'userMessage', content: [{ text }] };
  state.items.set(clientId, pending);
  input.value = '';
  renderChat();
  try { await api.chatSend(task.id, text, clientId, { model: task.model || undefined, effort: task.effort || undefined }); }
  catch (error) {
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
  const panel = makePanel(agentName(task) + ' · ' + task.name, 'agents', () => closeWorkTab(task));
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
  updateExportButtons();
  resetGit();
}
// Like VS Code's Ctrl+`: show the bottom panel with this task's terminal, creating one if needed.
async function toggleTerminalPanel() {
  if (!byId('terminal-drawer').hidden) { setDrawer(false); return; }
  setDrawer(true);
  const tab = active && !active.workArea && dockTabs().includes(active) ? active : dockTabs().at(-1);
  if (tab) { selectTab(tab); return; }
  await newDockTerminal();
}
byId('toggle-terminal').onclick = () => toggleTerminalPanel().catch(report);
async function openWorkspaceShell(createNew = false) {
  const task = actionTask();
  try {
    const cwd = task?.cwd ?? await api.home();
    if (task !== actionTask() || byId('terminal-drawer').hidden) return;
    const match = createNew ? null : findFolderPane(cwd, true);
    if (match) {
      selectTab(match.tab, false);
      selectPane(match, true);
    } else {
      await newDockTerminal(cwd);
    }
  } catch (error) { report(error); }
}
byId('open-workspace-shell').onclick = () => openWorkspaceShell();
byId('window-project-toggle').onclick = () => byId('toggle-workspaces-panel').click();
byId('expand-terminal').onclick = () => {
  const expanded = document.body.classList.toggle('terminal-maximized');
  byId('expand-terminal').setAttribute('aria-pressed', String(expanded));
  scheduleFit();
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
const chatPreferences = {
  enabled: storedChatSettings?.enabled === true,
  codex: storedChatSettings?.codex === 'chat' ? 'chat' : 'cli',
  claude: storedChatSettings?.claude === 'chat' ? 'chat' : 'cli',
  matchTerminal: storedChatSettings?.matchTerminal === true,
  contrast: Number.isInteger(storedChatSettings?.contrast) && storedChatSettings.contrast >= 70 && storedChatSettings.contrast <= 130
    ? storedChatSettings.contrast : 100
};

function applyChatPreferences() {
  const fields = chatSettingsForm.elements;
  fields['chat-enabled'].checked = chatPreferences.enabled;
  fields['codex-mode'].value = chatPreferences.codex;
  fields['claude-mode'].value = chatPreferences.claude;
  fields['match-terminal'].checked = chatPreferences.matchTerminal;
  fields['chat-contrast'].value = chatPreferences.contrast;
  byId('chat-contrast-value').value = chatPreferences.contrast + '%';
  byId('chat-launch-modes').disabled = !chatPreferences.enabled;
  document.body.classList.toggle('chat-match-terminal', chatPreferences.matchTerminal);
  document.body.style.setProperty('--chat-contrast-mix', ((chatPreferences.contrast - 70) / 60) * 100 + '%');
  for (const provider of ['codex', 'claude']) {
    byId('menu-' + provider).querySelector('.menu-arrow').textContent =
      chatPreferences[provider] === 'chat' ? '채팅' : 'CLI';
  }
}

byId('open-chat-settings').onclick = () => chatSettings.showModal();
chatSettingsForm.oninput = () => {
  const fields = chatSettingsForm.elements;
  chatPreferences.enabled = fields['chat-enabled'].checked;
  chatPreferences.codex = fields['codex-mode'].value;
  chatPreferences.claude = fields['claude-mode'].value;
  chatPreferences.matchTerminal = fields['match-terminal'].checked;
  chatPreferences.contrast = fields['chat-contrast'].valueAsNumber;
  localStorage.setItem(chatSettingsKey, JSON.stringify(chatPreferences));
  applyChatPreferences();
};
applyChatPreferences();

function filterTabMenu() {
  const query = tabSearch.value.trim().toLowerCase();
  let matches = 0;
  for (const group of tabMenu.querySelectorAll('.tab-menu-group')) {
    if (group.id === 'agent-launch-menu' && !chatPreferences.enabled) {
      group.hidden = true;
      continue;
    }
    const entries = [...group.querySelectorAll('button')];
    for (const entry of entries) {
      entry.hidden = !(entry.textContent + ' ' + (entry.dataset.search ?? '')).toLowerCase().includes(query);
      if (!entry.hidden) matches++;
    }
    group.hidden = entries.every(entry => entry.hidden);
  }
  byId('new-tab-no-results').hidden = matches > 0;
}
tabSearch.oninput = filterTabMenu;
tabSearch.onkeydown = event => {
  if (event.key !== 'Enter' && event.key !== 'ArrowDown') return;
  event.preventDefault();
  const first = tabMenu.querySelector('.tab-menu-group:not([hidden]) button:not([hidden])');
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
  const cwd = folder ?? actionTask()?.cwd ?? dockPane()?.cwd ?? await api.home();
  setDrawer(true);
  return openWorkspace(cwd);
}

async function newShellTab(folder, area = workAreaFor()) {
  const cwd = folder ?? area.current?.activePane?.cwd ?? area.current?.cwd ?? actionTask()?.cwd ?? currentPane()?.cwd ?? await api.home();
  if (!panelTree.contains(area.panel)) area = workArea(primaryChatPanel);
  if (panelTree.contains(terminalDock) && !document.body.classList.contains('codex-terminal-mode') &&
      ![...tabs.values()].some(tab => !tab.workArea)) setDrawer(false);
  return openWorkspace(cwd, 'shell', undefined, undefined, area);
}
function launchAgentFromMenu(provider) {
  if (!chatPreferences.enabled) return;
  return chatPreferences[provider] === 'chat' ? newTask(provider) : newShellTab(undefined, tabMenuArea);
}
function showPlanner() {
  openReview('planner');
  if (actionTask()) byId('planner-input').focus();
  else return newTask();
}
byId('terminal-planner').onclick = () => showPlanner()?.catch(report);
for (const [id, action, keywords] of [
  ['menu-shell', () => newShellTab(undefined, tabMenuArea), 'powershell terminal'],
  ['menu-planner', showPlanner, 'markdown note'],
  ['menu-codex', () => launchAgentFromMenu('codex'), 'agent chat cli 에이전트 채팅'],
  ['menu-claude', () => launchAgentFromMenu('claude'), 'agent chat cli 에이전트 채팅']
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

byId('switch-codex-view').onclick = async () => {
  const task = selectedTask;
  if (!task || task.provider === 'claude') return;
  const state = runtime(task);
  if (state.switching) return;
  if (state.terminalMode) {
    const pane = state.terminalPane;
    if (pane && !pane.exited) {
      setDrawer(true);
      selectTab(pane.tab, false);
      selectPane(pane, true);
      status('채팅으로 돌아가려면 Codex에서 /exit를 입력하세요.');
      return;
    }
    state.terminalMode = false;
    state.terminalPane = null;
    if (pane && panes.has(pane.id)) closePane(pane);
    setDrawer(false);
    await connectTask(task);
    return;
  }
  if (!task.threadId || state.busy || state.connecting || state.approvals.size) return;
  state.switching = true;
  renderChat();
  try {
    const installed = await api.agentProbe('codex', task.cwd);
    if (!installed) throw new Error('Codex CLI를 찾지 못했습니다.');
    if (task !== selectedTask) return;
    await api.chatClose(task.id);
    state.connected = false;
    if (task !== selectedTask) return;
    state.terminalMode = true;
    setDrawer(true);
    updateExportButtons();
    state.terminalPane = await openWorkspace(task.cwd, 'codex', task.threadId, installed.file);
    if (task === selectedTask && state.terminalPane?.running) {
      status('채팅으로 돌아가려면 Codex에서 /exit를 입력하세요.');
    }
  } catch (error) {
    state.terminalMode = false;
    state.status = error.message;
  } finally {
    state.switching = false;
    if (task === selectedTask || splitChats.has(task.id)) renderChat();
  }
};
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

async function refreshGit(force = false) {
  const cwd = reviewCwd();
  if (!cwd || byId('results-panel').dataset.review !== 'changes' ||
      byId('results-panel').dataset.collapsed === 'true' || gitBusyFor === cwd) return;
  const epoch = gitEpoch;
  gitBusyFor = cwd;
  try {
    const snapshot = await api.gitStatus(cwd);
    if (epoch !== gitEpoch || cwd !== reviewCwd()) return;
    const key = JSON.stringify(snapshot);
    if (!force && key === lastSnapshot) return;
    lastSnapshot = key;
    const fileCount = new Set(snapshot.files.map(file => file.name)).size;
    byId('git-branch').textContent = snapshot.root ? (snapshot.branch ?? '') + ' · 파일 ' + fileCount + '개' +
      (snapshot.files.length > fileCount ? ' · 변경 ' + snapshot.files.length + '건' : '') : '작업 폴더';
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
          list.append(row);
        }
      }
    }
    if (chosenPatch && !snapshot.files.some(file => file.name === chosenPatch.name && file.kind === chosenPatch.kind)) {
      chosenPatch = undefined;
      byId('patch-review').hidden = true;
    }
    if (force && chosenPatch) await openPatch(cwd, chosenPatch, byId('changes-list').querySelector('[aria-current=true]'));
  } catch (error) {
    if (epoch === gitEpoch && cwd === reviewCwd()) noteChanges(error.message);
  } finally {
    if (gitBusyFor === cwd) gitBusyFor = undefined;
  }
}

async function openPatch(cwd, entry, row) {
  const patch = { ...entry, cwd, selected: new Map() };
  chosenPatch = patch;
  const area = byId('patch-lines');
  area.replaceChildren();
  byId('patch-title').textContent = entry.name;
  byId('patch-review').hidden = false;
  byId('file-history').open = false;
  byId('file-commits').replaceChildren();
  byId('line-attribution').textContent = '';
  byId('attach-diff').disabled = true;
  for (const file of byId('changes-list').querySelectorAll('.change-file')) file.setAttribute('aria-current', String(file === row));
  byId('patch-title').textContent = entry.name + ' · ' + ({ staged: '스테이징됨', unstaged: '작업 트리', new: '새 파일', conflict: '충돌' }[entry.kind] ?? '');
  if (diffEditorTab) { diffEditorTab.name = 'diff · ' + entry.name.split('/').at(-1); renderWorkArea(diffEditorTab.workArea); }
  let content;
  try { content = await api.gitDiff(cwd, entry.name, entry.kind); }
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
      line.onclick = () => {
        if (patch.selected.has(index)) patch.selected.delete(index);
        else patch.selected.set(index, number + '  ' + text);
        line.setAttribute('aria-pressed', String(patch.selected.has(index)));
        byId('attach-diff').disabled = !actionTask() || !patch.selected.size;
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
  const excerpt = [...chosenPatch.selected].sort((a, b) => a[0] - b[0]).map(([, line]) => line).join('\n');
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
setInterval(() => refreshGit(), 3500);
onWorkspacePanelFocus = () => {
  if (reviewCwd() !== gitReviewCwd) resetGit();
};
onChatPanelFocus = () => {
  renderPlanner();
  resetGit();
  updateExportButtons();
};
tasksSidebar();
const previousTask = tasks.find(task => task.id === localStorage.getItem('agent-last-task'));
if (previousTask && !closedTasks.has(previousTask.id)) openTasks.add(previousTask.id);
renderEmptyTask();
renderWorkTabs();
renderPlanner();

function renderEmptyTask() {
  byId('chat-feed').replaceChildren();
  const empty = document.createElement('p');
  empty.className = 'chat-empty';
  const launch = button('Windows PowerShell 5.1 열기', newShellTab);
  launch.className = 'terminal-home-launch';
  const hint = document.createElement('p');
  hint.textContent = '터미널에서 codex 또는 claude 명령을 직접 실행하세요.';
  empty.append(launch, hint);
  byId('chat-feed').append(empty);
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
  output.textContent = windows.length ? windows.map(entry => Math.round(entry.usedPercent) + '%').join(' · ')
    : state === 'missing' ? 'CLI 없음' : state === 'failed' ? '조회 실패' : '한도 정보 없음';
  output.title = windows.length ? labels.join(' / ') : state === 'missing' ? 'Codex CLI를 찾지 못했습니다.'
    : state === 'failed' ? 'Codex 한도를 조회하지 못했습니다. 새로 고침으로 다시 시도하세요.' : 'Codex가 한도 정보를 보내지 않았습니다.';
  updateUsageMeter('codex-meter', windows[0]?.usedPercent);
}

function updateUsageMeter(id, percentage) {
  const meter = byId(id);
  meter.hidden = !Number.isFinite(percentage);
  if (!meter.hidden) meter.value = Math.min(100, Math.max(0, percentage));
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
    ? Math.round(claudeLimit.utilization * 100) + '%' : label[0]) : 'CLI /usage';
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
