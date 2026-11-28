// 터미널 프로필 탐지(PowerShell 7·WSL). 실행은 main.cjs의 'spawn'이 main/shells.cjs의 launchSpec으로 한다.
const shells = require('../shells.cjs');

module.exports = ({ handle }) => {
  handle('shell-profiles', async refresh => shells.profileEntries(await shells.detectShells({ refresh: refresh === true })));
};
