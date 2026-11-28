// Stage C 트랙 2: 전역 대화·명령 출력 검색(지식 색인) UI 및 비차단 색인 훅.

function extractChatItemText(item) {
  if (!item || typeof item !== 'object') return '';
  if (typeof item.text === 'string' && item.text.trim()) return item.text.trim();
  if (typeof item.aggregatedOutput === 'string' && item.aggregatedOutput.trim()) {
    const cmd = typeof item.command === 'string' ? item.command.trim() : '';
    return cmd ? cmd + '\n' + item.aggregatedOutput.trim() : item.aggregatedOutput.trim();
  }
  if (Array.isArray(item.content)) {
    return item.content.map(part => typeof part?.text === 'string' ? part.text : '').filter(Boolean).join('\n').trim();
  }
  return '';
}

function indexChatItem(task, item) {
  if (!api?.knowledgeAppend || !task || !item) return;
  if (!['userMessage', 'agentMessage', 'commandExecution'].includes(item.type)) return;
  const text = extractChatItemText(item);
  if (!text) return;
  const kind = item.type === 'commandExecution' ? 'command' : 'chat';
  const role = item.type === 'userMessage' ? 'user' : item.type === 'agentMessage' ? 'assistant' : 'command';
  const title = item.type === 'commandExecution'
    ? String(item.command ?? task.name ?? '').split(/\r?\n/, 1)[0].trim()
    : String(task.name ?? '');
  const project = task.worktree?.root ?? task.cwd ?? '';
  const id = `chat:${task.id}:${item.id || role}`;
  api.knowledgeAppend({
    id, kind, role, taskId: task.id, taskName: task.name ?? '',
    provider: task.provider ?? '', project, title, text, at: Date.now()
  }).catch(() => {});
}

function indexCommand(pane, record) {
  if (!api?.knowledgeAppend || !record) return;
  const text = String(record.text ?? record.output ?? '').trim();
  if (!text) return;
  const project = record.sourceCwd ?? pane?.cwd ?? '';
  api.knowledgeAppend({
    id: 'cmd:' + record.id,
    kind: 'command',
    role: 'command',
    taskId: '',
    taskName: pane?.tab?.name ?? '',
    provider: 'shell',
    project,
    title: String(record.label ?? '').trim(),
    text,
    at: record.at ?? Date.now()
  }).catch(() => {});
}

function appendHighlightedText(container, text, terms) {
  if (!terms?.length) {
    container.textContent = text;
    return;
  }
  const escaped = terms.map(t => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).filter(Boolean);
  if (!escaped.length) {
    container.textContent = text;
    return;
  }
  const regex = new RegExp('(' + escaped.join('|') + ')', 'gi');
  const parts = String(text ?? '').split(regex);
  for (let i = 0; i < parts.length; i++) {
    const part = parts[i];
    if (!part) continue;
    if (i % 2 === 1) {
      const mark = document.createElement('mark');
      mark.textContent = part;
      container.append(mark);
    } else {
      container.append(document.createTextNode(part));
    }
  }
}

