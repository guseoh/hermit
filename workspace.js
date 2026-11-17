
const taskKey = 'agent-workbench-tasks-v1';
let tasks;
try { tasks = JSON.parse(localStorage.getItem(taskKey) ?? '[]'); } catch { tasks = []; }
const runtimes = new Map();
let selectedTask = null;
let chosenFolder;
let chosenPatch;
let gitEpoch = 0;
let gitBusyFor;
let lastSnapshot;
let renderFrame;

function persist() {
  localStorage.setItem(taskKey, JSON.stringify(tasks));
  if (selectedTask) localStorage.setItem('agent-last-task', selectedTask.id);
}

function runtime(task) {
  if (!runtimes.has(task.id)) runtimes.set(task.id, {
    status: '연결되지 않음', items: new Map(), approvals: new Map(), draft: ''
  });
  return runtimes.get(task.id);
}

function setDrawer(show) {
  byId('terminal-drawer').hidden = !show;
  document.body.classList.toggle('terminal-visible', show);
  byId('toggle-terminal').setAttribute('aria-expanded', String(show));
  scheduleFit();
}

function setReview(mode) {
  byId('results-panel').dataset.review = mode;
  byId('review-changes').setAttribute('aria-pressed', String(mode === 'changes'));
  byId('review-results').setAttribute('aria-pressed', String(mode === 'results'));
  if (mode === 'changes') refreshGit();
  else document.body.classList.remove('diff-wide');
}

function tasksSidebar() {
  const list = byId('task-list');
  list.replaceChildren();
  const projects = new Map();
  for (const task of tasks) {
    if (!projects.has(task.cwd)) projects.set(task.cwd, []);
    projects.get(task.cwd).push(task);
  }
  for (const [folder, entries] of projects) {
    const group = document.createElement('section');
    group.className = 'group';
    const name = document.createElement('small');
    name.title = folder;
    name.textContent = folder.split(/[\\/]/).filter(Boolean).at(-1) ?? folder;
    group.append(name);
    for (const task of entries) {
      const item = button(task.name, () => chooseTask(task));
      item.className = 'tab';
      item.title = 'Codex · ' + task.cwd;
      item.setAttribute('aria-current', String(task === selectedTask));
      group.append(item);
    }
    list.append(group);
  }
}

function chooseTask(task) {
  if (selectedTask) runtime(selectedTask).draft = byId('chat-input').value;
  selectedTask = task;
  byId('chat-input').value = runtime(task).draft;
  byId('task-title').textContent = task.name;
  byId('task-folder').textContent = task.cwd;
  byId('task-folder').title = task.cwd;
  document.body.classList.add('task-visible');
  byId('composer').hidden = false;
  byId('close-task').hidden = false;
  byId('chat-feed').replaceChildren();
  tasksSidebar();
  persist();
  resetGit();
  renderChat();
}

async function connectTask(task) {
  const state = runtime(task);
  if (state.connecting || state.connected) return;
  state.connecting = true;
  state.status = 'Codex 연결 중…';
  if (task === selectedTask) renderChat();
  try {
    const result = await api.chatConnect({ id: task.id, cwd: task.cwd, threadId: task.threadId });
    state.threadId = result.threadId;
    state.model = result.model;
    state.items = new Map([...result.turns.flatMap(turn => turn.items ?? []), ...state.items.values()]
      .map(item => [item.id, item]));
    state.connected = true;
    if (!state.busy) state.status = '요청을 보낼 수 있습니다.';
    persist();
  } catch (error) {
    state.status = error.message;
  } finally {
    state.connecting = false;
    if (task === selectedTask) renderChat();
  }
}

function itemText(item) {
  if (item.type === 'userMessage') return (item.content ?? []).map(value => value.text ?? '').join('\n');
  if (item.type === 'agentMessage') return item.text ?? '';
  if (item.type === 'commandExecution') return [item.command, item.aggregatedOutput].filter(Boolean).join('\n');
  if (item.type === 'fileChange') return (item.changes ?? []).map(value => value.path).join('\n');
  if (item.type === 'plan') return item.text ?? '';
  return item.title ?? item.name ?? item.type;
}


