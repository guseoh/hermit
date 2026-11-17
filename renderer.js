
const api = window.workbench;
const byId = id => document.getElementById(id);
const groups = new Map();
const tabs = new Map();
const panes = new Map();
let active = null;
let fitFrame = 0;
const currentPane = () => active?.activePane;

function status(message) {
  byId('status').textContent = message;
}

function report(error) {
  status(error.message ?? String(error));
}

function button(label, action) {
  const element = document.createElement('button');
  element.textContent = label;
  element.onclick = () => Promise.resolve().then(action).catch(report);
  return element;
}


const terminalArea = byId('terminals');
const dropGuide = document.createElement('div');
dropGuide.className = 'split-drop-guide';
dropGuide.setAttribute('aria-hidden', 'true');
dropGuide.hidden = true;
terminalArea.append(dropGuide);



function trackPointer(event, move, finish) {
  const pointerId = event.pointerId;
  const controller = new AbortController();
  const options = { capture: true, signal: controller.signal };
  const stop = next => {
    controller.abort();
    finish(next);
  };

  window.addEventListener('pointermove', next => {
    if (next.pointerId !== pointerId) return;
    if (!(next.buttons & 1)) stop(null);
    else move(next);
  }, options);
  window.addEventListener('pointerup', next => {
    if (next.pointerId === pointerId) stop(next);
  }, options);
  window.addEventListener('pointercancel', next => {
    if (next.pointerId === pointerId) stop(null);
  }, options);
  window.addEventListener('blur', () => stop(null), { signal: controller.signal });
}


function registerTabDrag(element, getPane, moveWithinTab = false) {
  element.dataset.tabDrag = '';
  let suppressClick = false;

  element.addEventListener('pointerdown', event => {
    suppressClick = false;
    if (event.button !== 0 || !event.isPrimary || active?.expanded) return;
    const source = getPane();
    if (!source) return;
    let moved = false;
    const resolveDrop = next => {
      const drop = splitDrop(next);
      if (!drop || !canSplit(drop.pane, drop.direction)) return null;
      const move = source.tab !== active || (moveWithinTab && source !== drop.pane);
      return { ...drop, move };
    };

    trackPointer(event, next => {
      if (!moved && Math.hypot(next.clientX - event.clientX, next.clientY - event.clientY) < 7) return;
      moved = true;
      showSplitGuide(resolveDrop(next));
    }, next => {
      if (!moved) return;
      suppressClick = true;
      dropGuide.hidden = true;
      delete dropGuide.dataset.direction;
      const drop = next && resolveDrop(next);
      if (!drop || !panes.has(source.id)) return;
      if (drop.move) movePane(source, drop.pane, drop.direction);
      else openPane(active, drop.pane.cwd, 'shell', drop.pane, drop.direction).catch(report);
    });
  });
  element.addEventListener('click', event => {
    if (!suppressClick) return;
    suppressClick = false;
    if (!event.detail) return;
    event.preventDefault();
    event.stopImmediatePropagation();
  }, true);
}

const splitDirections = { left: '왼쪽', right: '오른쪽', up: '위쪽', down: '아래쪽' };

function isHorizontalSplit(direction) {
  return direction === 'left' || direction === 'right';
}

function canSplit(pane, direction) {
  if (!pane || pane.tab.expanded) return false;
  const rect = pane.section.getBoundingClientRect();
  return isHorizontalSplit(direction) ? rect.width >= 276 : rect.height >= 208;
}

function splitDrop(event) {
  const section = document.elementFromPoint(event.clientX, event.clientY)?.closest('.terminal-pane');
  const pane = panes.get(section?.dataset.paneId);
  if (!pane || pane.tab !== active) return null;
  const rect = section.getBoundingClientRect();
  const x = (event.clientX - rect.left) / rect.width;
  const y = (event.clientY - rect.top) / rect.height;
  const distances = { left: x, right: 1 - x, up: y, down: 1 - y };
  const direction = Object.keys(distances).reduce((best, edge) => distances[edge] < distances[best] ? edge : best);
  return distances[direction] <= 0.33 ? { pane, direction, rect } : null;
}

