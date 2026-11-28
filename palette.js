// Command palette (Ctrl+Shift+P / F1): one searchable place for every workbench action,
// replacing the scattered quick-tools popover and sidebar shortcuts.
const palette = document.createElement('div');
palette.id = 'command-palette';
palette.popover = 'auto';
palette.setAttribute('role', 'dialog');
palette.setAttribute('aria-label', '명령 팔레트');
const paletteInput = document.createElement('input');
paletteInput.type = 'text';
paletteInput.spellcheck = false;
paletteInput.placeholder = '명령 또는 작업 이름 입력';
paletteInput.setAttribute('aria-label', '명령 검색');
paletteInput.setAttribute('role', 'combobox');
paletteInput.setAttribute('aria-controls', 'command-palette-list');
paletteInput.setAttribute('aria-expanded', 'true');
const paletteList = document.createElement('div');
paletteList.id = 'command-palette-list';
paletteList.setAttribute('role', 'listbox');
palette.append(paletteInput, paletteList);
document.body.append(palette);

const click = id => () => byId(id).click();
const reviewFolder = async () => projectDirectory(reviewCwd() ?? await api.home());

function paletteCommands() {
  const commands = [
    ['새로 만들기', '새 PowerShell 탭', 'Ctrl+T', 'powershell terminal shell 터미널 탭', () => newShellTab()],
    ['새로 만들기', '플로팅 터미널에 새 셸', 'Ctrl+Shift+`', 'powershell terminal floating 터미널 플로팅', () => newDockTerminal()],
    ['새로 만들기', '새 에이전트 작업…', 'Ctrl+N', 'task agent codex claude 작업 에이전트 채팅', () => newTask()],
    ['새로 만들기', '새 Markdown 노트', '', 'markdown note 노트 메모', () => newNote()],
    ['새로 만들기', '웹 미리보기 열기', '', 'web preview localhost 웹 미리보기', () => openPreviewPanel()],
    ['열기', 'Markdown 노트 열기…', '', 'markdown note open 노트', () => showMarkdownNotes()],
    ['열기', '프로젝트 폴더 추가…', '', 'project folder add 폴더 프로젝트', click('add-workspace')],
    ['보기', '프로젝트 사이드바 표시/숨기기', 'Ctrl+B', 'sidebar project toggle 사이드바', click('toggle-workspaces-panel')],
    ['보기', '작업 검토 패널 표시/숨기기', 'Ctrl+L', 'review panel toggle 검토', click('toggle-results-panel')],
    ['보기', '플로팅 터미널 열기/닫기', 'Ctrl+Alt+A','terminal floating toggle 터미널 플로팅', click('nav-floating-terminal')],
    ['보기', '플로팅 터미널을 탭으로 열기', '', 'terminal maximize tab 최대화 탭', click('expand-terminal')],
    ['열기', '현재 작업의 파일 빠른 열기', 'Ctrl+P', 'file open 소스 파일 검색', quickOpenFile],
    ['에이전트', '다음 승인·로그인 대기 작업', '', '승인 로그인 대기', focusWaitingTask],
    ['검토', '요청별 변경·검증 이력', '', 'history diff 검증 이력', () => showRequestHistory(actionTask())],
    ['검토', 'PR 피드백 수정 전후 확인', '', 'PR CI 리뷰 결과', () => showFeedbackHistory(actionTask())],
    ['검토', '변경사항 보기', '', 'git changes diff 변경', () => openReview('changes')],
    ['검토', '터미널 명령 결과 보기', '', 'results command output 결과 복사', () => openReview('results')],
    ['검토', '플래너 열기', '', 'planner 플래너 메모', () => showPlanner()],
    ['검토', 'GitHub Pull Request 보기', '', 'github pr pull request', () => openReview('github')],
    ['검토', '에이전트 현황 보기', '', 'agents status 에이전트', () => openAgentsBoard()],
    ['도구', 'Git worktree…', '', 'git worktree branch 브랜치', async () => showWorktrees(reviewCwd() ?? await api.home())],
    ['도구', '실행 프로필…', '', 'run profile script 실행', async () => showRunProfiles(await reviewFolder())],
    ['도구', '현재 터미널 배치 저장', '', 'layout save 배치 저장', saveWorkspaceLayout],
    ['도구', '저장된 터미널 배치 열기…', '', 'layout restore 배치', showWorkspaceLayouts],
    ['에이전트', '모델 선택', 'Ctrl+Shift+M', 'model 모델', () => openChatPicker('chat-model')],
    ['에이전트', '추론 수준 선택', 'Ctrl+Shift+E', 'effort reasoning 추론', () => openChatPicker('chat-effort')],
    ['에이전트', '작업으로 이동…', 'Ctrl+K', 'task switch 작업 이동', () => openPalette('tasks')],
    ['설정', '채팅 UI 설정…', '', 'settings chat 설정', click('open-chat-settings')],
    ['설정', '절전 방지 설정…', '', 'sleep power 절전', () => byId('sleep-menu').showPopover()],
    ['설정', '리소스 관리자', '', 'memory resource 메모리 리소스', () => byId('resource-menu').showPopover()]
  ].map(([group, label, keys, words, run]) => ({ group, label, keys, words, run }));
  for (const task of tasks) {
    commands.push({
      group: '작업으로 이동', taskId: task.id, label: task.name, keys: agentName(task),
      words: task.cwd + ' ' + agentName(task), detail: task.cwd,
      run: () => chooseTask(task)
    });
  }
  return commands;
}

