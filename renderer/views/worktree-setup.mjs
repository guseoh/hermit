// worktree 환경 설정 화면과 작업 런처 연결(Stage C 트랙 2).
// - 프로젝트(저장소 루트)별: node_modules 등 정션 공유, 공유 폴더 목록, 만든 뒤 실행할 명령(postCreate)
// - 작업 런처: "새 브랜치와 worktree에서 작업" 아래에 이 저장소에 적용될 내용을 한 줄로 보여 준다.
// - workspace.js가 worktree를 만든 직후 prepare(created)를, 작업을 연 뒤 afterCreate(tasks)를 부른다.
import { configFor, saveConfig, parseDirs, validCommand, launcherSummary, resultSummary } from '../core/worktree-config.mjs';

const previews = new Map();
async function preview(folder, refresh = false) {
  const key = projectKey(folder);
  if (!refresh && previews.has(key)) return previews.get(key);
  const pending = api.worktreeSetupPreview(folder).catch(() => ({ repository: false }));
  previews.set(key, pending);
  const result = await pending;
  if (result.root) previews.set(projectKey(result.root), pending);
  setTimeout(() => previews.delete(key), 30000);
  return result;
}

function rootKey(found, folder) {
  return projectKey(found?.root ?? folder);
}

function showWorktreeSetup(folder) {
  const content = toolDialog('worktree 환경 설정');
  const state = toolElement('p', '저장소를 확인하는 중…', 'tool-muted');
  content.append(state);
  preview(folder, true).then(found => {
    if (!found.repository) {
      state.textContent = folder + ' — Git 저장소가 아니어서 worktree를 만들 수 없습니다.';
      return;
    }
    renderForm(content, state, found);
  }).catch(error => toolError(state, error));
}

function renderForm(content, state, found) {
  const key = rootKey(found);
  const config = configFor(localStorage, key);
  state.textContent = found.root;
  state.title = '이 설정은 이 저장소에서 만드는 모든 작업 worktree에 적용됩니다.';

  const include = toolElement('fieldset', '', 'worktree-setup-section');
  include.append(toolElement('legend', '.worktreeinclude 파일 복사'));
  include.append(toolElement('small', '저장소 루트의 .worktreeinclude(.gitignore와 같은 형식)에 맞는 파일 중 Git이 추적하지 않는 파일을 '
    + '새 worktree로 복사합니다. 이미 있는 파일은 덮어쓰지 않습니다. 파일당 5MB, 200개, 모두 20MB까지.'));
  const includeState = toolElement('p', !found.exists ? '.worktreeinclude가 없습니다. 예: .env, .env.local, config/*.local.json'
    : found.count ? '지금 복사될 파일 ' + found.count + '개' + (found.truncated ? ' 이상(제한에 걸림)' : '') : '패턴에 맞는 미추적 파일이 없습니다.', 'tool-muted');
  include.append(includeState);
  if (found.files?.length) {
    const list = toolElement('pre', found.files.join('\n') + (found.count > found.files.length ? '\n…' : ''), 'worktree-setup-files');
    include.append(list);
  }

  const share = toolElement('fieldset', '', 'worktree-setup-section');
  share.append(toolElement('legend', '폴더 공유(디렉터리 정션)'));
  const toggle = toolElement('label', '', 'worktree-setup-switch');
  const enabled = toolElement('input');
  enabled.type = 'checkbox';
  enabled.setAttribute('role', 'switch');
  enabled.checked = config.share;
  enabled.id = 'worktree-setup-share';
  toggle.append(enabled, toolElement('span', '원본 체크아웃의 폴더를 새 worktree에 정션으로 연결'));
  const dirsField = toolElement('label', '', 'approval-rules-field');
  const dirs = toolElement('textarea');
  dirs.id = 'worktree-setup-dirs';
  dirs.rows = 3;
  dirs.spellcheck = false;
  dirs.placeholder = 'node_modules\napps/web/node_modules';
  dirs.value = config.dirs.join('\n');
  dirsField.append(toolElement('span', '공유할 폴더(저장소 기준 상대 경로, 한 줄에 하나, 최대 10개)'), dirs);
  share.append(toggle, dirsField, toolElement('small', 'Git이 무시하는 폴더만 연결합니다. 정리할 때는 링크만 해제하고 원본 폴더는 지우지 않습니다. '
    + '공유하면 한 worktree의 설치·삭제가 원본과 다른 worktree에도 바로 반영됩니다.'));

  const hook = toolElement('fieldset', '', 'worktree-setup-section');
  hook.append(toolElement('legend', '만든 뒤 실행(postCreate)'));
  const commandField = toolElement('label', '', 'approval-rules-field');
  const command = toolElement('input');
  command.id = 'worktree-setup-command';
  command.spellcheck = false;
  command.maxLength = 500;
  command.placeholder = 'npm ci';
  command.value = config.postCreate;
  commandField.append(toolElement('span', 'PowerShell 명령 한 줄. 새 worktree 폴더의 터미널 탭에서 실행하고 출력을 보여 줍니다.'), command);
  hook.append(commandField);

  const feedback = toolElement('p', '', 'tool-error');
  feedback.hidden = true;
  feedback.setAttribute('role', 'alert');
  const save = button('저장', () => {
    const parsed = parseDirs(dirs.value);
    const problems = [];
    if (parsed.invalid.length) problems.push('쓸 수 없는 경로: ' + parsed.invalid.join(', '));
    if (parsed.overflow) problems.push('공유 폴더는 10개까지입니다.');
    if (enabled.checked && !parsed.dirs.length) problems.push('공유할 폴더를 하나 이상 적으세요.');
    if (!validCommand(command.value.trim())) problems.push('명령은 줄바꿈 없는 한 줄(500자 이하)로 적으세요.');
    if (problems.length) {
      feedback.textContent = problems.join('\n');
      feedback.hidden = false;
      return;
    }
    saveConfig(localStorage, key, { share: enabled.checked, dirs: parsed.dirs, postCreate: command.value.trim() });
    toolsDialog.close();
    refreshLauncher();
    status('worktree 환경 설정을 저장했습니다.');
  });
  save.className = 'primary';
  save.id = 'worktree-setup-save';
  const cancel = button('취소', () => toolsDialog.close());
  cancel.className = 'ghost';
  const actions = toolElement('div', '', 'actions');
  actions.append(cancel, save);
  content.append(include, share, hook, feedback, actions);
  enabled.focus();
}

