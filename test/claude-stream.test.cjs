// Claude 스트림 해석(claude.cjs) 테스트: thinking을 reasoning 항목으로, 마지막 호출의 usage를 컨텍스트 사용량으로.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const ClaudeSession = require('../claude.cjs');

test('thinking은 reasoning 항목으로 흘려보내고, 컨텍스트는 마지막 호출의 usage와 모델 창 크기로 계산한다', async () => {
  const events = [];
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'hermit-claude-stream-'));
  const session = new ClaudeSession('claude', directory, path.join(directory, 'history.json'), { items: [] }, event => events.push(event));
  const child = { ready: true, stdin: { write() {}, end() {} } };
  session.child = child;
  session.turn = { id: 'turn-1', text: '질문', items: [], streamText: '', written: true };
  session.turnId = 'turn-1';
  session.receive(child, { type: 'stream_event', event: { delta: { type: 'thinking_delta', thinking: '먼저 ' } } });
  session.receive(child, { type: 'stream_event', event: { delta: { type: 'thinking_delta', thinking: '구조를 본다' } } });
  session.receive(child, { type: 'assistant', message: {
    content: [{ type: 'thinking', thinking: '먼저 구조를 본다' }, { type: 'text', text: '답변' }],
    usage: { input_tokens: 10, cache_read_input_tokens: 30000, cache_creation_input_tokens: 2000, output_tokens: 500 }
  } });
  session.receive(child, { type: 'result', subtype: 'success', is_error: false, result: '답변',
    usage: { input_tokens: 999999, output_tokens: 999999 }, modelUsage: { 'claude-x': { contextWindow: 200000 } } });
  await new Promise(resolve => setTimeout(resolve, 50));

  const deltas = events.filter(event => event.method === 'item/reasoning/textDelta').map(event => event.params);
  assert.equal(deltas.map(delta => delta.delta).join(''), '먼저 구조를 본다');
  const reasoning = events.find(event => event.method === 'item/completed' && event.params.item.type === 'reasoning').params.item;
  assert.equal(reasoning.id, deltas[0].itemId, '스트리밍하던 항목을 같은 id로 마무리한다');
  assert.deepEqual(reasoning.content, ['먼저 구조를 본다']);
  const usage = events.find(event => event.method === 'usage/claude' && event.params.tokens).params;
  assert.deepEqual(usage.context, { used: 32510, window: 200000 });
  // 턴이 끝나면 유휴 종료 타이머가 걸리므로 세션을 닫아 테스트 프로세스가 끝나게 한다.
  session.child = null;
  await session.close();
});
