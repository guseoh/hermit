// diff 해석(renderer/git/diff.mjs) 테스트: 줄 번호, 머리 건너뛰기, 좌우 짝짓기.
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const load = () => import(pathToFileURL(path.join(__dirname, '..', 'renderer', 'git', 'diff.mjs')).href);
const sample = [
  'diff --git a/a.js b/a.js', 'index 1..2 100644', '--- a/a.js', '+++ b/a.js',
  '@@ -1,4 +1,5 @@ function main', ' keep', '-old one', '-old two', '+new one', '+new two', '+new three', ' tail',
  '\\ No newline at end of file', ''
].join('\n');

test('줄 번호를 이어 붙이고 머리와 "No newline" 줄은 건너뛴다', async () => {
  const { parsePatch } = await load();
  const { rows, truncated } = parsePatch(sample);
  assert.equal(truncated, false);
  assert.deepEqual(rows.map(row => [row.type, row.oldNumber, row.newNumber]), [
    ['hunk', '', ''], ['context', 1, 1], ['remove', 2, ''], ['remove', 3, ''], ['add', '', 2], ['add', '', 3], ['add', '', 4], ['context', 4, 5]
  ]);
  assert.equal(rows[0].header, 'function main');
  assert.equal(parsePatch(sample, 3).truncated, true);
});

test('좌우 비교: 삭제·추가를 순서대로 짝짓고 남는 쪽은 비운다', async () => {
  const { parsePatch, sideBySide } = await load();
  const pairs = sideBySide(parsePatch(sample).rows);
  const show = side => side ? side.type + ':' + (side.type === 'add' ? side.newNumber : side.oldNumber) : '-';
  assert.deepEqual(pairs.map(pair => pair.hunk ? 'hunk' : show(pair.left) + '|' + show(pair.right)),
    ['hunk', 'context:1|context:1', 'remove:2|add:2', 'remove:3|add:3', '-|add:4', 'context:4|context:4']);
});
