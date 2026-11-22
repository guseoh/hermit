const toolsDialog = byId('workbench-tools-dialog');
const toolsBody = byId('workbench-tools-body');
const quickTools = byId('quick-tools');

function toolElement(tag, text = '', className = '') {
  const element = document.createElement(tag);
  element.textContent = text;
  if (className) element.className = className;
  return element;
}

function toolDialog(title) {
  byId('workbench-tools-title').textContent = title;
  const content = toolElement('div', '', 'tool-content');
  toolsBody.replaceChildren(content);
  if (!toolsDialog.open) toolsDialog.showModal();
  return content;
}

function toolError(target, error) {
  target.textContent = error.message || String(error);
  target.className = 'tool-error';
}

function toolSection(content, title, items, render) {
  const details = toolElement('details');
  details.append(toolElement('summary', `${title} (${items.length})`));
  if (items.length) items.forEach(item => details.append(render(item)));
  else details.append(toolElement('p', '항목 없음', 'tool-muted'));
  content.append(details);
  return details;
}

async function showPullDetails(cwd, repository, pull) {
  const content = toolDialog(`#${pull.number} ${pull.title}`);
  const state = toolElement('p', 'PR 상세 정보를 불러오는 중…');
  content.append(state);
  try {
    const detail = await api.githubDetails(cwd, pull.number);
    state.textContent = [detail.state, detail.author?.login, `${detail.headRefName} → ${detail.baseRefName}`, detail.reviewDecision].filter(Boolean).join(' · ');
    if (detail.body) content.append(toolElement('p', detail.body, 'tool-text'));
    toolSection(content, '변경 파일', detail.files ?? [], file => toolElement('div', `${file.path}  +${file.additions} −${file.deletions}`, 'tool-row')).open = true;
    toolSection(content, '리뷰', detail.reviews ?? [], review => {
      const row = toolElement('div', '', 'tool-row');
      row.append(toolElement('strong', `${review.author?.login ?? '알 수 없음'} · ${review.state}`));
      if (review.body) row.append(toolElement('div', review.body, 'tool-text'));
      return row;
    });
    toolSection(content, '체크', detail.statusCheckRollup ?? [], check => toolElement('div', `${check.name ?? check.context} · ${check.conclusion || check.state || check.status}`, 'tool-row'));
    const actions = toolElement('div', '', 'tool-actions');
    const patch = toolElement('pre', '', 'tool-patch');
    patch.hidden = true;
    const view = button('전체 diff', async () => {
      view.disabled = true;
      patch.hidden = false;
      patch.textContent = 'diff를 불러오는 중…';
      try { patch.textContent = await api.githubDetails(cwd, pull.number, true) || '변경 내용 없음'; }
      catch (error) { patch.textContent = error.message; view.disabled = false; }
    });
    actions.append(view, button('GitHub에서 열기', () => api.githubOpen(repository, pull.number)));
    content.append(actions, patch);
  } catch (error) { toolError(state, error); }
}

async function showCommitDetails(cwd, hash) {
  const content = toolDialog(`커밋 ${hash.slice(0, 12)}`);
  const summary = toolElement('pre', '커밋 정보를 불러오는 중…');
  content.append(summary);
  try { summary.textContent = await api.gitCommitDetails(cwd, hash); }
  catch (error) { toolError(summary, error); }
}

function toolInput(label, placeholder, maxLength) {
  const field = toolElement('label', label);
  const input = toolElement('input');
  input.required = true;
  input.placeholder = placeholder;
  input.maxLength = maxLength;
  field.append(input);
  return { field, input };
}

