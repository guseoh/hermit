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
  focusedPanel = panel;
  for (const leaf of panelTree.querySelectorAll('.workspace-panel')) {
    leaf.dataset.focused = String(leaf === panel);
  }
  if ((panel === primaryChatPanel || panel.chatTask) && lastChatPanel !== panel) {
    lastChatPanel = panel;
    onChatPanelFocus?.();
  }
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
  if (focusedPanel === panel || lastChatPanel === panel) focusWorkspacePanel(primaryChatPanel);
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

function placeWorkspacePanel(panel, anchor, direction) {
  if (panel === anchor || !panelTree.contains(anchor)) return;
  if (panelTree.contains(panel)) detachWorkspacePanel(panel);
  const split = document.createElement('div');
  split.className = 'workspace-split';
  const horizontal = direction === 'left' || direction === 'right';
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
    setWorkspaceRatio(split, Math.min(85, Math.max(15, value)));
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
  setPanelIcon(trigger, panel === terminalDock ? 'split' : 'plus');
  trigger.title = '패널 추가 및 분할';
  trigger.onclick = event => showWorkspacePanelMenu(panel, event.currentTarget);
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

function showTerminalDock(show) {
  if (show && !panelTree.contains(terminalDock)) {
    placeWorkspacePanel(terminalDock, primaryChatPanel, 'right');
  } else if (!show && panelTree.contains(terminalDock)) {
    detachWorkspacePanel(terminalDock);
    panelParking.append(terminalDock);
  }
}

async function newSplitTerminal(anchor, direction, folder) {
  const cwd = folder ?? panelTask(anchor)?.cwd ?? anchor.terminalTab?.activePane?.cwd ?? currentPane()?.cwd ?? await api.home();
  if (!panelTree.contains(anchor)) return;
  const pane = await openWorkspace(cwd);
  if (!pane || !panes.has(pane.id)) return;
  const tab = pane.tab;
  const target = panelTree.contains(anchor) ? anchor : primaryChatPanel;
  const leaf = makePanel(tab.name, 'terminal', () => {
    detachWorkspacePanel(leaf);
    tab.workspacePanel = null;
    byId('terminals').append(tab.host);
    setDrawer(true);
    selectTab(tab);
  });
  tab.workspacePanel = leaf;
  leaf.terminalTab = tab;
  const header = leaf.firstElementChild;
  header.addEventListener('focusin', () => selectPane(tab.activePane));
  header.addEventListener('click', event => {
    if (!event.target.closest('button')) selectPane(tab.activePane, true);
  });
  leaf.append(tab.host);
  placeWorkspacePanel(leaf, target, direction);
  selectTab(tab, true);
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
