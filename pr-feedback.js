// PR 피드백에서 새 항목을 고르고, 에이전트에게 보낼 메시지를 만든다.
// 렌더러(window.prFeedback)와 Node 테스트(require) 양쪽에서 쓴다.
(function (root) {
  const maxItemText = 2000;
  const maxMessage = 30000;

  // 리뷰 봇 본문의 HTML 태그·배지 이미지를 걷어 내고 길이를 줄인다.
  function cleanBody(text) {
    return String(text ?? '')
      .replace(/<!--[\s\S]*?-->/g, '')
      .replace(/!\[[^\]]*\]\([^)]*\)/g, '')
      .replace(/<\/?(?:sub|sup|details|summary|br|p|div|span|img)[^>]*>/gi, '')
      .replace(/^Useful\? React with .*$/gm, '')
      .replace(/\*\*[ \t]+(?=\S)/g, '**')
      .replace(/\r\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim()
      .slice(0, maxItemText);
  }

  const checkKey = (head, check) => head + ':' + check.workflow + '/' + check.name;

  // seen이 없으면(처음 본 PR) 기존 리뷰·코멘트는 본 것으로 치고, 지금 실패 중인 체크만 조용히 보여 준다.
  function diffFeedback(feedback, seen) {
    const failed = feedback.checks.filter(check => check.failed);
    const ids = new Set(seen?.ids ?? []);
    const checks = new Set(seen?.checks ?? []);
    const first = !seen || seen.number !== feedback.number;
    const isNew = item => !first && !ids.has(item.id);
    const items = {
      failedChecks: failed.filter(check => !checks.has(checkKey(feedback.head, check))),
      reviews: feedback.reviews.filter(isNew),
      comments: feedback.comments.filter(isNew),
      reviewComments: feedback.reviewComments.filter(isNew)
    };
    const next = {
      number: feedback.number,
      checks: failed.map(check => checkKey(feedback.head, check)),
      ids: [...feedback.reviews, ...feedback.comments, ...feedback.reviewComments].map(item => item.id).slice(-500)
    };
    return { items, next, quiet: first };
  }

  const count = items => items.failedChecks.length + items.reviews.length + items.comments.length + items.reviewComments.length;

  function summary(items) {
    return [
      items.failedChecks.length && '실패한 체크 ' + items.failedChecks.length,
      items.reviews.length && '리뷰 ' + items.reviews.length,
      items.reviewComments.length && '코드 코멘트 ' + items.reviewComments.length,
      items.comments.length && '댓글 ' + items.comments.length
    ].filter(Boolean).join(' · ');
  }

  // 아직 보내지 않은 항목에 새 항목을 더한다(같은 id·체크는 한 번만).
  function mergeItems(previous, next) {
    if (!previous) return next;
    const merged = {};
    for (const key of ['failedChecks', 'reviews', 'comments', 'reviewComments']) {
      const seen = new Set();
      merged[key] = [...previous[key], ...next[key]].filter(item => {
        const id = item.id ?? item.workflow + '/' + item.name;
        if (seen.has(id)) return false;
        seen.add(id);
        return true;
      });
    }
    return merged;
  }

  const reviewStates = { APPROVED: '승인', CHANGES_REQUESTED: '수정 요청', COMMENTED: '코멘트', DISMISSED: '취소됨' };

  function composeMessage(feedback, items, logs = {}) {
    const parts = [
      'PR #' + feedback.number + ' (' + feedback.url + ')에 확인할 피드백이 있습니다.',
      '아래 내용을 검토하고, 타당한 지적은 코드를 고쳐 주세요. 동의하지 않는 항목은 이유를 설명해 주세요.'
    ];
    if (items.failedChecks.length) {
      parts.push('', '## 실패한 체크');
      for (const check of items.failedChecks) {
        parts.push('- ' + (check.workflow ? check.workflow + ' / ' : '') + check.name + ' (' + check.state + ')' + (check.url ? ' ' + check.url : ''));
        const log = logs[check.url];
        if (log) parts.push('  실패 로그 끝부분:', '```', log, '```');
      }
    }
    if (items.reviews.length) {
      parts.push('', '## 리뷰');
      for (const review of items.reviews) {
        parts.push('- @' + review.author + ' (' + (reviewStates[review.state] ?? review.state) + ')' + (review.body.trim() ? ':\n' + indent(cleanBody(review.body)) : ''));
      }
    }
    if (items.reviewComments.length) {
      parts.push('', '## 코드 리뷰 코멘트');
      for (const comment of items.reviewComments) {
        parts.push('- ' + comment.path + (comment.line ? ':' + comment.line : '') + ' @' + comment.author + ':\n' + indent(cleanBody(comment.body)));
      }
    }
    if (items.comments.length) {
      parts.push('', '## PR 댓글');
      for (const comment of items.comments) parts.push('- @' + comment.author + ':\n' + indent(cleanBody(comment.body)));
    }
    let message = parts.join('\n');
    if (message.length > maxMessage) message = message.slice(0, maxMessage) + '\n\n(길어서 뒷부분을 생략했습니다. 나머지는 PR에서 확인하세요.)';
    return message;
  }

  function indent(text) {
    return text.split('\n').map(line => '  ' + line).join('\n');
  }

  function updateFollowups(history, feedback) {
    for (const entry of history ?? []) {
      if (entry.number !== feedback.number || entry.repository !== feedback.repository) continue;
      entry.latestHead = feedback.head;
      for (const check of entry.checks) {
        const latest = feedback.checks.find(item => item.workflow === check.workflow && item.name === check.name);
        check.latestState = latest?.state || '결과 대기';
      }
    }
  }

  const api = { updateFollowups, cleanBody, diffFeedback, summary, mergeItems, composeMessage, count };
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.prFeedback = api;
})(globalThis);