function renderMessage(node, text) {
  if (node.dataset.source === text) return;
  node.dataset.source = text;
  const blocks = text.split(/(^[ \t]*\x60{3}[^\r\n]*\r?\n[\s\S]*?^[ \t]*\x60{3}[ \t]*$)/m);
  const fragment = document.createDocumentFragment();
  blocks.forEach((block, index) => {
    if (!block.trim()) return;
    if (index % 2) {
      const pre = document.createElement('pre');
      pre.textContent = block.replace(/^[^\n]*\n|\r?\n[ \t]*\x60{3}[ \t]*$/g, '');
      fragment.append(pre);
      return;
    }
    for (const line of block.trim().split(/\r?\n/)) {
      const heading = /^#{1,4}\s+(.+)$/.exec(line);
      const paragraph = document.createElement(heading ? 'h3' : 'p');
      for (const part of (heading?.[1] ?? line).split(/(\*\*[^*]+\*\*|\x60[^\x60]+\x60)/)) {
        if (part.startsWith('**') && part.endsWith('**')) {
          const strong = document.createElement('strong'); strong.textContent = part.slice(2, -2); paragraph.append(strong);
        } else if (part.startsWith('\x60') && part.endsWith('\x60')) {
          const code = document.createElement('code'); code.textContent = part.slice(1, -1); paragraph.append(code);
        } else if (part) paragraph.append(document.createTextNode(part));
      }
      fragment.append(paragraph);
    }
  });
  node.replaceChildren(fragment);
}


function renderChat() {
  if (!selectedTask) return;
  const state = runtime(selectedTask);
  const feed = byId('chat-feed');
  const stick = feed.scrollHeight - feed.scrollTop - feed.clientHeight < 100;
  if (!state.items.size) {
    feed.replaceChildren();
    const message = document.createElement('p');
    message.className = 'chat-empty';
    message.textContent = 'Codex에 작업을 요청하세요. 변경한 파일은 오른쪽에서 검토할 수 있습니다.';
    feed.append(message);
  } else {
    feed.querySelector('.chat-empty')?.remove();
    for (const child of [...feed.children]) {
      if (!state.items.has(child.dataset.item)) child.remove();
    }
    const rendered = new Map([...feed.children].map(child => [child.dataset.item, child]));
    for (const item of state.items.values()) {
      let node = rendered.get(item.id);
      const text = itemText(item);
      if (!node) {
        node = document.createElement('article');
        node.className = 'chat-entry ' + item.type;
        node.dataset.item = item.id;
        if (['userMessage', 'agentMessage', 'plan'].includes(item.type)) {
          const message = document.createElement('div'); message.className = 'chat-message'; node.append(message);
        } else {
          const details = document.createElement('details');
          const summary = document.createElement('summary');
          summary.textContent = { commandExecution: '명령 실행', fileChange: '파일 변경', reasoning: '작업 진행' }[item.type] ?? item.type;
          details.append(summary, document.createElement('pre'));
          node.append(details);
        }
        feed.append(node);
      }
      const message = node.querySelector('.chat-message');
      if (message) renderMessage(message, text);
      else {
        const body = node.querySelector('pre');
        if (body.textContent !== text) body.textContent = text;
      }
    }
  }
  if (stick) feed.scrollTop = feed.scrollHeight;
  const approvals = byId('approval-list');
  if (approvals.dataset.key !== JSON.stringify([selectedTask.id, ...state.approvals.keys()])) {
    approvals.dataset.key = JSON.stringify([selectedTask.id, ...state.approvals.keys()]);
    approvals.replaceChildren();
    for (const request of state.approvals.values()) {
      const card = document.createElement('div');
      card.className = 'approval';
      const reason = document.createElement('p');
      reason.textContent = [
        request.method.includes('commandExecution') ? '명령 실행 승인' : '파일 변경 승인',
        request.command, request.cwd, request.reason, request.grantRoot
      ].filter(Boolean).join(' · ');
      card.append(reason, ...[true, false].map(accept => button(accept ? '이번만 승인' : '거절', async () => {
        await api.chatApprove(state.taskId, request.id, accept);
        state.approvals.delete(request.id);
        renderChat();
      })));
      approvals.append(card);
    }
  }
  byId('composer-note').textContent = [state.model, state.status].filter(Boolean).join(' · ');
  byId('reconnect-chat').hidden = state.connected || state.connecting;
  byId('disconnect-chat').hidden = !state.connected || !!state.busy;
  byId('stop-chat').hidden = !state.busy || !state.connected;
  byId('send-chat').disabled = !state.connected || !!state.busy || !byId('chat-input').value.trim();
}

