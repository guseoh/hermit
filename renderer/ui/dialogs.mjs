// 공용 확인 대화상자. window.confirm 대신 앱 스타일로 대상·결과를 보여 주고 Esc로 취소한다.
// 사용: if (!await confirmAction({ title, target, result, confirmLabel, danger })) return;
const dialog = document.getElementById('confirm-dialog');
const title = document.getElementById('confirm-title');
const rows = document.getElementById('confirm-details');
const note = document.getElementById('confirm-note');
const accept = document.getElementById('confirm-accept');
const cancel = document.getElementById('confirm-cancel');
let pending = null;

function settle(value) {
  const resolve = pending;
  pending = null;
  resolve?.(value);
}

function confirmAction({ title: heading, target, result, note: detail, confirmLabel = '계속', danger = false }) {
  if (pending) settle(false);
  title.textContent = heading;
  rows.replaceChildren();
  for (const [label, value] of [['대상', target], ['결과', result]]) {
    if (!value) continue;
    const term = document.createElement('dt');
    term.textContent = label;
    const description = document.createElement('dd');
    description.textContent = value;
    rows.append(term, description);
  }
  rows.hidden = !rows.childElementCount;
  note.textContent = detail ?? '';
  note.hidden = !detail;
  accept.textContent = confirmLabel;
  accept.className = danger ? 'danger' : '';
  dialog.returnValue = '';
  return new Promise(resolve => {
    pending = resolve;
    dialog.showModal();
    (danger ? cancel : accept).focus();
  });
}

// 결과는 승인(submit)·취소 버튼·Esc(cancel)에서 바로 정한다. 대화상자를 연 직후 곧바로 닫으면
// Chromium이 close 이벤트를 건너뛰는 경우가 있어, close는 놓친 경로를 위한 예비로만 쓴다.
dialog.querySelector('form').addEventListener('submit', event => settle(event.submitter === accept));
cancel.onclick = () => { settle(false); dialog.close('cancel'); };
dialog.addEventListener('cancel', () => settle(false));
dialog.addEventListener('close', () => { if (!dialog.open) settle(dialog.returnValue === 'ok'); });

window.confirmAction = confirmAction;
