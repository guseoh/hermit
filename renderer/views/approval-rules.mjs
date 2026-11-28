// 승인 규칙 관리: 전역과 현재 프로젝트의 명령 접두사 허용·거부 목록을 한 줄에 하나씩 편집한다.
// 거부가 허용보다 우선하고, `tool:이름`은 Claude의 명령 아닌 도구(Edit, Write 등)를 뜻한다.
function rulesEditor(title, hint, entry) {
  const box = toolElement('fieldset', '', 'approval-rules-scope');
  box.append(toolElement('legend', title));
  if (hint) box.append(toolElement('small', hint));
  const fields = {};
  for (const [list, label] of [['allow', '묻지 않고 허용'], ['deny', '항상 거절']]) {
    const field = toolElement('label', '', 'approval-rules-field');
    const area = toolElement('textarea');
    area.rows = 4;
    area.spellcheck = false;
    area.dataset.rules = list;
    area.placeholder = list === 'allow' ? 'npm test\ngit status\ntool:Edit' : 'git push\nRemove-Item';
    area.value = entry[list].join('\n');
    field.append(toolElement('span', label), area);
    box.append(field);
    fields[list] = area;
  }
  return { box, read: () => Object.fromEntries(Object.entries(fields).map(([list, area]) =>
    [list, [...new Set(area.value.split('\n').map(line => line.trim()).filter(Boolean))]])) };
}

function showApprovalRules(task = actionTask()) {
  const content = toolDialog('승인 규칙');
  const policy = loadApprovalPolicy();
  content.append(toolElement('p', '에이전트가 명령 실행 승인을 요청하면 이 규칙과 먼저 비교합니다. 한 줄에 접두사 하나씩 적고, '
    + '"npm test"는 "npm test -- --watch"에도 맞습니다. 거절 규칙이 허용보다 우선하고, &&·;·|로 이어진 명령은 모든 부분이 허용될 때만 허용합니다.', 'approval-rules-intro'));
  const editors = [];
  if (task) {
    const key = taskProjectKey(task);
    const root = task.worktree?.root ?? task.handoffRoot ?? task.cwd;
    const editor = rulesEditor('이 프로젝트 · ' + (root.split(/[\\/]/).filter(Boolean).at(-1) ?? root), root + ' (이 저장소의 worktree 작업에도 적용)',
      policy.projects[key] ?? { allow: [], deny: [] });
    editors.push([editor, next => { next.projects[key] = editor.read(); }]);
  }
  const global = rulesEditor('전역', '모든 프로젝트에 적용합니다.', policy.global);
  editors.push([global, next => { next.global = global.read(); }]);
  content.append(...editors.map(([editor]) => editor.box));
  const save = button('저장', () => {
    const next = loadApprovalPolicy();
    for (const [, apply] of editors) apply(next);
    saveApprovalPolicy(next);
    toolsDialog.close();
    status('승인 규칙을 저장했습니다.');
  });
  save.className = 'primary';
  const actions = toolElement('div', '', 'actions');
  actions.append(button('취소', () => toolsDialog.close()), save);
  actions.firstElementChild.className = 'ghost';
  content.append(actions);
  content.querySelector('textarea')?.focus();
}

window.showApprovalRules = showApprovalRules;
