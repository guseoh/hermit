// 채팅 마크다운(renderer/chat/markdown.mjs) 테스트: 블록 파서, 인라인 서식, 구문 강조 토큰.
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const load = () => import(pathToFileURL(path.join(__dirname, '..', 'renderer', 'chat', 'markdown.mjs')).href);

test('블록을 나누고 블록마다 원문을 남긴다(증분 렌더의 비교 기준)', async () => {
  const { parseBlocks } = await load();
  const blocks = parseBlocks('# 제목\n\n첫 줄\n둘째 줄\n\n> 인용\n> 이어짐\n\n---\n\n```js\nconst a = 1;\n```');
  assert.deepEqual(blocks.map(block => block.type), ['heading', 'paragraph', 'quote', 'rule', 'code']);
  assert.equal(blocks[1].text, '첫 줄\n둘째 줄');
  assert.equal(blocks[2].text, '인용\n이어짐');
  assert.deepEqual([blocks[4].lang, blocks[4].text, blocks[4].closed], ['js', 'const a = 1;', true]);
  assert.equal(blocks[4].source, '```js\nconst a = 1;\n```');
});

test('스트리밍 중 닫히지 않은 코드 블록은 끝까지 코드로 보고, 앞 블록의 원문은 바뀌지 않는다', async () => {
  const { parseBlocks } = await load();
  const before = parseBlocks('설명\n\n```py\nprint(1)');
  const after = parseBlocks('설명\n\n```py\nprint(1)\nprint(2)');
  assert.equal(before[0].source, after[0].source);
  assert.deepEqual([after[1].closed, after[1].text], [false, 'print(1)\nprint(2)']);
});

test('목록: 체크박스, 번호 시작값, 들여쓴 하위 항목, 이어지는 줄', async () => {
  const { parseBlocks } = await load();
  const [list] = parseBlocks('- [x] 끝남\n- [ ] 남음\n  - 하위\n    이어지는 줄');
  assert.deepEqual(list.items.map(item => [item.text, item.checked, item.depth]), [['끝남', true, 0], ['남음', false, 0], ['하위\n이어지는 줄', undefined, 1]]);
  const [ordered] = parseBlocks('3. 셋\n4. 넷');
  assert.deepEqual([ordered.ordered, ordered.items[0].start], [true, 3]);
});

test('표는 구분선이 있을 때만 표로 본다', async () => {
  const { parseBlocks } = await load();
  assert.equal(parseBlocks('a | b\n--- | ---\n1 | 2')[0].type, 'table');
  assert.deepEqual(parseBlocks('| a | b |\n|---|:---:|\n| 1 | 2 |')[0].rows, [['1', '2']]);
  assert.equal(parseBlocks('a | b 는 표가 아니다')[0].type, 'paragraph');
});

test('인라인: 코드 안은 서식을 풀지 않고, 링크는 http·https만 만든다', async () => {
  const { parseInline } = await load();
  const tokens = parseInline('**굵게** `a*b*c` [문서](https://example.com/x) https://a.dev/p. javascript:alert(1)');
  assert.deepEqual(tokens.filter(token => token.type !== 'text').map(token => [token.type, token.text ?? token.href]),
    [['strong', undefined], ['code', 'a*b*c'], ['link', 'https://example.com/x'], ['link', 'https://a.dev/p']]);
  assert.ok(tokens.some(token => token.type === 'text' && token.text.includes('javascript:alert(1)')));
  assert.equal(parseInline('2 * 3 * 4').length, 1, '공백으로 둘러싼 별표는 기울임이 아니다');
});

test('구문 강조: 언어별 주석·문자열·키워드, 모르는 언어는 그대로', async () => {
  const { highlightTokens } = await load();
  const kinds = (code, lang) => highlightTokens(code, lang).filter(token => token.type !== 'plain').map(token => token.type + ':' + token.text);
  assert.deepEqual(kinds('const s = "x"; // 끝', 'ts'), ['keyword:const', 'string:"x"', 'comment:// 끝']);
  assert.deepEqual(kinds('if ($x -eq 1) { Write-Host "hi" } # c', 'powershell'), ['keyword:if', 'variable:$x', 'number:1', 'string:"hi"', 'comment:# c']);
  assert.deepEqual(kinds('def f(): return None', 'python'), ['keyword:def', 'keyword:return', 'keyword:None']);
  assert.deepEqual(highlightTokens('아무거나', 'unknownlang'), [{ type: 'plain', text: '아무거나' }]);
  assert.equal(highlightTokens('a "b" c', 'js').map(token => token.text).join(''), 'a "b" c', '토큰을 합치면 원문과 같다');
});
