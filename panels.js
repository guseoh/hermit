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
let draggingPanel;
const panelDirections = { right: '오른쪽', down: '아래', left: '왼쪽', up: '위' };

const paths = {
  project: 'M3 5h6l2 2h10v12H3z M8 7v12',
  agents: 'M4 4h6v6H4z M14 4h6v6h-6z M4 14h6v6H4z M14 14h6v6h-6z',
  branch: 'M7 5v14m10-14v3c0 4-4 5-10 5 M7 3v2m0 14v2m10-18v2',
  terminal: 'M3 4h18v16H3z M7 8l4 4-4 4m7 0h3',
  split: 'M3 4h18v16H3z M12 4v16m-5-8h2m6 0h2',
  down: 'M3 4h18v16H3z M3 12h18',
  plus: 'M12 5v14M5 12h14',
  close: 'm6 6 12 12M18 6 6 18',
  expand: 'M13 4h7v7M20 4l-6 6M11 20H4v-7m0 7 6-6',
  minus: 'M5 12h14',
  send: 'M12 19V5m-6 6 6-6 6 6',
  rename: 'm4 16 12-12 4 4L8 20H4zM13 7l4 4',
  pin: 'm8 4 8 0m-7 0v6l-3 3v2h12v-2l-3-3V4m-3 11v6',
  chevron: 'm9 5 7 7-7 7',
  note: 'M6 3h8l4 4v14H6z M14 3v5h4 M9 12h6m-6 4h6',
  web: 'M21 12a9 9 0 1 0-18 0 9 9 0 0 0 18 0Zm-18 0h18M12 3a14 14 0 0 1 0 18 14 14 0 0 1 0-18Z',
  more: 'M5 12h1m5 0h2m5 0h1',
  copy: 'M8 8h12v12H8z M16 8V4H4v12h4',
  check: 'm5 12 4 4L19 6',
  refresh: 'M20 10a8 8 0 1 0-2 7m2-13v6h-6',
  power: 'M12 3v9m-4-6a8 8 0 1 0 8 0',
  resource: 'M4 6h16v12H4zm4 8v1m4-4v4m4-6v6',
  settings: 'M9 3h6l1 3 3 1 2 4-2 3v4l-4 3-3-1-3 1-4-3v-4l-2-3 2-4 3-1z M15 12a3 3 0 1 0-6 0 3 3 0 1 0 6 0'
};

function setPanelIcon(element, name) {
  const ns = 'http://www.w3.org/2000/svg';
  const icon = document.createElementNS(ns, 'svg');
  icon.setAttribute('viewBox', '0 0 24 24');
  icon.setAttribute('aria-hidden', 'true');
  icon.classList.add('workbench-icon');
  const path = document.createElementNS(ns, 'path');
  path.setAttribute('d', paths[name]);
  icon.append(path);
  element.replaceChildren(icon);
}

for (const [id, name] of Object.entries({
  'window-project-toggle': 'project', 'show-agents': 'agents', 'show-changes': 'branch',
  'toggle-terminal': 'terminal', 'new-task-top': 'plus', 'open-terminal': 'plus',
  'open-chat-settings': 'settings',
  'split-terminal-right': 'split', 'split-terminal-down': 'down', rename: 'rename',
  close: 'close', 'expand-terminal': 'expand', 'minimize-terminal': 'minus', 'send-chat': 'send'
})) setPanelIcon(byId(id), name);

function focusWorkspacePanel(panel) {
  const changed = focusedPanel !== panel;
  focusedPanel = panel;
  for (const leaf of panelTree.querySelectorAll('.workspace-panel')) {
    leaf.dataset.focused = String(leaf === panel);
  }
  if ((panel === primaryChatPanel || panel.chatTask) && lastChatPanel !== panel) {
    lastChatPanel = panel;
    onChatPanelFocus?.();
  }
  if (changed) onWorkspacePanelFocus?.();
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
  if (panel === terminalDock) {
    for (const direction of ['right', 'down']) {
      addItem('터미널 목록을 ' + panelDirections[direction] + '로 이동', () => placeWorkspacePanel(panel, primaryChatPanel, direction));
    }
  }
  const rect = trigger.getBoundingClientRect();
  panelMenu.style.left = Math.max(4, Math.min(rect.left, innerWidth - 278)) + 'px';
  panelMenu.style.top = Math.min(rect.bottom + 3, Math.max(4, innerHeight - 310)) + 'px';
  panelMenu.showPopover();
  panelMenu.querySelector('button')?.focus();
}

function panelTask(panel) {
  return panel === primaryChatPanel ? selectedTask : panel.chatTask;
}

function makePanel(name, icon, onClose) {
  const panel = document.createElement('section');
  panel.className = 'workspace-panel';
  const header = document.createElement('header');
  header.className = 'workspace-panel-bar';
  const mark = document.createElement('span');
  setPanelIcon(mark, icon);
  const title = document.createElement('strong');
  title.textContent = name;
  const menu = button('', () => {});
  menu.className = 'icon-button panel-menu-button';
  menu.setAttribute('aria-label', '패널 분할');
  const close = button('', onClose);
  close.className = 'icon-button';
  close.setAttribute('aria-label', '패널 닫기');
  setPanelIcon(close, 'close');
  header.append(mark, title, menu, close);
  panel.append(header);
  bindWorkspacePanel(panel, header, menu);
  return panel;
}

