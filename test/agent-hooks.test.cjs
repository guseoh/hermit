// 터미널 에이전트 상태 알림(agent-hooks.cjs + agent-hook.ps1) 테스트. 실제 PowerShell 스크립트로 파이프에 보낸다.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFile } = require('node:child_process');
const { createHookServer, claudeSettings } = require('../agent-hooks.cjs');

const script = path.join(__dirname, '..', 'agent-hook.ps1');
const powershell = path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
const windows = process.platform === 'win32' && fs.existsSync(powershell);
let directory;
let server;
const received = [];
const open = new Set(['pane-1']);

before(() => {
  directory = fs.mkdtempSync(path.join(os.tmpdir(), 'workbench-hooks-'));
  server = createHookServer({ directory, script, isPane: id => open.has(id), onEvent: (...args) => received.push(args) });
});
after(() => { server.close(); fs.rmSync(directory, { recursive: true, force: true }); });

function runHook(event, env, extra = []) {
  return new Promise(resolve => execFile(powershell, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', script, event, ...extra],
    { env: { ...process.env, ...env }, windowsHide: true, timeout: 20000 }, (error, stdout) => resolve({ code: error?.code ?? 0, stdout })));
}
const until = async (check, limit = 4000) => { const start = Date.now(); while (!check() && Date.now() - start < limit) await new Promise(r => setTimeout(r, 50)); return check(); };

test('Claude 설정 파일에 세 가지 hook이 들어가고, 작업 폴더가 아니라 앱 데이터 폴더에 만든다', () => {
  const settings = JSON.parse(fs.readFileSync(server.settingsFile, 'utf8'));
  assert.deepEqual(Object.keys(settings.hooks).sort(), ['Notification', 'Stop', 'UserPromptSubmit']);
  assert.match(settings.hooks.Stop[0].hooks[0].command, /agent-hook\.ps1" claude-stop$/);
  assert.equal(path.dirname(server.settingsFile), directory);
  assert.deepEqual(claudeSettings('C:\\a b\\hook.ps1').hooks.Stop[0].hooks[0].command,
    'powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "C:/a b/hook.ps1" claude-stop');
});

test('맞는 토큰·열린 터미널의 상태만 받는다', { skip: !windows && 'Windows 전용' }, async () => {
  const result = await runHook('claude-stop', server.env('pane-1'));
  assert.equal(result.code, 0);
  assert.equal(result.stdout.trim(), '', 'hook은 아무것도 출력하지 않는다');
  assert.ok(await until(() => received.length === 1));
  assert.deepEqual(received[0], ['pane-1', 'done', 'claude-stop']);

  await runHook('claude-prompt', { ...server.env('pane-1'), WORKBENCH_HOOK_TOKEN: 'wrong' });
  await runHook('claude-prompt', server.env('pane-closed'));
  await runHook('unknown-event', server.env('pane-1'));
  await new Promise(r => setTimeout(r, 800));
  assert.equal(received.length, 1, '틀린 토큰·닫힌 터미널·모르는 이벤트는 무시');
});

test('Codex notify처럼 JSON 인자가 더 붙어도 받는다', { skip: !windows && 'Windows 전용' }, async () => {
  received.length = 0;
  await runHook('codex-turn', server.env('pane-1'), ['{"type":"agent-turn-complete","last-assistant-message":"done"}']);
  assert.ok(await until(() => received.length === 1));
  assert.deepEqual(received[0], ['pane-1', 'done', 'codex-turn']);
});

test('앱 밖(환경 변수 없음)에서 불리면 조용히 끝난다', { skip: !windows && 'Windows 전용' }, async () => {
  const env = { ...process.env };
  delete env.WORKBENCH_HOOK_PIPE;
  const result = await new Promise(resolve => execFile(powershell, ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', script, 'claude-stop'],
    { env, windowsHide: true }, (error, stdout) => resolve({ code: error?.code ?? 0, stdout })));
  assert.deepEqual(result, { code: 0, stdout: '' });
});
