const panelTree = byId('panel-tree');
const panelParking = byId('panel-parking');
const primaryChatPanel = byId('main-chat-panel');
const panelMenu = byId('panel-menu');
const splitChats = new Map();
const terminalDock = document.createElement('section');
terminalDock.className = 'workspace-panel terminal-workspace-panel';
terminalDock.append(byId('terminal-drawer'));
panelParking.append(terminalDock);

let focusedPanel = primaryChatPanel;
let lastChatPanel = primaryChatPanel;
let onChatPanelFocus;
let onWorkspacePanelFocus;
let onChatLayoutChanged;
let draggingPanel;
const panelDirections = { right: '오른쪽', down: '아래', left: '왼쪽', up: '위' };

// Icons come from icons.js (Lucide). One look everywhere: 24px grid, stroke 2, sized by CSS (16px default).
function setPanelIcon(element, name) {
  const nodes = iconNodes[name];
  if (!element || !nodes) return;
  const ns = 'http://www.w3.org/2000/svg';
  const icon = document.createElementNS(ns, 'svg');
  icon.setAttribute('viewBox', '0 0 24 24');
  icon.setAttribute('aria-hidden', 'true');
  icon.classList.add('workbench-icon');
  icon.dataset.iconName = name;
  for (const [tag, attributes] of nodes) {
    const child = document.createElementNS(ns, tag);
    for (const [key, value] of Object.entries(attributes)) child.setAttribute(key, value);
    icon.append(child);
  }
  element.replaceChildren(icon);
}
for (const [id, name] of Object.entries({
  'window-project-toggle': 'project', 'show-changes': 'panel-right',
  'new-task-top': 'plus', 'open-terminal': 'plus',
  'open-chat-settings': 'settings',
  'split-terminal-right': 'split', 'split-terminal-down': 'down', rename: 'rename',
  close: 'close', 'expand-terminal': 'expand', 'minimize-terminal': 'minus', 'send-chat': 'send',
  'refresh-git': 'refresh', 'refresh-github': 'refresh', 'expand-diff': 'expand', save: 'download'
})) setPanelIcon(byId(id), name);
// 마크업에서 data-icon="이름"으로 표시한 자리에도 같은 SVG 아이콘을 넣는다(글자 기호 대신).
for (const element of document.querySelectorAll('[data-icon]')) setPanelIcon(element, element.dataset.icon);

function focusWorkspacePanel(panel) {
  const changed = focusedPanel !== panel;
  focusedPanel = panel;
  for (const leaf of panelTree.querySelectorAll('.workspace-panel')) {
    leaf.dataset.focused = String(leaf === panel);
  }
  if (panelTask(panel) && lastChatPanel !== panel) {
    lastChatPanel = panel;
    onChatPanelFocus?.();
  }
  if (changed) onWorkspacePanelFocus?.();
  if (changed && panelTree.contains(panel)) onChatLayoutChanged?.();
}

function detachWorkspacePanel(panel) {
  const parent = panel.parentElement;
  if (!parent?.classList.contains('workspace-split')) {
    panel.remove();
  } else {
    const sibling = [...parent.children].find(child => child !== panel && child.matches('.workspace-panel,.workspace-split'));
    panel.remove();
    parent.replaceWith(sibling);
  }
  if (lastChatPanel === panel) lastChatPanel = primaryChatPanel;
  if (focusedPanel === panel) {
    const visible = [...panelTree.querySelectorAll('.workspace-panel')].find(leaf => leaf.getClientRects().length);
    focusWorkspacePanel(visible ?? primaryChatPanel);
  }
  balanceWorkspaceSplits();
  scheduleFit();
}

function setWorkspaceRatio(split, ratio) {
  split.style.setProperty('--panel-ratio', ratio + '%');
  split.children[1]?.setAttribute('aria-valuenow', String(Math.round(ratio)));
}

function balanceWorkspaceSplits() {
  function count(panel, axis) {
    if (panel?.dataset.axis !== axis) return 1;
    return count(panel.firstElementChild, axis) + count(panel.lastElementChild, axis);
  }
  for (const split of panelTree.querySelectorAll('.workspace-split:not([data-resized])')) {
    const first = count(split.firstElementChild, split.dataset.axis);
    const last = count(split.lastElementChild, split.dataset.axis);
    setWorkspaceRatio(split, 100 * first / (first + last));
  }
}

