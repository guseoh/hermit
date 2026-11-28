// 추가 터미널 프로필(main/shells.cjs)과, prompt.ps1이 Windows PowerShell 5.1과 PowerShell 7 모두에서 같은 표시를 내는지.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const shells = require('../main/shells.cjs');

test('pwsh 후보: PATH 먼저, 그다음 MSI 위치와 Store 별칭, 중복 없이', () => {
  const list = shells.pwshCandidates({
    PATH: 'C:\\Tools;"C:\\Program Files\\PowerShell\\7";relative\\dir;;C:\\tools',
    ProgramFiles: 'C:\\Program Files', LOCALAPPDATA: 'C:\\Users\\me\\AppData\\Local'
  });
  assert.deepEqual(list, [
    'C:\\Tools\\pwsh.exe',
    'C:\\Program Files\\PowerShell\\7\\pwsh.exe',
    'C:\\Program Files\\PowerShell\\7-preview\\pwsh.exe',
    'C:\\Users\\me\\AppData\\Local\\Microsoft\\WindowsApps\\pwsh.exe'
  ]);
});

test('pwsh 버전은 7 이상만 받는다', () => {
  assert.equal(shells.parsePwshVersion('7.7.0\r\n'), '7.7.0');
  assert.equal(shells.parsePwshVersion('7.5.0-preview.3'), '7.5.0-preview.3');
  assert.equal(shells.parsePwshVersion('6.2.7'), null);
  assert.equal(shells.parsePwshVersion(null), null);
});

test('wsl --list --quiet(UTF-16LE)에서 배포판 이름만, Docker Desktop 내부 배포판은 뺀다', () => {
  const output = Buffer.from('\uFEFFUbuntu\r\ndocker-desktop\r\nDebian\r\ndocker-desktop-data\r\n\r\n', 'utf16le');
  assert.deepEqual(shells.parseWslList(output), ['Ubuntu', 'Debian']);
  assert.deepEqual(shells.parseWslList(Buffer.from('Ubuntu-22.04\n', 'utf8')), ['Ubuntu-22.04']);
  assert.deepEqual(shells.parseWslList(Buffer.from('Windows Subsystem for Linux has no installed distributions.\r\n', 'utf16le')), [], '안내 문장은 이름이 아니다');
  assert.deepEqual(shells.parseWslList(''), []);
});

test('실행 사양: pwsh는 prompt.ps1을 Bypass로, WSL은 찾은 배포판만', () => {
  const found = { pwsh: { file: 'C:\\pwsh.exe', version: '7.7.0' }, wsl: { file: 'C:\\Windows\\System32\\wsl.exe', distros: ['Ubuntu'] } };
  assert.deepEqual(shells.launchSpec('pwsh', undefined, 'C:\\app\\prompt.ps1', found),
    { file: 'C:\\pwsh.exe', args: ['-NoLogo', '-ExecutionPolicy', 'Bypass', '-NoExit', '-File', 'C:\\app\\prompt.ps1'] });
  assert.deepEqual(shells.launchSpec('wsl', 'Ubuntu', 'x', found), { file: found.wsl.file, args: ['-d', 'Ubuntu'] });
  assert.deepEqual(shells.launchSpec('wsl', undefined, 'x', found).args, ['-d', 'Ubuntu'], '배포판을 안 주면 첫 번째');
  assert.throws(() => shells.launchSpec('wsl', 'Ubuntu; rm -rf /', 'x', found), /알 수 없는 WSL/);
  assert.throws(() => shells.launchSpec('pwsh', undefined, 'x', { pwsh: null, wsl: null }), /PowerShell 7/);
  assert.throws(() => shells.launchSpec('wsl', 'Ubuntu', 'x', { pwsh: null, wsl: null }), /WSL/);
  assert.throws(() => shells.launchSpec('cmd', undefined, 'x', found), /Unknown/);
  assert.deepEqual(shells.profileEntries(found), [
    { launcher: 'pwsh', name: 'PowerShell 7', detail: '7.7.0' },
    { launcher: 'wsl', name: 'WSL · Ubuntu', detail: 'Ubuntu', option: 'Ubuntu' }
  ]);
  assert.deepEqual(shells.profileEntries({ pwsh: null, wsl: null }), []);
});

// prompt.ps1을 불러와 명령 하나를 기록한 것처럼 만든 뒤 prompt 출력에 작업 폴더·명령 표시(OSC 777)가 있는지 본다.
const windowsPowerShell = path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
const pwsh = process.platform === 'win32' ? shells.pwshCandidates().find(file => shells.present(file)) : undefined;
const promptCheck = '. $env:WORKBENCH_PROMPT; $null = prompt; ' +
  "Add-History -ErrorAction SilentlyContinue -InputObject ([pscustomobject]@{ CommandLine = 'echo hi'; ExecutionStatus = 'Completed'; " +
  'StartExecutionTime = (Get-Date).AddMilliseconds(-250); EndExecutionTime = (Get-Date) }); ' +
  'if (-not $?) { $global:WorkbenchLastHistoryId = 0; $null = Get-Location }; ' +
  '$text = prompt; $last = (Get-History -Count 1).CommandLine; ' +
  '[Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($text)) + \' \' + [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($last))';
function promptOutput(exe) {
  const encoded = execFileSync(exe, ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', promptCheck], {
    encoding: 'utf8', windowsHide: true, timeout: 30000,
    env: { ...process.env, WORKBENCH_PROMPT: path.join(__dirname, '..', 'prompt.ps1') }
  }).trim().split(' ');
  return encoded.map(part => Buffer.from(part, 'base64').toString('utf8'));
}
for (const [label, exe] of [['Windows PowerShell 5.1', windowsPowerShell], ['PowerShell 7', pwsh]]) {
  test('prompt.ps1 셸 통합: ' + label, { skip: !(exe && process.platform === 'win32' && (exe === pwsh || fs.existsSync(exe))) && label + '이 없습니다' }, () => {
    // 5.1은 -Command 줄 자체도 기록에 넣으므로, 기대값은 셸이 보고한 마지막 기록이다.
    const [output, lastCommand] = promptOutput(exe);
    assert.ok(lastCommand, '기록된 명령');
    const directory = /\x1b\]777;workbench-directory;([A-Za-z0-9+/=]*)\x07/.exec(output);
    assert.ok(directory, JSON.stringify(output));
    assert.ok(Buffer.from(directory[1], 'base64').toString('utf8').length > 2, '작업 폴더');
    const marker = /\x1b\]777;workbench-prompt;([A-Za-z0-9+/=]+);([01]);(\d+)\x07/.exec(output);
    assert.ok(marker, JSON.stringify(output));
    assert.equal(Buffer.from(marker[1], 'base64').toString('utf8'), lastCommand);
    assert.equal(marker[2], '1');
    if (lastCommand === 'echo hi') assert.ok(Number(marker[3]) >= 200, '실행 시간(ms)');
    assert.match(output, /PS .*> ?$/, '원래 프롬프트가 뒤에 붙는다');
  });
}
