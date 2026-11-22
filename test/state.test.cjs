// 상태 파일(state.cjs) 저장·복원 테스트.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const state = require('../state.cjs');

const temporaryFile = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'workbench-state-')), 'nested', 'state.json');

test('앱 키만 남기고 문자열이 아닌 값은 버린다', () => {
  assert.deepEqual(state.sanitize({
    'agent-workbench-tasks-v1': '[]', 'workbench.result-pins': '{}', 'collapsed-results-panel': 'true',
    'agent-exe-codex': 'C:\\codex.exe', other: 'x', 'agent-bad key': 'x', 'workbench-number': 1
  }), {
    'agent-workbench-tasks-v1': '[]', 'workbench.result-pins': '{}', 'collapsed-results-panel': 'true',
    'agent-exe-codex': 'C:\\codex.exe'
  });
  assert.throws(() => state.sanitize(null), /잘못된 상태/);
  assert.throws(() => state.sanitize(['x']), /잘못된 상태/);
  assert.throws(() => state.sanitize({ 'workbench-big': 'x'.repeat(9 * 1024 * 1024) }), /8MB/);
});

test('쓴 내용을 그대로 다시 읽는다', () => {
  const file = temporaryFile();
  assert.equal(state.read(file), null, '파일이 없으면 null');
  const values = { 'agent-workbench-tasks-v1': JSON.stringify([{ id: '1', name: '한글 작업' }]), 'workbench-sleep-mode': 'off' };
  assert.equal(state.write(file, values), 2);
  assert.deepEqual(state.read(file), values);
  assert.ok(!fs.existsSync(file + '.tmp'), '임시 파일이 남지 않는다');
  state.write(file, { 'workbench-sleep-mode': 'always' });
  assert.deepEqual(state.read(file), { 'workbench-sleep-mode': 'always' }, '덮어쓴다');
});

test('깨진 파일과 다른 버전 파일은 따로 보관하고 null을 돌려준다', () => {
  for (const content of ['{ 깨진 JSON', JSON.stringify({ version: 99, values: {} })]) {
    const file = temporaryFile();
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, content);
    assert.equal(state.read(file), null);
    assert.ok(!fs.existsSync(file));
    assert.equal(fs.readdirSync(path.dirname(file)).filter(name => name.startsWith('state.json.corrupt-')).length, 1);
  }
});

test('렌더러와 메인의 키 규칙이 같다', () => {
  const renderer = fs.readFileSync(path.join(__dirname, '..', 'renderer.js'), 'utf8');
  const match = /const stateKeyPattern = (\/.+\/);/.exec(renderer);
  assert.ok(match, 'renderer.js에 stateKeyPattern이 있어야 한다');
  assert.equal(match[1], state.keyPattern.toString());
});
