// 리뷰 노트 → GitHub PR 리뷰: 요청 본문(줄 범위·쪽), 422면 본문 하나로 다시 올리기.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const reviewNotes = require('../review-notes.js');
const { publishReview } = require('../changes.cjs');

const notes = [
  reviewNotes.createNote({ file: 'src/b.js', kind: 'unstaged', lines: [{ side: 'new', line: 12, text: '+x' }, { side: 'new', line: 14, text: '+y' }], body: '이름을 바꿔 주세요', now: 2 }),
  reviewNotes.createNote({ file: 'src/a.js', kind: 'unstaged', lines: [{ side: 'old', line: 5, text: '-z' }], body: '왜 지웠나요?', now: 1 })
];

test('요청 본문: 파일·줄 순서, 새 쪽은 RIGHT·삭제만 있으면 LEFT, 여러 줄은 start_line', () => {
  const payload = reviewNotes.pullReviewPayload(notes, 'abc123');
  assert.equal(payload.commit_id, 'abc123');
  assert.equal(payload.event, 'COMMENT');
  assert.deepEqual(payload.comments, [
    { path: 'src/a.js', line: 5, side: 'LEFT', body: '왜 지웠나요?' },
    { path: 'src/b.js', line: 14, side: 'RIGHT', body: '이름을 바꿔 주세요', start_line: 12, start_side: 'RIGHT' }
  ]);
  assert.match(reviewNotes.pullReviewSummary(notes), /\*\*src\/a\.js \(삭제된 줄 5\)\*\*\n왜 지웠나요\?/);
});

function githubRepo() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hermit-review-'));
  execFileSync('git', ['-C', root, 'init', '-q']);
  execFileSync('git', ['-C', root, 'remote', 'add', 'origin', 'git@github.com:example/repo.git']);
  return root;
}

test('인라인으로 올리고, 줄이 PR diff에 없어 422가 나면 본문 하나로 다시 올린다', async () => {
  const root = githubRepo();
  const payload = reviewNotes.pullReviewPayload(notes, 'abc123');
  const sent = [];
  const ok = await publishReview(root, 7, payload, 'summary', async (cwd, args, input) => { sent.push([args[3], JSON.parse(input)]); return '{"html_url":"https://github.com/example/repo/pull/7#r1"}'; });
  assert.deepEqual(ok, { inline: true, url: 'https://github.com/example/repo/pull/7#r1', comments: 2 });
  assert.equal(sent[0][0], 'repos/example/repo/pulls/7/reviews');
  sent.length = 0;
  let calls = 0;
  const fallback = await publishReview(root, 7, payload, 'summary', async (cwd, args, input) => {
    calls++;
    if (calls === 1) throw Object.assign(new Error('failed'), { stderr: 'HTTP 422: Unprocessable Entity (line must be part of the diff)' });
    sent.push(JSON.parse(input));
    return '{"html_url":"u"}';
  });
  assert.deepEqual(fallback, { inline: false, url: 'u', comments: 2 });
  assert.deepEqual(sent, [{ commit_id: 'abc123', event: 'COMMENT', body: 'summary' }]);
  await assert.rejects(publishReview(root, 7, payload, 's', async () => { throw Object.assign(new Error('x'), { stderr: 'HTTP 401: Bad credentials' }); }), /올리지 못했습니다: HTTP 401/);
  await assert.rejects(publishReview(root, 0, payload, 's', async () => '{}'), /PR을 찾을 수 없습니다/);
});