async function showWorktrees(cwd) {
  const content = toolDialog('Git worktree');
  const list = toolElement('div', 'worktree를 불러오는 중…', 'tool-list');
  content.append(toolElement('p', cwd, 'tool-muted'), list);
  try {
    const entries = await api.gitWorktrees(cwd);
    list.replaceChildren();
    entries.forEach(entry => {
      const row = toolElement('div', '', 'tool-row tool-list-row');
      const name = toolElement('div');
      name.append(toolElement('strong', entry.branch ?? entry.head?.slice(0, 8) ?? 'bare'));
      name.append(toolElement('div', entry.path, 'tool-muted'));
      row.append(name);
      if (!entry.bare && !entry.prunable) row.append(button('터미널 열기', () => {
        toolsDialog.close();
        return newShellTab(entry.path);
      }));
      if (entry.prunable) row.append(toolElement('span', '폴더 없음', 'tool-muted'));
      list.append(row);
    });
    const form = toolElement('form', '', 'tool-form');
    const branch = toolInput('새 브랜치', 'feature/task', 200);
    const directory = toolInput('새 worktree 폴더의 절대 경로', 'C:\\Projects\\my-task', 1024);
    const create = toolElement('button', '현재 HEAD에서 생성');
    const feedback = toolElement('p');
    feedback.setAttribute('role', 'status');
    form.append(branch.field, directory.field, create, feedback);
    form.onsubmit = async event => {
      event.preventDefault();
      create.disabled = true;
      try {
        await api.gitCreateWorktree(cwd, directory.input.value.trim(), branch.input.value.trim());
        if (content.isConnected && toolsDialog.open) await showWorktrees(cwd);
      } catch (error) { toolError(feedback, error); }
      finally { create.disabled = false; }
    };
    content.append(form);
  } catch (error) { toolError(list, error); }
}

function loadToolSettings(key) {
  try { return JSON.parse(localStorage.getItem(key)) ?? {}; }
  catch { return {}; }
}

function projectDirectory(cwd) {
  const key = terminalFolderKey(cwd);
  return [...projectFolders].filter(folder => {
    const project = terminalFolderKey(folder);
    return key === project || key.startsWith(project + '\\');
  }).sort((a, b) => b.length - a.length)[0] ?? cwd;
}

const layoutKey = 'workbench-terminal-layouts-v1';
const lastLayoutKey = 'workbench-last-terminal-layout-v1';
const maxLayoutPanes = 16;
let restoringLayout = false;

function sessionLayout(pane, name, selectedPane) {
  if (!pane?.running || pane.launcher !== 'shell') return null;
  return { cwd: pane.cwd, name, focused: pane === selectedPane };
}

function layoutBranch(first, last, axis, ratio, resized = true) {
  if (!first || !last) return first ?? last;
  return { first, last, axis, ratio, resized };
}

function tabLayout(tab, node, selectedPane) {
  if (!node) return null;
  if (node.matches('.terminal-split')) {
    return layoutBranch(tabLayout(tab, node.firstElementChild, selectedPane),
      tabLayout(tab, node.lastElementChild, selectedPane), node.dataset.axis === 'columns' ? 'horizontal' : 'vertical',
      parseFloat(node.style.getPropertyValue('--split-first')) || 50);
  }
  const pane = tab.panes.find(pane => pane.section === node);
  return sessionLayout(pane, tab.name, selectedPane);
}

function workspaceLayout(node, selectedPane) {
  if (!node) return null;
  if (node.matches('.workspace-split')) {
    return layoutBranch(workspaceLayout(node.firstElementChild, selectedPane),
      workspaceLayout(node.lastElementChild, selectedPane), node.dataset.axis,
      parseFloat(node.style.getPropertyValue('--panel-ratio')) || 50, 'resized' in node.dataset);
  }
  const tab = node.terminalTab ?? (node === terminalDock ? active : null);
  return tab ? tabLayout(tab, tab.host.firstElementChild, selectedPane) : null;
}

function layoutSize(node) {
  return !node ? 0 : node.cwd ? 1 : layoutSize(node.first) + layoutSize(node.last);
}

