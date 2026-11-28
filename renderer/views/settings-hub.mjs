// 에이전트 설정 허브(renderer/views/settings-hub.mjs):
// 기존 #chat-settings 대화상자의 모든 DOM ID와 폼 동작을 유지한 채,
// 왼쪽 탭 레일(일반 · 에이전트·CLI · 지침·규칙 · MCP · 승인·보안 · 알림·업데이트 · 단축키)로 확장한다.

const TABS = [
  { id: 'general', label: '일반' },
  { id: 'agents', label: '에이전트·CLI' },
  { id: 'instructions', label: '지침·규칙' },
  { id: 'mcp', label: 'MCP' },
  { id: 'security', label: '승인·보안' },
  { id: 'notifications', label: '알림·업데이트' },
  { id: 'shortcuts', label: '단축키' }
];

const SHORTCUT_ROWS = [
  ['Ctrl+N', '새 에이전트 작업'],
  ['Ctrl+T', '새 터미널 탭'],
  ['Ctrl+Shift+P / F1', '명령 팔레트'],
  ['Ctrl+K', '작업 빠르게 전환'],
  ['Ctrl+P', '파일 빠르게 열기'],
  ['Ctrl+Shift+F', '작업 폴더 내용 검색'],
  ['Ctrl+Shift+Y', '응답 대기 중인 작업으로 이동'],
  ['Y / A / N', '승인 카드 허용 · 세션 허용 · 거절'],
  ['Ctrl+Alt+A / Ctrl+`', '플로팅 터미널 열기·접기'],
  ['Ctrl+Shift+`', '플로팅 터미널에 새 셸'],
  ['Ctrl+B / Ctrl+L', '프로젝트 · 작업 검토 사이드바 접기·펼치기'],
  ['Ctrl+Tab / Ctrl+1~9', '열린 작업 탭 전환'],
  ['Ctrl+Shift+M / E', '모델 · 추론 수준 선택'],
  ['Ctrl+↑ / ↓', '터미널 이전·다음 명령으로 이동']
];

const dialog = byId('chat-settings');
const form = dialog?.querySelector('form');

let activeTab = 'general';
let navButtons = new Map();
let panes = new Map();
let instructionsState = { cwd: null, items: [], selectedPath: null, original: '', loading: false };
let mcpState = { cwd: null, servers: [], sources: [], loading: false };

function el(tag, className = '', text = '') {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text) node.textContent = text;
  return node;
}

function activeWorkspaceCwd() {
  return (typeof reviewCwd === 'function' && reviewCwd())
    || (typeof actionTask === 'function' && actionTask()?.cwd)
    || (typeof currentPane === 'function' && currentPane()?.cwd)
    || '';
}

function buildAgentsExtra() {
  const box = el('div', 'settings-hub-card');
  const head = el('div', 'settings-hub-card-head');
  head.append(el('strong', '', '감지된 CLI와 터미널 프로필'));
  const refreshBtn = el('button', 'ghost', '다시 확인');
  refreshBtn.type = 'button';
  head.append(refreshBtn);
  const body = el('div', 'settings-hub-list');
  body.textContent = '설치된 도구를 확인하는 중…';
  box.append(head, body);

  async function refresh(force = false) {
    refreshBtn.disabled = true;
    body.textContent = '설치된 도구를 확인하는 중…';
    try {
      const [status, profiles] = await Promise.all([
        api.onboardingStatus?.(force).catch(() => null),
        window.hermitShellProfiles?.refresh(force).catch(() => []) ?? []
      ]);
      body.replaceChildren();
      const rows = [];
      if (status?.tools) {
        for (const [id, label] of [['codex', 'Codex CLI'], ['claude', 'Claude Code'], ['git', 'Git'], ['gh', 'GitHub CLI']]) {
          const info = status.tools[id];
          if (!info) continue;
          rows.push({ name: label, ok: Boolean(info.available), detail: info.version || (info.available ? '설치됨' : '설치되지 않음') });
        }
      }
      rows.push({ name: 'Windows PowerShell 5.1', ok: true, detail: '기본 셸' });
      for (const entry of profiles ?? []) {
        rows.push({ name: entry.name, ok: true, detail: entry.detail || entry.launcher });
      }
      if (!rows.length) {
        body.append(el('p', 'settings-hub-empty', '감지된 도구 정보를 불러오지 못했습니다.'));
      } else {
        for (const item of rows) {
          const row = el('div', 'settings-hub-row');
          row.append(el('strong', '', item.name));
          const meta = el('span', 'settings-hub-badge', item.detail);
          meta.dataset.state = item.ok ? 'ok' : 'muted';
          row.append(meta);
          body.append(row);
        }
      }
    } finally {
      refreshBtn.disabled = false;
    }
  }

  refreshBtn.onclick = () => refresh(true);
  return { element: box, refresh };
}