function showSplitGuide(drop) {
  dropGuide.hidden = false;
  if (!drop) {
    delete dropGuide.dataset.direction;
    dropGuide.textContent = '분할할 패널의 가장자리에 놓기';
    return;
  }
  const { direction, rect, move } = drop;
  const area = terminalArea.getBoundingClientRect();
  const width = rect.width * (isHorizontalSplit(direction) ? 0.5 : 1);
  const height = rect.height * (isHorizontalSplit(direction) ? 1 : 0.5);
  dropGuide.dataset.direction = direction;
  dropGuide.style.setProperty('--drop-left', rect.left - area.left + (direction === 'right' ? width : 0) + 'px');
  dropGuide.style.setProperty('--drop-top', rect.top - area.top + (direction === 'down' ? height : 0) + 'px');
  dropGuide.style.setProperty('--drop-width', width + 'px');
  dropGuide.style.setProperty('--drop-height', height + 'px');
  dropGuide.textContent = splitDirections[direction] + (move ? '으로 패널 이동' : '에 새 PowerShell 열기');
}

function movePane(pane, anchor, direction) {
  const origin = pane.tab;
  const target = anchor.tab;
  collapseSplit(pane);
  if (origin !== target) {
    origin.panes.splice(origin.panes.indexOf(pane), 1);
    target.panes.push(pane);
    pane.tab = target;
    if (!origin.panes.length) removeTab(origin);
    else if (origin.activePane === pane) origin.activePane = origin.panes[0];
    if (origin.expanded === pane) origin.expanded = null;
  }
  placePane(pane, anchor, direction);
  selectPane(pane, true);
  renderSidebar();
  scheduleFit();
}


function renderSidebar() {
  const sidebar = byId('workspaces');
  sidebar.replaceChildren();
  for (const group of groups.values()) {
    const section = document.createElement('section');
    section.className = 'group';
    const header = document.createElement('header');
    const title = document.createElement('strong');
    title.textContent = group.name;
    title.title = group.path;
    const add = button('+', () => openTab(group));
    add.setAttribute('aria-label', group.name + '에 탭 추가');
    header.append(title, add);
    section.append(header);
    for (const tab of group.tabs) {
      const item = button(tab.name, () => { setDrawer(true); selectTab(tab); });
      item.className = 'tab';
      item.dataset.terminalTabId = tab.id;
      item.title = tab.name + ' · 끌어서 분할';
      registerTabDrag(item, () => tab === active || tab.panes.length === 1 ? tab.activePane : null);
      item.setAttribute('aria-current', String(tab === active));
      section.append(item);
    }
    sidebar.append(section);
  }
}

function updateExportButtons() {
  const records = currentPane()?.records ?? [];
  const disabled = !records.some(record => record.selected);
  byId('copy').disabled = disabled;
  byId('save').disabled = disabled;
  const all = byId('select-all');
  all.disabled = !records.length;
  const count = records.filter(record => record.selected).length;
  byId('selected-count').textContent = count + '개 선택';
  byId('results-actions').hidden = !count || byId('results-panel').dataset.collapsed === 'true';
  all.textContent = records.length && records.every(record => record.selected)
    ? '선택 해제' : '전체 선택';
}

function renderResults() {
  const list = byId('commands');
  list.replaceChildren();
  const records = currentPane()?.records ?? [];
  if (!records.length) {
    const empty = document.createElement('p');
    empty.className = 'empty';
    empty.textContent = '명령이 끝나면 여기에 표시됩니다.';
    list.append(empty);
  } else {
    for (const record of [...records].reverse()) {
      const label = document.createElement('label');
      label.className = 'command';
      const checkbox = document.createElement('input');
      checkbox.type = 'checkbox';
      checkbox.checked = record.selected;
      checkbox.onchange = () => {
        record.selected = checkbox.checked;
        updateExportButtons();
      };
      label.append(checkbox, document.createTextNode(record.label));
      list.append(label);
    }
  }
  updateExportButtons();
}


function fitPane(pane) {
  if (!pane.host.clientWidth || !pane.host.clientHeight) return;
  pane.fit.fit();
  const { cols, rows } = pane.terminal;
  if (!pane.running || (pane.size?.cols === cols && pane.size?.rows === rows)) return;
  pane.size = { cols, rows };
  api.resize(pane.id, cols, rows).catch(error => {
    if (panes.has(pane.id) && pane.running) report(error);
  });
}

function scheduleFit() {
  if (fitFrame) return;
  fitFrame = requestAnimationFrame(() => {
    fitFrame = 0;
    active?.panes.forEach(fitPane);
  });
}

