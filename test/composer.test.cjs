// 채팅 입력창 도우미(composer.js) 테스트.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const composer = require('../composer.js');

test('Enter 이어 쓰기는 현재 목록 항목만 변경한다', () => {
  assert.deepEqual(composer.continueList('  - 항목', 6, 6), { start: 6, end: 6, text: '\n  - ' });
  assert.deepEqual(composer.continueList('- 항목\n- ', 7, 7), { start: 5, end: 7, text: '' });
  assert.deepEqual(composer.continueList('1. 항목', 5, 5), { start: 5, end: 5, text: '\n2. ' });
  assert.equal(composer.continueList('일반 요청', 5, 5), null);
  assert.equal(composer.continueList('- 항목', 2, 4), null);
});

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

test('@ 멘션: 범주 이름이면 그 범주를, 아니면 이름으로 찾고, 검색어가 없으면 범주마다 고르게 보인다', () => {
  const entries = [
    { category: 'terminal', name: 'PowerShell 1' }, { category: 'terminal', name: 'PowerShell 2' }, { category: 'terminal', name: 'PowerShell 3' },
    { category: 'task', name: '로그인 수정' }, { category: 'note', name: '회의록' }, { category: 'rule', name: 'AGENTS.md' }
  ];
  assert.deepEqual(composer.rankMentions(entries, '터미').map(entry => entry.name), ['PowerShell 1', 'PowerShell 2', 'PowerShell 3']);
  assert.deepEqual(composer.rankMentions(entries, 'agents').map(entry => entry.name), ['AGENTS.md']);
  assert.deepEqual(composer.rankMentions(entries, '로그').map(entry => entry.name), ['로그인 수정']);
  assert.deepEqual(composer.rankMentions(entries, '').map(entry => entry.category), ['terminal', 'terminal', 'task', 'note', 'rule']);
  assert.deepEqual(composer.rankMentions(entries, 'zzz'), []);
});

test('@ 멘션 블록은 토큰 자리에 넣고 앞뒤 글과 빈 줄로 띄운다', () => {
  const text = '이 오류 봐 줘 @터미 그리고 고쳐';
  const token = composer.findToken(text, text.indexOf(' 그리고'));
  const inserted = composer.insertBlock(text, token, '[터미널]\nerror');
  assert.equal(inserted.value, '이 오류 봐 줘\n\n[터미널]\nerror\n그리고 고쳐');
  assert.equal(inserted.value.slice(0, inserted.caret), '이 오류 봐 줘\n\n[터미널]\nerror\n');
  assert.equal(composer.insertBlock('@노트', composer.findToken('@노트'), 'body').value, 'body\n');
});