function scheduleChat() {
  if (!renderFrame) renderFrame = requestAnimationFrame(() => { renderFrame = 0; renderChat(); });
}

api.onChat((id, { method, params }) => {
  const task = tasks.find(item => item.id === id);
  if (!task) return;
  const state = runtime(task);
  state.taskId = id;
  if (method === 'item/started' || method === 'item/completed') {
    const item = params.item;
    const key = item.type === 'userMessage' && item.clientId ? item.clientId : item.id;
    state.items.set(key, { ...item, id: key });
  } else if (method === 'item/agentMessage/delta' || method === 'item/commandExecution/outputDelta') {
    const agent = method === 'item/agentMessage/delta';
    const item = state.items.get(params.itemId) ?? { id: params.itemId, type: agent ? 'agentMessage' : 'commandExecution' };
    const field = agent ? 'text' : 'aggregatedOutput';
    item[field] = ((item[field] ?? '') + params.delta).slice(-500000);
    state.items.set(item.id, item);
  } else if (method === 'turn/started') {
    if (state.threadId && !task.threadId) {
      task.threadId = state.threadId;
      persist();
    }
    state.busy = true;
    state.status = '작업 중';
  } else if (method === 'turn/completed') {
    state.busy = false;
    state.approvals.clear();
    state.status = { completed: '완료', interrupted: '중단됨', failed: '실패' }[params.turn.status] ?? params.turn.status;
    if (params.turn.error?.message) state.status += ' · ' + params.turn.error.message;
    if (task === selectedTask) refreshGit(!chosenPatch?.selected.size);
  } else if (method === 'approval') {
    state.approvals.set(params.id, params);
  } else if (method === 'disconnected') {
    state.connected = false;
    state.busy = false;
    state.approvals.clear();
    state.status = params.message;
    api.chatClose(id).catch(report);
  } else if (method === 'notice' || method === 'error') {
    state.status = params.message ?? params.error?.message ?? 'Codex 오류';
  } else return;
  if (task === selectedTask) scheduleChat();
});