function buildNotificationsExtra() {
  const box = el('div', 'settings-hub-card');
  const head = el('div', 'settings-hub-card-head');
  head.append(el('strong', '', '앱 업데이트 상태'));
  const statusEl = el('p', 'settings-hub-muted', '확인 중…');
  box.append(head, statusEl);

  async function refresh() {
    try {
      const info = await api.updateState?.();
      if (!info) { statusEl.textContent = '업데이트 상태를 확인할 수 없습니다.'; return; }
      if (info.version) {
        statusEl.textContent = `v${info.version} 업데이트가 준비되어 있습니다. 앱을 다시 시작하면 설치됩니다.`;
      } else if (!info.packaged) {
        statusEl.textContent = '개발 실행 모드입니다. 설치 버전에서 자동 업데이트가 동작합니다.';
      } else {
        statusEl.textContent = '최신 버전을 사용 중입니다.';
      }
    } catch {
      statusEl.textContent = '업데이트 상태를 확인할 수 없습니다.';
    }
  }

  return { element: box, refresh };
}

function buildInstructionsPane() {
  const section = el('section', 'settings-hub-pane');
  section.dataset.settingsPane = 'instructions';

  const header = el('div', 'settings-hub-section-head');
  const titleWrap = el('div');
  titleWrap.append(
    el('h3', '', '에이전트 지침·규칙'),
    el('p', 'settings-hub-muted', '프로젝트(CLAUDE.md, AGENTS.md, .agents/)와 전역 지침·설정 파일을 확인하고 편집합니다.')
  );
  const refreshBtn = el('button', 'ghost', '새로 고침');
  refreshBtn.type = 'button';
  header.append(titleWrap, refreshBtn);

  const layout = el('div', 'settings-hub-split');
  const fileList = el('div', 'settings-hub-file-list');
  fileList.setAttribute('role', 'listbox');
  fileList.setAttribute('aria-label', '지침 및 규칙 파일');

  const editorWrap = el('div', 'settings-hub-editor');
  const editorMeta = el('div', 'settings-hub-editor-head');
  const pathLabel = el('span', 'settings-hub-path', '파일을 선택하세요');
  const saveBtn = el('button', 'primary', '저장');
  saveBtn.type = 'button';
  saveBtn.disabled = true;
  editorMeta.append(pathLabel, saveBtn);

  const textarea = el('textarea', 'settings-hub-textarea');
  textarea.rows = 14;
  textarea.spellcheck = false;
  textarea.disabled = true;
  textarea.placeholder = '왼쪽 목록에서 지침 파일을 선택하면 내용을 확인하고 편집할 수 있습니다.';

  const feedback = el('p', 'settings-hub-feedback');
  feedback.setAttribute('role', 'status');

  editorWrap.append(editorMeta, textarea, feedback);
  layout.append(fileList, editorWrap);
  section.append(header, layout);

  function setFeedback(text, isError = false) {
    feedback.textContent = text;
    feedback.dataset.error = isError ? 'true' : 'false';
  }

  function updateSaveState() {
    saveBtn.disabled = !instructionsState.selectedPath || instructionsState.loading || textarea.value === instructionsState.original;
  }

  async function selectFile(item) {
    instructionsState.selectedPath = item.path;
    for (const btn of fileList.querySelectorAll('button[data-file-path]')) {
      btn.setAttribute('aria-selected', String(btn.dataset.filePath === item.path));
    }
    pathLabel.textContent = item.path;
    pathLabel.title = item.path;
    textarea.disabled = true;
    saveBtn.disabled = true;
    setFeedback('불러오는 중…');
    try {
      const result = await api.agentHubRead(instructionsState.cwd, item.path);
      instructionsState.original = result.content ?? '';
      textarea.value = instructionsState.original;
      textarea.disabled = !result.writable;
      setFeedback(result.exists ? `${result.size}바이트` : '아직 파일이 없습니다. 내용을 입력하고 저장하면 생성됩니다.');
      updateSaveState();
    } catch (error) {
      textarea.value = '';
      setFeedback(error.message || String(error), true);
    }
  }

  function renderFileList() {
    fileList.replaceChildren();
    const groups = [
      ['프로젝트', instructionsState.items.filter(item => item.scope === 'project')],
      ['전역', instructionsState.items.filter(item => item.scope === 'global')]
    ];
    for (const [groupLabel, items] of groups) {
      if (!items.length) continue;
      fileList.append(el('div', 'settings-hub-group-label', groupLabel));
      for (const item of items) {
        const btn = el('button', 'settings-hub-file-item');
        btn.type = 'button';
        btn.dataset.filePath = item.path;
        btn.setAttribute('role', 'option');
        btn.setAttribute('aria-selected', String(item.path === instructionsState.selectedPath));
        const name = el('span', 'settings-hub-file-name', item.label);
        const badge = el('span', 'settings-hub-badge', item.exists ? '있음' : '없음');
        badge.dataset.state = item.exists ? 'ok' : 'muted';
        btn.append(name, badge);
        btn.onclick = () => selectFile(item);
        fileList.append(btn);
      }
    }
    if (!instructionsState.items.length) {
      fileList.append(el('p', 'settings-hub-empty', '표시할 지침 파일이 없습니다.'));
    }
  }

  async function saveCurrent() {
    if (!instructionsState.selectedPath || saveBtn.disabled) return;
    saveBtn.disabled = true;
    setFeedback('저장하는 중…');
    try {
      const result = await api.agentHubWrite(instructionsState.cwd, instructionsState.selectedPath, textarea.value);
      instructionsState.original = textarea.value;
      const target = instructionsState.items.find(item => item.path === instructionsState.selectedPath);
      if (target) { target.exists = true; target.size = result.size; }
      renderFileList();
      setFeedback(`저장함 (${result.size}바이트)`);
      updateSaveState();
    } catch (error) {
      setFeedback(error.message || String(error), true);
      updateSaveState();
    }
  }

  textarea.addEventListener('input', updateSaveState);
  textarea.addEventListener('keydown', event => {
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 's') {
      event.preventDefault();
      saveCurrent();
    }
  });
  saveBtn.onclick = saveCurrent;

  async function refresh() {
    instructionsState.loading = true;
    refreshBtn.disabled = true;
    const cwd = activeWorkspaceCwd();
    instructionsState.cwd = cwd;
    try {
      const result = await api.agentHubInstructions(cwd);
      instructionsState.items = result?.items ?? [];
      renderFileList();
      const current = instructionsState.items.find(item => item.path === instructionsState.selectedPath)
        ?? instructionsState.items.find(item => item.exists)
        ?? instructionsState.items[0];
      if (current) await selectFile(current);
      else {
        instructionsState.selectedPath = null;
        instructionsState.original = '';
        textarea.value = '';
        textarea.disabled = true;
        pathLabel.textContent = '선택할 파일이 없습니다';
        setFeedback('');
      }
    } catch (error) {
      setFeedback(error.message || String(error), true);
    } finally {
      instructionsState.loading = false;
      refreshBtn.disabled = false;
      updateSaveState();
    }
  }

  refreshBtn.onclick = refresh;
  return { element: section, refresh };
}

