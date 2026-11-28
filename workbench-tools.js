const toolsDialog = byId('workbench-tools-dialog');
const toolsBody = byId('workbench-tools-body');

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

async function restoreContentTab(entry, area) {
  let tab;
  if (entry.type === 'note' && Object.hasOwn(notes, entry.id) && !noteTabs.has(entry.id)) {
    tab = buildNoteTab({ ...notes[entry.id], view: entry.view });
  } else if (entry.type === 'preview') {
    tab = openPreviewPanel(area, entry);
  } else if (entry.type === 'agents') {
    tab = openAgentsBoard(area, entry);
  } else if (entry.type === 'diff' && typeof entry.cwd === 'string' && typeof entry.name === 'string') {
    const host = toolElement('section', '', 'work-document diff-document');
    const output = toolElement('pre', '변경사항을 불러오는 중…');
    host.append(output);
    tab = { host, cwd: entry.cwd, name: 'diff · ' + entry.name.split('/').at(-1), icon: 'branch',
      diffEntry: { cwd: entry.cwd, name: entry.name, kind: entry.kind },
      actions: [button('검토 패널에서 열기', async () => {
        openReview('changes');
        await openPatch(entry.cwd, { name: entry.name, kind: entry.kind });
      })] };
    api.gitDiff(entry.cwd, entry.name, entry.kind).then(text => { output.textContent = text || '표시할 변경사항이 없습니다.'; },
      error => { output.textContent = error.message; });
  } else if (entry.type === 'shell') {
    const count = layoutSize(entry.tree);
    if (count < 1 || count > maxLayoutPanes) return;
    const firstLeaf = node => node.cwd ? node : firstLeaf(node.first);
    const first = await openWorkspace(firstLeaf(entry.tree).cwd, 'shell', undefined, undefined, area, false);
    if (!first) return;
    tab = first.tab;
    tab.owner = entry.owner;
    tab.name = entry.name || tab.name;
    async function restorePanes(node, pane) {
      if (node.cwd) {
        if (node.focused) tab.activePane = pane;
        return;
      }
      const horizontal = node.axis === 'horizontal';
      const sibling = await openPane(tab, firstLeaf(node.last).cwd, 'shell', pane, horizontal ? 'right' : 'down');
      if (!sibling) return;
      const element = pane.section.parentElement;
      setSplitRatio(element.terminalSplit, Number(node.ratio) || 50);
      await restorePanes(node.first, pane);
      await restorePanes(node.last, sibling);
    }
    await restorePanes(entry.tree, first);
  }
  if (tab && !tab.workArea) {
    tab.owner = entry.owner;
    attachWorkAreaTab(tab, area, false);
  }
  if (tab) tab.owner = entry.owner ?? null;
  return tab;
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

function openPreviewPanel(area = workAreaFor(), saved) {
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
      tab.previewAddress = address;
      saveChatLayout();
      frame.hidden = false;
      feedback.hidden = true;
      reload.disabled = external.disabled = false;
    } catch (error) { toolError(feedback, error); feedback.hidden = false; }
  };
  const pane = area.current?.activePane ?? currentPane();
  if (pane) input.value = recentContext(pane).text.match(/https?:\/\/(?:localhost|127\.0\.0\.1):\d+/i)?.[0] ?? '';
  panel.append(toolbar, feedback, frame);
  const tab = { name: '웹 미리보기', icon: 'web', host: panel, cwd: area.current?.cwd ?? pane?.cwd ?? reviewCwd() };
  attachWorkAreaTab(tab, area, !saved);
  if (saved) {
    tab.cwd = saved.cwd;
    tab.previewAddress = input.value = saved.address ?? '';
    if (input.value) toolbar.requestSubmit();
  } else activateWorkAreaTab(tab);
  return tab;
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
  terminalCopyMenu.append(button('전체 선택', () => {
    terminalCopyMenu.hidePopover();
    pane.terminal.selectAll();
    pane.terminal.focus();
  }), button('현재 터미널 출력 지우기', () => {
    terminalCopyMenu.hidePopover();
    pane.terminal.clearSelection();
    pane.terminal.write('\x1b[2J\x1b[3J\x1b[H');
    pane.terminal.focus();
  }), button('최근 화면 미리보기', () => {
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

// The rich editor (TipTap, vendor/rich-editor.js) is ~440KB, so it loads the first time a note opens.
let richEditorLoad;
function loadRichEditor() {
  richEditorLoad ??= new Promise((resolve, reject) => {
    if (window.RichMarkdownEditor) { resolve(window.RichMarkdownEditor); return; }
    const script = document.createElement('script');
    script.src = 'vendor/rich-editor.js';
    script.onload = () => resolve(window.RichMarkdownEditor);
    script.onerror = () => { richEditorLoad = null; reject(new Error('Markdown 편집기를 불러오지 못했습니다.')); };
    document.head.append(script);
  });
  return richEditorLoad;
}

// Toolbar of the rich mode, in Orca's order: block type, inline marks, lists, blocks, link.
const noteToolbar = [
  ['paragraph', '본문', '¶'], ['h1', '제목 1', 'H1'], ['h2', '제목 2', 'H2'], ['h3', '제목 3', 'H3'], null,
  ['bold', '굵게 (Ctrl+B)', 'B'], ['italic', '기울임 (Ctrl+I)', 'I'], ['strike', '취소선', 'S'], ['code', '인라인 코드', '`'], null,
  ['bulletList', '글머리 목록', 'list'], ['orderedList', '번호 목록', '1.'], ['taskList', '할 일 목록', 'check'], null,
  ['blockquote', '인용', '❝'], ['codeBlock', '코드 블록', '{ }'], ['link', '링크', 'link']
];

// Builds a note editor (host element + actions). Where it lives — a main tab or the floating
// note window — is decided by the caller; tab.onRename keeps whichever header in sync.
// Two modes like Orca: "서식" edits rendered Markdown in place (WYSIWYG), "원본" edits the Markdown text.
function buildNoteTab(note) {
  const host = toolElement('section', '', 'work-document note-workspace');
  const toolbar = toolElement('div', '', 'note-toolbar');
  toolbar.setAttribute('role', 'toolbar');
  toolbar.setAttribute('aria-label', '서식');
  const fields = toolElement('div', '', 'note-fields');
  const rich = toolElement('div', '', 'note-rich');
  const editor = toolElement('textarea', '', 'note-source');
  editor.setAttribute('aria-label', 'Markdown 원본');
  editor.placeholder = 'Markdown으로 메모를 작성하세요…';
  editor.spellcheck = false;
  editor.value = note.text;
  editor.addEventListener('keydown', event => {
    if (event.key !== 'Enter' || event.isComposing || event.keyCode === 229 || event.ctrlKey || event.altKey || event.shiftKey) return;
    const edit = composerAssist.continueList(editor.value, editor.selectionStart, editor.selectionEnd);
    if (!edit) return;
    event.preventDefault();
    editor.setRangeText(edit.text, edit.start, edit.end, 'end');
    editor.dispatchEvent(new Event('input', { bubbles: true }));
  });
  fields.append(rich, editor);
  const feedback = toolElement('p', '', 'note-feedback');
  feedback.setAttribute('role', 'status');
  host.append(toolbar, fields, feedback);
  const tab = { ...note, host, icon: 'note' };
  let richEditor = null;
  const renamed = () => {
    if (tab.workArea) renderWorkArea(tab.workArea);
    tab.onRename?.();
  };
  const changed = text => {
    tab.text = text;
    if (!tab.file) {
      const title = text.split(/\r?\n/).find(line => line.trim())?.replace(/^\s*#+\s*/, '').trim().slice(0, 50);
      const name = title || '제목 없는 노트';
      if (name !== tab.name) { tab.name = name; renamed(); }
    }
    try { rememberNote(tab); feedback.textContent = '초안 자동 저장됨'; }
    catch { feedback.textContent = '초안을 저장하지 못했습니다. 파일로 저장을 사용하세요.'; }
  };
  editor.oninput = () => changed(editor.value);

  const toolButtons = [];
  for (const entry of noteToolbar) {
    if (!entry) { toolbar.append(toolElement('span', '', 'note-toolbar-sep')); continue; }
    const [name, label, glyph] = entry;
    const item = button('', () => {
      if (!richEditor) return;
      if (name === 'link') {
        linkRow.hidden = false;
        linkInput.value = richEditor.linkHref();
        linkInput.focus();
        linkInput.select();
      } else richEditor.run(name);
    });
    item.className = 'note-tool';
    item.title = item.ariaLabel = label;
    item.dataset.tool = name;
    if (['list', 'check', 'link'].includes(glyph)) setPanelIcon(item, { list: 'list', check: 'check', link: 'external' }[glyph]);
    else item.textContent = glyph;
    toolButtons.push(item);
    toolbar.append(item);
  }
  // Inline link editor (Electron has no prompt()): Enter applies, Esc cancels, empty removes the link.
  const linkRow = toolElement('form', '', 'note-link-row');
  linkRow.hidden = true;
  const linkInput = toolElement('input');
  linkInput.type = 'url';
  linkInput.placeholder = 'https://… (비우면 링크 해제)';
  linkInput.setAttribute('aria-label', '링크 주소');
  const linkCancel = button('취소', () => { linkRow.hidden = true; richEditor?.focus(); });
  linkCancel.className = 'ghost';
  const linkApply = button('적용', () => {});
  linkApply.type = 'submit';
  linkApply.className = 'primary';
  linkRow.append(linkInput, linkCancel, linkApply);
  linkRow.onsubmit = event => {
    event.preventDefault();
    richEditor?.setLink(linkInput.value.trim());
    linkRow.hidden = true;
  };
  linkInput.onkeydown = event => { if (event.key === 'Escape') { event.stopPropagation(); linkCancel.click(); } };
  toolbar.after(linkRow);
  const syncToolbar = () => {
    for (const item of toolButtons) item.setAttribute('aria-pressed', String(!!richEditor?.isActive(item.dataset.tool)));
  };

  // 서식 | 원본
  const views = toolElement('div', '', 'segmented note-views');
  views.setAttribute('role', 'group');
  views.setAttribute('aria-label', '노트 보기');
  const setView = async (view, focus = true) => {
    host.dataset.view = view;
    saveChatLayout();
    for (const choice of views.children) choice.setAttribute('aria-pressed', String(choice.dataset.view === view));
    if (view === 'source') {
      editor.value = tab.text;
      if (focus) editor.focus();
      return;
    }
    try {
      const api = await loadRichEditor();
      if (!richEditor) {
        richEditor = api.create({ element: rich, markdown: tab.text, placeholder: '메모를 작성하세요. # 제목, - 목록, **굵게**를 쓰면 바로 서식이 적용됩니다.',
          onChange: changed, onSelection: syncToolbar });
      } else richEditor.setMarkdown(tab.text);
      syncToolbar();
      if (focus) richEditor.focus();
    } catch (error) {
      feedback.textContent = error.message + ' 원본으로 편집합니다.';
      setView('source', focus);
    }
  };
  for (const [view, label] of [['rich', '서식'], ['source', '원본']]) {
    const choice = button(label, () => setView(view));
    choice.dataset.view = view;
    views.append(choice);
  }
  tab.setView = setView;
  tab.focusEditor = () => (host.dataset.view === 'source' ? editor.focus() : richEditor?.focus());
  const save = button('파일로 저장', async () => {
    save.disabled = true;
    try {
      const result = await api.saveMarkdownNote(tab.text, tab.file, tab.cwd);
      if (!result) return;
      Object.assign(tab, result);
      rememberNote(tab);
      renamed();
      feedback.textContent = result.file;
      feedback.title = result.file;
    } catch (error) { feedback.textContent = error.message; }
    finally { save.disabled = false; }
  });
  tab.actions = [views, save];
  setView(note.view ?? 'rich', false);
  if (tab.file) feedback.textContent = feedback.title = tab.file;
  rememberNote(tab);
  noteTabs.set(tab.id, tab);
  return tab;
}
function showNote(note, area) {
  const existing = noteTabs.get(note.id);
  if (existing) { revealNote(existing); return; }
  const tab = buildNoteTab(note);
  attachWorkAreaTab(tab, area);
  activateWorkAreaTab(tab);
}

function revealNote(tab) {
  if (tab.workArea) activateWorkAreaTab(tab);
  else floatingNotes.show(tab);
}

// Orca opens a new note in a small floating window over the app; "최대화" moves it into a main tab.
const floatingNotes = (() => {
  const panel = toolElement('section', '', 'floating-notes');
  panel.hidden = true;
  panel.setAttribute('aria-label', 'Markdown 노트 창');
  const header = toolElement('header', '', 'floating-notes-bar');
  const strip = toolElement('nav', '', 'floating-notes-tabs');
  strip.setAttribute('aria-label', '떠 있는 노트');
  const add = button('', () => newNote());
  add.className = 'icon-button';
  add.title = add.ariaLabel = '새 Markdown 노트';
  setPanelIcon(add, 'plus');
  const tools = toolElement('div', '', 'floating-notes-tools');
  const maximize = button('', () => dock());
  maximize.className = 'icon-button';
  maximize.title = maximize.ariaLabel = '탭으로 열기(최대화)';
  setPanelIcon(maximize, 'expand');
  const minimize = button('', () => { panel.hidden = true; });
  minimize.className = 'icon-button';
  minimize.title = minimize.ariaLabel = '노트 창 숨기기';
  setPanelIcon(minimize, 'minus');
  tools.append(maximize, minimize);
  header.append(strip, add, tools);
  const body = toolElement('div', '', 'floating-notes-body');
  const actions = toolElement('div', '', 'floating-notes-actions');
  panel.append(header, actions, body);
  document.body.append(panel);
  const open = [];
  let current = null;

  function render() {
    strip.replaceChildren(...open.map(tab => {
      const item = toolElement('div', '', 'work-tab');
      item.dataset.active = String(tab === current);
      const select = button('', () => show(tab));
      const icon = toolElement('span');
      setPanelIcon(icon, 'note');
      const label = toolElement('span', tab.name, 'work-tab-label');
      select.append(icon, label);
      select.title = tab.file ?? tab.name;
      const close = button('', () => remove(tab, true));
      close.ariaLabel = tab.name + ' 닫기';
      setPanelIcon(close, 'close');
      item.append(select, close);
      return item;
    }));
    actions.replaceChildren(...(current?.actions ?? []));
    panel.hidden = !current;
  }
  function show(tab) {
    if (!open.includes(tab)) {
      open.push(tab);
      tab.onRename = render;
      body.append(tab.host);
    }
    for (const entry of open) entry.host.hidden = entry !== tab;
    current = tab;
    render();
    tab.focusEditor?.();
  }
  function remove(tab, closing) {
    const index = open.indexOf(tab);
    if (index < 0) return;
    open.splice(index, 1);
    tab.onRename = null;
    tab.host.remove();
    if (closing) { rememberNote(tab); noteTabs.delete(tab.id); }
    if (current === tab) current = open[Math.min(index, open.length - 1)] ?? null;
    if (current) current.host.hidden = false;
    render();
  }
  function dock() {
    const tab = current;
    if (!tab) return;
    remove(tab, false);
    tab.host.hidden = false;
    attachWorkAreaTab(tab, workArea(primaryChatPanel));
    activateWorkAreaTab(tab);
  }
  // Drag by the header (not by its buttons); the window stays inside the app.
  header.addEventListener('pointerdown', event => {
    if (event.button !== 0 || event.target.closest('button')) return;
    const rect = panel.getBoundingClientRect();
    const dx = event.clientX - rect.left;
    const dy = event.clientY - rect.top;
    trackPointer(event, next => {
      panel.style.left = Math.min(Math.max(0, next.clientX - dx), innerWidth - 120) + 'px';
      panel.style.top = Math.min(Math.max(0, next.clientY - dy), innerHeight - 60) + 'px';
      panel.style.right = panel.style.bottom = 'auto';
    }, () => {});
  });
  return { show, panel };
})();

function newNote() {
  floatingNotes.show(buildNoteTab({ id: crypto.randomUUID(), name: '제목 없는 노트', text: '', cwd: reviewCwd() }));
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
if (startupLayout && !localStorage.getItem(workspaceLayoutKey)) restoreWorkspaceLayout(startupLayout).catch(report);

async function quickOpenFile() {
  const task = actionTask();
  if (!task) return status('파일을 확인할 작업을 여세요.');
  const content = toolDialog('현재 작업의 파일 빠른 열기');
  const input = toolElement('input');
  input.placeholder = '파일 이름 또는 상대 경로';
  const list = toolElement('div');
  content.append(toolElement('small', task.cwd), input, list);
  input.focus();
  const files = await projectFiles(task.cwd);
  const render = () => {
    const matches = composerAssist.rankFiles(files, input.value, 30);
    list.replaceChildren(...matches.map(name => button(name, () => showSource(task.cwd, name, 1, task, true))));
    if (!matches.length) list.textContent = '일치하는 파일이 없습니다.';
  };
  input.oninput = render;
  input.onkeydown = event => {
    if (event.isComposing) return;
    if (event.key === 'Enter') list.firstElementChild?.click();
    else if (event.key === 'ArrowDown') { event.preventDefault(); list.querySelector('button')?.focus(); }
  };
  // 결과 목록에서는 위아래 방향키로 옮겨 다니고, 맨 위에서 위로 가면 입력창으로 돌아간다.
  list.onkeydown = event => {
    if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return;
    event.preventDefault();
    const next = event.key === 'ArrowDown' ? document.activeElement.nextElementSibling : document.activeElement.previousElementSibling;
    (next ?? (event.key === 'ArrowUp' ? input : null))?.focus();
  };
  render();
}

async function showSource(cwd, name, line, task, fromRoot = false) {
  const file = await api.sourceFile(cwd, name, fromRoot);
  const content = toolDialog(file.name);
  const source = toolElement('textarea');
  source.readOnly = true;
  source.wrap = 'off';
  source.className = 'source-reader';
  source.setAttribute('aria-label', file.name);
  source.value = file.text;
  const lines = source.value.split('\n');
  const first = Math.max(1, Math.min(line, lines.length));
  const start = lines.slice(0, first - 1).reduce((sum, text) => sum + text.length + 1, 0);
  content.append(toolElement('small', cwd + ' · ' + first + '행'), source);
  if (task) content.append(button('선택한 줄을 ' + task.name + '에 첨부', () => {
    if (!tasks.includes(task)) return;
    const low = source.value.slice(0, source.selectionStart).split('\n').length;
    const end = Math.max(source.selectionStart, source.selectionEnd - 1);
    const high = source.value.slice(0, end).split('\n').length;
    toolsDialog.close();
    chooseTask(task);
    appendToDraft(file.name + ':' + low + (high > low ? '-' + high : '') + '\n' + lines.slice(low - 1, high).join('\n'));
  }));
  source.focus();
  source.setSelectionRange(start, start + lines[first - 1].length);
  source.scrollTop = Math.max(0, first - 3) * parseFloat(getComputedStyle(source).lineHeight);
}

let lastWaitingTask;
function focusWaitingTask() {
  const waiting = tasks.filter(task => !closedTasks.has(task.id) && (runtime(task).approvals.size || runtime(task).authRequired));
  if (!waiting.length) return status('승인이나 로그인을 기다리는 작업이 없습니다.');
  const task = waiting[(waiting.findIndex(item => item.id === lastWaitingTask) + 1) % waiting.length];
  lastWaitingTask = task.id;
  chooseTask(task);
  const get = splitChats.get(task.id)?.getChatPart ?? byId;
  scheduleChat();
  requestAnimationFrame(() => (get('approval-list').querySelector('button') ?? get('claude-login')).focus());
}

function showRequestHistory(task) {
  const content = toolDialog('요청별 변경·검증 이력');
  for (const entry of [...(task?.history ?? [])].reverse()) {
    const detail = toolElement('details');
    detail.append(toolElement('summary', new Date(entry.at).toLocaleString() + ' · ' + entry.label),
      toolElement('p', entry.verification || '연결된 검증 없음'), toolElement('p', (entry.files ?? []).join(', ')), toolElement('pre', entry.diff));
    if (entry === task.history.at(-1)) {
      const profiles = loadToolSettings(runProfilesKey)[terminalFolderKey(task.worktree.root)] ?? [];
      for (const profile of profiles) {
        const run = button(profile.name + ' 검증', async () => {
          run.disabled = true;
          try {
            const result = await api.verifyProfile(task.cwd, profile.command, entry.tree);
            entry.verification = profile.name + ' · ' + result.result;
            persist();
            showRequestHistory(task);
          } finally { run.disabled = false; }
        });
        detail.append(run);
      }
    }
    content.append(detail);
  }
  if (!content.childElementCount) content.textContent = '별도 worktree에서 완료한 요청의 변경 이력이 여기에 표시됩니다.';
}

async function showFeedbackHistory(task) {
  if (!task) return status('PR 작업을 여세요.');
  const content = toolDialog('PR 피드백 수정 전후 확인');
  if (!task.feedbackHistory?.length) { content.textContent = '전달한 PR 피드백이 없습니다.'; return; }
  const current = await api.githubPrFeedback(task.cwd).catch(() => null);
  if (current) {
    prFeedback.updateFollowups(task.feedbackHistory, current);
    persist();
  }
  for (const entry of [...task.feedbackHistory].reverse()) {
    content.append(toolElement('strong', 'PR #' + entry.number + ' · ' + entry.head.slice(0, 8) + ' → ' + (entry.latestHead?.slice(0, 8) || '확인 대기')));
    for (const check of entry.checks) {
      content.append(toolElement('p', check.workflow + ' / ' + check.name + ' · 실패 → ' + (check.latestState || '결과 대기')));
    }
    for (const review of entry.reviews) {
      const toggle = button('', () => { review.resolved = !review.resolved; persist(); update(); });
      const update = () => { toggle.textContent = review.label + ' · ' + (review.resolved ? '해결됨' : '확인 대기'); };
      update();
      content.append(toggle);
    }
  }
}
