// Stage C 트랙 2: 관측성 UI — 모델 단가 기반 일별·프로젝트별 예상 비용($) 리포트 & 실행 중인 localhost 포트 현황.

function formatUsd(value) {
  const num = Number(value) || 0;
  if (num === 0) return '$0.00';
  if (num < 0.01) return '$' + num.toFixed(4);
  return '$' + num.toFixed(2);
}

function formatTokens(count) {
  const num = Number(count) || 0;
  if (num >= 1_000_000) return (num / 1_000_000).toFixed(2) + 'M';
  if (num >= 1_000) return (num / 1_000).toFixed(1) + 'K';
  return num.toLocaleString('ko-KR');
}

function projectLabel(projectPath) {
  if (!projectPath || projectPath === '(프로젝트 없음)') return '(프로젝트 없음)';
  const parts = String(projectPath).replace(/[\\/]+$/, '').split(/[\\/]/);
  return parts[parts.length - 1] || projectPath;
}

// Codex / Claude 토큰 이벤트를 관측성 원장으로 비차단 기록
const codexSeen = new Map();
function recordCodexUsage(params, task) {
  if (!api?.observabilityRecordUsage || !task) return;
  const thread = params?.threadId ?? runtime(task)?.threadId;
  const totals = params?.tokenUsage?.total;
  const recent = params?.tokenUsage?.last;
  if (!thread || !Number.isFinite(totals?.totalTokens)) return;

  const totalInput = Number(totals.inputTokens);
  const totalOutput = Number(totals.outputTokens);
  const totalCached = Number(totals.cachedInputTokens) || 0;
  const hasSplit = Number.isFinite(totalInput) && Number.isFinite(totalOutput);

  const prev = codexSeen.get(thread);
  const increasing = prev && totals.totalTokens >= prev.total;
  codexSeen.set(thread, {
    total: totals.totalTokens,
    input: hasSplit ? totalInput : Math.max(0, totals.totalTokens - totalCached),
    output: hasSplit ? totalOutput : 0,
    cached: totalCached
  });

  let inputTokens = 0;
  let outputTokens = 0;
  let cacheReadTokens = 0;
  if (increasing) {
    const cur = codexSeen.get(thread);
    inputTokens = Math.max(0, cur.input - prev.input);
    outputTokens = Math.max(0, cur.output - prev.output);
    cacheReadTokens = Math.max(0, cur.cached - prev.cached);
  } else if (recent) {
    const rCached = Number(recent.cachedInputTokens) || 0;
    inputTokens = Number.isFinite(recent.inputTokens) ? Math.max(0, recent.inputTokens - rCached) : Math.max(0, (Number(recent.totalTokens) || 0) - rCached);
    outputTokens = Number.isFinite(recent.outputTokens) ? Math.max(0, recent.outputTokens) : 0;
    cacheReadTokens = rCached;
  }
  if (inputTokens + outputTokens + cacheReadTokens === 0) return;

  api.observabilityRecordUsage({
    id: `codex:${thread}:${totals.totalTokens}`,
    provider: 'codex',
    model: task.model || runtime(task)?.model || '',
    project: task.worktree?.root ?? task.cwd ?? '',
    taskId: task.id,
    taskName: task.name ?? '',
    inputTokens,
    outputTokens,
    cacheReadTokens,
    cacheWriteTokens: 0,
    at: Date.now()
  }).catch(() => {});
}

function recordClaudeUsage(tokens, turnId, task) {
  if (!api?.observabilityRecordUsage || !tokens || !turnId || !task) return;
  api.observabilityRecordUsage({
    id: `claude:${turnId}`,
    provider: 'claude',
    model: task.model || runtime(task)?.model || '',
    project: task.worktree?.root ?? task.cwd ?? '',
    taskId: task.id,
    taskName: task.name ?? '',
    inputTokens: Number(tokens.input_tokens) || 0,
    outputTokens: Number(tokens.output_tokens) || 0,
    cacheReadTokens: Number(tokens.cache_read_input_tokens) || 0,
    cacheWriteTokens: Number(tokens.cache_creation_input_tokens) || 0,
    at: Date.now()
  }).catch(() => {});
}

