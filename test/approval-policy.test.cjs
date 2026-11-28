// 승인 정책(renderer/chat/approval.mjs) 테스트: 셸 래퍼 벗기기, 접두사 규칙, 거부 우선, 이어진 명령, 위험도.
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const load = () => import(pathToFileURL(path.join(__dirname, '..', 'renderer', 'chat', 'approval.mjs')).href);
const command = text => ({ method: 'item/commandExecution/requestApproval', command: text });

test('Codex가 감싼 PowerShell·cmd 래퍼를 벗겨 실제 명령만 비교한다', async () => {
  const { normalizeCommand } = await load();
  assert.equal(normalizeCommand('"C:\\WINDOWS\\System32\\WindowsPowerShell\\v1.0\\powershell.exe" -Command \'npm   test\''), 'npm test');
  assert.equal(normalizeCommand('pwsh.exe -NoProfile -Command "git status"'), 'git status');
  assert.equal(normalizeCommand('cmd /c dir'), 'dir');
  assert.equal(normalizeCommand('bash -lc \'ls -la\''), 'ls -la');
  assert.equal(normalizeCommand(['git', 'diff']), 'git diff');
});

test('접두사는 단어 경계로만 맞고, 거부 규칙이 허용보다 우선한다', async () => {
  const { approvalSubject, decide } = await load();
  const policy = { global: { allow: ['npm test', 'git'], deny: ['git push'] }, projects: {} };
  assert.deepEqual(decide(policy, 'p', approvalSubject(command('npm test -- --watch'))), { action: 'allow', rule: 'npm test', scope: '전역' });
  assert.equal(decide(policy, 'p', approvalSubject(command('npm testing'))), null);
  assert.deepEqual(decide(policy, 'p', approvalSubject(command('git push --force origin main'))), { action: 'deny', rule: 'git push', scope: '전역' });
  assert.equal(decide(policy, 'p', approvalSubject(command('git status'))).action, 'allow');
});

test('프로젝트 규칙이 전역보다 먼저 쓰이고, 다른 프로젝트에는 적용되지 않는다', async () => {
  const { approvalSubject, decide } = await load();
  const policy = { global: { allow: [], deny: [] }, projects: { a: { allow: ['npm run build'], deny: [] } } };
  assert.equal(decide(policy, 'a', approvalSubject(command('npm run build'))).scope, '프로젝트');
  assert.equal(decide(policy, 'b', approvalSubject(command('npm run build'))), null);
});

test('이어진 명령은 모든 조각이 허용일 때만 허용하고, 한 조각이라도 거부면 거부한다', async () => {
  const { approvalSubject, decide, commandSegments } = await load();
  assert.deepEqual(commandSegments('npm test && git push; echo "a;b" | more'), ['npm test', 'git push', 'echo "a;b"', 'more']);
  const policy = { global: { allow: ['npm test', 'echo'], deny: ['rm'] }, projects: {} };
  assert.equal(decide(policy, 'p', approvalSubject(command('npm test && echo done'))).action, 'allow');
  assert.equal(decide(policy, 'p', approvalSubject(command('npm test && curl x'))), null, '허용되지 않은 조각이 있으면 묻는다');
  assert.equal(decide(policy, 'p', approvalSubject(command('echo hi; rm -rf build'))).action, 'deny');
});

test('Claude 도구: Bash는 명령으로, 그 밖의 도구는 tool: 규칙으로 판단한다', async () => {
  const { approvalSubject, decide, sessionKey } = await load();
  const bash = approvalSubject({ method: 'claude/approval', tool: 'Bash', input: { command: 'npm test' } });
  const edit = approvalSubject({ method: 'claude/approval', tool: 'Edit', input: { file_path: 'a.js' } });
  const policy = { global: { allow: ['npm test', 'tool:Edit'], deny: [] }, projects: {} };
  assert.equal(bash.kind, 'command');
  assert.equal(decide(policy, 'p', bash).rule, 'npm test');
  assert.equal(decide(policy, 'p', edit).rule, 'tool:Edit');
  assert.equal(sessionKey(bash), 'command:npm test');
  assert.equal(sessionKey(edit), 'tool:edit');
});

test('항상 허용 접두사 제안과 위험도 요약', async () => {
  const { suggestPrefix, riskOf, approvalSubject } = await load();
  assert.equal(suggestPrefix('npm test -- --watch'), 'npm test');
  assert.equal(suggestPrefix('C:\\tools\\node.exe script.js'), 'node script.js');
  assert.equal(suggestPrefix('git -C repo status'), 'git');
  assert.equal(suggestPrefix('ls ./src'), 'ls');
  assert.equal(riskOf(approvalSubject(command('Remove-Item -Recurse -Force build'))).level, 'danger');
  assert.equal(riskOf(approvalSubject(command('git push --force'))).level, 'danger');
  assert.equal(riskOf(approvalSubject(command('npm install left-pad'))).level, 'network');
  assert.equal(riskOf(approvalSubject(command('npm test'))), null);
});

test('저장된 규칙이 깨져 있어도 빈 정책으로 읽는다', async () => {
  const { parsePolicy } = await load();
  assert.deepEqual(parsePolicy('{'), { global: { allow: [], deny: [] }, projects: {} });
  assert.deepEqual(parsePolicy(JSON.stringify({ global: { allow: [' npm test ', 3, ''] }, projects: { a: { deny: ['rm'] } } })),
    { global: { allow: ['npm test'], deny: [] }, projects: { a: { allow: [], deny: ['rm'] } } });
});

test('승인 결정을 CLI 형식으로 보낸다: Codex는 acceptForSession, Claude는 허용·거절', () => {
  const { CodexSession } = require('../agent.cjs');
  const ClaudeSession = require('../claude.cjs');
  const sent = [];
  const codex = { approvals: new Map([[1, 't'], [2, 't'], [3, 't']]), write: message => sent.push(message.result.decision) };
  CodexSession.prototype.resolve.call(codex, 1, 'session');
  CodexSession.prototype.resolve.call(codex, 2, true);
  CodexSession.prototype.resolve.call(codex, 3, 'decline');
  assert.deepEqual(sent, ['acceptForSession', 'accept', 'decline']);
  const replies = [];
  const claude = { approvals: new Map([['a', { input: { command: 'npm test' } }], ['b', { input: {} }]]), reply: (id, response) => replies.push(response.behavior) };
  ClaudeSession.prototype.resolve.call(claude, 'a', 'session');
  ClaudeSession.prototype.resolve.call(claude, 'b', 'decline');
  assert.deepEqual(replies, ['allow', 'deny']);
});
