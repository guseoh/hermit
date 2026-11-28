const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {
  createKnowledgeIndex,
  normalizeRecord,
  tokenizeQuery,
  extractSnippet
} = require('../main/knowledge-index.cjs');

function tempFile(t, name = 'knowledge-index.jsonl') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hermit-knowledge-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return path.join(dir, name);
}

test('쿼리 토큰화: 공백 분리·소문자·중복 제거·상한', () => {
  assert.deepEqual(tokenizeQuery('  PowerShell   WorkTree  powershell '), ['powershell', 'worktree']);
  assert.deepEqual(tokenizeQuery(''), []);
  assert.equal(tokenizeQuery('a b c d e f g h i j k l m n').length, 12);
});

test('스니펫 추출: 일치 지점 주변을 잘라내고 말줄임표를 붙인다', () => {
  const longText = '앞부분 '.repeat(40) + '특별한오류코드 ECONNREFUSED 발생 ' + '뒷부분 '.repeat(40);
  const snippet = extractSnippet(longText, ['econnrefused'], 40);
  assert.match(snippet, /ECONNREFUSED/);
  assert.ok(snippet.startsWith('…'));
  assert.ok(snippet.endsWith('…'));
});

test('레코드 정규화: 잘못된 kind나 빈 본문은 거부하고 길이를 제한한다', () => {
  assert.equal(normalizeRecord(null), null);
  assert.equal(normalizeRecord({ kind: 'unknown', text: 'hello' }), null);
  assert.equal(normalizeRecord({ kind: 'chat', text: '   ' }), null);
  const norm = normalizeRecord({ kind: 'chat', role: 'user', text: 'x'.repeat(200), project: 'C:\\repo' }, { maxTextLength: 50 });
  assert.equal(norm.text.length, 50);
  assert.equal(norm.kind, 'chat');
  assert.equal(norm.role, 'user');
});

test('JSONL 색인: 추가·검색·종류/프로젝트 필터·중복 제거·영속화', t => {
  const file = tempFile(t);
  const idx = createKnowledgeIndex(file);

  const r1 = idx.append({
    id: 'chat:t1:m1', kind: 'chat', role: 'user', taskId: 't1', taskName: '로그인 수정',
    provider: 'codex', project: 'C:\\Projects\\alpha', title: '로그인 수정',
    text: 'JWT 토큰 만료 시 refresh 로직을 고쳐줘', at: 1000
  });
  assert.equal(r1.ok, true);
  assert.equal(r1.deduplicated, false);

  // 같은 내용 재등록 시 중복 제거
  const r1Dup = idx.append({
    id: 'chat:t1:m1', kind: 'chat', role: 'user', taskId: 't1', taskName: '로그인 수정',
    provider: 'codex', project: 'C:\\Projects\\alpha', title: '로그인 수정',
    text: 'JWT 토큰 만료 시 refresh 로직을 고쳐줘', at: 1000
  });
  assert.equal(r1Dup.deduplicated, true);

  idx.append({
    id: 'cmd:c1', kind: 'command', role: 'command', provider: 'shell',
    project: 'C:\\Projects\\beta', title: 'npm test',
    text: 'npm test\nFAIL auth.test.js: JWT signature invalid', at: 2000
  });

  // 전체 검색
  const allJwt = idx.search({ query: 'jwt' });
  assert.equal(allJwt.total, 2);
  assert.equal(allJwt.items[0].id, 'cmd:c1'); // 최신순 tie-break

  // 종류 필터
  const onlyCmd = idx.search({ query: 'jwt', kind: 'command' });
  assert.equal(onlyCmd.total, 1);
  assert.equal(onlyCmd.items[0].id, 'cmd:c1');

  // 프로젝트 필터
  const onlyAlpha = idx.search({ query: 'jwt', project: 'c:\\projects\\alpha' });
  assert.equal(onlyAlpha.total, 1);
  assert.equal(onlyAlpha.items[0].id, 'chat:t1:m1');

  // 새 인스턴스로 다시 읽어도 손상 줄을 건너뛰고 복원된다
  fs.appendFileSync(file, '{corrupted json line\n', 'utf8');
  const reloaded = createKnowledgeIndex(file);
  const stats = reloaded.stats();
  assert.equal(stats.total, 2);
  assert.equal(stats.chatCount, 1);
  assert.equal(stats.commandCount, 1);
  assert.deepEqual(stats.projects, ['C:\\Projects\\beta', 'C:\\Projects\\alpha']);
});

test('크기/건수 상한 초과 시 자동 압축(compaction)으로 최신 항목만 유지한다', t => {
  const file = tempFile(t);
  const idx = createKnowledgeIndex(file, { maxRecords: 5 });
  for (let i = 1; i <= 10; i++) {
    idx.append({
      id: 'cmd:' + i, kind: 'command', project: 'C:\\repo',
      title: 'echo ' + i, text: 'output ' + i, at: i * 1000
    });
  }
  const lines = fs.readFileSync(file, 'utf8').trim().split(/\r?\n/);
  assert.ok(lines.length <= 5, '압축 후 파일 줄 수가 maxRecords 이하');
  const reloaded = createKnowledgeIndex(file, { maxRecords: 5 });
  const res = reloaded.search({});
  assert.equal(res.total, 5);
  assert.equal(res.items[0].id, 'cmd:10');
  assert.equal(res.items[4].id, 'cmd:6');
});
