// 도메인별 IPC 등록: 이 폴더의 *.cjs(index 제외)가 각자 handle(...)로 채널을 등록한다.
// Stage C부터 새 기능의 IPC는 main.cjs에 직접 넣지 않고 여기에 파일을 하나 더해, 여러 작업이
// main.cjs의 같은 자리를 고치지 않게 한다.
// 각 파일: module.exports = context => { context.handle('채널', (...args) => ...); };
// context: { handle, app, shell, dialog, getWindow, shellExe, changes, files, probe, send }
const fs = require('node:fs');
const path = require('node:path');

function registerAll(context) {
  const names = fs.readdirSync(__dirname).filter(name => name.endsWith('.cjs') && name !== 'index.cjs').sort();
  for (const name of names) {
    const register = require(path.join(__dirname, name));
    if (typeof register !== 'function') throw new Error('main/ipc/' + name + '는 함수를 내보내야 합니다.');
    register(context);
  }
  return names;
}

module.exports = { registerAll };
