// Windows Electron regression test with a disposable profile and no live agent turns.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { once } = require('node:events');
const { setTimeout: sleep } = require('node:timers/promises');

const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'hermit-ui-'));
const repo = path.resolve(__dirname, '..');
const stateFile = path.join(profile, 'workbench-state.json');
const fixtures = [
  { id: '11111111-1111-4111-8111-111111111111', name: 'Codex sample', provider: 'codex', cwd: profile },
  { id: '22222222-2222-4222-8222-222222222222', name: 'Claude sample', provider: 'claude', cwd: path.join(profile, 'work') }
];
fs.mkdirSync(fixtures[1].cwd);
fs.writeFileSync(stateFile, JSON.stringify({ version: 1, values: {
  'agent-workbench-tasks-v1': JSON.stringify(fixtures),
  'agent-open-tasks': JSON.stringify(fixtures.map(task => task.id))
} }));

let app;
let socket;
let serial = 0;
const errors = [];

async function waitFor(read, label) {
  for (let attempt = 0; attempt < 135; attempt++) {
    const value = await read();
    if (value) return value;
    await sleep(200);
  }
  throw new Error('Timed out waiting for ' + label + '\n' + errors.join('\n'));
}

async function launch() {
  let stderr = '';
  app = spawn(require('electron'), ['--remote-debugging-port=0', '.'], {
    cwd: repo, env: { ...process.env, AGENT_WORKBENCH_PROFILE: profile }, windowsHide: true
  });
  app.stdout.resume();
  app.stderr.on('data', data => { stderr = (stderr + data).slice(-8000); });
  const port = await waitFor(() => {
    if (app.exitCode !== null) throw new Error(stderr);
    return /ws:\/\/127\.0\.0\.1:(\d+)/.exec(stderr)?.[1];
  }, 'Electron DevTools');
  const target = await waitFor(async () => {
    const response = await fetch('http://127.0.0.1:' + port + '/json/list');
    return (await response.json()).find(entry => entry.url.endsWith('/index.html'));
  }, 'Hermit renderer');
  socket = new WebSocket(target.webSocketDebuggerUrl);
  await once(socket, 'open');
  socket.addEventListener('message', ({ data }) => {
    const message = JSON.parse(data);
    if (message.method === 'Runtime.exceptionThrown') errors.push(message.params.exceptionDetails.exception?.description);
  });
  await command('Runtime.enable');
  await waitFor(() => evaluate('document.readyState === "complete" && !restoringChatLayout && splitChats.size >= 2'), 'workspace restoration');
}

function command(method, params) {
  const client = socket;
  const id = ++serial;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => finish(new Error('DevTools command timed out: ' +
      (params?.expression ?? method) + '\n' + errors.join('\n'))), 12000);
    function finish(error, result) {
      clearTimeout(timer);
      client.removeEventListener('message', onMessage);
      if (error) reject(error);
      else resolve(result);
    }
    function onMessage({ data }) {
      const message = JSON.parse(data);
      if (message.id !== id) return;
      const error = message.error ?? message.result?.exceptionDetails;
      finish(error && new Error(JSON.stringify(error)), message.result);
    }
    client.addEventListener('message', onMessage);
    client.send(JSON.stringify({ id, method, params }));
  });
}

