// 종료 시 업데이트 안내(main/update-prompt.cjs): 언제 묻는지, 어떤 선택지를 주는지.
const test = require('node:test');
const assert = require('node:assert/strict');
const { askOnQuit, quitDialog, choiceAt } = require('../main/update-prompt.cjs');

test('받아 둔 업데이트가 있고 아직 정하지 않았을 때만 종료를 묻는다', () => {
  assert.equal(askOnQuit({ pending: '0.1.9', available: true }), true);
  assert.equal(askOnQuit({ pending: '', available: true }), false, '받은 업데이트 없음');
  assert.equal(askOnQuit({ pending: '0.1.9', available: false }), false, 'updater 없음(개발 실행)');
  assert.equal(askOnQuit({ pending: '0.1.9', available: true, decided: true }), false, '이미 고름·지금 설치 중');
  assert.equal(askOnQuit({ pending: '0.1.9', available: true, systemEnding: true }), false, 'Windows 종료 중에는 막지 않는다');
  assert.equal(askOnQuit(), false);
});

test('종료 안내는 다시 시작을 기본으로, 창이 있을 때만 취소를 준다', () => {
  const dialog = quitDialog('0.1.9');
  assert.match(dialog.options.message, /v0\.1\.9/);
  assert.deepEqual(dialog.choices, ['restart', 'install', 'cancel']);
  assert.equal(dialog.options.buttons.length, 3);
  assert.equal(dialog.options.defaultId, 0);
  assert.equal(choiceAt(dialog, dialog.options.cancelId), 'cancel');
  assert.equal(choiceAt(dialog, 0), 'restart');
  assert.equal(choiceAt(dialog, 1), 'install');
  assert.equal(choiceAt(dialog, 9), 'cancel', '알 수 없는 응답은 취소로');

  const closed = quitDialog('', false);
  assert.deepEqual(closed.choices, ['restart', 'install']);
  assert.match(closed.options.message, /새 버전/);
  assert.equal(choiceAt(closed, closed.options.cancelId), 'install', '창이 없으면 Esc는 그냥 설치하고 종료');
  assert.equal(choiceAt(closed, 7), 'install');
});
