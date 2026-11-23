// 설치본 설정과 스크립트 경로(paths.cjs) 테스트.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { script, unpackedDirectory } = require('../paths.cjs');
const pkg = require('../package.json');

test('스크립트 경로는 앱 폴더의 .ps1을 가리키고, 실제로 있다', () => {
  for (const name of ['prompt.ps1', 'agent-hook.ps1', 'agent-probe.ps1', 'codex-server.ps1']) {
    assert.equal(script(name), path.join(unpackedDirectory, name));
    assert.ok(fs.existsSync(script(name)), name);
  }
});

test('asar 안이라면 app.asar.unpacked로 바꾼다', () => {
  const mapped = 'C:\\App\\resources\\app.asar\\main.cjs'.replace(/app\.asar(?=[\\/]|$)/, 'app.asar.unpacked');
  assert.equal(mapped, 'C:\\App\\resources\\app.asar.unpacked\\main.cjs');
  assert.equal('C:\\x\\app.asarx'.replace(/app\.asar(?=[\\/]|$)/, 'app.asar.unpacked'), 'C:\\x\\app.asarx', '비슷한 이름은 그대로');
});

test('설치본 설정: asar 끔, node-pty 재빌드 안 함, 테스트·문서는 빼고, GitHub로 업데이트', () => {
  assert.equal(pkg.build.asar, false);
  assert.equal(pkg.build.npmRebuild, false);
  for (const pattern of ['!test/**', '!docs/**', '!profile/**', '!dist/**']) assert.ok(pkg.build.files.includes(pattern), pattern);
  assert.deepEqual(pkg.build.publish[0], { provider: 'github', owner: 'guseoh', repo: 'hermit-releases', releaseType: 'release' });
  assert.ok(pkg.dependencies['electron-updater'], '자동 업데이트는 실행 의존성');
  assert.match(pkg.dependencies['electron-updater'], /^\d/, '버전 고정');
});

test('앱 데이터 폴더를 예전 이름으로 고정한다', () => {
  const main = fs.readFileSync(path.join(__dirname, '..', 'main.cjs'), 'utf8');
  assert.match(main, /app\.setPath\('userData', [^\n]*path\.join\(app\.getPath\('appData'\), 'powershell-workbench'\)\)/);
  // 시험용 데이터 폴더(AGENT_WORKBENCH_PROFILE)는 개발 실행에서만 쓴다. 설치본은 항상 예전 폴더.
  assert.match(main, /const profileOverride = !app\.isPackaged && process\.env\.AGENT_WORKBENCH_PROFILE;/);
  assert.ok(main.indexOf("app.setPath('userData'") < main.indexOf('requestSingleInstanceLock'), '단일 실행 잠금보다 먼저');
});
