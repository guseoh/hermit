// diff 줄별 리뷰 노트(review-notes.js) 테스트.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const notes = require('../review-notes.js');

const note = (file, lines, body, at = 1) => notes.createNote({ file, kind: 'unstaged', lines, body, id: file + at, now: at });

test('노트는 파일·줄·내용이 있어야 만들어진다', () => {
  assert.throws(() => notes.createNote({ file: 'a.js', lines: [], body: 'x' }), /줄을 선택/);
  assert.throws(() => notes.createNote({ file: 'a.js', lines: [{ side: 'new', line: 3, text: '+a' }], body: '  ' }), /내용을 입력/);
  assert.throws(() => notes.createNote({ file: 'a.js', lines: [{ side: 'new', line: 0, text: '+a' }], body: 'x' }), /줄을 선택/);
  assert.throws(() => notes.createNote({ file: 'a.js', lines: [{ side: 'new', line: 1, text: '+a' }], body: 'x'.repeat(4001) }), /4000자/);
  const created = notes.createNote({ file: 'a.js', kind: 'staged', lines: [{ side: 'weird', line: 2, text: '+b' }], body: '  고치기  ' });
  assert.equal(created.body, '고치기');
  assert.equal(created.lines[0].side, 'new');
  assert.match(created.id, /^n/);
});

test('위치는 새 쪽 줄 범위를 우선 쓰고, 삭제된 줄만 있으면 따로 표시한다', () => {
  assert.equal(notes.location(note('a.js', [{ side: 'new', line: 12, text: '+x' }], 'n')), 'a.js:12');
  assert.equal(notes.location(note('a.js', [{ side: 'new', line: 15, text: '+x' }, { side: 'new', line: 12, text: '+y' }], 'n')), 'a.js:12-15');
  assert.equal(notes.location(note('a.js', [{ side: 'old', line: 10, text: '-x' }, { side: 'new', line: 10, text: '+y' }], 'n')),
    'a.js:10 (삭제된 줄 10 포함)');
  assert.equal(notes.location(note('a.js', [{ side: 'old', line: 4, text: '-x' }, { side: 'old', line: 5, text: '-y' }], 'n')), 'a.js (삭제된 줄 4-5)');
  assert.deepEqual(notes.anchor(note('a.js', [{ side: 'old', line: 9, text: '-x' }, { side: 'new', line: 3, text: '+y' }], 'n')), { side: 'new', line: 3 });
});

test('여러 파일의 노트를 파일·줄 순서로 묶어 한 메시지로 만든다', () => {
  const all = [
    note('src/b.js', [{ side: 'new', line: 40, text: '+  return x;' }], '널 확인이 필요합니다.', 1),
    note('src/a.js', [{ side: 'new', line: 20, text: '+const y = 2;' }], '이름을 바꿔 주세요.', 2),
    note('src/a.js', [{ side: 'new', line: 5, text: '+const x = 1;' }, { side: 'new', line: 6, text: '+let z;' }], '상수로 만들어 주세요.\n두 줄 모두요.', 3)
  ];
  const message = notes.composeMessage(all);
  assert.match(message, /^변경사항을 검토하고 diff에 리뷰 노트 3개를 남겼습니다\./);
  const order = ['## src/a.js', '1. src/a.js:5-6', '2. src/a.js:20', '## src/b.js', '3. src/b.js:40'].map(text => message.indexOf(text));
  assert.ok(order.every(index => index >= 0), message);
  assert.deepEqual([...order].sort((a, b) => a - b), order, '파일과 줄 순서대로 나온다');
  assert.match(message, /```diff\n\+const x = 1;\n\+let z;\n```\n노트: 상수로 만들어 주세요\.\n      두 줄 모두요\./);
  assert.match(message, / · 작업 트리/);
});

test('노트 수 한도를 넘기면 거부한다', () => {
  const full = Array.from({ length: notes.maxNotes }, (_, i) => note('a.js', [{ side: 'new', line: i + 1, text: '+' }], 'n', i));
  assert.throws(() => notes.addNote(full, note('a.js', [{ side: 'new', line: 1, text: '+' }], 'n', 999)), /200개까지/);
  assert.equal(notes.addNote([], full[0]).length, 1);
});

test('저장값을 읽을 때 형식이 맞는 노트만 남긴다', () => {
  const good = note('a.js', [{ side: 'new', line: 1, text: '+a' }], 'ok');
  assert.deepEqual(notes.load(JSON.stringify({ 'C:\\repo': [good, { id: 1 }, null], 'C:\\empty': [], bad: 'x' })), { 'C:\\repo': [good] });
  assert.deepEqual(notes.load('{깨짐'), {});
  assert.deepEqual(notes.load(null), {});
  assert.deepEqual(notes.load('[1]'), {});
});
