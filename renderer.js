
const api = window.workbench;
const byId = id => document.getElementById(id);

const groups = new Map();
const tabs = new Map();
const panes = new Map();
let active = null;
let fitFrame = 0;
const currentPane = () => active?.activePane;

// ── 토스트 알림 ─────────────────────────────────────────────────────────
// 예전 하단 상태 줄(#status) 대신 오른쪽 아래에 잠깐 띄운다. 오류는 더 오래 남고, 마우스를 올리면 사라지지 않는다.
const toastHost = document.createElement('div');
toastHost.id = 'toasts';
toastHost.setAttribute('role', 'status');
toastHost.setAttribute('aria-live', 'polite');
document.body.append(toastHost);
const toastLimit = 4;

function toast(message, { kind = 'info', timeout, action } = {}) {
  const text = String(message ?? '').trim();
  if (!text) return null;
  const same = [...toastHost.children].find(node => node.dataset.text === text && node.dataset.kind === kind);
  if (same) { same.restartTimer(); return same; }
  const node = document.createElement('div');
  node.className = 'toast';
  node.dataset.kind = kind;
  node.dataset.text = text;
  const body = document.createElement('span');
  body.className = 'toast-text';
  body.textContent = text;
  const close = document.createElement('button');
  close.type = 'button';
  close.className = 'toast-close';
  close.ariaLabel = '알림 닫기';
  close.title = '닫기';
  close.textContent = '×';
  if (typeof setPanelIcon === 'function') setPanelIcon(close, 'close');
  const dismiss = () => {
    clearTimeout(node.timer);
    node.dataset.leaving = 'true';
    setTimeout(() => node.remove(), 160);
  };
  close.onclick = dismiss;
  const duration = timeout ?? (kind === 'error' ? 9000 : action ? 10000 : 4000);
  node.restartTimer = () => {
    clearTimeout(node.timer);
    node.timer = setTimeout(dismiss, duration);
  };
  node.onmouseenter = () => clearTimeout(node.timer);
  node.onmouseleave = node.restartTimer;
  node.append(body);
  if (action) {
    const act = document.createElement('button');
    act.type = 'button';
    act.className = 'toast-action';
    act.textContent = action.label;
    act.onclick = () => { dismiss(); Promise.resolve().then(action.run).catch(report); };
    node.append(act);
  }
  node.append(close);
  toastHost.append(node);
  while (toastHost.children.length > toastLimit) toastHost.firstElementChild.remove();
  node.restartTimer();
  return node;
}

function status(message, kind = 'info') {
  byId('status').textContent = message ?? '';
  toast(message, { kind });
}

function report(error) {
  const message = String(error?.message ?? error).replace(/^Error invoking remote method '[^']+': (?:Error: )?/, '');
  status(message, 'error');
}

function button(label, action) {
  const element = document.createElement('button');
  element.type = 'button';
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
  if (origin !== target && origin.panes.length) refreshPaneControls(origin);
  renderSidebar();
  scheduleFit();
}