async function saveWorkspaceLayout() {
  const pane = focusedPanel.terminalTab?.activePane ?? currentPane();
  const tree = workspaceLayout(panelTree.firstElementChild, pane);
  const count = layoutSize(tree);
  if (!count || count > maxLayoutPanes) throw new Error(`PowerShell 패널 1~${maxLayoutPanes}개를 배치한 뒤 저장하세요.`);
  const cwd = projectDirectory(reviewCwd() ?? pane?.cwd ?? await api.home());
  const key = terminalFolderKey(cwd);
  const layouts = loadToolSettings(layoutKey);
  layouts[key] = { cwd, tree };
  localStorage.setItem(layoutKey, JSON.stringify(layouts));
  localStorage.setItem(lastLayoutKey, key);
  status(`${cwd} · PowerShell 패널 ${count}개 배치 저장됨`);
}

async function restoreWorkspaceLayout(entry) {
  if (restoringLayout) return;
  restoringLayout = true;
  try {
    const anchor = panelTree.contains(focusedPanel) ? focusedPanel : primaryChatPanel;
    let selectedPane;
    let firstPane;
    let failed = 0;
    async function mount(node) {
      if (node.cwd) {
        const pane = await openWorkspace(node.cwd);
        if (!pane?.running || !panes.has(pane.id)) {
          if (pane && panes.has(pane.id)) closeTab(pane.tab);
          failed++;
          return null;
        }
        renameTab(pane.tab, node.name);
        firstPane ??= pane;
        if (node.focused) selectedPane = pane;
        return mountTerminalPanel(pane);
      }
      const first = await mount(node.first);
      const last = await mount(node.last);
      if (!first || !last) return first ?? last;
      const { split, divider } = createWorkspaceSplit(node.axis === 'horizontal');
      if (node.resized) split.dataset.resized = 'true';
      split.append(first, divider, last);
      setWorkspaceRatio(split, node.ratio);
      return split;
    }
    const count = layoutSize(entry.tree);
    if (!count || count > maxLayoutPanes) throw new Error('저장된 패널 배치를 읽을 수 없습니다.');
    const root = await mount(entry.tree);
    if (root) {
      placeWorkspacePanel(root, panelTree.contains(anchor) ? anchor : primaryChatPanel, 'right');
      const pane = selectedPane ?? firstPane;
      focusWorkspacePanel(pane.tab.workspacePanel);
      selectTab(pane.tab, true);
      localStorage.setItem(lastLayoutKey, terminalFolderKey(entry.cwd));
    }
    status(`PowerShell 패널 ${count - failed}개 복원${failed ? ` · ${failed}개 열기 실패` : ''}`);
  } finally { restoringLayout = false; }
}

function showWorkspaceLayouts() {
  const content = toolDialog('저장된 터미널 배치');
  const layouts = Object.values(loadToolSettings(layoutKey));
  if (!layouts.length) content.append(toolElement('p', '저장된 배치가 없습니다.', 'tool-muted'));
  layouts.forEach(entry => {
    const row = toolElement('div', '', 'tool-row tool-list-row');
    row.append(toolElement('span', `${entry.cwd} · ${layoutSize(entry.tree)}개`), button('배치 열기', () => {
      toolsDialog.close();
      return restoreWorkspaceLayout(entry);
    }));
    content.append(row);
  });
}

const runProfilesKey = 'workbench-run-profiles-v1';

