// 받아 둔 업데이트가 있을 때 앱을 끄면 설치가 조용히(/S) 진행돼 사용자가 알아차리지 못한다.
// 종료 직전에 "설치하고 다시 시작 / 설치하고 종료 / 취소"를 물어 설치가 일어난다는 것을 보여 준다.
// Electron에 의존하지 않는 판단·문구만 여기에 두고 단위 테스트한다(main.cjs가 dialog로 띄운다).

// 종료를 물어볼지: 받아 둔 버전이 있고, 이미 정하지 않았고, Windows 종료·로그오프 중이 아닐 때만.
function askOnQuit({ pending, available, decided, systemEnding } = {}) {
  return !!(available && typeof pending === 'string' && pending && !decided && !systemEnding);
}

// cancelable: 창이 아직 있어 종료를 취소할 수 있는지(창이 이미 닫혔으면 취소는 의미가 없다).
function quitDialog(version, cancelable = true) {
  const label = version ? 'v' + version : '새 버전';
  const buttons = ['설치하고 다시 시작', '설치하고 종료'];
  const choices = ['restart', 'install'];
  if (cancelable) { buttons.push('취소'); choices.push('cancel'); }
  return {
    options: {
      type: 'info',
      title: 'Hermit 업데이트',
      message: label + ' 업데이트를 받아 두었습니다.',
      detail: '종료하면 업데이트를 설치합니다. 설치에는 몇 초에서 1분쯤 걸리고 진행 창은 따로 뜨지 않습니다.\n'
        + '"설치하고 다시 시작"을 고르면 설치가 끝난 뒤 Hermit을 새 버전으로 다시 엽니다.',
      buttons,
      defaultId: 0,
      cancelId: cancelable ? buttons.length - 1 : 1,
      noLink: true
    },
    choices
  };
}

function choiceAt(dialog, response) {
  return dialog.choices[response] ?? (dialog.choices.includes('cancel') ? 'cancel' : 'install');
}

// 받아 둔 버전(main.cjs가 update-downloaded에서 채운다). main/ipc/updates.cjs가 렌더러에 알려 준다.
const state = { version: '' };

module.exports = { askOnQuit, quitDialog, choiceAt, state };