function createWorkspaceSplit(horizontal) {
  const split = document.createElement('div');
  split.className = 'workspace-split';
  split.dataset.axis = horizontal ? 'horizontal' : 'vertical';
  const divider = document.createElement('div');
  divider.className = 'workspace-divider';
  divider.tabIndex = 0;
  divider.setAttribute('role', 'separator');
  divider.setAttribute('aria-label', '패널 크기 조절');
  divider.setAttribute('aria-orientation', horizontal ? 'vertical' : 'horizontal');
  divider.setAttribute('aria-valuemin', '15');
  divider.setAttribute('aria-valuemax', '85');
  function resize(value) {
    split.dataset.resized = 'true';
    const ratio = Math.min(85, Math.max(15, value));
    setWorkspaceRatio(split, ratio);
    split.onresized?.(ratio);
    onChatLayoutChanged?.();
    scheduleFit();
  }
  divider.onpointerdown = event => {
    if (event.button !== 0) return;
    event.preventDefault();
    divider.setPointerCapture(event.pointerId);
  };
  divider.onpointermove = event => {
    if (!divider.hasPointerCapture(event.pointerId)) return;
    const rect = split.getBoundingClientRect();
    resize(100 * (horizontal ? (event.clientX - rect.left) / rect.width : (event.clientY - rect.top) / rect.height));
  };
  divider.onkeydown = event => {
    const step = horizontal ? { ArrowLeft: -5, ArrowRight: 5 } : { ArrowUp: -5, ArrowDown: 5 };
    if (!step[event.key]) return;
    event.preventDefault();
    resize(Number(divider.getAttribute('aria-valuenow')) + step[event.key]);
  };
  return { split, divider };
}

function placeWorkspacePanel(panel, anchor, direction) {
  if (panel === anchor || !panelTree.contains(anchor)) return;
  if (panelTree.contains(panel)) detachWorkspacePanel(panel);
  const { split, divider } = createWorkspaceSplit(direction === 'left' || direction === 'right');
  anchor.replaceWith(split);
  if (direction === 'left' || direction === 'up') split.append(panel, divider, anchor);
  else split.append(anchor, divider, panel);
  balanceWorkspaceSplits();
  focusWorkspacePanel(panel);
  scheduleFit();
  onChatLayoutChanged?.();
}

function dropEdge(panel, event) {
  const rect = panel.getBoundingClientRect();
  const x = (event.clientX - rect.left) / rect.width;
  const y = (event.clientY - rect.top) / rect.height;
  return Object.entries({ left: x, right: 1 - x, up: y, down: 1 - y }).sort((a, b) => a[1] - b[1])[0][0];
}

function bindWorkspacePanel(panel, header, trigger) {
  if (trigger) {
    setPanelIcon(trigger, panel === terminalDock ? 'split' : 'plus');
    trigger.title = '패널 추가 및 분할';
    trigger.onclick = event => showWorkspacePanelMenu(panel, event.currentTarget);
  }
  header.draggable = true;
  header.ondragstart = event => {
    if (event.target.closest('button')) { event.preventDefault(); return; }
    draggingPanel = panel;
    event.dataTransfer.effectAllowed = 'move';
    event.dataTransfer.setData('text/plain', 'workbench-panel');
  };
  header.ondragend = () => {
    draggingPanel = null;
    for (const target of panelTree.querySelectorAll('[data-drop-edge]')) delete target.dataset.dropEdge;
  };
  panel.ondragover = event => {
    if (!draggingPanel || draggingPanel === panel) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = 'move';
    panel.dataset.dropEdge = dropEdge(panel, event);
  };
  panel.ondragleave = event => {
    if (!panel.contains(event.relatedTarget)) delete panel.dataset.dropEdge;
  };
  panel.ondrop = event => {
    if (!draggingPanel || draggingPanel === panel) return;
    event.preventDefault();
    const source = draggingPanel;
    draggingPanel = null;
    delete panel.dataset.dropEdge;
    placeWorkspacePanel(source, panel, dropEdge(panel, event));
  };
  panel.addEventListener('focusin', () => focusWorkspacePanel(panel));
  panel.addEventListener('pointerdown', () => focusWorkspacePanel(panel));
}

