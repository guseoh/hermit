// 자동 업데이트 상태: 렌더러를 다시 불러와도(F5) "업데이트 준비됨" 표시를 되살리도록 받아 둔 버전을 알려 준다.
// 설치(update-install)와 종료 안내는 main.cjs의 updater 쪽에 있다.
const updatePrompt = require('../update-prompt.cjs');

module.exports = ({ handle, app }) => {
  handle('update-state', () => ({ version: updatePrompt.state.version, packaged: app.isPackaged }));
};
