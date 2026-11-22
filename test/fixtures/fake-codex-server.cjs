// codex app-server --stdio 흉내. 테스트에 필요한 JSON-RPC만 답한다.
//  - thread/start: cwd별 thread를 만든다
//  - turn/start: turn/started → (텍스트에 APPROVE가 있으면 승인 요청) → agentMessage → turn/completed
//  - text가 CRASH면 프로세스를 끝낸다
const { createInterface } = require('node:readline');
const send = message => process.stdout.write(JSON.stringify(message) + '\n');
let threads = 0;
let serverRequest = 1000;
const waitingApproval = new Map();
const loaded = new Set();

createInterface({ input: process.stdin }).on('line', line => {
  const message = JSON.parse(line);
  const { id, method, params } = message;
  if (method === 'initialize') return send({ id, result: { userAgent: 'fake' } });
  if (method === 'initialized') return;
  if (method === 'thread/start') {
    const threadId = 'thread-' + (++threads);
    loaded.add(threadId);
    send({ method: 'thread/started', params: { thread: { id: threadId, cwd: params.cwd } } });
    return send({ id, result: { thread: { id: threadId, cwd: params.cwd }, model: 'fake-model' } });
  }
  if (method === 'thread/resume') return send({ id, result: { thread: { id: params.threadId }, model: 'fake-model' } });
  // 진짜 Codex처럼 구독을 끊은 thread는 잠시 뒤 내린다(시험용으로 300ms)
  if (method === 'thread/unsubscribe') { setTimeout(() => loaded.delete(params.threadId), 300); return send({ id, result: { status: 'unsubscribed' } }); }
  if (method === 'thread/loaded/list') return send({ id, result: { data: [...loaded] } });
  if (method === 'account/rateLimits/read') return send({ id, result: { rateLimits: { primary: { usedPercent: 12 } } } });
  if (method === 'turn/start') {
    const text = params.input?.[0]?.text ?? '';
    if (text === 'CRASH') process.exit(3);
    const turn = { id: 'turn-' + params.threadId + '-' + Date.now() };
    send({ id, result: { turn } });
    send({ method: 'turn/started', params: { threadId: params.threadId, turn } });
    send({ method: 'account/rateLimits/updated', params: { rateLimits: { primary: { usedPercent: 13 } } } });
    const finish = () => {
      send({ method: 'item/completed', params: { threadId: params.threadId, item: { id: 'item-' + turn.id, type: 'agentMessage', text: 'echo:' + text } } });
      send({ method: 'turn/completed', params: { threadId: params.threadId, turn: { ...turn, status: 'completed' } } });
    };
    if (text.includes('APPROVE')) {
      const requestId = ++serverRequest;
      waitingApproval.set(requestId, finish);
      send({ id: requestId, method: 'item/commandExecution/requestApproval', params: { threadId: params.threadId, turnId: turn.id, command: 'rm -rf dist' } });
    } else setTimeout(finish, 20);
    return;
  }
  if (id !== undefined && !method && waitingApproval.has(id)) {
    const finish = waitingApproval.get(id);
    waitingApproval.delete(id);
    send({ method: 'item/completed', params: { threadId: 'ignored', item: { id: 'decision', type: 'note', text: message.result?.decision } } });
    return finish();
  }
  if (id !== undefined && method) send({ id, error: { code: -32601, message: 'unknown ' + method } });
});