function buildMcpPane() {
  const section = el('section', 'settings-hub-pane');
  section.dataset.settingsPane = 'mcp';

  const header = el('div', 'settings-hub-section-head');
  const titleWrap = el('div');
  titleWrap.append(
    el('h3', '', 'MCP 서버'),
    el('p', 'settings-hub-muted', '프로젝트 .mcp.json과 Claude·Codex 전역 설정에 등록된 MCP 서버를 한곳에서 확인합니다.')
  );
  const refreshBtn = el('button', 'ghost', '새로 고침');
  refreshBtn.type = 'button';
  header.append(titleWrap, refreshBtn);

  const list = el('div', 'settings-hub-mcp-list');
  const sourcesBox = el('div', 'settings-hub-sources');
  section.append(header, list, sourcesBox);

  async function refresh() {
    mcpState.loading = true;
    refreshBtn.disabled = true;
    const cwd = activeWorkspaceCwd();
    mcpState.cwd = cwd;
    list.replaceChildren(el('p', 'settings-hub-muted', 'MCP 설정을 불러오는 중…'));
    sourcesBox.replaceChildren();
    try {
      const result = await api.agentHubMcp(cwd);
      mcpState.servers = result?.servers ?? [];
      mcpState.sources = result?.sources ?? [];
      list.replaceChildren();

      if (!mcpState.servers.length) {
        list.append(el('p', 'settings-hub-empty',
          '등록된 MCP 서버가 없습니다. 프로젝트 루트에 .mcp.json을 만들거나 ~/.claude.json, ~/.codex/config.toml에 MCP 서버를 추가하면 여기에 표시됩니다.'));
      } else {
        for (const server of mcpState.servers) {
          const card = el('div', 'settings-hub-mcp-card');
          const top = el('div', 'settings-hub-mcp-top');
          top.append(el('strong', '', server.name));
          const badges = el('div', 'settings-hub-badges');
          const sourceBadge = el('span', 'settings-hub-badge', server.source);
          sourceBadge.dataset.state = 'muted';
          const statusBadge = el('span', 'settings-hub-badge', server.enabled ? '활성' : '비활성');
          statusBadge.dataset.state = server.enabled ? 'ok' : 'muted';
          badges.append(sourceBadge, statusBadge);
          top.append(badges);
          const target = el('div', 'settings-hub-mono', server.target || '(명령/URL 없음)');
          card.append(top, target);
          if (server.envKeys?.length) {
            card.append(el('div', 'settings-hub-muted', '환경 변수: ' + server.envKeys.join(', ')));
          }
          list.append(card);
        }
      }

      if (mcpState.sources.length) {
        sourcesBox.append(el('div', 'settings-hub-group-label', '탐색한 설정 파일'));
        for (const src of mcpState.sources) {
          const row = el('div', 'settings-hub-row');
          const left = el('div');
          left.append(el('strong', '', src.source), el('small', 'settings-hub-mono', src.path));
          const stateText = src.error ? '오류: ' + src.error : src.exists ? `서버 ${src.count}개` : '파일 없음';
          const badge = el('span', 'settings-hub-badge', stateText);
          badge.dataset.state = src.error ? 'error' : src.exists ? 'ok' : 'muted';
          row.append(left, badge);
          sourcesBox.append(row);
        }
      }
    } catch (error) {
      list.replaceChildren(el('p', 'settings-hub-feedback', error.message || String(error)));
    } finally {
      mcpState.loading = false;
      refreshBtn.disabled = false;
    }
  }

  refreshBtn.onclick = refresh;
  return { element: section, refresh };
}