async function evaluate(expression) {
  return (await command('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })).result.value;
}

// HERMIT_SMOKE_SHOTS=<폴더>를 주면 주요 화면을 PNG로 남긴다(눈으로 확인용, 기본은 건너뜀).
async function shot(name) {
  const folder = process.env.HERMIT_SMOKE_SHOTS;
  if (!folder) return;
  await sleep(250);
  const { data } = await command('Page.captureScreenshot', { format: 'png' });
  fs.mkdirSync(folder, { recursive: true });
  fs.writeFileSync(path.join(folder, name + '.png'), Buffer.from(data, 'base64'));
}

async function stop() {
  socket.close();
  const stopped = once(app, 'exit');
  app.kill();
  await stopped;
}

async function drag(from, target) {
  await command('Input.dispatchMouseEvent', { type: 'mousePressed', button: 'left', buttons: 1, clickCount: 1, x: from[0], y: from[1] });
  await command('Input.dispatchMouseEvent', { type: 'mouseMoved', buttons: 1, x: from[0] + 12, y: from[1] + 12 });
  await command('Input.dispatchMouseEvent', { type: 'mouseMoved', buttons: 1, x: target[0], y: target[1] });
  await command('Input.dispatchMouseEvent', { type: 'mouseReleased', button: 'left', clickCount: 1, x: target[0], y: target[1] });
}

async function run() {
  await launch();
  await evaluate('byId("resource-menu").showPopover()');
  await waitFor(() => evaluate('byId("resource-rows").rows.length === 2'), 'app-only memory snapshot');
  assert.match(await evaluate('byId("resource-rows").rows[0].cells[1].textContent'), /^[1-9]\d*\.\d MiB$/);
  await evaluate('byId("resource-menu").hidePopover()');
  await evaluate('byId("nav-floating-terminal").click()');
  assert.equal(await evaluate('byId("floating-terminal").hidden'), false);
  await evaluate('window.dispatchEvent(new KeyboardEvent("keydown", { code: "KeyA", ctrlKey: true, altKey: true }))');
  await waitFor(() => evaluate('byId("floating-terminal").hidden'), 'floating terminal shortcut');
  await evaluate('tasks.forEach(task => { runtime(task).manualDisconnect = true; }); chooseTask(tasks[1]);');
  assert.equal(await evaluate('primaryChatPanel.workArea.current === splitChats.get(tasks[1].id)'), true);
  const [from, edge] = await evaluate('(() => {const tab = document.querySelector("[data-task-id=\\"' + fixtures[1].id + '\\"] button").getBoundingClientRect();const panel = primaryChatPanel.getBoundingClientRect();return [[tab.left+tab.width/2, tab.top+tab.height/2],[panel.right-10,panel.top+panel.height/2]]})()');
  await drag(from, edge);
  assert.equal(await evaluate('splitChats.get(tasks[1].id).workArea.panel !== primaryChatPanel'), true);
  // 분할 채팅 머리줄: 각 패널의 버튼은 자기 작업만 조작한다.
  assert.deepEqual(await evaluate('(()=>{const get=splitChats.get(tasks[1].id).getChatPart; renderChat(); return [get("task-view-switch").hidden, get("task-shell").hidden, get("task-view-switch").closest(".workspace-panel")===splitChats.get(tasks[1].id).workArea.panel, document.querySelectorAll("#view-terminal").length];})()'), [false, false, true, 1]);
  await shot('split-header');
  assert.deepEqual(await evaluate('(()=>{window.headerCalls=[]; const switchView=switchTaskView, shell=newShellTab; switchTaskView=async task=>headerCalls.push(["view",task.id]); newShellTab=async(cwd,area)=>headerCalls.push(["shell",cwd,area.panel===splitChats.get(tasks[1].id).workArea.panel]); const get=splitChats.get(tasks[1].id).getChatPart; get("view-terminal").click(); get("task-shell").click(); byId("view-terminal").click(); byId("task-shell").click(); switchTaskView=switchView; newShellTab=shell; return [headerCalls, panelTask(primaryChatPanel).id];})()'),
    [[['view', fixtures[1].id], ['shell', fixtures[1].cwd, true], ['view', fixtures[0].id], ['shell', fixtures[0].cwd, false]], fixtures[0].id]);
  assert.equal(await evaluate('reviewCwd()'), fixtures[1].cwd);
  await evaluate('(()=>{const input=taskChatInput(tasks[1]); input.value="- 항목"; input.setSelectionRange(4,4); input.dispatchEvent(new Event("input")); input.dispatchEvent(new KeyboardEvent("keydown",{key:"Enter",bubbles:true,cancelable:true}));})()');
  assert.equal(await evaluate('taskChatInput(tasks[1]).value'), '- 항목\n- ');
  await evaluate('taskChatInput(tasks[1]).dispatchEvent(new KeyboardEvent("keydown",{key:"Enter",bubbles:true,cancelable:true}))');
  assert.equal(await evaluate('taskChatInput(tasks[1]).value'), '- 항목\n');

  await evaluate('window.noteFixture=buildNoteTab({id:"fixture-note",name:"Test note",text:"- 항목",cwd:tasks[0].cwd,view:"source"}); attachWorkAreaTab(noteFixture,primaryChatPanel.workArea);');
  await evaluate('(()=>{const input=noteFixture.host.querySelector(".note-source");input.setSelectionRange(4,4);input.dispatchEvent(new KeyboardEvent("keydown",{key:"Enter",bubbles:true,cancelable:true}));})()');
  assert.equal(await evaluate('noteFixture.host.querySelector(".note-source").value'), '- 항목\n- ');
  await evaluate('noteFixture.text="- 항목"; noteFixture.setView("rich")');
  await waitFor(() => evaluate('!!noteFixture.host.querySelector(".tiptap li")'), 'rich note list');
  await evaluate('(()=>{const editor=noteFixture.host.querySelector(".tiptap"); const p=editor.querySelector("li p"); editor.focus(); const r=document.createRange(); r.selectNodeContents(p); r.collapse(false); getSelection().removeAllRanges(); getSelection().addRange(r);})()');
  const enter = () => command('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 });
  await enter();
  await waitFor(() => evaluate('noteFixture.host.querySelectorAll(".tiptap li").length === 2'), 'continued rich bullet');
  await enter();
  await waitFor(() => evaluate('noteFixture.host.querySelectorAll(".tiptap li").length === 1'), 'exit empty rich bullet');
  await evaluate('noteFixture.setView("source",false)');
  const sourceNote = await evaluate('noteFixture.text');
  await evaluate('void openPreviewPanel(primaryChatPanel.workArea, { cwd: tasks[0].cwd });');
  await evaluate('openWorkspace(tasks[0].cwd,"shell",undefined,undefined,primaryChatPanel.workArea).then(() => true)');
  await waitFor(() => evaluate('primaryChatPanel.workArea.current?.activePane?.running'), 'PowerShell startup');
  await evaluate('byId("resource-menu").showPopover()');
  await waitFor(() => evaluate('byId("resource-rows").rows.length === 3'), 'terminal memory snapshot');
  assert.match(await evaluate('byId("resource-rows").rows[1].cells[1].textContent'), /^[1-9]\d*\.\d MiB$/);
  await evaluate('byId("resource-menu").hidePopover()');
  await evaluate('(()=>{const tab=primaryChatPanel.workArea.current; return openPane(tab,tab.activePane.cwd,"shell",tab.activePane,"down").then(() => true);})()');
  await evaluate('saveChatLayout()');
  const saved = await evaluate('localStorage.getItem(workspaceLayoutKey)');
  await waitFor(() => JSON.parse(fs.readFileSync(stateFile, 'utf8')).values['agent-workspace-layout-v2'] === saved, 'layout saved on disk');
  await stop();
  await launch();
  assert.equal(await evaluate('splitChats.get(tasks[1].id).workArea.panel !== primaryChatPanel'), true);
  assert.equal(await evaluate('taskChatInput(tasks[1]).value'), '- 항목\n');
  assert.equal(await evaluate('primaryChatPanel.workArea.current.panes.length'), 2);
  assert.equal(await evaluate('primaryChatPanel.workArea.tabs.size'), 4);
  assert.equal(await evaluate('noteTabs.get("fixture-note").text'), sourceNote);

  await evaluate('recordCodexUsage({threadId:"test",tokenUsage:{last:{totalTokens:10},total:{totalTokens:10}}},tasks[0]); recordCodexUsage({threadId:"test",tokenUsage:{total:{totalTokens:10}}},tasks[0]); updateClaudeUsage({turnId:"test",tokens:{input_tokens:5,output_tokens:3,cache_read_input_tokens:2}},tasks[1]); byId("open-agent-usage").click();');
  assert.match(await evaluate('byId("usage-totals").textContent'), /Codex · 10 토큰 · 캐시 0/);
  assert.match(await evaluate('byId("usage-totals").textContent'), /Claude Code · 10 토큰 · 캐시 2/);
  await evaluate('byId("agent-usage-dialog").close(); window.confirmResult=confirmAction({title:"확인",target:"C:/repo\\nmain → origin/main",result:"푸시합니다.",confirmLabel:"푸시",danger:true}); 0');
  assert.equal(await evaluate('byId("confirm-dialog").open && document.activeElement.id'), 'confirm-cancel');
  assert.equal(await evaluate('[...byId("confirm-details").children].map(node=>node.textContent).join("|")'), '대상|C:/repo\nmain → origin/main|결과|푸시합니다.');
  // 대화상자를 연 직후 몇 ms 안의 Esc는 Chromium이 놓칠 수 있어(사람은 그렇게 빨리 누르지 않는다) 잠시 기다린다.
  await sleep(300);
  await command('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
  await waitFor(() => evaluate('!byId("confirm-dialog").open'), 'confirm closed with Escape');
  assert.equal(await evaluate('Promise.race([confirmResult, new Promise(resolve => setTimeout(() => resolve("pending"), 2000))])'), false);
  await evaluate('window.confirmResult=confirmAction({title:"확인",result:"지웁니다."}); 0');
  assert.deepEqual(await evaluate('[byId("confirm-details").hidden, byId("confirm-details").childElementCount, byId("confirm-note").hidden, byId("confirm-accept").textContent, byId("confirm-accept").className]'), [false, 2, true, "계속", ""]);
  await evaluate('byId("confirm-accept").click()');
  assert.equal(await evaluate('confirmResult'), true);
  await evaluate('window.confirmResult=confirmAction({title:"확인"}); byId("confirm-cancel").click()');
  assert.equal(await evaluate('confirmResult'), false);
  await evaluate('window.forwarded=[]; sendChatText=async(task, text)=>{forwarded.push({provider:task.provider,text});return true;};');
  await evaluate('tasks[0].handoffSchedule={state:"waiting",turnId:"failed",text:"do not send"};runScheduledHandoff(tasks[0],"failed")');
  assert.equal(await evaluate('forwarded.length'), 0);
  await evaluate('tasks[0].handoffSchedule={state:"waiting",turnId:"ok",text:"review result"};runScheduledHandoff(tasks[0],"completed")');
  await evaluate('tasks[1].handoffSchedule={state:"waiting",turnId:"ok",text:"review result"};runScheduledHandoff(tasks[1],"completed")');
  assert.deepEqual(await evaluate('forwarded.map(entry=>entry.provider)'), ['claude', 'codex']);

  // 작업 런처: Ctrl+N → 요청 입력 → Enter 한 번으로 이름 생성·작업 생성·첫 요청 전송.
  assert.equal(await evaluate('taskNameFromPrompt("## `로그인` 오류를   고쳐 줘\\n자세한 내용")'), '로그인 오류를 고쳐 줘');
  assert.equal(await evaluate('taskNameFromPrompt("/plan " + "가나다라마 ".repeat(10))'), Array(6).fill('가나다라마').join(' ') + '…');
  await evaluate('window.forwarded=[]; connectTask=async()=>{}; whenSettled=async()=>{}; document.activeElement?.blur(); 0');
  const key = (key, code, keyCode, modifiers = 0) => command('Input.dispatchKeyEvent', { type: 'keyDown', key, code, windowsVirtualKeyCode: keyCode, modifiers });
  await key('n', 'KeyN', 78, 2);
  await waitFor(() => evaluate('byId("task-dialog").open && document.activeElement.id === "task-prompt"'), 'launcher opened with Ctrl+N');
  await evaluate('byId("task-prompt").value="로그인 오류를 고쳐 줘"; updateTaskNamePreview(); 0');
  await shot('launcher');
  await evaluate('byId("task-prompt").value=""; updateTaskNamePreview(); 0');
  await key('Enter', 'Enter', 13);
  assert.equal(await evaluate('byId("task-dialog").open && !byId("task-error").hidden'), true);
  await evaluate('byId("task-worktree").checked=false; byId("task-dialog").querySelector("form").elements["task-provider"].value="claude"; 0');
  await command('Input.insertText', { text: '런처 첫 요청' });
  await key('Enter', 'Enter', 13, 8);
  assert.equal(await evaluate('byId("task-dialog").open'), true, 'Shift+Enter keeps the launcher open');
  await command('Input.insertText', { text: '\n둘째 줄' });
  assert.equal(await evaluate('byId("task-name").placeholder'), '런처 첫 요청');
  const before = await evaluate('tasks.length');
  await key('Enter', 'Enter', 13);
  await waitFor(() => evaluate('forwarded.length === 1'), 'first request sent');
  assert.equal(await evaluate('byId("task-dialog").open'), false);
  assert.equal(await evaluate('tasks.length'), before + 1);
  assert.deepEqual(await evaluate('[tasks.at(-1).name, tasks.at(-1).provider, selectedTask === tasks.at(-1), forwarded[0].text]'), ['런처 첫 요청', 'claude', true, '런처 첫 요청\n둘째 줄']);

  // TUI 원클릭 종료: [채팅] 버튼이 /exit를 보내고 PowerShell 복귀 신호를 받으면 채팅으로 돌아온다.
  const fakeTui = async () => {
    await evaluate('openWorkspace(tasks[0].cwd,"shell").then(pane=>{window.tuiPane=pane; return true;})');
    await waitFor(() => evaluate('tuiPane.running && (()=>{const b=tuiPane.terminal.buffer.active;for(let i=0;i<b.length;i++){if(b.getLine(i)?.translateToString(true).includes(String.fromCharCode(0x276f)))return true;}return false;})()'), 'fake TUI shell prompt');
    await evaluate('(()=>{const state=runtime(tasks[0]); state.terminalMode=true; state.terminalPane=tuiPane; return true;})()');
  };
  await fakeTui();
  // 이 셸에는 PSReadLine이 없어 Ctrl+U가 문자로 남으므로, 앱이 보내는 키 입력 그대로를 이름으로 받는 함수를 만든다.
  await evaluate('window.workbench.input(tuiPane.id, "Set-Item -Path (\\"function:\\" + [char]0x15 + \\"/exit\\") -Value { [Console]::Write([char]27 + \\"]777;workbench-agent;returned\\" + [char]7) }\\r").then(()=>true)');
  await new Promise(resolve => setTimeout(resolve, 1500));
  await evaluate('switchTaskView(tasks[0]); 0');
  await waitFor(() => evaluate('!runtime(tasks[0]).terminalMode && !panes.has(tuiPane.id)'), 'TUI exit returned to chat');
  assert.equal(await evaluate('byId("confirm-dialog").open'), false);
  // /exit에 응답이 없으면 강제 종료를 확인받고 터미널을 닫는다.
  await fakeTui();
  await evaluate('agentExitTimeout=800; switchTaskView(tasks[0]); 0');
  await waitFor(() => evaluate('byId("confirm-dialog").open'), 'force exit confirmation');
  assert.equal(await evaluate('runtime(tasks[0]).terminalMode'), true);
  await evaluate('byId("confirm-accept").click()');
  await waitFor(() => evaluate('!runtime(tasks[0]).terminalMode && !panes.has(tuiPane.id)'), 'forced TUI exit returned to chat').catch(async error => {
    error.message += '\n' + await evaluate('JSON.stringify({mode:runtime(tasks[0]).terminalMode, switching:runtime(tasks[0]).switching, status:runtime(tasks[0]).status, exited:tuiPane.exited, agent:tuiPane.agentState, open:panes.has(tuiPane.id), same:runtime(tasks[0]).terminalPane===tuiPane, confirm:byId("confirm-dialog").open})');
    throw error;
  });

  // 탭 탐색: Ctrl+1~9는 탭 줄 순서, Ctrl+Tab은 최근 사용 순서. Ctrl을 떼면 확정된다.
  const ctrl = async (key, code, keyCode, shift = false) => {
    await command('Input.dispatchKeyEvent', { type: 'keyDown', key, code, windowsVirtualKeyCode: keyCode, modifiers: 2 | (shift ? 8 : 0) });
    await command('Input.dispatchKeyEvent', { type: 'keyUp', key, code, windowsVirtualKeyCode: keyCode, modifiers: 2 | (shift ? 8 : 0) });
  };
  const releaseCtrl = () => command('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Control', code: 'ControlLeft', windowsVirtualKeyCode: 17 });
  const tabIndex = () => evaluate('(()=>{const area=primaryChatPanel.workArea; return [...area.strip.children].map(row=>row.workspaceTab).filter(Boolean).indexOf(area.current);})()');
  await evaluate('document.activeElement?.blur(); focusWorkspacePanel(primaryChatPanel); 0');
  const tabCount = await evaluate('[...primaryChatPanel.workArea.strip.children].filter(row=>row.workspaceTab).length');
  assert.ok(tabCount >= 3, 'needs at least three tabs, got ' + tabCount);
  await ctrl('1', 'Digit1', 49); await releaseCtrl();
  assert.equal(await tabIndex(), 0);
  await ctrl('2', 'Digit2', 50); await releaseCtrl();
  assert.equal(await tabIndex(), 1);
  await ctrl('9', 'Digit9', 57); await releaseCtrl();
  assert.equal(await tabIndex(), tabCount - 1);
  await ctrl('Tab', 'Tab', 9); await releaseCtrl();
  assert.equal(await tabIndex(), 1, 'Ctrl+Tab returns to the previous tab');
  await ctrl('Tab', 'Tab', 9); await releaseCtrl();
  assert.equal(await tabIndex(), tabCount - 1, 'Ctrl+Tab toggles between the two most recent tabs');
  await ctrl('Tab', 'Tab', 9); await ctrl('Tab', 'Tab', 9); await releaseCtrl();
  assert.equal(await tabIndex(), 0, 'holding Ctrl walks further back in recent order');
  // 최근 순서 [0, 마지막, 1]에서 Tab 두 번(→1) 뒤 Shift+Tab 한 번이면 '마지막'으로 돌아온다.
  await ctrl('Tab', 'Tab', 9); await ctrl('Tab', 'Tab', 9); await ctrl('Tab', 'Tab', 9, true); await releaseCtrl();
  assert.equal(await tabIndex(), tabCount - 1, 'Ctrl+Shift+Tab walks recent order backwards');
  await evaluate('document.activeElement?.blur(); focusWorkspacePanel(primaryChatPanel); 0');
  await ctrl('p', 'KeyP', 80); await releaseCtrl();
  await waitFor(() => evaluate('byId("workbench-tools-dialog").open && byId("workbench-tools-title").textContent === "현재 작업의 파일 빠른 열기"'), 'Ctrl+P quick open');
  await evaluate('byId("workbench-tools-dialog").close(); 0');
  assert.deepEqual(errors, []);
  console.log('Hermit Electron smoke passed');
  await stop();
}

run().catch(error => { console.error(error); process.exitCode = 1; }).finally(() => { socket?.close(); app?.kill(); });