function showWorkspacePanelMenu(panel, trigger) {
  if (panelMenu.matches(':popover-open')) panelMenu.hidePopover();
  panelMenu.replaceChildren();
  const addItem = (label, action) => {
    const item = button(label, () => { panelMenu.hidePopover(); return action(); });
    panelMenu.append(item);
  };
  for (const [direction, edge] of Object.entries(panelDirections)) {
    addItem(edge + '에 PowerShell', () => newSplitTerminal(panel, direction));
  }
  addItem('새 웹 미리보기 탭', () => openPreviewPanel(workAreaFor(panel)));
  const separator = document.createElement('hr');
  panelMenu.append(separator);
  for (const task of tasks.filter(task => openTasks.has(task.id) && task !== selectedTask && !splitChats.has(task.id)).slice(0, 8)) {
    addItem('오른쪽에 기존 대화 · ' + task.name, () => openSplitChat(task, panel, 'right'));
  }
  const rect = trigger.getBoundingClientRect();
  panelMenu.style.left = Math.max(4, Math.min(rect.left, innerWidth - 278)) + 'px';
  panelMenu.style.top = Math.min(rect.bottom + 3, Math.max(4, innerHeight - 310)) + 'px';
  panelMenu.showPopover();
  panelMenu.querySelector('button')?.focus();
}

function panelTask(panel) {
  return panel?.workArea?.current?.chatTask ?? null;
}

// The terminal dock lives in Orca's "floating terminal": a global panel over the window, opened by
// the sidebar or Ctrl+Alt+A, independent of which task is in front. Task terminals are tabs.
const floatingTerminal = byId('floating-terminal');
floatingTerminal.append(terminalDock);

function showTerminalDock(show) {
  floatingTerminal.hidden = !show;
  byId('nav-floating-terminal').setAttribute('aria-expanded', String(show));
  if (show) scheduleFit();
}

function workArea(panel) {
  if (panel.workArea) return panel.workArea;
  const main = panel === primaryChatPanel;
  const area = { panel, tabs: new Set(), current: null };
  const bar = document.createElement('header');
  bar.className = 'workspace-panel-bar work-area-bar';
  area.actions = document.createElement('div');
  area.actions.className = 'work-area-actions';
  if (main) {
    area.strip = byId('workbench-tabs');
    document.querySelector('.window-tools').prepend(area.actions);
    area.actions.hidden = true;
  } else {
    area.strip = document.createElement('nav');
    area.strip.className = 'work-area-tabs';
    area.strip.setAttribute('aria-label', '이 영역의 탭');
    const add = button('', () => openNewTabMenu(add, panel));
    add.className = 'icon-button area-add-tab';
    add.title = add.ariaLabel = '이 영역에 새 탭';
    setPanelIcon(add, 'plus');
    bar.append(area.strip, add, area.actions);
    panel.prepend(bar);
    bindWorkspacePanel(panel, bar, null);
  }
  area.strip.workArea = area;
  area.strip.addEventListener('wheel', event => {
    const { strip } = area;
    if (event.ctrlKey || event.deltaX || !event.deltaY || strip.scrollWidth <= strip.clientWidth) return;
    event.preventDefault();
    strip.scrollLeft += event.deltaY * (event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? strip.clientWidth : 1);
  }, { passive: false });
  panel.workArea = area;
  return area;
}

function workAreaFor(panel = focusedPanel) {
  return panelTree.contains(panel) && panel.workArea ? panel.workArea : workArea(primaryChatPanel);
}

function revealActiveWorkTab(strip) {
  const tab = strip.querySelector('.work-tab[data-active=true]');
  if (!tab || strip.scrollWidth <= strip.clientWidth) return;
  tab.scrollIntoView({ block: 'nearest', inline: 'nearest' });
}

function renderWorkArea(area) {
  if (area.panel === primaryChatPanel) renderWorkTabs();
  else {
    area.strip.replaceChildren();
    appendWorkAreaTabs(area.strip, area);
    arrangeWorkTabStrip(area);
    revealActiveWorkTab(area.strip);
  }
}

function showWorkAreaTab(tab, area = tab?.workArea) {
  if (!area) return;
  if (area.current === tab) return;
  if (area.current) area.current.host.hidden = true;
  area.actions.replaceChildren();
  area.current = tab;
  window.recordRecentTab?.(area, tab);
  const { panel } = area;
  panel.terminalTab = tab?.panes ? tab : null;
  panel.previewCwd = tab?.cwd;
  area.actions.hidden = !tab;
  if (panel === primaryChatPanel) {
    panel.classList.toggle('showing-work-tab', !!tab);
    byId('conversation').hidden = !!tab;
    panel.querySelector(':scope > header').hidden = !!tab && !tab.chatTask;
    document.body.classList.toggle('primary-work-tab', !!tab);
  }
  if (tab) {
    tab.host.hidden = false;
    if (tab.panes) refreshPaneControls(tab);
    else area.actions.replaceChildren(...(tab.actions ?? []));
  }
  renderWorkArea(area);
  if (focusedPanel === panel) {
    if (panelTask(panel)) { lastChatPanel = panel; onChatPanelFocus?.(); }
    onWorkspacePanelFocus?.();
  }
  scheduleFit();
  onChatLayoutChanged?.();
}