function buildShortcutsPane() {
  const section = el('section', 'settings-hub-pane');
  section.dataset.settingsPane = 'shortcuts';

  const header = el('div', 'settings-hub-section-head');
  const titleWrap = el('div');
  titleWrap.append(
    el('h3', '', '단축키'),
    el('p', 'settings-hub-muted', '터미널에 포커스가 있을 때 일부 키는 셸·CLI로 전달됩니다.')
  );
  header.append(titleWrap);

  const list = el('div', 'settings-hub-card');
  for (const [keys, description] of SHORTCUT_ROWS) {
    const row = el('div', 'settings-hub-row');
    row.append(el('span', '', description));
    row.append(el('kbd', 'settings-hub-kbd', keys));
    list.append(row);
  }
  section.append(header, list);
  return { element: section };
}

let agentsExtra;
let notificationsExtra;
let instructionsPane;
let mcpPane;

function selectTab(tabId) {
  if (!TABS.some(tab => tab.id === tabId)) return;
  activeTab = tabId;
  for (const [id, btn] of navButtons) {
    btn.setAttribute('aria-selected', String(id === tabId));
  }
  for (const [id, elements] of panes) {
    for (const node of elements) node.hidden = id !== tabId;
  }
  if (dialog?.open) refreshActiveTab();
}