function renderSummaryCards(container, report) {
  const totals = report.totals ?? {};
  const totalTokens = (totals.inputTokens ?? 0) + (totals.outputTokens ?? 0) + (totals.cacheReadTokens ?? 0) + (totals.cacheWriteTokens ?? 0);
  const grid = toolElement('div', '', 'obs-summary-grid');
  const cards = [
    ['예상 비용', formatUsd(totals.costUsd), `최근 ${report.days}일 기준`],
    ['총 토큰', formatTokens(totalTokens), `입력 ${formatTokens(totals.inputTokens)} · 출력 ${formatTokens(totals.outputTokens)}`],
    ['캐시 토큰', formatTokens((totals.cacheReadTokens ?? 0) + (totals.cacheWriteTokens ?? 0)), `관측 요청 ${(totals.samples ?? 0).toLocaleString('ko-KR')}건`]
  ];
  for (const [label, value, sub] of cards) {
    const card = toolElement('div', '', 'obs-metric-card');
    card.append(
      toolElement('span', label, 'obs-metric-label'),
      toolElement('strong', value, 'obs-metric-value'),
      toolElement('small', sub, 'obs-metric-sub')
    );
    grid.append(card);
  }
  container.append(grid);
}

function renderBreakdownTable(title, rows, labelFn, emptyText) {
  const section = toolElement('div', '', 'obs-subsection');
  section.append(toolElement('h4', title, 'obs-subtitle'));
  if (!rows?.length) {
    section.append(toolElement('p', emptyText, 'tool-muted'));
    return section;
  }
  const table = toolElement('table', '', 'obs-table');
  const thead = document.createElement('thead');
  const headRow = thead.insertRow();
  for (const col of ['항목', '토큰 (입력/출력/캐시)', '예상 비용']) {
    const th = document.createElement('th');
    th.textContent = col;
    headRow.append(th);
  }
  const tbody = document.createElement('tbody');
  for (const row of rows.slice(0, 15)) {
    const tr = tbody.insertRow();
    const labelCell = tr.insertCell();
    const { text, full } = labelFn(row);
    labelCell.textContent = text;
    if (full) labelCell.title = full;
    const tokCell = tr.insertCell();
    tokCell.className = 'obs-num';
    const cache = (row.cacheReadTokens ?? 0) + (row.cacheWriteTokens ?? 0);
    tokCell.textContent = `${formatTokens(row.inputTokens)} / ${formatTokens(row.outputTokens)} / ${formatTokens(cache)}`;
    const costCell = tr.insertCell();
    costCell.className = 'obs-num';
    costCell.textContent = formatUsd(row.costUsd);
  }
  table.append(thead, tbody);
  section.append(table);
  return section;
}