// Orca's rule: a task owns its editor-area tabs and splits. Tabs opened while a task is in front
// belong to it; tabs opened with no task are shared and stay visible under every task.
function tabOwner() {
  return focusedPanel.workArea?.current?.owner ?? panelTask(focusedPanel)?.id ?? panelTask(lastChatPanel)?.id ?? panelTask(primaryChatPanel)?.id ?? null;
}

function tabVisible(tab) {
  return !!tab && (tab.chatTask || !tab.owner || tab.owner === tabOwner());
}

function relayoutSplits() {
  // Deepest splits first, so a parent sees whether its children ended up empty.
  for (const split of [...panelTree.querySelectorAll('.workspace-split')].reverse()) {
    const first = split.firstElementChild;
    const second = split.lastElementChild;
    const showFirst = !first.hidden;
    const showSecond = !second.hidden;
    split.hidden = !showFirst && !showSecond;
    split.dataset.solo = showFirst && showSecond ? '' : showFirst ? 'first' : 'second';
    const divider = split.querySelector(':scope > .workspace-divider');
    if (divider) divider.hidden = !(showFirst && showSecond);
  }
}

function applyTaskLayout() {
  for (const leaf of panelTree.querySelectorAll('.workspace-panel')) {
    const area = leaf.workArea;
    if (!area || leaf === primaryChatPanel) continue;
    const visible = [...area.tabs].filter(tabVisible);
    leaf.hidden = !visible.length;
    if (visible.length && !tabVisible(area.current)) showWorkAreaTab(visible.at(-1), area);
    else renderWorkArea(area);
  }
  const primary = primaryChatPanel.workArea;
  if (primary.current && !tabVisible(primary.current)) showWorkAreaTab(null, primary);
  relayoutSplits();
  if (active?.workArea && !tabVisible(active)) selectTab(dockTabs().at(-1) ?? null, false);
  renderWorkArea(primary);
  scheduleFit();
}

function attachWorkAreaTab(tab, area, activate = true) {
  if (tab.owner === undefined) tab.owner = tabOwner();
  tab.workArea = area;
  tab.workspacePanel = area.panel;
  area.tabs.add(tab);
  area.panel.append(tab.host);
  if (activate) showWorkAreaTab(tab, area);
  else tab.host.hidden = true;
  onChatLayoutChanged?.();
}

function removeWorkAreaTab(tab) {
  const area = tab.workArea;
  if (!area) return;
  area.tabs.delete(tab);
  tab.workArea = tab.workspacePanel = null;
  tab.host.remove();
  if (!area.tabs.size && area.panel !== primaryChatPanel) {
    detachWorkspacePanel(area.panel);
    onChatLayoutChanged?.();
    return;
  }
  if (area.current === tab) showWorkAreaTab([...area.tabs].filter(tabVisible).at(-1), area);
  else renderWorkArea(area);
  onChatLayoutChanged?.();
}

function activateWorkAreaTab(tab, focus = true) {
  if (tab.panes) selectTab(tab, focus);
  else {
    showWorkAreaTab(tab);
    focusWorkspacePanel(tab.workArea.panel);
    if (tab.chatTask) activateDockedChat(tab.chatTask);
    if (focus) tab.host.querySelector('textarea,input')?.focus();
  }
}

function mountTerminalPanel(pane) {
  const leaf = document.createElement('section');
  leaf.className = 'workspace-panel';
  attachWorkAreaTab(pane.tab, workArea(leaf));
  return leaf;
}

function arrangeWorkTabStrip(area) {
  const rows = [...area.strip.children];
  const indices = new Map((area.tabOrder ?? []).map((tab, index) => [tab, index]));
  rows.sort((a, b) => (indices.get(a.workspaceTab) ?? Infinity) - (indices.get(b.workspaceTab) ?? Infinity));
  area.strip.append(...rows);
  area.tabOrder = rows.map(row => row.workspaceTab);
}