function refreshPaneControls(tab) {
  const multiple = tab.panes.length > 1;
  for (const pane of tab.panes) {
    pane.section.dataset.active = String(pane === tab.activePane);
    pane.section.hidden = !!tab.expanded && tab.expanded !== pane;
    pane.expand.hidden = !multiple;
    pane.expand.textContent = tab.expanded === pane ? '복원' : '확대';
    pane.expand.setAttribute('aria-pressed', String(tab.expanded === pane));
    pane.close.hidden = !multiple;
  }
  tab.host.dataset.expanded = String(!!tab.expanded);
}

function selectPane(pane, focus = false) {
  const tab = pane.tab;
  const changed = tab.activePane !== pane;
  tab.activePane = pane;
  if (active !== tab) return;
  refreshPaneControls(tab);
  if (changed) {
    status(pane.message ?? '');
    renderResults();
  }
  if (focus) pane.terminal.focus();
}

function selectTab(tab) {
  if (active) active.host.hidden = true;
  active = tab ?? null;
  byId('tab-title').textContent = active?.name ?? 'PowerShell 5.1';
  byId('rename').disabled = byId('close').disabled = byId('open-terminal').disabled = !active;
  status(active?.activePane?.message ?? '');
  if (active) {
    active.host.hidden = false;
    refreshPaneControls(active);
    scheduleFit();
    active.activePane?.terminal.focus();
  }
  renderSidebar();
  renderResults();
}


function setSplitRatio(split, ratio) {
  split.ratio = Math.max(25, Math.min(75, ratio));
  split.element.style.setProperty('--split-first', split.ratio + 'fr');
  split.element.style.setProperty('--split-second', (100 - split.ratio) + 'fr');
  split.divider.setAttribute('aria-valuenow', Math.round(split.ratio));
  scheduleFit();
}

function splitDivider(split) {
  const divider = document.createElement('div');
  divider.className = 'split-divider';
  divider.tabIndex = 0;
  divider.setAttribute('role', 'separator');
  divider.setAttribute('aria-label', '터미널 분할 크기');
  divider.setAttribute('aria-orientation', split.horizontal ? 'vertical' : 'horizontal');
  divider.title = '끌어서 패널 크기 조절';
  divider.setAttribute('aria-valuemin', '25');
  divider.setAttribute('aria-valuemax', '75');
  divider.setAttribute('aria-valuenow', '50');

  divider.addEventListener('pointerdown', event => {
    if (event.button !== 0 || !event.isPrimary) return;
    event.preventDefault();
    divider.focus();
    divider.dataset.resizing = '';
    trackPointer(event, next => {
      const bounds = split.element.getBoundingClientRect();
      const offset = split.horizontal ? next.clientX - bounds.left : next.clientY - bounds.top;
      const length = split.horizontal ? bounds.width : bounds.height;
      if (length) setSplitRatio(split, offset / length * 100);
    }, () => { delete divider.dataset.resizing; });
  });

  divider.addEventListener('keydown', event => {
    const keys = split.horizontal ? ['ArrowLeft', 'ArrowRight'] : ['ArrowUp', 'ArrowDown'];
    if (!keys.includes(event.key)) return;
    event.preventDefault();
    setSplitRatio(split, split.ratio + (event.key === keys[0] ? -5 : 5));
  });
  return divider;
}

function placePane(pane, anchor, direction) {
  if (!anchor) {
    pane.tab.host.append(pane.section);
    return;
  }
  const element = document.createElement('div');
  element.className = 'terminal-split';
  const split = { element, horizontal: isHorizontalSplit(direction), ratio: 50 };
  element.dataset.axis = split.horizontal ? 'columns' : 'rows';
  split.divider = splitDivider(split);
  const before = direction === 'left' || direction === 'up';
  anchor.section.replaceWith(element);
  element.append(before ? pane.section : anchor.section, split.divider, before ? anchor.section : pane.section);
}

function collapseSplit(pane) {
  const split = pane.section.parentElement;
  if (!split?.classList.contains('terminal-split')) return null;
  const sibling = split.firstElementChild === pane.section ? split.lastElementChild : split.firstElementChild;
  split.replaceWith(sibling);
  return sibling;
}


