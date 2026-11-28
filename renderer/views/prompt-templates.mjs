// 프롬프트 템플릿 관리: 내 템플릿을 추가·수정·삭제한다. 기본 템플릿과 이름이 같으면 내 것이 대신 쓰인다.
// 입력창 첫머리에서 /이름 또는 제목으로 고르면 본문이 들어가고, 본문의 첫 "항목: " 줄 끝에 커서가 놓인다.
const namePattern = /^[a-z][a-z0-9-]{0,30}$/;

function templateEditor(entry, onRemove) {
  const box = toolElement('fieldset', '', 'template-editor');
  const head = toolElement('div', '', 'template-editor-head');
  const name = toolElement('input');
  name.value = entry.name ?? '';
  name.placeholder = '이름 (영문, 예: deploy)';
  name.setAttribute('aria-label', '템플릿 이름');
  name.spellcheck = false;
  const title = toolElement('input');
  title.value = entry.title ?? '';
  title.placeholder = '제목 (예: 배포 점검)';
  title.setAttribute('aria-label', '템플릿 제목');
  const remove = button('삭제', onRemove);
  remove.className = 'ghost';
  head.append(name, title, remove);
  const body = toolElement('textarea');
  body.rows = 4;
  body.value = entry.body ?? '';
  body.placeholder = '본문. "대상: "처럼 콜론으로 끝나는 줄에 커서가 놓입니다.';
  body.setAttribute('aria-label', '템플릿 본문');
  box.append(head, body);
  return { box, read: () => ({ name: name.value.trim().toLowerCase(), title: title.value.trim(), body: body.value.replace(/\s+$/, '') }) };
}

function showPromptTemplates() {
  const content = toolDialog('프롬프트 템플릿');
  content.append(toolElement('p', '입력창 첫머리에서 /이름이나 제목(예: /버그)을 입력해 고릅니다. 내 템플릿은 이 PC에만 저장됩니다.', 'approval-rules-intro'));
  const list = toolElement('div', '', 'template-list');
  const editors = [];
  const add = entry => {
    const editor = templateEditor(entry, () => {
      editors.splice(editors.indexOf(editor), 1);
      editor.box.remove();
    });
    editors.push(editor);
    list.append(editor.box);
    return editor;
  };
  for (const entry of customTemplates()) add(entry);
  const error = toolElement('p', '', 'tool-error');
  error.hidden = true;
  const create = button('템플릿 추가', () => add({ name: '', title: '', body: '' }).box.querySelector('input').focus());
  const builtIns = toolElement('details');
  builtIns.append(toolElement('summary', '기본 템플릿 (' + composerAssist.templates.length + ')'));
  for (const template of composerAssist.templates) {
    builtIns.append(toolElement('strong', '/' + template.name + ' · ' + template.title), toolElement('pre', template.body));
  }
  const save = button('저장', () => {
    const next = editors.map(editor => editor.read()).filter(entry => entry.name || entry.body);
    const invalid = next.find(entry => !namePattern.test(entry.name) || !entry.body.trim());
    const names = next.map(entry => entry.name);
    if (invalid) { error.textContent = '이름은 영문 소문자로 시작하는 32자 이하(영문·숫자·-)여야 하고, 본문이 있어야 합니다: ' + (invalid.name || '(이름 없음)'); error.hidden = false; return; }
    if (new Set(names).size !== names.length) { error.textContent = '같은 이름의 템플릿이 있습니다.'; error.hidden = false; return; }
    localStorage.setItem(promptTemplatesKey, JSON.stringify(next));
    toolsDialog.close();
    status('프롬프트 템플릿을 저장했습니다.');
  });
  save.className = 'primary';
  const cancel = button('취소', () => toolsDialog.close());
  cancel.className = 'ghost';
  const actions = toolElement('div', '', 'actions');
  actions.append(create, cancel, save);
  content.append(list, error, builtIns, actions);
}

window.showPromptTemplates = showPromptTemplates;
