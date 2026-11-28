const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { historyPath, prepareTerminal, syncHistory, saveHistory } = require('../main/claude-history-sync.cjs');

test('TUI 최초 실행과 반복 전환에서 같은 세션의 새 대화만 복원한다', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'hermit-claude-history-'));
  const previous = process.env.CLAUDE_CONFIG_DIR;
  process.env.CLAUDE_CONFIG_DIR = root;
  t.after(async () => {
    if (previous === undefined) delete process.env.CLAUDE_CONFIG_DIR;
    else process.env.CLAUDE_CONFIG_DIR = previous;
    await fs.rm(root, { recursive: true, force: true });
  });
  const file = historyPath(path.join(root, 'hermit'), '11111111-1111-4111-8111-111111111111');
  const cwd = path.join(root, 'work');
  assert.throws(() => historyPath(root, '../history'));
  const launch = await prepareTerminal(file, cwd);
  assert.equal(launch.resume, false);
  // 입력 없이 종료한 뒤 다시 열어도 아직 만들어지지 않은 CLI 세션을 resume하지 않는다.
  await syncHistory(file, cwd);
  assert.deepEqual(await prepareTerminal(file, cwd), launch);
  const { sessionId } = launch;
  const project = path.join(root, 'projects', 'custom-worktree-key');
  await fs.mkdir(project, { recursive: true });
  const log = path.join(project, sessionId + '.jsonl');
  const row = (uuid, type, content, extra) => JSON.stringify({
    sessionId, uuid, type, message: { content }, ...extra
  }) + '\n';
  await fs.writeFile(log, row('a', 'user', '한글 요청') +
    row('b', 'assistant', [{ type: 'tool_use', id: 'tool-1', name: 'Read', input: {} }]) +
    row('c', 'user', [{ type: 'tool_result', tool_use_id: 'tool-1', content: '내용' }]) +
    row('d', 'assistant', [{ type: 'text', text: '첫 답변' }]) +
    row('e', 'user', '별도 세션', { sessionId: 'other' }) +
    row('f', 'assistant', '하위 에이전트', { isSidechain: true }));
  const history = await syncHistory(file, cwd);
  assert.equal(history.sessionId, sessionId);
  assert.equal(history.items.length, 3);
  assert.equal(history.items[0].content[0].text, '한글 요청');
  assert.equal(history.items[1].output, '내용');
  assert.equal(history.items[2].text, '첫 답변');
  // Hermit이 채팅 턴을 자체 ID로 이미 기록한 경우 JSONL 사본은 가져오지 않는다.
  history.items.push({ id: 'original-chat-id', type: 'agentMessage', text: '채팅 답변' });
  await saveHistory(file, history);
  await fs.appendFile(log, row('g', 'assistant', '채팅 답변'));
  assert.deepEqual(await prepareTerminal(file, cwd), { sessionId, resume: true });
  await fs.appendFile(log, row('h', 'user', '한글 요청'));
  const next = await syncHistory(file, cwd);
  assert.deepEqual(next.items.map(item => item.id), [...history.items.map(item => item.id), 'tui-h-0']);
  assert.deepEqual(await syncHistory(file, cwd), next);
});
