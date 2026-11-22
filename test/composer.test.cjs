// 채팅 입력창 도우미(composer.js) 테스트.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const composer = require('../composer.js');

test('커서 앞의 /명령과 @파일을 찾는다', () => {
  assert.deepEqual(composer.findToken('/ter'), { kind: 'command', query: 'ter', start: 0, end: 4 });
  assert.deepEqual(composer.findToken('/'), { kind: 'command', query: '', start: 0, end: 1 });
  assert.equal(composer.findToken('/terminal now'), null, '명령 뒤에 띄어 쓰면 끝');
  assert.equal(composer.findToken('a /ter'), null, '명령은 입력 첫머리에서만');
  assert.deepEqual(composer.findToken('고쳐 줘 @src/ma'), { kind: 'file', query: 'src/ma', start: 5, end: 12 });
  assert.deepEqual(composer.findToken('@'), { kind: 'file', query: '', start: 0, end: 1 });
  assert.equal(composer.findToken('mail@example.com'), null, '단어 중간의 @는 아님');
  assert.deepEqual(composer.findToken('@a.js 그리고', 5), { kind: 'file', query: 'a.js', start: 0, end: 5 }, '커서 위치 기준');
});

test('파일 후보는 이름이 검색어로 시작하는 것부터, 같으면 짧은 경로부터', () => {
  const files = ['src/main.cjs', 'docs/main-notes.md', 'test/domain.test.cjs', 'lib/m/a/i/n.js', 'README.md'];
  assert.deepEqual(composer.rankFiles(files, 'main'), ['src/main.cjs', 'docs/main-notes.md', 'test/domain.test.cjs', 'lib/m/a/i/n.js']);
  assert.deepEqual(composer.rankFiles(files, 'docs/'), ['docs/main-notes.md']);
  assert.deepEqual(composer.rankFiles(files, 'SRC\\MAIN'), ['src/main.cjs'], '대소문자·역슬래시 무시');
  assert.equal(composer.rankFiles(files, '', 3).length, 3);
  assert.deepEqual(composer.rankFiles(files, 'zzz'), []);
});

test('명령은 이름이나 설명으로 고른다', () => {
  assert.deepEqual(composer.matchCommands('te').map(c => c.name), ['terminal']);
  assert.ok(composer.matchCommands('').length >= 5);
  assert.deepEqual(composer.matchCommands('대기열').map(c => c.name), ['queue']);
});

test('고른 후보로 토큰을 바꾼다(파일은 @경로, 공백 있는 경로는 따옴표, 명령은 지움)', () => {
  const text = '고쳐 줘 @src/ma 부탁';
  const token = composer.findToken(text, 12);
  assert.deepEqual(composer.applyChoice(text, token, 'src/main.cjs'), { value: '고쳐 줘 @src/main.cjs  부탁', caret: 19 });
  assert.equal(composer.applyChoice('@my', composer.findToken('@my'), 'my file.txt').value, '@"my file.txt" ');
  assert.deepEqual(composer.applyChoice('/ter', composer.findToken('/ter'), 'terminal'), { value: '', caret: 0 });
});