const dockRatioKey = 'workbench-terminal-dock-ratio';

// The terminal dock behaves like VS Code's bottom panel: it spans the whole editor
// area under every chat or work-area split and keeps the height the user dragged it to.
function showTerminalDock(show) {
  if (show && !panelTree.contains(terminalDock)) {
    const root = panelTree.firstElementChild;
    placeWorkspacePanel(terminalDock, root, 'down');
    const split = terminalDock.parentElement;
    if (split?.classList.contains('workspace-split')) {
      const saved = Number(localStorage.getItem(dockRatioKey));
      split.dataset.resized = 'true';
      setWorkspaceRatio(split, saved >= 15 && saved <= 85 ? saved : 62);
      split.onresized = ratio => localStorage.setItem(dockRatioKey, String(Math.round(ratio)));
      scheduleFit();
    }
  } else if (!show && panelTree.contains(terminalDock)) {
    detachWorkspacePanel(terminalDock);
    panelParking.append(terminalDock);
  }
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
    revealActiveWorkTab(area.strip);
  }
}

function showWorkAreaTab(tab, area = tab?.workArea) {
  if (!area) return;
  if (area.current === tab) return;
  if (area.current) area.current.host.hidden = true;
  area.actions.replaceChildren();
  area.current = tab;
  const { panel } = area;
  panel.terminalTab = tab?.panes ? tab : null;
  panel.previewCwd = tab?.cwd;
  area.actions.hidden = !tab;
  if (panel === primaryChatPanel) {
    panel.classList.toggle('showing-work-tab', !!tab);
    byId('conversation').hidden = !!tab;
    panel.querySelector(':scope > header').hidden = !!tab;
    document.body.classList.toggle('primary-work-tab', !!tab);
  }
  if (tab) {
    tab.host.hidden = false;
    if (tab.panes) refreshPaneControls(tab);
    else area.actions.replaceChildren(...(tab.actions ?? []));
  }
  renderWorkArea(area);
  if (focusedPanel === panel) onWorkspacePanelFocus?.();
  scheduleFit();
}

function attachWorkAreaTab(tab, area) {
  tab.workArea = area;
  tab.workspacePanel = area.panel;
  area.tabs.add(tab);
  area.panel.append(tab.host);
  showWorkAreaTab(tab, area);
}

function removeWorkAreaTab(tab) {
  const area = tab.workArea;
  if (!area) return;
  area.tabs.delete(tab);
  tab.workArea = tab.workspacePanel = null;
  tab.host.remove();
  if (!area.tabs.size && area.panel !== primaryChatPanel) {
    detachWorkspacePanel(area.panel);
    return;
  }
  if (area.current === tab) showWorkAreaTab([...area.tabs].at(-1), area);
  else renderWorkArea(area);
}

function activateWorkAreaTab(tab, focus = true) {
  if (tab.panes) selectTab(tab, focus);
  else {
    showWorkAreaTab(tab);
    focusWorkspacePanel(tab.workArea.panel);
    if (focus) tab.host.querySelector('textarea,input')?.focus();
  }
}

function mountTerminalPanel(pane) {
  const leaf = document.createElement('section');
  leaf.className = 'workspace-panel';
  attachWorkAreaTab(pane.tab, workArea(leaf));
  return leaf;
}

function moveWorkAreaTab(tab, target, direction) {
  if (!direction && tab.workArea === target.workArea) return;
  removeWorkAreaTab(tab);
  if (direction) {
    const leaf = document.createElement('section');
    leaf.className = 'workspace-panel';
    attachWorkAreaTab(tab, workArea(leaf));
    placeWorkspacePanel(leaf, target, direction);
  } else attachWorkAreaTab(tab, target.workArea);
  activateWorkAreaTab(tab);
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
      if (strip?.workArea && strip.workArea !== tab.workArea) return { target: strip.workArea.panel };
      const target = node?.closest('.workspace-panel');
      if (!target || (target === tab.workArea.panel && tab.workArea.tabs.size === 1 &&
        (target !== primaryChatPanel || !selectedTask))) return null;
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
      if (drop) moveWorkAreaTab(tab, drop.target, drop.direction);
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

const dockHeader = byId('terminal-drawer').querySelector('header');
const dockMenu = button('', () => {});
dockMenu.className = 'icon-button panel-menu-button';
dockMenu.setAttribute('aria-label', '터미널 패널 배치');
dockHeader.querySelector('.actions').append(dockMenu);
bindWorkspacePanel(terminalDock, dockHeader, dockMenu);
bindWorkspacePanel(primaryChatPanel, primaryChatPanel.querySelector('header'), primaryChatPanel.querySelector('.panel-menu-button'));
focusWorkspacePanel(primaryChatPanel);
window.addEventListener('resize', scheduleFit);