async function newTask() {
  chosenFolder = selectedTask?.cwd ?? currentPane()?.cwd ?? await api.home();
  byId('task-cwd').textContent = chosenFolder;
  byId('task-name').value = '';
  byId('task-dialog').showModal();
}
byId('new-task').onclick = byId('new-task-top').onclick = () => newTask().catch(report);
byId('choose-task-cwd').onclick = async () => {
  const folder = await api.folder();
  if (folder) { chosenFolder = folder; byId('task-cwd').textContent = folder; }
};
byId('cancel-task').onclick = () => byId('task-dialog').close();
byId('task-dialog').querySelector('form').onsubmit = event => {
  event.preventDefault();
  const name = byId('task-name').value.trim();
  if (!name) return;
  const task = { id: crypto.randomUUID(), name, cwd: chosenFolder };
  tasks.push(task);
  byId('task-dialog').close();
  chooseTask(task);
  connectTask(task);
};
byId('task-title').ondblclick = () => {
  const task = selectedTask;
  if (!task) return;
  editInline(byId('task-title'), name => {
    task.name = name;
    byId('task-title').textContent = name;
    persist();
    tasksSidebar();
  });
};
byId('disconnect-chat').onclick = async () => {
  const task = selectedTask;
  const state = runtime(task);
  if (state.busy) return;
  try {
    await api.chatClose(task.id);
    state.connected = false;
    state.status = '연결 종료됨 · 다시 연결할 수 있습니다.';
    renderChat();
  } catch (error) { state.status = error.message; renderChat(); }
};
byId('chat-input').oninput = scheduleChat;
byId('reconnect-chat').onclick = () => { if (selectedTask) connectTask(selectedTask); };
byId('stop-chat').onclick = async () => {
  const task = selectedTask;
  try { await api.chatStop(task.id); }
  catch (error) { runtime(task).status = error.message; renderChat(); }
};
byId('composer').onsubmit = async event => {
  event.preventDefault();
  const task = selectedTask;
  if (!task) return;
  const state = runtime(task);
  const text = byId('chat-input').value.trim();
  if (!text || state.busy || !state.connected) return;
  state.busy = true;
  state.status = '요청 전송 중…';
  const clientId = crypto.randomUUID();
  const pending = { id: clientId, type: 'userMessage', content: [{ text }] };
  state.items.set(clientId, pending);
  byId('chat-input').value = '';
  renderChat();
  try { await api.chatSend(task.id, text, clientId); }
  catch (error) {
    if (state.items.get(clientId) === pending) state.items.delete(clientId);
    state.busy = false;
    state.status = error.message;
    if (selectedTask === task && !byId('chat-input').value) byId('chat-input').value = text;
    else if (selectedTask !== task && !state.draft) state.draft = text;
    renderChat();
  }
};
byId('close-task').onclick = () => {
  if (!selectedTask) return;
  runtime(selectedTask).draft = byId('chat-input').value;
  selectedTask = null;
  localStorage.removeItem('agent-last-task');
  document.body.classList.remove('task-visible');
  byId('task-title').textContent = '에이전트 작업공간';
  byId('task-folder').textContent = '';
  byId('composer').hidden = true;
  byId('close-task').hidden = true;
  byId('approval-list').replaceChildren();
  delete byId('approval-list').dataset.key;
  renderEmptyTask();
  tasksSidebar();
  resetGit();
};
byId('toggle-terminal').onclick = () => setDrawer(byId('terminal-drawer').hidden);
byId('show-changes').onclick = () => {
  if (byId('results-panel').dataset.collapsed === 'true') byId('toggle-results-panel').click();
  setReview('changes');
};
byId('review-changes').onclick = () => setReview('changes');
byId('review-results').onclick = () => setReview('results');

function reviewCwd() {
  return selectedTask?.cwd ?? currentPane()?.cwd;
}

function resetGit() {
  gitEpoch++;
  chosenPatch = undefined;
  lastSnapshot = undefined;
  byId('patch-review').hidden = true;
  byId('changes-list').replaceChildren();
  byId('git-branch').textContent = '';
  refreshGit();
}

function noteChanges(message) {
  const note = document.createElement('p');
  note.className = 'empty';
  note.textContent = message;
  byId('changes-list').replaceChildren(note);
}

async function refreshGit(force = false) {
  const cwd = reviewCwd();
  if (!cwd || byId('results-panel').dataset.review !== 'changes' ||
      byId('results-panel').dataset.collapsed === 'true' || gitBusyFor === cwd) return;
  const epoch = gitEpoch;
  gitBusyFor = cwd;
  try {
    const snapshot = await api.gitStatus(cwd);
    if (epoch !== gitEpoch || cwd !== reviewCwd()) return;
    const key = JSON.stringify(snapshot);
    if (!force && key === lastSnapshot) return;
    lastSnapshot = key;
    byId('git-branch').textContent = snapshot.root ? (snapshot.branch ?? '') + ' · 파일 ' + new Set(snapshot.files.map(file => file.name)).size + '개' : '작업 폴더';
    if (!snapshot.root) { noteChanges('Git 저장소가 아닙니다.'); return; }
    if (!snapshot.files.length) noteChanges('변경된 파일이 없습니다.');
    else {
      const list = byId('changes-list');
      list.replaceChildren();
      for (const entry of snapshot.files) {
        const label = { staged: '스테이징', unstaged: '작업 트리', new: '새 파일', conflict: '충돌' }[entry.kind];
        const row = button(label + ' · ' + entry.name, () => openPatch(cwd, entry, row));
        row.className = 'change-file';
        row.title = (entry.from ? entry.from + ' → ' : '') + entry.name;
        row.setAttribute('aria-current', String(chosenPatch?.name === entry.name && chosenPatch?.kind === entry.kind));
        list.append(row);
      }
    }
    if (chosenPatch && !snapshot.files.some(file => file.name === chosenPatch.name && file.kind === chosenPatch.kind)) {
      chosenPatch = undefined;
      byId('patch-review').hidden = true;
    }
    if (force && chosenPatch) await openPatch(cwd, chosenPatch, byId('changes-list').querySelector('[aria-current=true]'));
  } catch (error) {
    if (epoch === gitEpoch && cwd === reviewCwd()) noteChanges(error.message);
  } finally {
    if (gitBusyFor === cwd) gitBusyFor = undefined;
  }
}