function renderSidebar() {
  const sidebar = byId('workspaces');
  sidebar.replaceChildren();
  const query = byId('project-search').value.trim().toLowerCase();
  const folder = dockFolderKey();
  for (const group of groups.values()) {
    if (folder && terminalFolderKey(group.path) !== folder) continue;
    const matching = group.tabs.filter(tab => !tab.workArea && (group.path + ' ' + tab.name).toLowerCase().includes(query));
    if (!matching.length) continue;
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
    for (const tab of matching) {
      const item = button(tab.name, () => { if (!tab.workspacePanel) setDrawer(true); selectTab(tab); });
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

const resultPinsKey = 'workbench.result-pins';
let resultPins = [];
try {
  const saved = JSON.parse(localStorage.getItem(resultPinsKey) ?? '[]');
  if (Array.isArray(saved)) resultPins = saved.filter(record => record?.id && record.cwd && typeof record.text === 'string');
} catch {}

function availableResults() {
  const pane = currentPane();
  if (!pane) return [];
  const saved = resultPins.filter(record => record.cwd === terminalFolderKey(pane.cwd));
  const ids = new Set(pane.records.map(record => record.id));
  return [...saved.filter(record => !ids.has(record.id)), ...pane.records];
}

function filteredResults() {
  const scope = byId('results-scope').value;
  const query = byId('results-search').value.trim().toLowerCase();
  const records = scope === 'session' ? currentPane()?.records ?? [] : availableResults();
  return records.filter(record => (scope !== 'pinned' || resultPins.some(pin => pin.id === record.id)) &&
    (!query || record.text.toLowerCase().includes(query) || record.label.toLowerCase().includes(query)));
}

function toggleResultPin(pane, record) {
  const previous = resultPins;
  const pinned = previous.some(pin => pin.id === record.id);
  if (!pinned && (previous.length >= 30 || record.text.length > 32000)) {
    byId('results-feedback').textContent = '최대 30개, 항목당 32,000자까지 고정할 수 있습니다.';
    return;
  }
  const next = pinned ? previous.filter(pin => pin.id !== record.id) :
    [...previous, { id: record.id, label: record.label, text: record.text, output: record.output, ok: record.ok,
      sourceCwd: record.sourceCwd, duration: record.duration, at: record.at, selected: false, cwd: terminalFolderKey(pane.cwd) }];
  localStorage.setItem(resultPinsKey, JSON.stringify(next.map(pin => ({ ...pin, selected: false }))));
  resultPins = next;
  renderResults();
}

function updateExportButtons() {
  const records = filteredResults();
  const disabled = !records.some(record => record.selected);
  byId('copy').disabled = disabled;
  byId('save').disabled = disabled;
  byId('attach-terminal-results').disabled = disabled || !canAttachTerminalResults();
  const all = byId('select-all');
  all.disabled = !records.length;
  const count = records.filter(record => record.selected).length;
  byId('selected-count').textContent = count + '개 선택';
  byId('results-actions').hidden = !records.length || byId('results-panel').dataset.collapsed === 'true';
  all.textContent = records.length && records.every(record => record.selected)
    ? '선택 해제' : '전체 선택';
}

function resultRow(pane, record) {
  const row = document.createElement('div');
  row.className = 'result-row';
  row.dataset.status = record.ok === false ? 'failed' : record.ok ? 'ok' : 'unknown';
  const label = document.createElement('label');
  label.className = 'command';
  const checkbox = document.createElement('input');
  checkbox.type = 'checkbox';
  checkbox.checked = record.selected;
  checkbox.onchange = () => {
    record.selected = checkbox.checked;
    refreshRecordChip(record);
    updateExportButtons();
  };
  const body = document.createElement('span');
  body.className = 'command-body';
  const line = document.createElement('span');
  line.className = 'command-line';
  line.textContent = record.label;
  const output = (record.output ?? '').replace(/\s+$/, '');
  const lineCount = output ? output.split('\n').length : 0;
  const meta = document.createElement('span');
  meta.className = 'command-meta';
  meta.textContent = [
    record.ok === false ? '실패' : record.ok ? '성공' : '',
    formatDuration(record.duration),
    lineCount ? lineCount + '줄' : '출력 없음',
    record.at ? new Date(record.at).toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit' }) : ''
  ].filter(Boolean).join(' · ');
  body.append(line, meta);
  label.append(checkbox, body);
  const pinned = resultPins.some(pin => pin.id === record.id);
  const pin = button('', () => toggleResultPin(pane, record));
  pin.className = 'icon-button';
  pin.title = pinned ? '고정 해제' : '결과 고정';
  pin.setAttribute('aria-label', pin.title);
  pin.setAttribute('aria-pressed', String(pinned));
  setPanelIcon(pin, 'pin');
  row.append(label, pin);
  if (output) {
    const preview = document.createElement('details');
    preview.className = 'command-preview';
    const summary = document.createElement('summary');
    summary.textContent = output.split('\n').find(text => text.trim())?.trim().slice(0, 160) ?? '';
    const full = document.createElement('pre');
    const shown = output.split('\n');
    full.textContent = shown.slice(0, 200).join('\n') + (shown.length > 200 ? '\n… ' + (shown.length - 200) + '줄 더 있음 (복사하면 모두 포함)' : '');
    if (record.ok === false && record.sourceCwd) {
      const locations = new Map();
      for (const line of shown) {
        const match = line.match(/(?:^|\s|\()((?:[A-Za-z]:[\\/]|\.{1,2}[\\/]|[\w.-]+[\\/])[^<>:"|?*\r\n]*?\.[\w]+|[\w.-]+\.[\w]+):(\d+)(?=[:)\s,]|$)/);
        if (match) locations.set(match[1] + ':' + match[2], match);
        if (locations.size >= 20) break;
      }
      for (const [label, match] of locations) preview.append(button(label, () =>
        showSource(record.sourceCwd, match[1], Number(match[2]))));
    }
    preview.append(summary, full);
    row.append(preview);
  }
  return row;
}

function renderResults() {
  const list = byId('commands');
  const stickToBottom = list.scrollHeight - list.scrollTop - list.clientHeight < 40;
  list.replaceChildren();
  byId('results-feedback').textContent = '';
  const pane = currentPane();
  const records = filteredResults();
  if (!records.length) {
    const empty = document.createElement('p');
    empty.className = 'empty';
    empty.textContent = !pane ? '터미널을 열어 명령을 실행하세요.' : availableResults().length ? '검색 조건에 맞는 결과가 없습니다.' : '명령이 끝나면 여기에 표시됩니다.';
    list.append(empty);
  } else {
    // Oldest first, matching the order selected results are copied in.
    for (const record of records) list.append(resultRow(pane, record));
    if (stickToBottom) list.scrollTop = list.scrollHeight;
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
    for (const tab of tabs.values()) {
      if (tab.host.getClientRects().length) tab.panes.forEach(fitPane);
    }
    refreshSplitActions();
  });
}

function refreshPaneControls(tab) {
  const multiple = tab.panes.length > 1;
  const workspaceActions = tab.workArea?.current === tab ? tab.workArea.actions : null;
  const singlePane = tab.panes[0];
  if (workspaceActions && singlePane && !multiple && singlePane.actions.parentElement !== workspaceActions) {
    workspaceActions.replaceChildren(singlePane.actions);
  } else if (workspaceActions && multiple) workspaceActions.replaceChildren();
  for (const pane of tab.panes) {
    pane.section.dataset.active = String(pane === tab.activePane);
    pane.section.hidden = !!tab.expanded && tab.expanded !== pane;
    pane.header.hidden = !!workspaceActions && !multiple;
    if ((!workspaceActions || multiple) && pane.actions.parentElement !== pane.header) {
      pane.header.append(pane.actions);
    }
    pane.expand.hidden = !multiple;
    pane.expand.textContent = tab.expanded === pane ? '복원' : '확대';
    pane.expand.setAttribute('aria-pressed', String(tab.expanded === pane));
    pane.close.hidden = !multiple;
  }
  tab.host.dataset.expanded = String(!!tab.expanded);
  refreshSplitActions();
}

function refreshSplitActions() {
  const pane = currentPane();
  byId('split-terminal-right').disabled = !canSplit(pane, 'right');
  byId('split-terminal-down').disabled = !canSplit(pane, 'down');
  byId('terminal-layout-summary').textContent = pane
    ? (active.panes.length > 1 ? active.panes.length + '개 패널 · ' : '') + pane.cwd
    : '터미널 패널';
}

function splitActiveTerminal(direction) {
  const pane = currentPane();
  if (!canSplit(pane, direction)) return;
  openPane(pane.tab, pane.cwd, 'shell', pane, direction).catch(report);
}
byId('split-terminal-right').onclick = () => splitActiveTerminal('right');
byId('split-terminal-down').onclick = () => splitActiveTerminal('down');

function selectPane(pane, focus = false) {
  const tab = pane.tab;
  const changed = tab.activePane !== pane;
  tab.activePane = pane;
  if (tab.workArea && (active !== tab || tab.workArea.current !== tab)) selectTab(tab, false);
  if (active !== tab) return;
  refreshPaneControls(tab);
  if (changed) {
    status(pane.message ?? '');
    renderResults();
  }
  if (focus) pane.terminal.focus();
}

function selectTab(tab, focus = true) {
  if (active && !active.workspacePanel) active.host.hidden = true;
  active = tab ?? null;
  byId('tab-title').textContent = active?.name ?? '터미널';
  const legacyTab = [...tabs.values()].some(item => !item.workArea);
  byId('empty-terminal').hidden = !!active && (legacyTab || !active.workArea);
  byId('rename').disabled = byId('close').disabled = !active;
  status(active?.activePane?.message ?? '');
  if (active) {
    if (active.workArea) {
      showWorkAreaTab(active);
      if (focus) focusWorkspacePanel(active.workArea.panel);
    }
    active.host.hidden = false;
    refreshPaneControls(active);
    scheduleFit();
    if (focus) active.activePane?.terminal.focus();
  }
  renderSidebar();
  renderResults();
  refreshSplitActions();
}


function setSplitRatio(split, ratio) {
  split.ratio = Math.max(25, Math.min(75, ratio));
  split.element.style.setProperty('--split-first', split.ratio + 'fr');
  split.element.style.setProperty('--split-second', (100 - split.ratio) + 'fr');
  onChatLayoutChanged?.();
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
  element.terminalSplit = split;
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


function recordCommand(pane, encodedCommand, outcome = {}) {
  const terminal = pane.terminal;
  const buffer = terminal.buffer.active;
  const marker = terminal.registerMarker();
  if (!marker) return true;

  const start = pane.prompt;
  pane.prompt = { marker, column: buffer.cursorX, cwd: pane.promptDirectory };
  if (!start) return true;

  const first = start.marker.line;
  // The start marker stays alive while a record uses it, so the terminal can show the block.
  const release = () => start.marker.dispose();
  if (!encodedCommand) { release(); return true; }

  let command;
  try {
    command = new TextDecoder().decode(Uint8Array.from(atob(encodedCommand), byte => byte.charCodeAt(0)));
  } catch {
    release();
    return true;
  }

  const label = command.split(/\r?\n/, 1)[0].trim();
  if (!label) { release(); return true; }
  const last = marker.line;
  if (first < 0 || last < first) {
    release();
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
  const output = entered >= 0 ? lines.slice(entered + 1).join('\n').trimEnd() : text.trimEnd();
  if (entered >= 0) {
    lines[entered] = label;
    text = lines.slice(entered).join('\n');
  } else {
    text = command + (text ? '\n' + text.trimEnd() : '');
  }
  const record = {
    id: crypto.randomUUID(), text, output, label: label.slice(0, 180), selected: false,
    sourceCwd: start.cwd, ok: outcome.ok, duration: outcome.duration, at: Date.now(), marker: start.marker
  };
  pane.records.push(record);
  decorateRecord(pane, record);
  if (pane.records.length > 50) disposeRecord(pane.records.shift());
  if (currentPane() === pane) renderResults();
  return true;
}

function formatDuration(ms) {
  if (!Number.isFinite(ms)) return '';
  if (ms < 1000) return ms + 'ms';
  if (ms < 60000) return (ms / 1000).toFixed(ms < 10000 ? 1 : 0) + 's';
  return Math.floor(ms / 60000) + 'm ' + Math.round(ms % 60000 / 1000) + 's';
}

function recordStatusText(record) {
  return (record.ok === false ? '✕' : record.ok ? '✓' : '•') + (Number.isFinite(record.duration) ? ' ' + formatDuration(record.duration) : '');
}

// A chip at the right end of each command's prompt line marks the block in the terminal itself.
// Clicking it selects the result for copying, like ticking it in the results panel.
function decorateRecord(pane, record) {
  let decoration;
  try {
    decoration = pane.terminal.registerDecoration({ marker: record.marker, anchor: 'right', x: 0, width: 10, layer: 'top' });
  } catch { return; }
  if (!decoration) return;
  record.decoration = decoration;
  decoration.onRender(element => {
    element.classList.add('command-chip');
    element.dataset.status = record.ok === false ? 'failed' : record.ok ? 'ok' : 'unknown';
    element.dataset.selected = String(record.selected);
    element.textContent = recordStatusText(record);
    element.title = record.label + '\n' + (record.ok === false ? '실패' : record.ok ? '성공' : '상태 알 수 없음') +
      (Number.isFinite(record.duration) ? ' · ' + formatDuration(record.duration) : '') + '\n클릭해 복사할 결과로 선택';
    if (element.dataset.bound) return;
    element.dataset.bound = 'true';
    element.addEventListener('mousedown', event => event.stopPropagation());
    element.addEventListener('click', event => {
      event.stopPropagation();
      showRecordMenu(pane, record, element);
    });
  });
}

// VS Code's command decoration menu: copy the output, copy command and output, rerun, or mark the
// result for a multi-result copy in the review panel.
const recordMenu = document.createElement('div');
recordMenu.className = 'status-menu terminal-copy-menu record-menu';
recordMenu.popover = 'auto';
document.body.append(recordMenu);

function canRerun(pane) {
  return pane.running && pane.launcher === 'shell' && pane.agentState !== 'started';
}

function showRecordMenu(pane, record, anchor) {
  if (recordMenu.matches(':popover-open')) recordMenu.hidePopover();
  const title = document.createElement('strong');
  title.textContent = record.label;
  const items = [
    ['출력 복사', async () => { await api.copy(record.output ?? ''); terminalMessage(pane, '명령 출력을 복사했습니다.'); }, !record.output],
    ['명령과 출력 복사', async () => { await api.copy(record.text); terminalMessage(pane, '명령과 출력을 복사했습니다.'); }, false],
    ['다시 실행', () => { api.input(pane.id, record.label + String.fromCharCode(13)).catch(report); pane.terminal.focus(); }, !canRerun(pane)],
    [record.selected ? '복사 대상에서 빼기' : '복사 대상으로 선택', () => {
      record.selected = !record.selected;
      refreshRecordChip(record);
      if (currentPane() === pane) renderResults();
    }, false]
  ];
  recordMenu.replaceChildren(title, ...items.map(([label, action, disabled]) => {
    const item = button(label, async () => { recordMenu.hidePopover(); await action(); });
    item.disabled = disabled;
    return item;
  }));
  const rect = anchor.getBoundingClientRect();
  recordMenu.style.left = Math.max(4, Math.min(rect.right - 220, innerWidth - 228)) + 'px';
  recordMenu.style.top = Math.min(rect.bottom + 4, innerHeight - 190) + 'px';
  recordMenu.showPopover();
  recordMenu.querySelector('button:not(:disabled)')?.focus();
}

// Ctrl+Up / Ctrl+Down: scroll the focused shell to the previous / next recorded command.
function scrollToCommand(direction) {
  const pane = panes.get(document.activeElement?.closest?.('.terminal-pane')?.dataset.paneId);
  if (!pane) return;
  const top = pane.terminal.buffer.active.viewportY;
  const lines = pane.records.map(record => record.marker?.line).filter(line => line >= 0);
  const target = direction < 0 ? lines.filter(line => line < top).at(-1) : lines.find(line => line > top);
  if (target === undefined) {
    if (direction > 0) pane.terminal.scrollToBottom();
    return;
  }
  pane.terminal.scrollToLine(target);
}

function refreshRecordChip(record) {
  const element = record.decoration?.element;
  if (element) element.dataset.selected = String(record.selected);
}

function disposeRecord(record) {
  record?.decoration?.dispose();
  record?.marker?.dispose();
}


function terminalMessage(pane, message) {
  pane.message = message;
  if (currentPane() === pane) status(message);
}

function paneTitle(launcher) {
  return { shell: 'PowerShell', codex: 'Codex', claude: 'Claude', 'claude-login': 'Claude 로그인' }[launcher];
}

async function openPane(tab, cwd, launcher, anchor = null, direction = null, executable, resumeId) {
  const id = crypto.randomUUID();
  const section = document.createElement('section');
  section.className = 'terminal-pane';
  section.dataset.paneId = id;
  section.setAttribute('aria-label', paneTitle(launcher) + ' 터미널');
  const header = document.createElement('div');
  header.className = 'pane-header';
  const title = document.createElement('strong');
  title.textContent = cwd.split(/[\\/]/).filter(Boolean).at(-1) ?? cwd;
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
  const context = button('', () => showTerminalCopyMenu(pane, context));
  context.className = 'icon-button';
  context.title = '터미널 복사 옵션';
  context.setAttribute('aria-label', context.title);
  setPanelIcon(context, 'more');
  const copy = button('', async () => {
    const text = pane.terminal.getSelection() || readTerminalRows(pane.terminal.buffer.active, pane.terminal.buffer.active.viewportY, pane.terminal.rows);
    if (!text.trim()) { terminalMessage(pane, '복사할 터미널 출력이 없습니다.'); return; }
    await api.copy(text);
    terminalMessage(pane, '터미널 출력을 복사했습니다.');
    copy.dataset.copied = 'true';
    setPanelIcon(copy, 'check');
    clearTimeout(copyTimer);
    copyTimer = setTimeout(() => {
      delete copy.dataset.copied;
      setPanelIcon(copy, 'copy');
    }, 1500);
  });
  let copyTimer;
  copy.className = 'icon-button copy-terminal-screen';
  copy.title = '선택 영역 또는 현재 화면 복사 · 메뉴에서 범위 선택';
  copy.setAttribute('aria-label', copy.title);
  setPanelIcon(copy, 'copy');
  copy.oncontextmenu = event => {
    event.preventDefault();
    showTerminalCopyMenu(pane, copy);
  };
  copy.onkeydown = event => {
    if (!event.shiftKey || event.key !== 'F10') return;
    event.preventDefault();
    showTerminalCopyMenu(pane, copy);
  };
  actions.append(badge, copy, context, expand, close);
  header.append(title, actions);
  const host = document.createElement('div');
  host.className = 'pane-screen';
  section.append(header, host);

  const palette = getComputedStyle(document.documentElement);
  const foreground = palette.getPropertyValue('--text').trim();
  const terminal = new Terminal({
    scrollback: 20000, fontFamily: palette.getPropertyValue('--terminal-font').trim(), fontSize: 14,
    theme: {
      background: palette.getPropertyValue('--terminal').trim(),
      foreground,
      cursor: foreground,
      selectionBackground: palette.getPropertyValue('--terminal-selection').trim()
    },
    windowsPty: { backend: 'conpty' },
    // registerDecoration (command chips) is still a proposed API in xterm 6.
    allowProposedApi: true
  });
  const fit = new FitAddon.FitAddon();
  terminal.loadAddon(fit);
  const pane = {
    id, tab, cwd, launcher, section, host, terminal, fit, expand, close, badge,
    header, actions, records: [], running: false, resumeId
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
    const [type, encodedCommand, succeeded, elapsed] = data.split(';');
    if (type === 'workbench-directory') {
      try { pane.promptDirectory = new TextDecoder().decode(Uint8Array.from(atob(encodedCommand), c => c.charCodeAt(0))); }
      catch { pane.promptDirectory = ''; }
      return true;
    }
    if (type === 'workbench-agent') {
      pane.agentState = encodedCommand;
      pane.badge.textContent = { started: 'CLI 시작됨', returned: 'PowerShell', missing: '실행 실패' }[encodedCommand] ?? '연결됨';
      // 에이전트 TUI가 끝나고 PowerShell로 돌아왔음을 알린다(작업의 채팅 복귀에 쓴다).
      if (encodedCommand === 'returned') {
        pane.hookState = undefined;
        document.dispatchEvent(new CustomEvent('workbench-agent-returned', { detail: pane.id }));
      }
      return true;
    }
    return type === 'workbench-prompt' && recordCommand(pane, encodedCommand, {
      ok: succeeded === undefined ? undefined : succeeded === '1',
      duration: Number.isFinite(Number(elapsed)) && elapsed !== undefined ? Number(elapsed) : undefined
    });
  });
  terminal.onData(data => {
    if (pane.running) api.input(pane.id, data).catch(report);
    if (pane.launcher === 'codex') document.dispatchEvent(new CustomEvent('workbench-terminal-input', { detail: { id: pane.id, data } }));
  });

  selectPane(pane, true);
  fitPane(pane);
  scheduleFit();
  const { cols, rows } = terminal;
  pane.size = { cols, rows };
  try {
    if (resumeId) await api.spawn(id, cwd, cols, rows, launcher, executable, resumeId);
    else await api.spawn(id, cwd, cols, rows, launcher, executable);
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
    if (resumeId || launcher === 'claude-login') pane.exited = true;
  }
  onChatLayoutChanged?.();
  return pane;
}

function openTab(group, cwd = group.path, launcher = 'shell', executable, resumeId, area, activate = true) {
  const host = document.createElement('div');
  host.className = 'terminal-tab';
  const tab = { id: crypto.randomUUID(), name: paneTitle(launcher) + ' ' + (++group.count),
    group, host, panes: [], expanded: null };
  group.tabs.push(tab);
  tabs.set(tab.id, tab);
  if (area) attachWorkAreaTab(tab, area, activate);
  else byId('terminals').append(host);
  if (activate) selectTab(tab);
  return openPane(tab, cwd, launcher, null, null, executable, resumeId);
}

function terminalFolderKey(path) {
  return path?.replace(/\//g, '\\').replace(/\\+$/, '').toLowerCase();
}

function findFolderPane(path, dockOnly = false) {
  const key = terminalFolderKey(path);
  return [...panes.values()].reverse().find(pane => !pane.exited && (!dockOnly || !pane.tab.workArea) &&
    terminalFolderKey(pane.cwd) === key);
}

// The floating terminal is global, so it lists every floating shell regardless of the task in front.
function dockFolderKey() {
  return null;
}

function dockTabs() {
  const key = dockFolderKey();
  return [...tabs.values()].filter(tab => !tab.workArea && (!key || terminalFolderKey(tab.group.path) === key));
}

function dockPane() {
  return active && !active.workArea ? active.activePane : null;
}

function openWorkspace(path, launcher = 'shell', resumeId, executable, area, activate = true) {
  const key = terminalFolderKey(path);
  let group = groups.get(key);
  if (!group) {
    const name = path.split(/[\\/]/).filter(Boolean).at(-1) ?? path;
    group = { name, path, tabs: [], count: 0 };
    groups.set(key, group);
  }
  return openTab(group, path, launcher, executable, resumeId, area, activate);
}

function disposePane(pane) {
  panes.delete(pane.id);
  pane.prompt?.marker.dispose();
  pane.records.forEach(disposeRecord);
  pane.terminal.dispose();
  pane.actions.remove();
  pane.section.remove();
  api.close(pane.id).catch(report);
}

function removeTab(tab) {
  tabs.delete(tab.id);
  tab.group.tabs.splice(tab.group.tabs.indexOf(tab), 1);
  tab.host.remove();
  removeWorkAreaTab(tab);
}

function closeTab(tab) {
  const conversationPane = tab.panes.find(pane => pane.resumeId && !pane.exited);
  if (conversationPane) {
    status(launcherName(conversationPane.launcher) + '에서 /exit를 입력한 뒤 터미널을 닫으세요.');
    return;
  }
  const area = tab.workArea;
  const wasActive = active === tab;
  tab.panes.forEach(disposePane);
  removeTab(tab);
  if (wasActive) {
    const current = area?.current;
    if (current && !current.panes) { selectTab(null); activateWorkAreaTab(current); }
    else selectTab(current ?? (area ? [...tabs.values()].reverse().find(item => item.workArea?.current === item) : dockTabs().at(-1)));
  }
  renderSidebar();
}


// 터미널에서 실행한 에이전트 CLI의 표시 이름.
function launcherName(launcher, short = false) {
  return { claude: short ? 'Claude' : 'Claude Code', codex: 'Codex', agy: 'Antigravity' }[launcher] ?? launcher;
}

function closePane(pane) {
  if (pane.resumeId && !pane.exited) {
    status(launcherName(pane.launcher) + '에서 /exit를 입력한 뒤 터미널을 닫으세요.');
    return;
  }
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
  document.dispatchEvent(new CustomEvent('workbench-terminal-ended', { detail: id }));
});
new ResizeObserver(scheduleFit).observe(byId('terminals'));


byId('close').onclick = () => { if (active) closeTab(active); };



let launcherFile;
let launchProbeEpoch = 0;
async function checkLauncher(explicit, refresh = false) {
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
    result = await api.agentProbe(tool, launchDirectory, explicit ?? localStorage.getItem('agent-exe-' + tool), refresh);
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
byId('retry-launcher').onclick = () => checkLauncher(undefined, true);
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
  if (!active) return openWorkspaceShell();
  launchTarget = active;
  launchAnchor = currentPane();
  launchDirectory = currentPane()?.cwd ?? active.group.path;
  byId('launch-cwd').textContent = launchDirectory;
  byId('launch-kind').value = 'shell';
  for (const direction of Object.keys(splitDirections)) {
    byId('launch-' + direction).disabled = !canSplit(launchAnchor, direction);
  }
  byId('launch-position').value = 'tab';
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
    openWorkspace(cwd, launcher, undefined, executable).catch(report);
  } else if (panes.has(launchAnchor?.id) && launchAnchor.tab === target && canSplit(launchAnchor, position)) {
    selectTab(target);
    openPane(target, cwd, launcher, launchAnchor, position, executable).catch(report);
  }
};

function readTerminalRows(buffer, start, count) {
  let text = '';
  const end = Math.min(start + count, buffer.length);
  for (let index = start; index < end; index++) {
    const line = buffer.getLine(index);
    if (!line) continue;
    if (index > start && !line.isWrapped) text += '\n';
    text += line.translateToString(index + 1 === end || !buffer.getLine(index + 1)?.isWrapped);
  }
  return text.trimEnd();
}

function recentContext(pane) {
  const buffer = pane.terminal.buffer.active;
  const alternate = buffer.type === 'alternate';
  let end = buffer.length;
  if (!alternate) {
    const cursor = buffer.baseY + buffer.cursorY;
    while (end > cursor + 1 && !buffer.getLine(end - 1)?.translateToString(true).trim()) end--;
  }
  const start = Math.max(0, end - (alternate ? pane.terminal.rows : 200));
  return { text: readTerminalRows(buffer, start, end - start), alternate };
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
  if (tab.workArea) renderWorkArea(tab.workArea);
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
  return filteredResults().filter(record => record.selected).map(record => record.text).join('\r\n\r\n');
}
byId('results-search').oninput = byId('results-scope').onchange = renderResults;
byId('select-all').onclick = () => {
  const records = filteredResults();
  const select = !records.every(record => record.selected);
  for (const record of records) {
    record.selected = select;
    refreshRecordChip(record);
  }
  renderResults();
};
byId('copy').onclick = async () => {
  try {
    await api.copy(selectedText());
    byId('results-feedback').textContent = '클립보드에 복사했습니다.';
  } catch (error) { report(error); }
};
byId('save').onclick = async () => {
  try {
    if (await api.save(selectedText())) byId('results-feedback').textContent = '결과를 저장했습니다.';
  } catch (error) { report(error); }
};

// Drag the inner edge of either sidebar to resize it; double-click restores the default width.
for (const [id, variable] of [['workspaces-panel', '--workspaces-custom'], ['results-panel', '--results-custom']]) {
  const panel = byId(id);
  const key = 'workbench-width-' + id;
  const left = id === 'workspaces-panel';
  const apply = width => {
    if (width === null) document.body.style.removeProperty(variable);
    else document.body.style.setProperty(variable, width + 'px');
    scheduleFit();
  };
  const clamp = width => Math.round(Math.min(Math.max(width, 220), left ? 500 : Math.max(260, innerWidth * 0.45)));
  const saved = Number(localStorage.getItem(key));
  if (saved) apply(clamp(saved));
  const handle = document.createElement('div');
  handle.className = 'sidebar-resizer';
  handle.tabIndex = 0;
  handle.setAttribute('role', 'separator');
  handle.setAttribute('aria-orientation', 'vertical');
  handle.setAttribute('aria-label', (left ? '프로젝트' : '작업 검토') + ' 패널 너비');
  handle.title = '끌어서 너비 조절 · 두 번 클릭하면 기본 너비';
  const store = width => {
    apply(width);
    if (width === null) localStorage.removeItem(key);
    else localStorage.setItem(key, String(width));
  };
  handle.addEventListener('pointerdown', event => {
    if (event.button !== 0 || !event.isPrimary) return;
    event.preventDefault();
    handle.dataset.resizing = '';
    document.body.classList.add('resizing-sidebar');
    const origin = panel.getBoundingClientRect();
    trackPointer(event, next => {
      store(clamp(left ? next.clientX - origin.left : origin.right - next.clientX));
    }, () => {
      delete handle.dataset.resizing;
      document.body.classList.remove('resizing-sidebar');
    });
  });
  handle.ondblclick = () => store(null);
  handle.onkeydown = event => {
    const step = { ArrowLeft: left ? -16 : 16, ArrowRight: left ? 16 : -16 }[event.key];
    if (!step) return;
    event.preventDefault();
    store(clamp(panel.getBoundingClientRect().width + step));
  };
  panel.append(handle);
}

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
  const saved = localStorage.getItem(key);
  setCollapsed(saved === null ? id === 'results-panel' : saved === 'true');
  toggle.onclick = () => {
    const collapsed = panel.dataset.collapsed !== 'true';
    setCollapsed(collapsed);
    localStorage.setItem(key, String(collapsed));
  };
}
