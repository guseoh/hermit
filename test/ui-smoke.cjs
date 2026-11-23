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
    const timer = setTimeout(() => finish(new Error('DevTools command timed out: ' + method)), 12000);
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
  await evaluate('tasks.forEach(task => { runtime(task).manualDisconnect = true; }); chooseTask(tasks[1]);');
  assert.equal(await evaluate('primaryChatPanel.workArea.current === splitChats.get(tasks[1].id)'), true);
  const [from, edge] = await evaluate('(() => {const tab = document.querySelector("[data-task-id=\\"' + fixtures[1].id + '\\"] button").getBoundingClientRect();const panel = primaryChatPanel.getBoundingClientRect();return [[tab.left+tab.width/2, tab.top+tab.height/2],[panel.right-10,panel.top+panel.height/2]]})()');
  await drag(from, edge);
  assert.equal(await evaluate('splitChats.get(tasks[1].id).workArea.panel !== primaryChatPanel'), true);
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
  await evaluate('byId("agent-usage-dialog").close(); window.forwarded=[]; sendChatText=async(task, text)=>{forwarded.push({provider:task.provider,text});return true;};');
  await evaluate('tasks[0].handoffSchedule={state:"waiting",turnId:"failed",text:"do not send"};runScheduledHandoff(tasks[0],"failed")');
  assert.equal(await evaluate('forwarded.length'), 0);
  await evaluate('tasks[0].handoffSchedule={state:"waiting",turnId:"ok",text:"review result"};runScheduledHandoff(tasks[0],"completed")');
  await evaluate('tasks[1].handoffSchedule={state:"waiting",turnId:"ok",text:"review result"};runScheduledHandoff(tasks[1],"completed")');
  assert.deepEqual(await evaluate('forwarded.map(entry=>entry.provider)'), ['claude', 'codex']);
  assert.deepEqual(errors, []);
  console.log('Hermit Electron smoke passed');
  await stop();
}

run().catch(error => { console.error(error); process.exitCode = 1; }).finally(() => { socket?.close(); app?.kill(); });
