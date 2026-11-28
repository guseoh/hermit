const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {
  resolvePricing,
  estimateCost,
  summarizeUsage,
  createUsageLedger,
  parseTasklistCsv,
  parseListeningPorts
} = require('../main/observability.cjs');

function tempFile(t, name = 'usage-ledger.jsonl') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hermit-obs-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return path.join(dir, name);
}

test('모델 단가 계산: Claude·Codex 모델 매칭과 기본 단가 폴백', () => {
  assert.equal(resolvePricing('claude-sonnet-4-20250514', 'claude').key, 'claude-sonnet-4');
  assert.equal(resolvePricing('claude-opus-4-1', 'claude').key, 'claude-opus-4');
  assert.equal(resolvePricing('gpt-5-codex', 'codex').key, 'gpt-5');
  assert.equal(resolvePricing('', 'codex').key, 'gpt-5');
  assert.equal(resolvePricing('', 'claude').key, 'claude-sonnet-4');

  // Sonnet 4: $3/1M input, $15/1M output, $0.3/1M cacheRead, $3.75/1M cacheWrite
  const est = estimateCost({
    model: 'claude-sonnet-4',
    provider: 'claude',
    inputTokens: 1_000_000,
    outputTokens: 100_000,
    cacheReadTokens: 1_000_000,
    cacheWriteTokens: 200_000
  });
  // 3 + 1.5 + 0.3 + 0.75 = 5.55
  assert.equal(est.costUsd, 5.55);

  // 음수·NaN은 0으로 처리
  const zero = estimateCost({ inputTokens: -100, outputTokens: Number.NaN, provider: 'codex' });
  assert.equal(zero.costUsd, 0);
});

test('일별·프로젝트별 집계: 기간 필터링과 정렬', () => {
  const now = new Date('2026-11-28T12:00:00').getTime();
  const dayMs = 86400000;
  const records = [
    { provider: 'claude', project: 'C:\\proj\\a', inputTokens: 100_000, outputTokens: 10_000, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: 0.45, at: now },
    { provider: 'codex', project: 'C:\\proj\\b', inputTokens: 200_000, outputTokens: 20_000, cacheReadTokens: 50_000, cacheWriteTokens: 0, costUsd: 0.9, at: now - dayMs },
    { provider: 'claude', project: 'C:\\proj\\a', inputTokens: 50_000, outputTokens: 5_000, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: 0.2, at: now - 40 * dayMs }
  ];

  const report = summarizeUsage(records, { days: 7, now });
  assert.equal(report.totals.samples, 2);
  assert.equal(report.totals.costUsd, 1.35);
  assert.equal(report.byProject[0].project, 'C:\\proj\\b');
  assert.equal(report.byProject[0].costUsd, 0.9);
  assert.equal(report.byProject[1].project, 'C:\\proj\\a');
  assert.equal(report.byDay.length, 2);
  assert.ok(report.byDay[0].day > report.byDay[1].day);
});

test('JSONL 사용량 원장: 기록·중복 제거·재로드 영속성', t => {
  const file = tempFile(t);
  const ledger = createUsageLedger(file);
  const now = Date.now();

  const r1 = ledger.record({
    id: 'claude:turn-1', provider: 'claude', model: 'claude-sonnet-4',
    project: 'C:\\Projects\\hermit', inputTokens: 500_000, outputTokens: 50_000, at: now
  });
  assert.equal(r1.ok, true);
  assert.equal(r1.deduplicated, false);
  assert.equal(r1.costUsd, 2.25);

  const dup = ledger.record({
    id: 'claude:turn-1', provider: 'claude', model: 'claude-sonnet-4',
    project: 'C:\\Projects\\hermit', inputTokens: 500_000, outputTokens: 50_000, at: now
  });
  assert.equal(dup.deduplicated, true);

  // 빈 토큰 기록은 거부
  assert.equal(ledger.record({ provider: 'codex', inputTokens: 0, outputTokens: 0 }).ok, false);

  const reloaded = createUsageLedger(file);
  const report = reloaded.summarize({ days: 7, now });
  assert.equal(report.totals.samples, 1);
  assert.equal(report.totals.costUsd, 2.25);
});

test('Windows netstat + tasklist 파서: localhost LISTENING 포트 추출과 IPv4/IPv6 중복 병합', () => {
  const netstat = [
    'Active Connections',
    '  Proto  Local Address          Foreign Address        State           PID',
    '  TCP    0.0.0.0:3000           0.0.0.0:0              LISTENING       4210',
    '  TCP    [::]:3000              [::]:0                 LISTENING       4210',
    '  TCP    127.0.0.1:5173         0.0.0.0:0              LISTENING       8820',
    '  TCP    [::1]:8080             [::]:0                 LISTENING       9912',
    '  TCP    192.168.0.15:445       0.0.0.0:0              LISTENING       4',
    '  TCP    127.0.0.1:5173         127.0.0.1:54321        ESTABLISHED     8820'
  ].join('\r\n');

  const tasklist = [
    '"node.exe","4210","Console","1","45,200 K"',
    '"vite.exe","8820","Console","1","81,000 K"',
    '"python.exe","9912","Console","1","30,100 K"'
  ].join('\r\n');

  const names = parseTasklistCsv(tasklist);
  assert.equal(names.get(4210), 'node.exe');

  const ports = parseListeningPorts(netstat, tasklist);
  assert.deepEqual(ports, [
    { port: 3000, pid: 4210, address: '0.0.0.0', processName: 'node.exe', url: 'http://localhost:3000' },
    { port: 5173, pid: 8820, address: '127.0.0.1', processName: 'vite.exe', url: 'http://localhost:5173' },
    { port: 8080, pid: 9912, address: '[::1]', processName: 'python.exe', url: 'http://localhost:8080' }
  ]);
});