function refreshActiveTab() {
  if (activeTab === 'agents') agentsExtra?.refresh(false);
  else if (activeTab === 'instructions') instructionsPane?.refresh();
  else if (activeTab === 'mcp') mcpPane?.refresh();
  else if (activeTab === 'notifications') notificationsExtra?.refresh();
}

function initSettingsHub() {
  if (!dialog || !form || dialog.classList.contains('settings-hub')) return;
  dialog.classList.add('settings-hub');

  const titleEl = byId('chat-settings-title');
  if (titleEl) titleEl.textContent = '설정';

  const fieldsets = [...form.querySelectorAll(':scope > fieldset.chat-settings-group')];
  const launchModes = byId('chat-launch-modes');
  const approvalFieldset = byId('open-approval-rules')?.closest('fieldset');
  const notificationsFieldset = form.elements['notifications']?.closest('fieldset');
  const appearanceFieldset = form.elements['match-terminal']?.closest('fieldset');
  const actionsBar = form.querySelector(':scope > .actions');

  const shell = el('div', 'settings-hub-shell');
  const nav = el('nav', 'settings-hub-nav');
  nav.setAttribute('role', 'tablist');
  nav.setAttribute('aria-label', '설정 분류');
  nav.setAttribute('aria-orientation', 'vertical');

  for (const tab of TABS) {
    const btn = el('button', 'settings-hub-tab', tab.label);
    btn.type = 'button';
    btn.dataset.settingsTab = tab.id;
    btn.setAttribute('role', 'tab');
    btn.setAttribute('aria-selected', String(tab.id === activeTab));
    btn.onclick = () => selectTab(tab.id);
    navButtons.set(tab.id, btn);
    nav.append(btn);
  }

  const body = el('div', 'settings-hub-body');
  const addToPane = (id, node) => {
    if (!node) return;
    if (!panes.has(id)) panes.set(id, []);
    panes.get(id).push(node);
    body.append(node);
  };

  // 기존 fieldset들을 각 탭에 배치(DOM ID와 form.elements 참조는 모두 그대로 유지)
  addToPane('general', appearanceFieldset);
  addToPane('agents', launchModes);
  agentsExtra = buildAgentsExtra();
  addToPane('agents', agentsExtra.element);

  instructionsPane = buildInstructionsPane();
  addToPane('instructions', instructionsPane.element);

  mcpPane = buildMcpPane();
  addToPane('mcp', mcpPane.element);

  addToPane('security', approvalFieldset);

  addToPane('notifications', notificationsFieldset);
  notificationsExtra = buildNotificationsExtra();
  addToPane('notifications', notificationsExtra.element);

  const shortcutsPane = buildShortcutsPane();
  addToPane('shortcuts', shortcutsPane.element);

  // 혹시 매칭되지 않은 fieldset이 있다면 general에 보관
  for (const fs of fieldsets) {
    if (!body.contains(fs)) addToPane('general', fs);
  }

  shell.append(nav, body);
  if (actionsBar) form.insertBefore(shell, actionsBar);
  else form.append(shell);

  selectTab('general');

  // 대화상자가 열릴 때 현재 탭의 동적 데이터 새로고침
  new MutationObserver(() => {
    if (dialog.open) refreshActiveTab();
  }).observe(dialog, { attributes: true, attributeFilter: ['open'] });
}

initSettingsHub();

window.hermitSettingsHub = {
  selectTab,
  refresh: refreshActiveTab,
  currentTab: () => activeTab,
  tabs: TABS.map(tab => tab.id)
};