function showRunProfiles(cwd) {
  const content = toolDialog('실행 프로필');
  const key = terminalFolderKey(cwd);
  const stored = loadToolSettings(runProfilesKey);
  const profiles = stored[key] ?? [];
  content.append(toolElement('p', cwd, 'tool-muted'));
  const form = toolElement('form', '', 'tool-form');
  const name = toolInput('이름', '개발 서버', 80);
  const command = toolInput('PowerShell 명령', 'npm run dev', 500);
  const save = toolElement('button', '프로필 추가');
  const feedback = toolElement('p');
  feedback.setAttribute('role', 'status');
  let editing;
  function persist(next) {
    stored[key] = next;
    localStorage.setItem(runProfilesKey, JSON.stringify(stored));
    showRunProfiles(cwd);
  }
  profiles.forEach(profile => {
    const row = toolElement('div', '', 'tool-row tool-list-row');
    const text = toolElement('div');
    text.append(toolElement('strong', profile.name), toolElement('code', profile.command));
    const actions = toolElement('div', '', 'tool-actions');
    actions.append(button('실행', async () => {
      toolsDialog.close();
      const pane = await newShellTab(cwd);
      if (!pane?.running) throw new Error('PowerShell 프로필 실행에 실패했습니다.');
      renameTab(pane.tab, profile.name);
      await api.input(pane.id, profile.command + '\r');
    }), button('편집', () => {
      editing = profile.id;
      name.input.value = profile.name;
      command.input.value = profile.command;
      save.textContent = '프로필 저장';
      name.input.focus();
    }), button('삭제', () => persist(profiles.filter(item => item.id !== profile.id))));
    row.append(text, actions);
    content.append(row);
  });
  form.append(name.field, command.field, save, feedback);
  form.onsubmit = event => {
    event.preventDefault();
    const profile = { id: editing ?? crypto.randomUUID(), name: name.input.value.trim(), command: command.input.value.trim() };
    try {
      if (!profile.name || !profile.command || /[\x00-\x1f\x7f]/.test(profile.command)) throw new Error('이름과 한 줄짜리 PowerShell 명령을 입력하세요.');
      if (!editing && profiles.length >= 20) throw new Error('폴더당 실행 프로필은 최대 20개입니다.');
      persist(editing ? profiles.map(item => item.id === editing ? profile : item) : [...profiles, profile]);
    } catch (error) { toolError(feedback, error); }
  };
  content.append(form);
}

