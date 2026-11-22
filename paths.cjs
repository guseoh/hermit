// 앱 파일 경로. 지금 설치본은 asar로 묶지 않는다(package.json의 build.asar=false): node-pty의 출력 워커와
// PowerShell(.ps1)이 asar 안의 파일을 읽지 못하기 때문이다. 나중에 asar를 다시 켜더라도 .ps1은
// app.asar.unpacked에서 읽도록 경로를 바꿔 둔다.
const path = require('node:path');

const unpackedDirectory = __dirname.replace(/app\.asar(?=[\\/]|$)/, 'app.asar.unpacked');

function script(name) {
  return path.join(unpackedDirectory, name);
}

module.exports = { script, unpackedDirectory };
