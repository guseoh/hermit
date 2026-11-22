// PR 피드백 판별·메시지(pr-feedback.js)와 체크 정규화(changes.cjs) 테스트. GitHub는 호출하지 않는다.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const prFeedback = require('../pr-feedback.js');
const { normalizeCheck } = require('../changes.cjs');

const feedback = (overrides = {}) => ({
  repository: 'owner/repo', number: 7, url: 'https://github.com/owner/repo/pull/7', title: '로그인 수정', head: 'aaa',
  checks: [
    { name: 'test', workflow: 'CI', state: 'FAILURE', failed: true, url: 'https://github.com/owner/repo/actions/runs/1/job/2' },
    { name: 'lint', workflow: 'CI', state: 'SUCCESS', failed: false, url: '' }
  ],
  reviews: [{ id: 'R1', author: 'kim', state: 'CHANGES_REQUESTED', body: '에러 처리를 추가하세요.' }],
  comments: [{ id: 'C1', author: 'lee', body: '좋아요' }],
  reviewComments: [{ id: '11', author: 'bot[bot]', body: '**<sub>![P1](x)</sub> 널 확인**\n\n<!-- id -->', path: 'a.js', line: 3 }],
  ...overrides
});

test('체크 결과를 실패 여부와 함께 정규화한다', () => {
  assert.deepEqual(normalizeCheck({ __typename: 'CheckRun', name: 'test', workflowName: 'CI', status: 'COMPLETED', conclusion: 'FAILURE', detailsUrl: 'u' }),
    { name: 'test', workflow: 'CI', state: 'FAILURE', failed: true, url: 'u' });
  assert.equal(normalizeCheck({ __typename: 'CheckRun', name: 't', status: 'IN_PROGRESS', conclusion: null }).failed, false);
  assert.equal(normalizeCheck({ __typename: 'CheckRun', name: 't', status: 'COMPLETED', conclusion: 'SUCCESS' }).failed, false);
  assert.deepEqual(normalizeCheck({ __typename: 'StatusContext', context: 'ci/x', state: 'ERROR', targetUrl: 't' }),
    { name: 'ci/x', workflow: '', state: 'ERROR', failed: true, url: 't' });
});

test('처음 본 PR은 기존 리뷰·코멘트를 본 것으로 치고, 실패한 체크만 조용히 보여 준다', () => {
  const { items, next, quiet } = prFeedback.diffFeedback(feedback(), undefined);
  assert.equal(quiet, true);
  assert.deepEqual(items.failedChecks.map(check => check.name), ['test']);
  assert.equal(items.reviews.length + items.comments.length + items.reviewComments.length, 0);
  assert.deepEqual(next.ids.sort(), ['11', 'C1', 'R1']);
  assert.deepEqual(next.checks, ['aaa:CI/test']);
});

test('이후에는 새 항목만 고르고, 같은 커밋에서 이미 본 실패는 다시 알리지 않는다', () => {
  const seen = prFeedback.diffFeedback(feedback(), undefined).next;
  assert.equal(prFeedback.count(prFeedback.diffFeedback(feedback(), seen).items), 0);

  const later = feedback({ reviews: [...feedback().reviews, { id: 'R2', author: 'kim', state: 'APPROVED', body: '' }] });
  const { items, quiet } = prFeedback.diffFeedback(later, seen);
  assert.equal(quiet, false);
  assert.deepEqual(items.reviews.map(review => review.id), ['R2']);

  const newHead = prFeedback.diffFeedback(feedback({ head: 'bbb' }), seen);
  assert.deepEqual(newHead.items.failedChecks.map(check => check.name), ['test'], '새 커밋에서 다시 실패하면 다시 보여 준다');

  const otherPr = prFeedback.diffFeedback(feedback({ number: 8 }), seen);
  assert.equal(otherPr.quiet, true, '다른 PR이면 처음 본 것으로 다룬다');
});

test('보내지 않은 항목에 새 항목을 중복 없이 더한다', () => {
  const first = { failedChecks: [feedback().checks[0]], reviews: [feedback().reviews[0]], comments: [], reviewComments: [] };
  const second = { failedChecks: [feedback().checks[0]], reviews: [{ id: 'R2', author: 'a', state: 'COMMENTED', body: 'x' }], comments: [], reviewComments: [] };
  const merged = prFeedback.mergeItems(first, second);
  assert.equal(merged.failedChecks.length, 1);
  assert.deepEqual(merged.reviews.map(review => review.id), ['R1', 'R2']);
  assert.equal(prFeedback.summary(merged), '실패한 체크 1 · 리뷰 2');
  assert.equal(prFeedback.mergeItems(null, second), second);
});

test('에이전트에게 보낼 메시지에 체크 로그·리뷰·코멘트를 담고, 봇 장식은 걷어 낸다', () => {
  const data = feedback();
  const items = { failedChecks: [data.checks[0]], reviews: data.reviews, comments: data.comments, reviewComments: data.reviewComments };
  const message = prFeedback.composeMessage(data, items, { [data.checks[0].url]: 'Error: expected 1 to be 2' });
  assert.match(message, /^PR #7 \(https:\/\/github\.com\/owner\/repo\/pull\/7\)/);
  assert.match(message, /## 실패한 체크\n- CI \/ test \(FAILURE\)/);
  assert.match(message, /Error: expected 1 to be 2/);
  assert.match(message, /@kim \(수정 요청\):\n  에러 처리를 추가하세요\./);
  assert.match(message, /- a\.js:3 @bot\[bot\]:\n  \*\*널 확인\*\*/);
  assert.doesNotMatch(message, /<sub>|<!--|!\[P1\]/);
  assert.match(message, /## PR 댓글\n- @lee:\n  좋아요/);
});

test('너무 긴 메시지는 자르고 안내를 붙인다', () => {
  const data = feedback({ comments: [{ id: 'C9', author: 'x', body: 'y'.repeat(1990) }] });
  const many = { failedChecks: [], reviews: [], reviewComments: [], comments: Array.from({ length: 30 }, (_, i) => ({ ...data.comments[0], id: 'C' + i })) };
  const message = prFeedback.composeMessage(data, many);
  assert.ok(message.length < 30200);
  assert.match(message, /뒷부분을 생략했습니다/);
});