function formatTime(at) {
  if (!Number.isFinite(at)) return '';
  return new Date(at).toLocaleString('ko-KR', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}

function basename(filePath) {
  if (!filePath) return '';
  const parts = String(filePath).replace(/[\\/]+$/, '').split(/[\\/]/);
  return parts[parts.length - 1] || filePath;
}

function showKnowledgeSearch(initialQuery = '') {
  const content = toolDialog('전역 지식 검색');
  content.classList.add('knowledge-search-view');

  const controls = toolElement('form', '', 'knowledge-search-controls');
  controls.setAttribute('role', 'search');
  const input = toolElement('input');
  input.id = 'knowledge-search-input';
  input.type = 'search';
  input.placeholder = '과거 대화와 터미널 명령 출력 검색…';
  input.setAttribute('aria-label', '지식 검색어');
  input.spellcheck = false;
  input.maxLength = 300;
  input.value = initialQuery;

  const kindSelect = toolElement('select');
  kindSelect.id = 'knowledge-search-kind';
  kindSelect.setAttribute('aria-label', '종류 필터');
  for (const [value, label] of [['all', '전체'], ['chat', '대화'], ['command', '명령 출력']]) {
    const option = toolElement('option', label);
    option.value = value;
    kindSelect.append(option);
  }

  const projectSelect = toolElement('select');
  projectSelect.id = 'knowledge-search-project';
  projectSelect.setAttribute('aria-label', '프로젝트 필터');
  const allProject = toolElement('option', '전체 프로젝트');
  allProject.value = '';
  projectSelect.append(allProject);

  controls.append(input, kindSelect, projectSelect);

  const summary = toolElement('p', '색인을 불러오는 중…', 'tool-muted knowledge-search-summary');
  summary.id = 'knowledge-search-summary';
  summary.setAttribute('role', 'status');

  const results = toolElement('div', '', 'knowledge-search-results');
  results.id = 'knowledge-search-results';

  content.append(controls, summary, results);

  let epoch = 0;
  let timer = null;
  let projectsPopulated = false;

  function populateProjects(projects) {
    if (projectsPopulated) return;
    projectsPopulated = true;
    const current = projectSelect.value;
    projectSelect.replaceChildren();
    const allOpt = toolElement('option', '전체 프로젝트');
    allOpt.value = '';
    projectSelect.append(allOpt);
    for (const proj of projects ?? []) {
      const opt = toolElement('option', basename(proj));
      opt.value = proj;
      opt.title = proj;
      projectSelect.append(opt);
    }
    projectSelect.value = current;
  }

  async function runSearch() {
    const currentEpoch = ++epoch;
    try {
      const data = await api.knowledgeSearch({
        query: input.value,
        kind: kindSelect.value,
        project: projectSelect.value,
        limit: 60
      });
      if (currentEpoch !== epoch || !content.isConnected) return;
      populateProjects(data.stats?.projects);
      const statsText = `총 ${(data.stats?.total ?? 0).toLocaleString('ko-KR')}건 색인 (대화 ${(data.stats?.chatCount ?? 0).toLocaleString('ko-KR')} · 명령 ${(data.stats?.commandCount ?? 0).toLocaleString('ko-KR')})`;
      summary.textContent = input.value.trim()
        ? `${data.total.toLocaleString('ko-KR')}건 일치 · ${statsText}`
        : statsText;

      results.replaceChildren();
      if (!data.items?.length) {
        const empty = toolElement('p',
          data.stats?.total
            ? '일치하는 대화나 명령 출력이 없습니다.'
            : '아직 색인된 기록이 없습니다. 에이전트와 대화를 주고받거나 터미널에서 명령을 실행하면 자동으로 기록됩니다.',
          'tool-muted knowledge-search-empty');
        results.append(empty);
        return;
      }

      for (const item of data.items) {
        const card = toolElement('article', '', 'knowledge-result');
        const head = toolElement('div', '', 'knowledge-result-head');
        const badge = toolElement('span', item.kind === 'chat' ? (item.role === 'user' ? '질문' : '답변') : '명령', 'knowledge-badge');
        badge.dataset.kind = item.kind;
        const title = toolElement('strong', item.title || item.taskName || '(제목 없음)', 'knowledge-result-title');
        const meta = toolElement('span', [basename(item.project), formatTime(item.at)].filter(Boolean).join(' · '), 'knowledge-result-meta');
        head.append(badge, title, meta);

        const snippet = toolElement('p', '', 'knowledge-result-snippet');
        appendHighlightedText(snippet, item.snippet || item.text, data.terms);

        const actions = toolElement('div', '', 'tool-actions knowledge-result-actions');
        const copyBtn = button('복사', async () => {
          await api.copy(item.text || item.title);
          status('검색 결과를 클립보드에 복사했습니다.');
        });
        copyBtn.className = 'ghost';
        actions.append(copyBtn);

        if (item.kind === 'chat' && item.taskId) {
          const target = tasks.find(t => t.id === item.taskId);
          if (target) {
            const jumpBtn = button('작업으로 이동', () => {
              toolsDialog.close();
              chooseTask(target);
            });
            jumpBtn.className = 'ghost';
            actions.append(jumpBtn);
          }
        } else if (item.kind === 'command' && item.project) {
          const termBtn = button('폴더에서 터미널 열기', () => {
            toolsDialog.close();
            return newShellTab(item.project);
          });
          termBtn.className = 'ghost';
          actions.append(termBtn);
        }

        card.append(head, snippet, actions);
        results.append(card);
      }
    } catch (error) {
      if (currentEpoch === epoch) toolError(summary, error);
    }
  }

  function scheduleSearch() {
    clearTimeout(timer);
    timer = setTimeout(() => runSearch(), 120);
  }

  controls.onsubmit = event => {
    event.preventDefault();
    clearTimeout(timer);
    runSearch();
  };
  input.addEventListener('input', scheduleSearch);
  kindSelect.addEventListener('change', () => runSearch());
  projectSelect.addEventListener('change', () => runSearch());

  runSearch();
  input.focus();
}

// 사이드바 바로가기에 지식 검색 버튼 추가(index.html 본문 충돌 방지).
const sidebarNav = document.querySelector('#workspaces-panel .sidebar-nav');
if (sidebarNav && !byId('nav-knowledge-search')) {
  const navBtn = document.createElement('button');
  navBtn.type = 'button';
  navBtn.id = 'nav-knowledge-search';
  const icon = document.createElement('span');
  icon.setAttribute('aria-hidden', 'true');
  setPanelIcon(icon, 'search');
  const label = document.createElement('span');
  label.textContent = '지식 검색';
  navBtn.append(icon, label);
  navBtn.onclick = () => showKnowledgeSearch();
  sidebarNav.append(navBtn);
}

window.showKnowledgeSearch = showKnowledgeSearch;
window.knowledgeSearch = { indexChatItem, indexCommand, show: showKnowledgeSearch };
