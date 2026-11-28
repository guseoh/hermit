// 에이전트 현황판: 메인 작업 영역의 전체 폭 탭. 작업을 상태별 칸(칸반)으로 나누고,
// 카드마다 경과 시간·변경 수치·진행 단계를 보여 주며 그 자리에서 승인·거절·중단할 수 있다.
// 탭은 작업과 무관한 공용 탭이라 어느 작업을 앞에 두어도 보이고, 재시작하면 배치와 함께 복원된다.
const laneLabels = { working: '작업 중', waiting: '입력·승인 대기', idle: '대기', done: '완료', failed: '실패·중단' };
const changeTtl = 15000;
const changes = new Map(); // cwd → { at, files, added, removed, pending }
let boardTab = null;
let frame = 0;
let ticker = 0;
const cards = new Map(); // task id → { key, node }

function element(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function boardOpen() {
  return !!boardTab?.workArea && panelTree.contains(boardTab.host);
}

function duration(ms) {
  const seconds = Math.max(0, Math.floor(ms / 1000));
  if (seconds < 60) return seconds + '초';
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return minutes + '분 ' + String(seconds % 60).padStart(2, '0') + '초';
  return Math.floor(minutes / 60) + '시간 ' + (minutes % 60) + '분';
}

// 작업 폴더의 변경 수치. 같은 폴더는 한 번만, 15초 안에는 다시 묻지 않는다.
function changeSummary(task) {
  const cached = changes.get(task.cwd);
  if (!cached || (!cached.pending && Date.now() - cached.at > changeTtl)) {
    const entry = { at: Date.now(), pending: true, files: cached?.files, added: cached?.added, removed: cached?.removed };
    changes.set(task.cwd, entry);
    api.gitStatus(task.cwd).then(snapshot => {
      const files = snapshot.files ?? [];
      Object.assign(entry, {
        files: new Set(files.map(file => file.name)).size,
        added: files.reduce((sum, file) => sum + (file.added ?? 0), 0),
        removed: files.reduce((sum, file) => sum + (file.removed ?? 0), 0)
      });
    }, () => { entry.files = undefined; }).finally(() => {
      entry.pending = false;
      entry.at = Date.now();
      scheduleAgentsBoard();
    });
  }
  const entry = changes.get(task.cwd);
  if (!Number.isFinite(entry.files)) return '';
  return entry.files ? '파일 ' + entry.files + '개 · +' + entry.added + ' −' + entry.removed : '변경 없음';
}

function elapsedText(task, state) {
  return state.turnStartedAt ? '경과 ' + duration(Date.now() - state.turnStartedAt) : timeAgo(task.activeAt ?? task.createdAt);
}

// 카드 내용이 바뀌었는지 가늠하는 열쇠. 같으면 기존 노드를 그대로 둬서 클릭·포커스가 끊기지 않는다.
function cardKey(task) {
  const state = runtime(task);
  const plan = Array.isArray(state.plan) ? state.plan.map(entry => entry?.status + entry?.step) : [];
  return JSON.stringify([task.name, task.provider, taskStatus(state), taskState(state), task.worktree?.branch, task === selectedTask,
    state.turnStartedAt ?? timeAgo(task.activeAt ?? task.createdAt), changeSummary(task), plan, [...state.approvals.keys()], !!state.busy, state.status]);
}

function card(task) {
  const state = runtime(task);
  const kind = taskState(state);
  const label = taskStatus(state) || '대기';
  const node = element('article', 'agent-board-card');
  node.dataset.agentCard = task.id;
  node.dataset.state = kind;
  node.setAttribute('aria-current', String(task === selectedTask));
  const open = button('', () => chooseTask(task));
  open.className = 'agent-board-open';
  open.title = task.name + ' 작업 열기';
  open.append(agentMark(task.provider), element('strong', '', task.name));
  const meta = element('p', 'agent-board-meta', [label, task.worktree?.branch ?? '기본 체크아웃'].join(' · '));
  meta.title = state.authMessage ?? state.status ?? label;
  const facts = element('p', 'agent-board-facts');
  const elapsed = element('span', 'agent-board-elapsed');
  if (state.turnStartedAt) elapsed.dataset.started = state.turnStartedAt;
  elapsed.textContent = elapsedText(task, state);
  const summary = changeSummary(task);
  facts.append(elapsed, ...(summary ? [(elapsed.textContent ? ' · ' : '') + summary] : []));
  node.append(open, meta, facts);
  const plan = Array.isArray(state.plan) ? state.plan.filter(Boolean) : [];
  if (plan.length) {
    const done = plan.filter(entry => entry.status === 'completed').length;
    const current = plan.find(entry => entry.status === 'inProgress')?.step;
    const progress = element('div', 'agent-board-progress');
    const meter = element('progress');
    meter.max = plan.length;
    meter.value = done;
    meter.setAttribute('aria-label', '진행 ' + done + '/' + plan.length);
    progress.append(meter, element('small', '', done + '/' + plan.length + (current ? ' · ' + current : '')));
    node.append(progress);
  }
  const actions = element('div', 'agent-board-actions');
  for (const request of state.approvals.values()) {
    const ask = element('p', 'agent-board-approval', request.command ?? request.reason ?? '승인 요청');
    ask.title = ask.textContent;
    const approve = button('승인', () => answerApproval(task, request, true).catch(report));
    approve.className = 'primary';
    const deny = button('거절', () => answerApproval(task, request, false).catch(report));
    deny.className = 'ghost';
    actions.append(ask, approve, deny);
  }
  if (state.busy) {
    const stop = button('중단', () => stopChat(task).catch(report));
    stop.className = 'ghost';
    actions.append(stop);
  }
  if (actions.childElementCount) node.append(actions);
  return node;
}

function renderAgentsBoard() {
  if (!boardOpen()) return;
  const host = boardTab.host;
  const live = tasks.filter(task => openTasks.has(task.id) || ['working', 'waiting'].includes(taskState(runtime(task))));
  live.sort((first, second) => (second.activeAt ?? second.createdAt ?? 0) - (first.activeAt ?? first.createdAt ?? 0));
  let board = host.querySelector(':scope > .agent-board');
  if (!board) {
    board = element('div', 'agent-board');
    for (const [kind, label] of Object.entries(laneLabels)) {
      const lane = element('section', 'agent-board-lane');
      lane.dataset.agentLane = kind;
      lane.setAttribute('aria-label', label);
      lane.append(element('h3', '', label), element('div', 'agent-board-list'));
      board.append(lane);
    }
    host.replaceChildren(board);
  }
  const seen = new Set();
  for (const [kind, label] of Object.entries(laneLabels)) {
    const lane = board.querySelector('[data-agent-lane="' + kind + '"]');
    const list = lane.lastElementChild;
    const items = live.filter(task => taskState(runtime(task)) === kind);
    lane.firstElementChild.textContent = label + ' ' + items.length;
    const nodes = items.map(task => {
      seen.add(task.id);
      const key = cardKey(task);
      let entry = cards.get(task.id);
      if (!entry || entry.key !== key) {
        const next = card(task);
        entry?.node.replaceWith(next);
        entry = { key, node: next };
        cards.set(task.id, entry);
      }
      return entry.node;
    });
    if (!nodes.length) nodes.push(list.querySelector(':scope > .agent-board-empty') ?? element('p', 'agent-board-empty', '없음'));
    // 순서가 같으면 노드를 옮기지 않는다.
    if (nodes.some((node, index) => list.children[index] !== node) || list.children.length !== nodes.length) list.replaceChildren(...nodes);
  }
  for (const [id, entry] of cards) if (!seen.has(id)) { entry.node.remove(); cards.delete(id); }
  // 실행 중인 작업이 있으면 경과 시간 글자만 1초마다 고치고, 없으면 멈춘다.
  const running = live.some(task => runtime(task).turnStartedAt);
  if (running && !ticker) ticker = setInterval(tickElapsed, 1000);
  else if (!running && ticker) { clearInterval(ticker); ticker = 0; }
}

function tickElapsed() {
  if (!boardOpen() || document.hidden) return;
  for (const node of boardTab.host.querySelectorAll('.agent-board-elapsed[data-started]')) {
    node.textContent = '경과 ' + duration(Date.now() - Number(node.dataset.started));
  }
}

function scheduleAgentsBoard() {
  if (frame || !boardOpen()) return;
  frame = requestAnimationFrame(() => { frame = 0; renderAgentsBoard(); });
}

function openAgentsBoard(area = workAreaFor(), saved) {
  if (boardOpen()) {
    if (!saved) activateWorkAreaTab(boardTab);
    return boardTab;
  }
  const host = element('section', 'work-document agents-board');
  host.setAttribute('aria-label', '에이전트 현황');
  // owner를 null로 두어 어느 작업에서도 보이는 공용 탭으로 만든다.
  boardTab = { name: '에이전트 현황', icon: 'agents', host, owner: null, agentsBoard: true };
  boardTab.onClose = () => {
    clearInterval(ticker);
    ticker = 0;
    cards.clear();
  };
  attachWorkAreaTab(boardTab, area, !saved);
  renderAgentsBoard();
  if (!saved) activateWorkAreaTab(boardTab);
  return boardTab;
}

Object.assign(window, { openAgentsBoard, scheduleAgentsBoard, renderAgentsBoard });