// ── 작업 런처 요약 ──────────────────────────────────────────────
const launcherNote = toolElement('div', '', 'task-worktree-setup');
launcherNote.id = 'task-worktree-setup';
const launcherText = toolElement('small');
const launcherEdit = button('환경 설정…', () => showWorktreeSetup(chosenFolder));
launcherEdit.className = 'ghost';
launcherEdit.type = 'button';
launcherNote.append(launcherText, launcherEdit);
launcherNote.hidden = true;
byId('task-dialog').querySelector('.task-worktree-note')?.after(launcherNote);

let launcherEpoch = 0;
async function refreshLauncher() {
  const epoch = ++launcherEpoch;
  const folder = chosenFolder;
  const dialog = byId('task-dialog');
  if (!dialog.open || !folder || !(byId('task-worktree').checked || byId('task-compare').checked)) { launcherNote.hidden = true; return; }
  const found = await preview(folder);
  if (epoch !== launcherEpoch) return;
  if (!found.repository) { launcherNote.hidden = true; return; }
  const summary = launcherSummary(configFor(localStorage, rootKey(found, folder)), found);
  launcherText.textContent = summary || '복사·공유·실행할 내용 없음';
  launcherNote.dataset.empty = String(!summary);
  launcherNote.hidden = false;
}
new MutationObserver(() => refreshLauncher().catch(() => {})).observe(byId('task-dialog'), { attributes: true, attributeFilter: ['open'] });
new MutationObserver(() => refreshLauncher().catch(() => {})).observe(byId('task-cwd'), { childList: true, characterData: true, subtree: true });
for (const id of ['task-worktree', 'task-compare']) byId(id).addEventListener('change', () => refreshLauncher().catch(() => {}));

// ── 생성 직후 연결 ──────────────────────────────────────────────
// worktree를 만든 직후(에이전트를 연결하기 전) 파일 복사·정션 연결. 실패해도 작업 생성은 계속한다.
async function prepare(created) {
  const config = configFor(localStorage, projectKey(created.root));
  try {
    return { ...(await api.worktreeSetupApply(created.root, created.path, { share: config.share, dirs: config.dirs })), postCreate: config.postCreate };
  } catch (error) {
    return { error: ipcMessage(error), postCreate: config.postCreate };
  }
}

// 작업을 연 뒤: 결과 알림, postCreate 명령을 그 worktree의 PowerShell 탭에서 실행(채팅 탭은 앞에 둔다).
async function afterCreate(planned) {
  for (const entry of planned) {
    const setup = entry.setup;
    if (!setup || !entry.worktree) continue;
    const summary = resultSummary(setup);
    if (summary) toast(entry.name + ' · ' + summary, { kind: setup.error ? 'warn' : 'info' });
    if (!setup.postCreate) continue;
    try {
      const area = workArea(primaryChatPanel);
      const pane = await openWorkspace(entry.worktree.path, 'shell', undefined, undefined, area, false);
      if (!pane?.running) throw new Error('PowerShell을 시작하지 못했습니다.');
      renameTab(pane.tab, 'postCreate · ' + entry.name);
      await api.input(pane.id, setup.postCreate + '\r');
      toast('새 worktree에서 실행 중: ' + setup.postCreate, { action: { label: '터미널 보기', run: () => activateWorkAreaTab(pane.tab) } });
    } catch (error) {
      toast('postCreate 명령을 실행하지 못했습니다: ' + ipcMessage(error), { kind: 'warn' });
    }
  }
}

// 프로젝트 행 우클릭 메뉴: worktree 환경 설정…
const projectMenu = toolElement('div', '', 'status-menu project-context-menu');
projectMenu.popover = 'auto';
projectMenu.id = 'project-context-menu';
document.body.append(projectMenu);
byId('task-list').addEventListener('contextmenu', event => {
  const heading = event.target.closest?.('.project-heading');
  const folder = heading?.querySelector('button[title]')?.title;
  if (!folder) return;
  event.preventDefault();
  projectMenu.replaceChildren(button('worktree 환경 설정…', () => { projectMenu.hidePopover(); showWorktreeSetup(folder); }));
  projectMenu.style.left = Math.min(event.clientX, innerWidth - 240) + 'px';
  projectMenu.style.top = Math.min(event.clientY, innerHeight - 60) + 'px';
  projectMenu.showPopover();
  projectMenu.querySelector('button')?.focus();
});

window.worktreeSetup = { prepare, afterCreate, refreshLauncher };
window.showWorktreeSetup = showWorktreeSetup;