function parsePreviewAddress(value) {
  const input = value.trim();
  try {
    const address = new URL(/^https?:\/\//i.test(input) ? input : 'http://' + input);
    if (['http:', 'https:'].includes(address.protocol) && ['localhost', '127.0.0.1'].includes(address.hostname) && !address.username && !address.password) return address.href;
  } catch {}
  throw new Error('localhost 또는 127.0.0.1 주소를 입력하세요.');
}

function openPreviewPanel(area = workAreaFor()) {
  const panel = toolElement('section', '', 'preview-panel work-document');
  const toolbar = toolElement('form', '', 'preview-toolbar');
  const input = toolElement('input');
  input.placeholder = 'http://localhost:5173';
  input.setAttribute('aria-label', '로컬 개발 서버 주소');
  input.required = true;
  const load = toolElement('button', '열기');
  let address;
  const reload = button('새로 고침', () => { frame.src = address; });
  const external = button('브라우저', () => api.openLocalPreview(address));
  reload.disabled = external.disabled = true;
  const feedback = toolElement('p', '', 'tool-error');
  feedback.hidden = true;
  feedback.setAttribute('role', 'status');
  const frame = toolElement('iframe');
  frame.title = '로컬 개발 서버';
  frame.setAttribute('sandbox', 'allow-scripts allow-forms allow-same-origin');
  frame.referrerPolicy = 'no-referrer';
  frame.hidden = true;
  toolbar.append(input, load, reload, external);
  toolbar.onsubmit = event => {
    event.preventDefault();
    try {
      address = parsePreviewAddress(input.value);
      input.value = frame.src = address;
      frame.hidden = false;
      feedback.hidden = true;
      reload.disabled = external.disabled = false;
    } catch (error) { toolError(feedback, error); feedback.hidden = false; }
  };
  const pane = area.current?.activePane ?? currentPane();
  if (pane) input.value = recentContext(pane).text.match(/https?:\/\/(?:localhost|127\.0\.0\.1):\d+/i)?.[0] ?? '';
  panel.append(toolbar, feedback, frame);
  const tab = { name: '웹 미리보기', icon: 'web', host: panel, cwd: area.current?.cwd ?? pane?.cwd ?? reviewCwd() };
  attachWorkAreaTab(tab, area);
  activateWorkAreaTab(tab);
}

const terminalCopyMenu = toolElement('div', '', 'status-menu terminal-copy-menu');
terminalCopyMenu.popover = 'auto';
document.body.append(terminalCopyMenu);

function showTerminalCopyMenu(pane, trigger) {
  if (terminalCopyMenu.matches(':popover-open')) terminalCopyMenu.hidePopover();
  const buffer = pane.terminal.buffer.active;
  terminalCopyMenu.replaceChildren();
  for (const [label, text] of [
    ['선택 영역 복사', pane.terminal.getSelection()],
    ['현재 화면 복사', readTerminalRows(buffer, buffer.viewportY, pane.terminal.rows)],
    ['마지막 명령의 출력 복사', pane.records.at(-1)?.output]
  ]) {
    const item = button(label, async () => {
      terminalCopyMenu.hidePopover();
      await api.copy(text);
      terminalMessage(pane, `${label} 완료`);
    });
    item.disabled = !text?.trim();
    terminalCopyMenu.append(item);
  }
  terminalCopyMenu.append(button('최근 화면 미리보기', () => {
    terminalCopyMenu.hidePopover();
    showRecentContext(pane);
  }), button('명령 결과 보기', () => {
    terminalCopyMenu.hidePopover();
    selectTab(pane.tab, false);
    selectPane(pane);
    openReview('results');
  }));
  const rect = trigger.getBoundingClientRect();
  terminalCopyMenu.style.left = Math.max(4, Math.min(rect.left, innerWidth - 250)) + 'px';
  terminalCopyMenu.style.top = Math.min(rect.bottom + 3, Math.max(4, innerHeight - 180)) + 'px';
  terminalCopyMenu.showPopover();
  terminalCopyMenu.querySelector('button:not(:disabled)')?.focus();
}

const notesKey = 'workbench-markdown-notes-v1';
const notes = loadToolSettings(notesKey);
const noteTabs = new Map();

function rememberNote(note) {
  const { id, name, text, file, cwd } = note;
  notes[id] = { id, name, text, file, cwd };
  localStorage.setItem(notesKey, JSON.stringify(notes));
}

function closeDocumentTab(tab) {
  if (tab.onClose) {
    const onClose = tab.onClose;
    tab.onClose = null;
    onClose();
    if (!tab.workArea) return;
  }
  if (tab.icon === 'note') {
    rememberNote(tab);
    noteTabs.delete(tab.id);
  }
  const area = tab.workArea;
  const wasCurrent = area.current === tab;
  removeWorkAreaTab(tab);
  if (wasCurrent && area.current && panelTree.contains(area.panel)) activateWorkAreaTab(area.current);
}

function showNote(note, area) {
  const existing = noteTabs.get(note.id);
  if (existing) { activateWorkAreaTab(existing); return; }
  const host = toolElement('section', '', 'work-document note-workspace');
  const fields = toolElement('div', '', 'note-fields');
  const editor = toolElement('textarea');
  editor.setAttribute('aria-label', 'Markdown 편집');
  editor.placeholder = 'Markdown으로 메모를 작성하세요…';
  editor.spellcheck = false;
  editor.value = note.text;
  const preview = toolElement('article', '', 'chat-message note-preview');
  preview.setAttribute('aria-label', 'Markdown 미리보기');
  preview.tabIndex = 0;
  fields.append(editor, preview);
  const feedback = toolElement('p', '', 'note-feedback');
  feedback.setAttribute('role', 'status');
  host.append(fields, feedback);
  const tab = { ...note, host, icon: 'note' };
  const save = button('파일로 저장', async () => {
    save.disabled = true;
    try {
      const result = await api.saveMarkdownNote(tab.text, tab.file, tab.cwd);
      if (!result) return;
      Object.assign(tab, result);
      rememberNote(tab);
      if (tab.workArea) renderWorkArea(tab.workArea);
      feedback.textContent = result.file;
      feedback.title = result.file;
    } catch (error) { feedback.textContent = error.message; }
    finally { save.disabled = false; }
  });
  tab.actions = [save];
  editor.oninput = () => {
    tab.text = editor.value;
    if (!tab.file) {
      const title = tab.text.split(/\r?\n/).find(line => line.trim())?.replace(/^\s*#+\s*/, '').trim().slice(0, 50);
      const name = title || '제목 없는 노트';
      if (name !== tab.name) {
        tab.name = name;
        if (tab.workArea) renderWorkArea(tab.workArea);
      }
    }
    renderMessage(preview, tab.text);
    try { rememberNote(tab); feedback.textContent = '초안 자동 저장됨'; }
    catch (error) { feedback.textContent = '초안을 저장하지 못했습니다. 파일로 저장을 사용하세요.'; }
  };
  renderMessage(preview, tab.text);
  if (tab.file) feedback.textContent = feedback.title = tab.file;
  rememberNote(tab);
  noteTabs.set(tab.id, tab);
  attachWorkAreaTab(tab, area);
  activateWorkAreaTab(tab);
}

function newNote(area = workAreaFor()) {
  showNote({ id: crypto.randomUUID(), name: '제목 없는 노트', text: '', cwd: reviewCwd() }, area);
}

async function openMarkdownFile(area) {
  const result = await api.openMarkdownNote(reviewCwd());
  if (!result) return;
  const cached = Object.values(notes).find(note => terminalFolderKey(note.file) === terminalFolderKey(result.file));
  const note = cached && (noteTabs.has(cached.id) || cached.text === result.text)
    ? cached : { id: crypto.randomUUID(), ...result };
  showNote(note, panelTree.contains(area.panel) ? area : workArea(primaryChatPanel));
}

function showMarkdownNotes(area = workAreaFor()) {
  const content = toolDialog('Markdown 노트 열기');
  const choose = button('Markdown 파일 선택…', async () => {
    toolsDialog.close();
    await openMarkdownFile(area);
  });
  content.append(choose);
  for (const note of Object.values(notes).reverse()) {
    const row = toolElement('div', '', 'tool-row tool-list-row');
    const name = toolElement('span', note.name);
    name.title = note.file ?? '로컬 초안';
    row.append(name, button('열기', () => { toolsDialog.close(); showNote(note, area); }));
    content.append(row);
  }
}

setPanelIcon(byId('quick-tools-trigger'), 'terminal');
setPanelIcon(quickTools.querySelector('header button'), 'minus');
for (const [group, entries] of [
  ['quick-tools-launch', [
    ['새 PowerShell', 'terminal', () => newShellTab()],
    ['새 Markdown 노트', 'note', () => newNote()],
    ['Markdown 노트 열기', 'note', () => showMarkdownNotes()],
    ['웹 미리보기', 'web', () => openPreviewPanel()]
  ]],
  ['quick-tools-manage', [
    ['실행 프로필', 'settings', async () => showRunProfiles(projectDirectory(reviewCwd() ?? await api.home()))],
    ['Git worktree', 'branch', async () => showWorktrees(reviewCwd() ?? await api.home())],
    ['현재 터미널 배치 저장', 'pin', saveWorkspaceLayout],
    ['저장된 터미널 배치 열기', 'project', showWorkspaceLayouts]
  ]]
]) {
  for (const [label, icon, action] of entries) {
    const item = button('', () => { quickTools.hidePopover(); return action(); });
    const mark = toolElement('span');
    setPanelIcon(mark, icon);
    item.append(mark, toolElement('span', label));
    byId(group).append(item);
  }
}

for (const [id, icon, keywords, action] of [
  ['menu-preview', 'web', 'web browser localhost 웹', openPreviewPanel],
  ['menu-note', 'note', 'markdown note 메모', newNote]
]) {
  const entry = byId(id);
  setPanelIcon(entry.querySelector('span'), icon);
  entry.dataset.search = keywords;
  entry.onclick = () => {
    tabMenu.hidePopover();
    action(tabMenuArea);
  };
}
const startupLayout = loadToolSettings(layoutKey)[localStorage.getItem(lastLayoutKey)];
if (startupLayout) restoreWorkspaceLayout(startupLayout).catch(report);