async function openPatch(cwd, entry, row) {
  const patch = { ...entry, cwd, selected: new Map() };
  chosenPatch = patch;
  const area = byId('patch-lines');
  area.replaceChildren();
  byId('patch-title').textContent = entry.name;
  byId('patch-review').hidden = false;
  byId('attach-diff').disabled = true;
  for (const file of byId('changes-list').children) file.setAttribute('aria-current', String(file === row));
  let content;
  try { content = await api.gitDiff(cwd, entry.name, entry.kind); }
  catch (error) { if (chosenPatch === patch) area.textContent = error.message; return; }
  if (chosenPatch !== patch || cwd !== reviewCwd()) return;
  let oldLine, newLine;
  const fragment = document.createDocumentFragment();
  const lines = content.split(/\r?\n/);
  for (const [index, text] of lines.slice(0, 2500).entries()) {
    const hunk = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(text);
    const code = text[0];
    let number;
    if (hunk) {
      oldLine = Number(hunk[1]);
      newLine = Number(hunk[2]);
    } else if (oldLine !== undefined) {
      if (code === '-') number = '−' + oldLine++;
      if (code === '+') number = '+' + newLine++;
      if (code === ' ') { oldLine++; number = String(newLine++); }
    }
    const line = document.createElement(number ? 'button' : 'div');
    line.className = 'patch-row' + (number && code === '+' ? ' add' : number && code === '-' ? ' remove' : '');
    const gutter = document.createElement('span');
    gutter.textContent = number ?? '';
    const body = document.createElement('span');
    body.textContent = text;
    line.append(gutter, body);
    if (number) {
      line.type = 'button';
      line.setAttribute('aria-pressed', 'false');
      line.onclick = () => {
        if (patch.selected.has(index)) patch.selected.delete(index);
        else patch.selected.set(index, number + '  ' + text);
        line.setAttribute('aria-pressed', String(patch.selected.has(index)));
        byId('attach-diff').disabled = !selectedTask || !patch.selected.size;
      };
    }
    fragment.append(line);
  }
  if (lines.length > 2500) {
    const note = document.createElement('p');
    note.textContent = '처음 2,500줄을 표시합니다.';
    fragment.append(note);
  }
  area.append(fragment);
}

byId('attach-diff').onclick = () => {
  if (!selectedTask || !chosenPatch?.selected.size) return;
  const excerpt = [...chosenPatch.selected].sort((a, b) => a[0] - b[0]).map(([, line]) => line).join('\n');
  const input = byId('chat-input');
  input.value += (input.value.trim() ? '\n\n' : '') + '검토 대상: ' + chosenPatch.name + '\n' + excerpt + '\n\n검토 메모: ';
  input.focus();
  input.setSelectionRange(input.value.length, input.value.length);
  scheduleChat();
};
byId('expand-diff').onclick = () => {
  byId('expand-diff').setAttribute('aria-pressed', String(document.body.classList.toggle('diff-wide')));
};
byId('refresh-git').onclick = () => refreshGit(true);
setInterval(() => refreshGit(), 3500);
tasksSidebar();
const previousTask = tasks.find(task => task.id === localStorage.getItem('agent-last-task'));
if (previousTask) chooseTask(previousTask);
else renderEmptyTask();

function renderEmptyTask() {
  byId('chat-feed').replaceChildren();
  const empty = document.createElement('p');
  empty.className = 'chat-empty';
  empty.textContent = '새 작업을 열어 Codex에 요청하거나, 터미널에서 기존 세션을 사용하세요.';
  byId('chat-feed').append(empty);
}
