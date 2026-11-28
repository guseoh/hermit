// squash 병합 감지(changes.cjs mergedPullRequestFor) 테스트: 병합된 PR의 head가 로컬 브랜치 끝과 같을 때만 병합으로 본다.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { mergedPullRequestFor } = require('../changes.cjs');

function repository() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hermit-squash-'));
  const git = (...args) => execFileSync('git', ['-C', root, ...args], { encoding: 'utf8' }).trim();
  git('init', '-q');
  git('config', 'user.email', 't@example.com');
  git('config', 'user.name', 't');
  git('remote', 'add', 'origin', 'https://github.com/example/repo.git');
  fs.writeFileSync(path.join(root, 'a.txt'), '1');
  git('add', '.');
  git('commit', '-q', '-m', 'init');
  git('checkout', '-q', '-b', 'agent/task');
  fs.writeFileSync(path.join(root, 'a.txt'), '2');
  git('commit', '-qam', 'work');
  return { root, head: git('rev-parse', 'HEAD') };
}

test('병합된 PR의 head가 브랜치 끝과 같으면 그 PR을 돌려준다', async () => {
  const { root, head } = repository();
  const calls = [];
  const fake = async (cwd, repo, args) => {
    calls.push([repo, args.slice(0, 5)]);
    return JSON.stringify([{ number: 7, headRefOid: 'deadbeef', mergedAt: 'x', url: 'u7' }, { number: 9, headRefOid: head, mergedAt: '2026-11-28', url: 'u9' }]);
  };
  assert.deepEqual(await mergedPullRequestFor(root, 'agent/task', fake), { number: 9, url: 'u9', mergedAt: '2026-11-28' });
  assert.deepEqual(calls, [['example/repo', ['pr', 'list', '--head', 'agent/task', '--state']]]);
});

test('병합 뒤 로컬에 커밋이 더 있거나, gh가 실패하거나, GitHub 원격이 아니면 병합으로 보지 않는다', async () => {
  const { root } = repository();
  assert.equal(await mergedPullRequestFor(root, 'agent/task', async () => JSON.stringify([{ number: 7, headRefOid: 'older', url: 'u' }])), null);
  assert.equal(await mergedPullRequestFor(root, 'agent/task', async () => { throw new Error('gh: not logged in'); }), null);
  execFileSync('git', ['-C', root, 'remote', 'set-url', 'origin', 'https://gitlab.com/example/repo.git']);
  let called = false;
  assert.equal(await mergedPullRequestFor(root, 'agent/task', async () => { called = true; return '[]'; }), null);
  assert.equal(called, false);
});