function moveWorkAreaTab(tab, target, direction, before) {
  if (direction && tab.workArea === target.workArea && target !== primaryChatPanel && target.workArea.tabs.size === 1) return;
  if (!direction && tab.workArea === target.workArea && before === undefined) return;
  if (!direction && tab.workArea === target.workArea && before === tab) return;
  const sameArea = !direction && tab.workArea === target.workArea;
  if (!sameArea && tab.workArea) removeWorkAreaTab(tab);
  if (direction) {
    const leaf = document.createElement('section');
    leaf.className = 'workspace-panel';
    attachWorkAreaTab(tab, workArea(leaf));
    placeWorkspacePanel(leaf, target, direction);
  } else if (!sameArea) attachWorkAreaTab(tab, workArea(target));
  if (before !== undefined && tab.workArea.tabOrder) {
    const order = tab.workArea.tabOrder.filter(item => item !== tab);
    const position = order.indexOf(before);
    order.splice(position === -1 ? order.length : position, 0, tab);
    tab.workArea.tabOrder = order;
    renderWorkArea(tab.workArea);
  }
  activateWorkAreaTab(tab);
  onChatLayoutChanged?.();
}

function registerWorkAreaDrag(element, tab) {
  let dragged = false;
  let guide;
  element.addEventListener('pointerdown', event => {
    dragged = false;
    if (event.button !== 0 || !event.isPrimary) return;
    function findDrop(next) {
      const node = document.elementFromPoint(next.clientX, next.clientY);
      const strip = node?.closest('#workbench-tabs,.work-area-tabs');
      if (strip?.workArea) {
        const row = node.closest('.work-tab');
        const before = row && next.clientX < row.getBoundingClientRect().left + row.offsetWidth / 2
          ? row.workspaceTab : row?.nextElementSibling?.workspaceTab;
        return { target: strip.workArea.panel, before: before ?? null };
      }
      const target = node?.closest('.workspace-panel');
      if (!target || (target === tab.workArea.panel && tab.workArea.tabs.size === 1 &&
        target !== primaryChatPanel)) return null;
      const rect = target.getBoundingClientRect();
      const direction = dropEdge(target, next);
      const x = (next.clientX - rect.left) / rect.width;
      const y = (next.clientY - rect.top) / rect.height;
      if ({ left:x, right:1-x, up:y, down:1-y }[direction] > 0.3) return null;
      return { target, direction };
    }
    trackPointer(event, next => {
      if (!dragged && Math.hypot(next.clientX - event.clientX, next.clientY - event.clientY) < 7) return;
      dragged = true;
      if (guide) delete guide.dataset.dropEdge;
      const drop = findDrop(next);
      guide = drop?.target;
      if (guide && drop.direction) guide.dataset.dropEdge = drop.direction;
    }, next => {
      if (guide) delete guide.dataset.dropEdge;
      guide = null;
      if (!dragged || !next || !tab.workArea) return;
      const drop = findDrop(next);
      if (drop) moveWorkAreaTab(tab, drop.target, drop.direction, drop.before ?? (drop.direction ? undefined : null));
    });
  });
  element.addEventListener('click', event => {
    if (dragged && event.detail) event.stopImmediatePropagation();
    dragged = false;
  }, true);
}

workArea(primaryChatPanel);

async function newSplitTerminal(anchor, direction, folder) {
  const cwd = folder ?? panelTask(anchor)?.cwd ?? anchor.terminalTab?.activePane?.cwd ?? currentPane()?.cwd ?? await api.home();
  if (!panelTree.contains(anchor)) return;
  const pane = await openWorkspace(cwd);
  if (!pane || !panes.has(pane.id)) return;
  const target = panelTree.contains(anchor) ? anchor : primaryChatPanel;
  placeWorkspacePanel(mountTerminalPanel(pane), target, direction);
  selectTab(pane.tab, true);
  return pane;
}

// The floating panel is not part of the split tree, so its header is not a drag source.
const dockHeader = byId('terminal-drawer').querySelector('header');
terminalDock.addEventListener('focusin', () => focusWorkspacePanel(terminalDock));
terminalDock.addEventListener('pointerdown', () => focusWorkspacePanel(terminalDock));
bindWorkspacePanel(primaryChatPanel, primaryChatPanel.querySelector('header'), primaryChatPanel.querySelector('.panel-menu-button'));
focusWorkspacePanel(primaryChatPanel);
window.addEventListener('resize', scheduleFit);