function recordCommand(pane, encodedCommand) {
  const terminal = pane.terminal;
  const buffer = terminal.buffer.active;
  const marker = terminal.registerMarker();
  if (!marker) return true;

  const start = pane.prompt;
  pane.prompt = { marker, column: buffer.cursorX };
  if (!start) return true;

  const first = start.marker.line;
  start.marker.dispose();
  if (!encodedCommand) return true;

  let command;
  try {
    command = new TextDecoder().decode(Uint8Array.from(atob(encodedCommand), byte => byte.charCodeAt(0)));
  } catch {
    return true;
  }

  const label = command.split(/\r?\n/, 1)[0].trim();
  if (!label) return true;
  const last = marker.line;
  if (first < 0 || last < first) {
    pane.message = '터미널 버퍼를 초과한 명령은 결과 목록에 담을 수 없습니다.';
    if (currentPane() === pane) status(pane.message);
    return true;
  }

  let text = '';
  for (let row = first; row <= last; row++) {
    const line = buffer.getLine(row);
    if (!line || (row === last && pane.prompt.column === 0)) break;
    if (row > first && !line.isWrapped) text += '\n';
    text += line.translateToString(row !== last, row === first ? start.column : 0,
      row === last ? pane.prompt.column : undefined);
  }

  const lines = text.trimEnd().split('\n');
  const entered = lines.findIndex(line => line.trimEnd().endsWith(label));
  if (entered >= 0) {
    lines[entered] = label;
    text = lines.slice(entered).join('\n');
  } else {
    text = command + (text ? '\n' + text.trimEnd() : '');
  }
  pane.records.push({ text, label: label.slice(0, 180), selected: false });
  if (pane.records.length > 50) pane.records.shift();
  if (currentPane() === pane) renderResults();
  return true;
}


function terminalMessage(pane, message) {
  pane.message = message;
  if (currentPane() === pane) status(message);
}

function paneTitle(launcher) {
  return { shell: 'PowerShell', codex: 'Codex', claude: 'Claude' }[launcher];
}

async function openPane(tab, cwd, launcher, anchor = null, direction = null, executable) {
  const id = crypto.randomUUID();
  const section = document.createElement('section');
  section.className = 'terminal-pane';
  section.dataset.paneId = id;
  section.setAttribute('aria-label', paneTitle(launcher) + ' 터미널');
  const header = document.createElement('div');
  header.className = 'pane-header';
  const title = document.createElement('strong');
  title.textContent = paneTitle(launcher);
  title.title = cwd + ' · 끌어서 분할';
  registerTabDrag(title, () => pane, true);
  const badge = document.createElement('span');
  badge.className = 'pane-state';
  badge.textContent = '연결 중';
  const expand = button('확대', () => {
    pane.tab.expanded = pane.tab.expanded === pane ? null : pane;
    selectPane(pane, true);
    scheduleFit();
  });
  const close = button('닫기', () => closePane(pane));
  close.setAttribute('aria-label', paneTitle(launcher) + ' 패널 닫기');
  const actions = document.createElement('div');
  actions.className = 'pane-actions';
  const context = button('▤', () => showRecentContext(pane));
  context.className = 'icon-button';
  context.title = '최근 화면';
  context.setAttribute('aria-label', '최근 화면');
  actions.append(badge, context, expand, close);
  header.append(title, actions);
  const host = document.createElement('div');
  host.className = 'pane-screen';
  section.append(header, host);

  const terminal = new Terminal({
    scrollback: 20000, fontFamily: 'MesloLGS Nerd Font, Cascadia Mono, Consolas, monospace', fontSize: 14,
    theme: { background: '#101010', foreground: '#efefed', cursor: '#dfd6be', selectionBackground: '#5a5343' },
    windowsPty: { backend: 'conpty' }
  });
  const fit = new FitAddon.FitAddon();
  terminal.loadAddon(fit);
  const pane = {
    id, tab, cwd, launcher, section, host, terminal, fit, expand, close, badge,
    records: [], running: false
  };
  tab.panes.push(pane);
  panes.set(id, pane);
  placePane(pane, anchor, direction);
  terminal.open(host);

  section.addEventListener('focusin', () => selectPane(pane));
  header.addEventListener('click', event => {
    if (event.target.closest('button')) return;
    selectPane(pane, true);
  });
  terminal.parser.registerOscHandler(777, data => {
    const [type, encodedCommand] = data.split(';', 2);
    if (type === 'workbench-agent') {
      pane.agentState = encodedCommand;
      pane.badge.textContent = { started: 'CLI 시작됨', returned: 'PowerShell', missing: '실행 실패' }[encodedCommand] ?? '연결됨';
      return true;
    }
    return type === 'workbench-prompt' && recordCommand(pane, encodedCommand);
  });
  terminal.onData(data => {
    if (pane.running) api.input(pane.id, data).catch(report);
  });

  selectPane(pane, true);
  fitPane(pane);
  scheduleFit();
  const { cols, rows } = terminal;
  pane.size = { cols, rows };
  try {
    await api.spawn(id, cwd, cols, rows, launcher, executable);
    if (!panes.has(id)) {
      await api.close(id);
      return;
    }
    if (!pane.exited) {
      pane.running = true;
      if (!pane.agentState) badge.textContent = launcher === 'shell' ? '연결됨' : 'CLI 시작 중';
      if (active === pane.tab) fitPane(pane);
    }
  } catch (error) {
    if (!panes.has(id)) return;
    badge.textContent = '연결 실패';
    terminalMessage(pane, error.message);
  }
}

