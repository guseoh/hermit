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
  await waitFor(() => evaluate('document.readyState === "complete" && typeof restoringChatLayout === "boolean" && !restoringChatLayout && splitChats.size >= 2'), 'workspace restoration');
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
  // 에이전트 현황판: 메인 작업 영역의 탭으로 열리고, 카드에서 승인·거절·중단하며, 재시작 후 복원된다.
  await evaluate('window.shellTab=primaryChatPanel.workArea.current; focusWorkspacePanel(primaryChatPanel); byId("show-agents").click(); 0');
  assert.deepEqual(await evaluate('[primaryChatPanel.workArea.current?.agentsBoard, document.querySelectorAll(".agent-board-lane").length, document.querySelectorAll(".agent-board-card").length >= 2, getComputedStyle(primaryChatPanel.workArea.current.host).display !== "none"]'), [true, 5, true, true]);
  await evaluate('(()=>{window.boardCalls=[]; const state=runtime(tasks[0]); state.approvals.set("fake-approval",{id:"fake-approval",method:"item/commandExecution/requestApproval",command:"npm test"}); state.busy=true; state.turnStartedAt=Date.now()-65000; state.plan=[{step:"분석",status:"completed"},{step:"수정",status:"inProgress"}]; answerApproval=async(task,request,accept)=>{boardCalls.push([task.id,request.id,accept]);}; stopChat=async task=>{boardCalls.push([task.id,"stop"]);}; renderAgentsBoard(); return true;})()');
  await shot('agents-board');
  const cardSelector = '[data-agent-lane=\\"waiting\\"] [data-agent-card=\\"' + fixtures[0].id + '\\"]';
  assert.match(await evaluate('document.querySelector("' + cardSelector + ' .agent-board-facts").textContent'), /^경과 1분 0\d초/);
  assert.equal(await evaluate('document.querySelector("' + cardSelector + ' .agent-board-progress small").textContent'), '1/2 · 수정');
  await evaluate('(()=>{const buttons=[...document.querySelectorAll("' + cardSelector + ' .agent-board-actions button")]; for (const label of ["승인","거절","중단"]) buttons.find(node=>node.textContent===label).click(); return true;})()');
  await waitFor(() => evaluate('boardCalls.length === 3'), 'board actions');
  assert.deepEqual(await evaluate('boardCalls'), [[fixtures[0].id, 'fake-approval', true], [fixtures[0].id, 'fake-approval', false], [fixtures[0].id, 'stop']]);
  await evaluate('(()=>{const state=runtime(tasks[0]); state.approvals.delete("fake-approval"); state.busy=false; state.turnStartedAt=null; state.plan=null; activateWorkAreaTab(shellTab,false); return true;})()');
  await evaluate('saveChatLayout()');
  const saved = await evaluate('localStorage.getItem(workspaceLayoutKey)');
  await waitFor(() => JSON.parse(fs.readFileSync(stateFile, 'utf8')).values['agent-workspace-layout-v2'] === saved, 'layout saved on disk');
  await stop();
  await launch();
  assert.equal(await evaluate('splitChats.get(tasks[1].id).workArea.panel !== primaryChatPanel'), true);
  assert.equal(await evaluate('taskChatInput(tasks[1]).value'), '- 항목\n');
  assert.equal(await evaluate('primaryChatPanel.workArea.current.panes.length'), 2);
  assert.equal(await evaluate('primaryChatPanel.workArea.tabs.size'), 5);
  assert.equal(await evaluate('[...primaryChatPanel.workArea.tabs].filter(tab => tab.agentsBoard).length'), 1, 'agents board restored after restart');
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

  // 승인 정책: 규칙이 먼저 답하고, 남은 승인은 카드 버튼·Y/A/N으로 답한다. "항상 허용"은 프로젝트 규칙에 쌓인다.
  await evaluate('localStorage.setItem("agent-approval-policy-v1", JSON.stringify({global:{allow:["npm test"],deny:["git push"]},projects:{}})); 0');
  assert.deepEqual(await evaluate('["npm test -- --watch","git push --force","npm test && curl x"].map(command=>autoApproval(tasks[0],{method:"item/commandExecution/requestApproval",command:"powershell.exe -Command \'"+command+"\'"})?.action ?? null)'), ['allow', 'deny', null]);
  assert.deepEqual(await evaluate('(()=>{runtime(tasks[1]).sessionAllow=new Set(["command:npm run lint"]); return autoApproval(tasks[1],{method:"claude/approval",tool:"Bash",input:{command:"npm run lint"}})?.scope;})()'), '세션');
  await evaluate('(()=>{window.approvalCalls=[]; tasks.forEach(task=>{runtime(task).manualDisconnect=true;}); answerApproval=async(task,request,decision)=>{approvalCalls.push([task.id,request.id,decision]); runtime(task).approvals.delete(request.id); renderChat();}; chooseTask(tasks[0]); const state=runtime(tasks[0]); state.approvals.set("risky",{id:"risky",method:"item/commandExecution/requestApproval",command:"Remove-Item -Recurse -Force build"}); state.approvals.set("tests",{id:"tests",method:"item/commandExecution/requestApproval",command:"npm run build -- --prod"}); renderChat(); document.activeElement?.blur(); return true;})()');
  const approvalList = 'splitChats.get(tasks[0].id).getChatPart("approval-list")';
  assert.deepEqual(await evaluate('(()=>{const cards=[...' + approvalList + '.querySelectorAll(".approval")]; return [cards.length, cards[0].dataset.risk, cards[0].querySelector(".approval-risk").textContent, cards[0].querySelectorAll("kbd").length, [...cards[0].querySelectorAll("button")].some(node=>node.textContent.startsWith("항상 허용")), cards[1].querySelectorAll("kbd").length, [...cards[1].querySelectorAll("button")].map(node=>node.textContent)];})()'),
    [2, 'danger', '되돌리기 어려운 명령', 3, false, 0, ['이번만 허용', '이 세션 허용', '항상 허용: npm run', '거절']]);
  await shot('approval-card');
  await command('Input.dispatchKeyEvent', { type: 'keyDown', key: 'n', code: 'KeyN', windowsVirtualKeyCode: 78 });
  await waitFor(() => evaluate('approvalCalls.length === 1'), 'N declines the first approval');
  await evaluate('(()=>{const input=taskChatInput(tasks[0]); input.focus(); return true;})()');
  await command('Input.dispatchKeyEvent', { type: 'keyDown', key: 'y', code: 'KeyY', windowsVirtualKeyCode: 89 });
  assert.equal(await evaluate('approvalCalls.length'), 1, 'typing in the composer does not answer approvals');
  await evaluate('[...' + approvalList + '.querySelectorAll("button")].find(node=>node.textContent.startsWith("항상 허용")).click(); 0');
  await waitFor(() => evaluate('approvalCalls.length === 2'), 'always allow answers the approval');
  assert.deepEqual(await evaluate('approvalCalls'), [[fixtures[0].id, 'risky', 'decline'], [fixtures[0].id, 'tests', 'accept']]);
  assert.deepEqual(await evaluate('loadApprovalPolicy().projects[taskProjectKey(tasks[0])].allow'), ['npm run']);
  await evaluate('showApprovalRules(tasks[0]); 0');
  assert.deepEqual(await evaluate('[...byId("workbench-tools-body").querySelectorAll("textarea")].map(area=>area.value)'), ['npm run', '', 'npm test', 'git push']);
  await evaluate('(()=>{const areas=byId("workbench-tools-body").querySelectorAll("textarea"); areas[1].value="rm\\n rm \\n"; [...byId("workbench-tools-body").querySelectorAll("button")].find(node=>node.textContent==="저장").click(); return true;})()');
  assert.deepEqual(await evaluate('[byId("workbench-tools-dialog").open, loadApprovalPolicy().projects[taskProjectKey(tasks[0])].deny]'), [false, ['rm']]);
  await evaluate('localStorage.removeItem("agent-approval-policy-v1"); runtime(tasks[1]).sessionAllow=undefined; 0');

  // 채팅 마크다운: 코드 블록(언어·복사·강조)·링크·체크박스, 스트리밍 중에는 바뀐 끝 블록만 다시 그린다.
  await evaluate('(()=>{const state=runtime(tasks[0]); state.items.set("md-1",{id:"md-1",type:"agentMessage",text:"## 결과\\n\\n- [x] 테스트 통과\\n- [ ] 문서\\n\\n[가이드](https://example.com/guide)를 보세요.\\n\\n```ts\\nconst answer = 42; // 주석"}); renderChat(); return true;})()');
  const mdNode = 'splitChats.get(tasks[0].id).getChatPart("chat-feed").querySelector("[data-item=\\"md-1\\"] .chat-message")';
  assert.deepEqual(await evaluate('(()=>{const node=' + mdNode + '; window.mdFirst=node.firstElementChild; return [node.querySelector("h2").textContent, node.querySelectorAll("li.md-task input:checked").length, node.querySelector("a.md-link").getAttribute("href"), node.querySelector(".md-code-header span").textContent, [...node.querySelectorAll(".md-code [class^=tok-]")].map(span=>span.className)];})()'),
    ['결과', 1, 'https://example.com/guide', 'ts', ['tok-keyword', 'tok-number', 'tok-comment']]);
  await evaluate('(()=>{runtime(tasks[0]).items.get("md-1").text += "\\nconsole.log(answer);\\n```\\n\\n끝."; renderChat(); return true;})()');
  assert.deepEqual(await evaluate('(()=>{const node=' + mdNode + '; return [node.firstElementChild === mdFirst, node.querySelector(".md-code code").textContent, node.lastElementChild.textContent];})()'),
    [true, 'const answer = 42; // 주석\nconsole.log(answer);', '끝.']);
  await shot('markdown');
  await evaluate('(()=>{const node=' + mdNode + '; node.querySelector(".md-copy").click(); return true;})()');
  await waitFor(() => evaluate(mdNode + '.querySelector(".md-copy").textContent !== "복사"'), 'code copy feedback');
  assert.equal(await evaluate(mdNode + '.querySelector(".md-copy").textContent'), '복사됨');
  await evaluate('runtime(tasks[0]).items.delete("md-1"); renderChat(); 0');

  // 입력창은 내용에 맞춰 늘어나고 화면 높이의 40%에서 멈춘다.
  assert.deepEqual(await evaluate('(()=>{const input=taskChatInput(tasks[0]); const saved=input.value; const heights=[]; for (const lines of [1, 6, 200]) { input.value=Array(lines).fill("줄").join("\\n"); heights.push(input.offsetHeight); } input.value=saved; return [heights[0] <= 52, heights[1] > heights[0] + 60, heights[2] <= Math.ceil(innerHeight * 0.4) + 1, heights[2] > heights[1]];})()'), [true, true, true, true]);

  // @ 멘션: 노트·다른 작업의 맥락을 블록으로 넣는다.
  const suggest = 'splitChats.get(tasks[0].id).getChatPart("chat-suggest")';
  const mention = async (text, label) => {
    await evaluate('(()=>{const input=taskChatInput(tasks[0]); input.focus(); input.value=' + JSON.stringify(text) + '; input.setSelectionRange(input.value.length,input.value.length); input.dispatchEvent(new Event("input")); return true;})()');
    await waitFor(() => evaluate('[...' + suggest + '.querySelectorAll(".suggest-row span")].some(node=>node.textContent===' + JSON.stringify(label) + ')'), 'mention ' + label);
    await evaluate('[...' + suggest + '.querySelectorAll(".suggest-row")].find(row=>row.querySelector("span").textContent===' + JSON.stringify(label) + ').click(); 0');
    return evaluate('taskChatInput(tasks[0]).value');
  };
  assert.equal(await mention('이 메모대로 해 줘 @노', '노트 · - 항목'), '이 메모대로 해 줘\n\n[노트 "- 항목"]\n- 항목\n');
  await evaluate('runtime(tasks[1]).items.set("ans",{id:"ans",type:"agentMessage",text:"원인은 캐시입니다."}); 0');
  assert.match(await mention('@작업', '작업 · Claude sample'), /^\[다른 작업 "Claude sample" \(Claude Code, .+\)의 최근 답변\]\n원인은 캐시입니다\.\n$/);
  await evaluate('(()=>{runtime(tasks[1]).items.delete("ans"); const input=taskChatInput(tasks[0]); input.value=""; input.dispatchEvent(new Event("input")); input.blur(); return true;})()');

  // 라이브 체크리스트: Claude TodoWrite도 같은 계획 형태로 바꿔 입력창 위에 진행도와 현재 단계를 보여 준다.
  await evaluate('(()=>{runtime(tasks[0]).plan=planFromTodos([{content:"원인 분석",status:"completed"},{content:"수정",activeForm:"수정하는 중",status:"in_progress"},{content:"테스트",status:"pending"}]); renderChat(); return true;})()');
  const planBar = 'splitChats.get(tasks[0].id).getChatPart("chat-plan")';
  assert.deepEqual(await evaluate('(()=>{const bar=' + planBar + '; return [bar.hidden, bar.querySelector(".chat-plan-label").textContent, bar.querySelector(".chat-plan-count").textContent, [...bar.querySelectorAll("li")].map(li=>li.dataset.status+":"+li.textContent)];})()'),
    [false, '수정하는 중', '1/3', ['completed:원인 분석', 'inProgress:수정하는 중', 'pending:테스트']]);
  await evaluate(planBar + '.open = true; 0');
  await shot('plan-bar');
  await evaluate('(()=>{runtime(tasks[0]).plan=runtime(tasks[0]).plan.map(entry=>({...entry,status:"completed"})); renderChat(); return true;})()');
  assert.deepEqual(await evaluate('[' + planBar + '.querySelector(".chat-plan-label").textContent, ' + planBar + '.dataset.complete]'), ['계획 완료', 'true']);
  await evaluate('runtime(tasks[0]).plan=null; renderChat(); 0');
  assert.equal(await evaluate(planBar + '.hidden'), true);

  // 메시지 동작: 복사, 여기서 분기(이 지점까지의 대화를 담아 런처를 연다).
  await evaluate('(()=>{const state=runtime(tasks[0]); state.items.set("u1",{id:"u1",type:"userMessage",content:[{text:"로그인이 느려요"}]}); state.items.set("a1",{id:"a1",type:"agentMessage",text:"캐시가 원인입니다."}); state.items.set("u2",{id:"u2",type:"userMessage",content:[{text:"캐시를 끄고 다시 측정해 줘"}]}); renderChat(); return true;})()');
  const entryOf = id => 'splitChats.get(tasks[0].id).getChatPart("chat-feed").querySelector("[data-item=\\"' + id + '\\"]")';
  await evaluate('[...' + entryOf('a1') + '.querySelectorAll(".message-actions button")].find(node=>node.textContent==="복사").click(); 0');
  await waitFor(() => evaluate('[...' + entryOf('a1') + '.querySelectorAll(".message-actions button")].some(node=>node.textContent==="복사됨")'), 'message copy feedback');
  await evaluate('[...' + entryOf('u2') + '.querySelectorAll(".message-actions button")].find(node=>node.textContent==="여기서 분기").click(); 0');
  await waitFor(() => evaluate('byId("task-dialog").open && byId("task-name").value.startsWith("분기 · ")'), 'branch opens the launcher');
  assert.match(await evaluate('byId("task-prompt").value'), /이전 대화:\n사용자: 로그인이 느려요\n\nCodex: 캐시가 원인입니다\.\n\n요청:\n캐시를 끄고 다시 측정해 줘$/);
  await evaluate('byId("cancel-task").click(); (()=>{const state=runtime(tasks[0]); for (const id of ["u1","a1","u2"]) state.items.delete(id); renderChat(); return true;})()');

  // 이어진 읽기·검색 단계 3개 이상은 한 줄로 접고, 누르면 펼친다. 2개뿐이거나 일반 명령이 끼면 접지 않는다.
  await evaluate('(()=>{const state=runtime(tasks[0]); state.busy=false; const read=(id,type)=>state.items.set(id,{id,type:"commandExecution",command:"rg x",status:"completed",exitCode:0,commandActions:[{type,command:"rg x"}]}); read("r1","read"); read("r2","search"); read("r3","listFiles"); read("r4","read"); state.items.set("w1",{id:"w1",type:"commandExecution",command:"npm test",status:"completed",exitCode:0,commandActions:[{type:"unknown",command:"npm test"}]}); read("r5","read"); read("r6","read"); renderChat(); return true;})()');
  const feedOf = 'splitChats.get(tasks[0].id).getChatPart("chat-feed")';
  const foldState = () => evaluate('["r1","r2","r3","r4","w1","r5","r6"].map(id=>{const node=' + feedOf + '.querySelector("[data-item=\\""+id+"\\"]"); return node.classList.contains("read-step-hidden") ? "hidden" : node.classList.contains("read-step-collapsed") ? "collapsed" : "shown";})');
  assert.deepEqual(await foldState(), ['collapsed', 'hidden', 'hidden', 'hidden', 'shown', 'shown', 'shown']);
  assert.equal(await evaluate(feedOf + '.querySelector("[data-item=\\"r1\\"] .read-group-toggle").textContent'), '파일 읽기·검색 4단계');
  await evaluate(feedOf + '.querySelector("[data-item=\\"r1\\"] .read-group-toggle").click(); 0');
  await waitFor(async () => (await foldState())[1] === 'shown', 'read steps expanded');
  assert.equal(await evaluate(feedOf + '.querySelector("[data-item=\\"r1\\"] .read-group-toggle").getAttribute("aria-expanded")'), 'true');
  await evaluate('(()=>{const state=runtime(tasks[0]); for (const id of ["r1","r2","r3","r4","w1","r5","r6"]) state.items.delete(id); renderChat(); return true;})()');

  // 체크포인트 복원과 전송의 경합: 복원 확인 중에는 전송·대기열이 멈추고, 턴이 돌고 있으면 복원을 열지 않으며,
  // 확인하는 사이 턴이 시작되면 승인해도 복원하지 않는다(가짜 참조라 복원이 실행되면 오류가 남는다).
  await evaluate('(()=>{const state=runtime(tasks[0]); state.busy=false; state.connecting=false; window.restoring=restoreTurn(tasks[0],"refs/fake/checkpoint"); return true;})()');
  await waitFor(() => evaluate('byId("confirm-dialog").open'), 'restore confirmation');
  assert.deepEqual(await evaluate('sendChatText(tasks[0],"경합 전송").then(result=>[result, runtime(tasks[0]).restoring, runtime(tasks[0]).busy, [...runtime(tasks[0]).items.values()].some(item=>item.content?.[0]?.text==="경합 전송")])'), [null, true, false, false]);
  await evaluate('byId("confirm-cancel").click(); restoring');
  assert.equal(await evaluate('runtime(tasks[0]).restoring'), false);
  await evaluate('runtime(tasks[0]).busy=true; restoreTurn(tasks[0],"refs/fake/checkpoint")');
  assert.equal(await evaluate('byId("confirm-dialog").open'), false, 'no restore while a turn is running');
  await evaluate('(()=>{const state=runtime(tasks[0]); state.busy=false; window.restoring=restoreTurn(tasks[0],"refs/fake/checkpoint"); return true;})()');
  await waitFor(() => evaluate('byId("confirm-dialog").open'), 'second restore confirmation');
  await evaluate('runtime(tasks[0]).busy=true; byId("confirm-accept").click(); restoring');
  assert.deepEqual(await evaluate('[runtime(tasks[0]).restoring, byId("confirm-dialog").open]'), [false, false]);
  await evaluate('runtime(tasks[0]).busy=false; 0');
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
    // 프롬프트 문자는 환경(CI 글꼴·코드 페이지)마다 다르므로, prompt.ps1이 프롬프트마다 보내는 OSC 표시를 기다린다.
    await waitFor(() => evaluate('!!(tuiPane.running && tuiPane.prompt)'), 'fake TUI shell prompt');
    await evaluate('(()=>{const state=runtime(tasks[0]); state.terminalMode=true; state.terminalPane=tuiPane; return true;})()');
  };
  await fakeTui();
  // PSReadLine이 없으면 Ctrl+U가 문자로 남고, 있으면 빠진다. 두 경우 모두 받도록 '\x15/exit'와 '/exit' 함수를 함께 만든다.
  await evaluate('window.workbench.input(tuiPane.id, "$returned = { [Console]::Write([char]27 + \\"]777;workbench-agent;returned\\" + [char]7) }; Set-Item -Path (\\"function:\\" + [char]0x15 + \\"/exit\\") -Value $returned; Set-Item -Path \\"function:/exit\\" -Value $returned\\r").then(()=>true)');
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