function showObservability(initialTab = 'all') {
  const content = toolDialog('관측성 · 비용 및 로컬 포트');
  content.classList.add('observability-view');

  // ── 1) 예상 비용 리포트 ─────────────────────────────────────────
  const costSection = toolElement('section', '', 'obs-section');
  const costHead = toolElement('div', '', 'obs-section-head');
  costHead.append(toolElement('h3', '모델 단가 기반 예상 비용'));
  const periodSelect = toolElement('select');
  periodSelect.id = 'obs-period';
  periodSelect.setAttribute('aria-label', '비용 집계 기간');
  for (const [value, label] of [['7', '최근 7일'], ['30', '최근 30일'], ['90', '최근 90일']]) {
    const opt = toolElement('option', label);
    opt.value = value;
    periodSelect.append(opt);
  }
  periodSelect.value = '30';
  costHead.append(periodSelect);

  const costBody = toolElement('div', '', 'obs-cost-body');
  costBody.id = 'obs-cost-body';
  costBody.append(toolElement('p', '사용량 원장을 불러오는 중…', 'tool-muted'));
  costSection.append(costHead, costBody);

  // ── 2) 실행 중인 localhost 포트 ──────────────────────────────────
  const portsSection = toolElement('section', '', 'obs-section');
  const portsHead = toolElement('div', '', 'obs-section-head');
  portsHead.append(toolElement('h3', '실행 중인 localhost 포트'));
  const refreshPortsBtn = button('새로 고침', () => loadPorts());
  refreshPortsBtn.id = 'obs-refresh-ports';
  portsHead.append(refreshPortsBtn);

  const portsBody = toolElement('div', '', 'obs-ports-body');
  portsBody.id = 'obs-ports-body';
  portsBody.append(toolElement('p', '로컬 포트를 확인하는 중…', 'tool-muted'));
  portsSection.append(portsHead, portsBody);

  if (initialTab === 'ports') content.append(portsSection, costSection);
  else content.append(costSection, portsSection);

  async function loadCosts() {
    try {
      const report = await api.observabilityUsageReport({ days: Number(periodSelect.value) || 30 });
      if (!content.isConnected) return;
      costBody.replaceChildren();
      renderSummaryCards(costBody, report);
      costBody.append(
        renderBreakdownTable(
          '프로젝트별 예상 비용',
          report.byProject,
          row => ({ text: projectLabel(row.project), full: row.project }),
          '기록된 토큰 사용량이 없습니다. 에이전트와 대화를 나누면 자동으로 집계됩니다.'
        ),
        renderBreakdownTable(
          '일별 예상 비용',
          report.byDay,
          row => ({ text: row.day }),
          '해당 기간에 기록된 사용량이 없습니다.'
        ),
        toolElement('small', '표준 모델 API 단가(입력·출력·캐시) 기준 추정치이며 실제 구독/청구 금액과 다를 수 있습니다.', 'tool-muted')
      );
    } catch (error) {
      if (content.isConnected) {
        costBody.replaceChildren();
        const err = toolElement('p', '', 'tool-error');
        toolError(err, error);
        costBody.append(err);
      }
    }
  }

  async function loadPorts() {
    refreshPortsBtn.disabled = true;
    try {
      const ports = await api.observabilityPorts();
      if (!content.isConnected) return;
      portsBody.replaceChildren();
      if (!ports?.length) {
        portsBody.append(toolElement('p', '현재 수신 대기(LISTENING) 중인 localhost 포트가 없습니다.', 'tool-muted'));
        return;
      }
      const list = toolElement('div', '', 'obs-port-list');
      for (const entry of ports) {
        const row = toolElement('div', '', 'obs-port-row');
        const info = toolElement('div', '', 'obs-port-info');
        const portLabel = toolElement('strong', ':' + entry.port, 'obs-port-number');
        const detail = toolElement('span', [entry.processName || '프로세스', 'PID ' + entry.pid, entry.address].join(' · '), 'tool-muted');
        info.append(portLabel, detail);

        const actions = toolElement('div', '', 'tool-actions');
        const previewBtn = button('미리보기', () => {
          toolsDialog.close();
          openPreviewPanel(workAreaFor(), { address: entry.url, cwd: reviewCwd() });
        });
        const openBtn = button('브라우저', () => api.openLocalPreview(entry.url));
        openBtn.className = 'ghost';
        actions.append(previewBtn, openBtn);

        row.append(info, actions);
        list.append(row);
      }
      portsBody.append(list);
    } catch (error) {
      if (content.isConnected) {
        portsBody.replaceChildren();
        const err = toolElement('p', '', 'tool-error');
        toolError(err, error);
        portsBody.append(err);
      }
    } finally {
      refreshPortsBtn.disabled = false;
    }
  }

  periodSelect.addEventListener('change', () => loadCosts());
  loadCosts();
  loadPorts();
}

// 사이드바 바로가기 & 사용량 대화상자에 진입점 추가(index.html 본문 충돌 방지).
const sidebarNav = document.querySelector('#workspaces-panel .sidebar-nav');
if (sidebarNav && !byId('nav-observability')) {
  const navBtn = document.createElement('button');
  navBtn.type = 'button';
  navBtn.id = 'nav-observability';
  const icon = document.createElement('span');
  icon.setAttribute('aria-hidden', 'true');
  setPanelIcon(icon, 'resource');
  const label = document.createElement('span');
  label.textContent = '비용·포트 현황';
  navBtn.append(icon, label);
  navBtn.onclick = () => showObservability();
  sidebarNav.append(navBtn);
}

const usageDialog = byId('agent-usage-dialog');
if (usageDialog && !byId('open-observability-from-usage')) {
  const openBtn = button('비용 리포트 · 로컬 포트 보기…', () => {
    usageDialog.close();
    showObservability();
  });
  openBtn.id = 'open-observability-from-usage';
  openBtn.type = 'button';
  usageDialog.querySelector('section:last-of-type')?.append(openBtn);
}

window.showObservability = showObservability;
window.observability = { recordCodexUsage, recordClaudeUsage, show: showObservability };