function openTab(group, cwd = group.path, launcher = 'shell', executable) {
  const host = document.createElement('div');
  host.className = 'terminal-tab';
  const tab = { id: crypto.randomUUID(), name: paneTitle(launcher) + ' ' + (++group.count),
    group, host, panes: [], expanded: null };
  byId('terminals').append(host);
  group.tabs.push(tab);
  tabs.set(tab.id, tab);
  selectTab(tab);
  return openPane(tab, cwd, launcher, null, null, executable);
}

function openWorkspace(path) {
  const key = path.toLowerCase();
  let group = groups.get(key);
  if (!group) {
    const name = path.split(/[\\/]/).filter(Boolean).at(-1) ?? path;
    group = { name, path, tabs: [], count: 0 };
    groups.set(key, group);
  }
  return openTab(group);
}

function disposePane(pane) {
  panes.delete(pane.id);
  pane.prompt?.marker.dispose();
  pane.terminal.dispose();
  pane.section.remove();
  api.close(pane.id).catch(report);
}

function removeTab(tab) {
  tabs.delete(tab.id);
  tab.group.tabs.splice(tab.group.tabs.indexOf(tab), 1);
  tab.host.remove();
}

function closeTab(tab) {
  tab.panes.forEach(disposePane);
  removeTab(tab);
  selectTab(tab.group.tabs.at(-1) ?? [...tabs.values()].at(-1));
}


function closePane(pane) {
  const tab = pane.tab;
  if (tab.panes.length === 1) {
    closeTab(tab);
    return;
  }
  const sibling = collapseSplit(pane);
  tab.panes.splice(tab.panes.indexOf(pane), 1);
  if (tab.expanded === pane) tab.expanded = null;
  disposePane(pane);
  const next = tab.activePane === pane
    ? tab.panes.find(candidate => sibling?.contains(candidate.section)) ?? tab.panes[0]
    : tab.activePane;
  selectPane(next, true);
  scheduleFit();
}


api.onData((id, data) => panes.get(id)?.terminal.write(data));
api.onExit((id, code) => {
  const pane = panes.get(id);
  if (!pane) return;
  pane.running = false;
  pane.exited = true;
  pane.badge.textContent = '종료 ' + code;
  terminalMessage(pane, '세션 종료 (' + code + ')');
});
new ResizeObserver(scheduleFit).observe(byId('terminals'));


byId('add-workspace').onclick = async () => {
  try {
    const path = await api.folder();
    if (path) { setDrawer(true); await openWorkspace(path); }
  } catch (error) { report(error); }
};
byId('close').onclick = () => { if (active) closeTab(active); };



