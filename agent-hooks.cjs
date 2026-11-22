// 터미널에서 직접 돌리는 에이전트(TUI)의 상태를 받는다. Orca처럼 작업 목록의 상태 점과 알림이 TUI에서도 동작하게 한다.
//  - 앱 시작 때 이름 있는 파이프를 열고, 앱이 띄운 에이전트 터미널에만 파이프 이름·일회용 토큰·터미널 ID를 환경 변수로 준다.
//  - Claude Code는 --settings로 hooks(UserPromptSubmit·Notification·Stop)를, Codex는 -c notify=[...]를 넣는다.
//    둘 다 작업 폴더의 설정 파일은 건드리지 않는다.
//  - hook은 agent-hook.ps1을 실행해 {token, pane, event} 한 줄을 보낸다. 토큰과 터미널 ID가 맞을 때만 받는다.
const net = require('node:net');
const fs = require('node:fs');
const path = require('node:path');
const { randomBytes, timingSafeEqual } = require('node:crypto');

const events = new Map([
  ['claude-prompt', 'working'], ['claude-notification', 'waiting'], ['claude-stop', 'done'], ['codex-turn', 'done']
]);

function hookCommand(script, event) {
  return 'powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "' + script.replace(/\\/g, '/') + '" ' + event;
}

function claudeSettings(script) {
  const hook = event => [{ hooks: [{ type: 'command', command: hookCommand(script, event), timeout: 10 }] }];
  return { hooks: { UserPromptSubmit: hook('claude-prompt'), Notification: hook('claude-notification'), Stop: hook('claude-stop') } };
}

// isPane(id): 지금 열려 있는 터미널인지, onEvent(paneId, state, event): 받은 상태를 넘길 곳
function createHookServer({ directory, script, isPane, onEvent }) {
  const token = randomBytes(24).toString('hex');
  const name = 'agent-workbench-' + process.pid + '-' + randomBytes(6).toString('hex');
  const pipe = '\\\\.\\pipe\\' + name;
  fs.mkdirSync(directory, { recursive: true });
  const settingsFile = path.join(directory, 'claude-hooks.json');
  fs.writeFileSync(settingsFile, JSON.stringify(claudeSettings(script), null, 1));
  const expected = Buffer.from(token);
  const server = net.createServer(socket => {
    let buffer = '';
    socket.setEncoding('utf8');
    socket.setTimeout(3000, () => socket.destroy());
    socket.on('data', chunk => {
      buffer += chunk;
      if (buffer.length > 4096) return socket.destroy();
      let newline;
      while ((newline = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, newline).trim();
        buffer = buffer.slice(newline + 1);
        handle(line);
      }
    });
    socket.on('end', () => { if (buffer.trim()) handle(buffer.trim()); });
    socket.on('error', () => {});
  });
  function handle(line) {
    let message;
    try { message = JSON.parse(line.replace(/^﻿/, '')); } catch { return; }
    const given = Buffer.from(String(message?.token ?? ''));
    if (given.length !== expected.length || !timingSafeEqual(given, expected)) return;
    const state = events.get(message.event);
    if (!state || typeof message.pane !== 'string' || !isPane(message.pane)) return;
    onEvent(message.pane, state, message.event);
  }
  server.on('error', () => {});
  server.listen(pipe);
  return {
    pipe, name, token, settingsFile,
    env: paneId => ({ WORKBENCH_HOOK_PIPE: name, WORKBENCH_HOOK_TOKEN: token, WORKBENCH_PANE: paneId }),
    close: () => server.close()
  };
}

module.exports = { createHookServer, claudeSettings, hookCommand, events };