let paletteItems = [];
let paletteIndex = 0;

function renderPalette() {
  const terms = paletteInput.value.trim().toLowerCase().split(/\s+/).filter(Boolean);
  paletteItems = paletteCommands().filter(command => paletteMode !== 'tasks' || command.group === '작업으로 이동').filter(command => {
    const haystack = (command.group + ' ' + command.label + ' ' + command.words).toLowerCase();
    return terms.every(term => haystack.includes(term));
  });
  if (paletteMode === 'tasks' && !paletteInput.value.trim() && priorTaskId && !closedTasks.has(priorTaskId)) {
    const previousIndex = paletteItems.findIndex(command => command.taskId === priorTaskId);
    if (previousIndex > 0) paletteItems.unshift(...paletteItems.splice(previousIndex, 1));
  }
  paletteIndex = Math.min(paletteIndex, Math.max(0, paletteItems.length - 1));
  paletteList.replaceChildren();
  let group;
  paletteItems.forEach((command, index) => {
    if (command.group !== group) {
      group = command.group;
      const heading = document.createElement('div');
      heading.className = 'palette-group';
      heading.textContent = group;
      paletteList.append(heading);
    }
    const item = document.createElement('div');
    item.className = 'palette-item';
    item.id = 'palette-item-' + index;
    item.setAttribute('role', 'option');
    item.setAttribute('aria-selected', String(index === paletteIndex));
    const label = document.createElement('span');
    label.textContent = command.label;
    item.append(label);
    if (command.detail) {
      const detail = document.createElement('small');
      detail.textContent = command.detail;
      item.append(detail);
    }
    if (command.keys) {
      const keys = document.createElement('kbd');
      keys.textContent = command.keys;
      item.append(keys);
    }
    item.onpointerdown = event => event.preventDefault();
    item.onclick = () => runPaletteCommand(index);
    paletteList.append(item);
  });
  if (!paletteItems.length) {
    const empty = document.createElement('p');
    empty.className = 'palette-empty';
    empty.textContent = '일치하는 명령이 없습니다.';
    paletteList.append(empty);
  }
  paletteInput.setAttribute('aria-activedescendant', paletteItems.length ? 'palette-item-' + paletteIndex : '');
  byId('palette-item-' + paletteIndex)?.scrollIntoView({ block: 'nearest' });
}

function runPaletteCommand(index) {
  const command = paletteItems[index];
  if (!command) return;
  palette.hidePopover();
  Promise.resolve().then(command.run).catch(report);
}

// mode 'tasks' (Ctrl+K) lists only tasks to jump to, like Orca's worktree switcher.
let paletteMode = 'all';
function openPalette(mode = 'all') {
  if (palette.matches(':popover-open') && paletteMode === mode) { palette.hidePopover(); return; }
  paletteMode = mode;
  paletteInput.placeholder = mode === 'tasks' ? '이동할 작업 이름 입력' : '명령 또는 작업 이름 입력';
  paletteInput.value = '';
  paletteIndex = 0;
  renderPalette();
  palette.showPopover();
  paletteInput.focus();
}

paletteInput.oninput = () => { paletteIndex = 0; renderPalette(); };
paletteInput.onkeydown = event => {
  if (event.isComposing) return;
  if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
    event.preventDefault();
    if (!paletteItems.length) return;
    paletteIndex = (paletteIndex + (event.key === 'ArrowDown' ? 1 : -1) + paletteItems.length) % paletteItems.length;
    renderPalette();
  } else if (event.key === 'Enter') {
    event.preventDefault();
    runPaletteCommand(paletteIndex);
  } else if (event.key === 'Escape') {
    event.preventDefault();
    palette.hidePopover();
  }
};
paletteInput.onblur = () => requestAnimationFrame(() => {
  if (!palette.contains(document.activeElement)) palette.hidePopover();
});

const paletteButton = byId('open-command-palette');
setPanelIcon(paletteButton, 'palette');
paletteButton.onclick = () => openPalette();