let launcherFile;
let launchProbeEpoch = 0;
async function checkLauncher(explicit) {
  const epoch = ++launchProbeEpoch;
  const tool = byId('launch-kind').value;
  const submit = byId('launch-dialog').querySelector('button[type=submit]');
  const info = byId('launcher-info');
  const controls = ['retry-launcher', 'browse-launcher', 'launcher-help'].map(byId);
  controls.forEach(control => { control.hidden = true; });
  launcherFile = null;
  submit.disabled = tool !== 'shell';
  info.textContent = tool === 'shell' ? '' : '실행 환경 확인 중…';
  if (tool === 'shell') return;
  let result;
  try {
    result = await api.agentProbe(tool, launchDirectory, explicit ?? localStorage.getItem('agent-exe-' + tool));
  } catch (error) {
    if (epoch === launchProbeEpoch) info.textContent = error.message;
  }
  if (epoch !== launchProbeEpoch) return;
  if (result) {
    launcherFile = result.file;
    if (explicit) localStorage.setItem('agent-exe-' + tool, explicit);
    info.textContent = result.version;
    submit.disabled = false;
  } else {
    if (info.textContent === '실행 환경 확인 중…') info.textContent = tool + ' 실행 파일을 찾거나 실행하지 못했습니다.';
    controls[0].hidden = controls[1].hidden = false;
    controls[2].hidden = tool !== 'claude';
  }
}
byId('launch-kind').onchange = () => checkLauncher();
byId('retry-launcher').onclick = () => checkLauncher();
byId('browse-launcher').onclick = async () => {
  try {
    const executable = await api.agentBrowse();
    if (executable && byId('launch-dialog').open) await checkLauncher(executable);
  } catch (error) { report(error); }
};
byId('launcher-help').onclick = event => {
  event.preventDefault();
  api.claudeHelp().catch(report);
};


let launchTarget;
let launchDirectory;
let launchAnchor;
byId('open-terminal').onclick = () => {
  launchTarget = active;
  launchAnchor = currentPane();
  launchDirectory = currentPane()?.cwd ?? active.group.path;
  byId('launch-cwd').textContent = launchDirectory;
  byId('launch-kind').value = 'shell';
  for (const direction of Object.keys(splitDirections)) {
    byId('launch-' + direction).disabled = !canSplit(launchAnchor, direction);
  }
  byId('launch-position').value = canSplit(launchAnchor, 'right') ? 'right'
    : canSplit(launchAnchor, 'down') ? 'down' : 'tab';
  byId('launch-dialog').showModal();
  checkLauncher();
};
byId('browse-cwd').onclick = async () => {
  try {
    const directory = await api.folder();
    if (directory && byId('launch-dialog').open) {
      launchDirectory = directory;
      byId('launch-cwd').textContent = directory;
      checkLauncher();
    }
  } catch (error) { report(error); }
};
byId('cancel-launch').onclick = () => byId('launch-dialog').close('cancel');
byId('launch-dialog').querySelector('form').onsubmit = event => {
  event.preventDefault();
  const target = launchTarget;
  const cwd = launchDirectory;
  const launcher = byId('launch-kind').value;
  const position = byId('launch-position').value;
  if (launcher !== 'shell' && !launcherFile) return;
  const executable = launcherFile;
  byId('launch-dialog').close();
  if (!tabs.has(target?.id)) return;
  if (position === 'tab') {
    openTab(target.group, cwd, launcher, executable).catch(report);
  } else if (panes.has(launchAnchor?.id) && launchAnchor.tab === target && canSplit(launchAnchor, position)) {
    selectTab(target);
    openPane(target, cwd, launcher, launchAnchor, position, executable).catch(report);
  }
};

function recentContext(pane) {
  const buffer = pane.terminal.buffer.active;
  const alternate = buffer.type === 'alternate';
  let end = buffer.length;
  if (!alternate) {
    const cursor = buffer.baseY + buffer.cursorY;
    while (end > cursor + 1 && !buffer.getLine(end - 1)?.translateToString(true).trim()) end--;
  }
  const start = Math.max(0, end - (alternate ? pane.terminal.rows : 200));
  let text = '';
  for (let index = start; index < end; index++) {
    const line = buffer.getLine(index);
    if (!line) continue;
    if (index > start && !line.isWrapped) text += '\n';
    text += line.translateToString(!buffer.getLine(index + 1)?.isWrapped);
  }
  return { text: text.trimEnd(), alternate };
}

function showRecentContext(pane) {
  const { text, alternate } = recentContext(pane);
  byId('context-note').textContent = paneTitle(pane.launcher) + (alternate
    ? ' · 현재 화면' : ' · 터미널 최근 최대 200줄');
  byId('context-text').value = text;
  byId('copy-context').disabled = !text;
  byId('context-dialog').showModal();
};
byId('context-text').oninput = () => {
  byId('copy-context').disabled = !byId('context-text').value.trim();
};
byId('copy-context').onclick = async () => {
  try {
    await api.copy(byId('context-text').value);
    byId('context-dialog').close();
    status('미리보기 내용을 복사했습니다.');
  } catch (error) { report(error); }
};


let renameTarget;


function editInline(label, save) {
  const input = document.createElement('input');
  input.className = 'inline-title';
  input.value = label.textContent;
  input.maxLength = 60;
  input.setAttribute('aria-label', '이름 변경');
  label.after(input);
  label.hidden = true;
  let finished = false;
  let saveAfterComposition = false;

  const finish = accept => {
    if (finished) return;
    finished = true;
    const name = input.value.trim();
    input.remove();
    label.hidden = false;
    if (accept && name) save(name);
  };

  input.onkeydown = event => {
    if (event.isComposing || event.keyCode === 229) {
      if (event.key === 'Enter') saveAfterComposition = true;
      if (event.key === 'Escape') saveAfterComposition = false;
      return;
    }
    if (!['Enter', 'Escape'].includes(event.key)) return;
    event.preventDefault();
    finish(event.key === 'Enter');
  };
  input.addEventListener('compositionend', () => {
    if (saveAfterComposition) requestAnimationFrame(() => finish(true));
    saveAfterComposition = false;
  });
  input.onblur = () => finish(true);
  input.focus();
  input.select();
}

function renameTab(tab, name) {
  if (!tabs.has(tab.id)) return;
  tab.name = name;
  if (active === tab) byId('tab-title').textContent = name;
  const item = byId('workspaces').querySelector('[data-terminal-tab-id="' + tab.id + '"]');
  if (item) {
    item.textContent = name;
    item.title = name + ' · 끌어서 분할';
  }
}


byId('tab-title').ondblclick = () => {
  const tab = active;
  if (!tab) return;
  editInline(byId('tab-title'), name => renameTab(tab, name));
};
byId('rename').onclick = () => {
  renameTarget = active;
  byId('new-name').value = active.name;
  byId('rename-dialog').returnValue = '';
  byId('rename-dialog').showModal();
  byId('new-name').select();
};
byId('cancel-rename').onclick = () => byId('rename-dialog').close('cancel');
byId('rename-dialog').onclose = () => {
  const name = byId('new-name').value.trim();
  if (byId('rename-dialog').returnValue === 'ok' && name && tabs.has(renameTarget.id)) {
    renameTab(renameTarget, name);
  }
};
function selectedText() {
  return currentPane()?.records.filter(record => record.selected).map(record => record.text).join('\r\n\r\n');
}
byId('select-all').onclick = () => {
  const records = currentPane()?.records ?? [];
  const select = !records.every(record => record.selected);
  for (const record of records) record.selected = select;
  renderResults();
};
byId('copy').onclick = async () => {
  try {
    await api.copy(selectedText());
    status('선택한 명령과 출력을 복사했습니다.');
  } catch (error) { report(error); }
};
byId('save').onclick = async () => {
  try {
    if (await api.save(selectedText())) status('결과를 저장했습니다.');
  } catch (error) { report(error); }
};

for (const id of ['workspaces-panel', 'results-panel']) {
  const panel = byId(id);
  const toggle = byId('toggle-' + id);
  const key = 'collapsed-' + id;
  const content = panel.querySelectorAll('[data-sidebar-content]');
  const label = id === 'workspaces-panel' ? '작업공간' : '결과';
  const setCollapsed = collapsed => {
    panel.dataset.collapsed = String(collapsed);
    for (const element of content) element.hidden = collapsed;
    document.body.classList.toggle(key, collapsed);
    toggle.setAttribute('aria-expanded', String(!collapsed));
    const description = label + (collapsed ? ' 펼치기' : ' 접기');
    toggle.setAttribute('aria-label', description);
    toggle.title = description;
    scheduleFit();
    if (id === 'results-panel') updateExportButtons();
  };
  setCollapsed(localStorage.getItem(key) === 'true');
  toggle.onclick = () => {
    const collapsed = panel.dataset.collapsed !== 'true';
    setCollapsed(collapsed);
    localStorage.setItem(key, String(collapsed));
  };
}


api.home().then(openWorkspace).catch(report);
