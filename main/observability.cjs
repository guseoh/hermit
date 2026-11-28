// Stage C 트랙 2: 관측성 — 모델 단가 기반 일별·프로젝트별 예상 비용($) 원장 및 Windows localhost 포트 스캐너.
const fs = require('node:fs');
const path = require('node:path');
const { execFile } = require('node:child_process');

// USD per 1,000,000 tokens (standard API reference rates; used for local estimation only).
const MODEL_PRICING = [
  { key: 'claude-opus-4', match: /claude.*opus|opus/i, input: 15, output: 75, cacheRead: 1.5, cacheWrite: 18.75 },
  { key: 'claude-sonnet-4', match: /claude.*sonnet|sonnet/i, input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
  { key: 'claude-haiku-3.5', match: /claude.*haiku|haiku/i, input: 0.8, output: 4, cacheRead: 0.08, cacheWrite: 1.0 },
  { key: 'gpt-5-mini', match: /gpt-?5.*mini|o4-mini|o3-mini/i, input: 0.25, output: 2.0, cacheRead: 0.025, cacheWrite: 0.25 },
  { key: 'gpt-5', match: /gpt-?5|codex/i, input: 1.25, output: 10.0, cacheRead: 0.125, cacheWrite: 1.25 },
  { key: 'o3', match: /\bo3\b/i, input: 2.0, output: 8.0, cacheRead: 0.5, cacheWrite: 2.0 },
  { key: 'gpt-4.1-mini', match: /gpt-?4\.1.*mini|gpt-?4o.*mini/i, input: 0.4, output: 1.6, cacheRead: 0.1, cacheWrite: 0.4 },
  { key: 'gpt-4.1', match: /gpt-?4\.1|gpt-?4o/i, input: 2.0, output: 8.0, cacheRead: 0.5, cacheWrite: 2.0 }
];

const PROVIDER_DEFAULTS = {
  claude: MODEL_PRICING[1], // claude-sonnet-4
  codex: MODEL_PRICING[4]   // gpt-5
};
const FALLBACK_PRICING = { key: 'default', input: 2.0, output: 8.0, cacheRead: 0.2, cacheWrite: 2.5 };

function resolvePricing(model, provider) {
  const name = String(model ?? '').trim();
  if (name) {
    for (const entry of MODEL_PRICING) {
      if (entry.match.test(name)) return entry;
    }
  }
  const prov = String(provider ?? '').trim().toLowerCase();
  if (PROVIDER_DEFAULTS[prov]) return PROVIDER_DEFAULTS[prov];
  return FALLBACK_PRICING;
}

function nonNegativeInt(value) {
  const num = Number(value);
  return Number.isFinite(num) && num > 0 ? Math.floor(num) : 0;
}

function estimateCost({ inputTokens = 0, outputTokens = 0, cacheReadTokens = 0, cacheWriteTokens = 0, model = '', provider = '' } = {}) {
  const rates = resolvePricing(model, provider);
  const input = nonNegativeInt(inputTokens);
  const output = nonNegativeInt(outputTokens);
  const cacheRead = nonNegativeInt(cacheReadTokens);
  const cacheWrite = nonNegativeInt(cacheWriteTokens);
  const costUsd = (
    input * rates.input +
    output * rates.output +
    cacheRead * rates.cacheRead +
    cacheWrite * rates.cacheWrite
  ) / 1_000_000;
  return {
    costUsd: Math.round(costUsd * 1_000_000) / 1_000_000,
    pricingKey: rates.key,
    rates: { input: rates.input, output: rates.output, cacheRead: rates.cacheRead, cacheWrite: rates.cacheWrite }
  };
}

function localDayKey(time = Date.now()) {
  const date = new Date(time);
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

function normalizeUsageRecord(input) {
  if (!input || typeof input !== 'object') return null;
  const inputTokens = nonNegativeInt(input.inputTokens);
  const outputTokens = nonNegativeInt(input.outputTokens);
  const cacheReadTokens = nonNegativeInt(input.cacheReadTokens);
  const cacheWriteTokens = nonNegativeInt(input.cacheWriteTokens);
  if (inputTokens + outputTokens + cacheReadTokens + cacheWriteTokens === 0) return null;
  const provider = String(input.provider ?? '').trim().toLowerCase().slice(0, 32) || 'unknown';
  const model = String(input.model ?? '').trim().slice(0, 120);
  const project = String(input.project ?? '').trim().slice(0, 512);
  const taskId = String(input.taskId ?? '').trim().slice(0, 128);
  const taskName = String(input.taskName ?? '').trim().slice(0, 160);
  const at = Number.isFinite(input.at) && input.at > 0 ? Math.floor(input.at) : Date.now();
  const id = String(input.id ?? '').trim().slice(0, 180);
  const est = estimateCost({ inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens, model, provider });
  return {
    id, provider, model, pricingKey: est.pricingKey, project, taskId, taskName,
    inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens,
    costUsd: est.costUsd, at
  };
}

function emptyBucket() {
  return { costUsd: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, samples: 0 };
}

function addToBucket(bucket, rec) {
  bucket.costUsd = Math.round((bucket.costUsd + rec.costUsd) * 1_000_000) / 1_000_000;
  bucket.inputTokens += rec.inputTokens;
  bucket.outputTokens += rec.outputTokens;
  bucket.cacheReadTokens += rec.cacheReadTokens;
  bucket.cacheWriteTokens += rec.cacheWriteTokens;
  bucket.samples += 1;
}

function summarizeUsage(records, { days = 30, now = Date.now() } = {}) {
  const spanDays = Math.min(365, Math.max(1, Math.floor(Number(days) || 30)));
  const cutoffDate = new Date(now);
  cutoffDate.setDate(cutoffDate.getDate() - spanDays + 1);
  const cutoffDay = localDayKey(cutoffDate.getTime());

  const totals = emptyBucket();
  const dayMap = new Map();
  const projectMap = new Map();
  const byProvider = { codex: emptyBucket(), claude: emptyBucket() };

  for (const rec of records) {
    const day = localDayKey(rec.at);
    if (day < cutoffDay) continue;
    addToBucket(totals, rec);

    let dayBucket = dayMap.get(day);
    if (!dayBucket) { dayBucket = { day, ...emptyBucket() }; dayMap.set(day, dayBucket); }
    addToBucket(dayBucket, rec);

    const projectKey = (rec.project || '(프로젝트 없음)').toLowerCase();
    let projBucket = projectMap.get(projectKey);
    if (!projBucket) { projBucket = { project: rec.project || '(프로젝트 없음)', ...emptyBucket() }; projectMap.set(projectKey, projBucket); }
    addToBucket(projBucket, rec);

    if (!byProvider[rec.provider]) byProvider[rec.provider] = emptyBucket();
    addToBucket(byProvider[rec.provider], rec);
  }

  const byDay = [...dayMap.values()].sort((a, b) => b.day.localeCompare(a.day));
  const byProject = [...projectMap.values()].sort((a, b) => b.costUsd - a.costUsd || b.samples - a.samples);
  return { days: spanDays, totals, byDay, byProject, byProvider };
}

function createUsageLedger(filePath, { maxRecords = 10000 } = {}) {
  let loaded = false;
  let records = [];
  const seenIds = new Set();

  function load() {
    if (loaded) return;
    loaded = true;
    records = [];
    seenIds.clear();
    if (!filePath || !fs.existsSync(filePath)) return;
    let raw = '';
    try { raw = fs.readFileSync(filePath, 'utf8'); } catch { return; }
    for (const line of raw.split(/\r?\n/)) {
      if (!line.trim()) continue;
      try {
        const rec = normalizeUsageRecord(JSON.parse(line));
        if (!rec) continue;
        if (rec.id && seenIds.has(rec.id)) continue;
        if (rec.id) seenIds.add(rec.id);
        records.push(rec);
      } catch {}
    }
  }

  function compact() {
    if (!filePath) return;
    records = records.slice(-maxRecords);
    seenIds.clear();
    for (const rec of records) if (rec.id) seenIds.add(rec.id);
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    const temp = filePath + '.' + process.pid + '.' + Date.now() + '.tmp';
    const body = records.map(rec => JSON.stringify(rec)).join('\n') + (records.length ? '\n' : '');
    fs.writeFileSync(temp, body, 'utf8');
    fs.renameSync(temp, filePath);
  }

  function record(input) {
    load();
    const rec = normalizeUsageRecord(input);
    if (!rec) return { ok: false, reason: 'invalid' };
    if (rec.id && seenIds.has(rec.id)) return { ok: true, deduplicated: true, costUsd: rec.costUsd };
    if (rec.id) seenIds.add(rec.id);
    records.push(rec);
    if (filePath) {
      fs.mkdirSync(path.dirname(filePath), { recursive: true });
      fs.appendFileSync(filePath, JSON.stringify(rec) + '\n', 'utf8');
      if (records.length > Math.floor(maxRecords * 1.25)) compact();
    }
    return { ok: true, deduplicated: false, costUsd: rec.costUsd };
  }

  function summarize(options = {}) {
    load();
    return summarizeUsage(records, options);
  }

  return { record, summarize, compact };
}

// ── Windows localhost 포트 스캐너 ────────────────────────────────────────────
function parseTasklistCsv(csvText) {
  const map = new Map();
  for (const line of String(csvText ?? '').split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    // CSV format: "Image Name","PID","Session Name","Session#","Mem Usage"
    const match = /^"([^"]+)","(\d+)"/.exec(trimmed);
    if (match) map.set(Number(match[2]), match[1]);
  }
  return map;
}

function parseAddressPort(raw) {
  // IPv6: [::1]:5173 or [::]:3000
  const v6 = /^(\[[^\]]+\]):(\d+)$/.exec(raw);
  if (v6) return { host: v6[1].toLowerCase(), port: Number(v6[2]) };
  // IPv4: 127.0.0.1:5173 or 0.0.0.0:3000
  const v4 = /^(\d+\.\d+\.\d+\.\d+):(\d+)$/.exec(raw);
  if (v4) return { host: v4[1], port: Number(v4[2]) };
  return null;
}

const LOCAL_HOSTS = new Set(['127.0.0.1', '0.0.0.0', '[::1]', '[::]']);

function parseListeningPorts(netstatOutput, tasklistCsvOutput = '') {
  const pidNames = parseTasklistCsv(tasklistCsvOutput);
  const byPort = new Map();

  for (const line of String(netstatOutput ?? '').split(/\r?\n/)) {
    const parts = line.trim().split(/\s+/);
    if (parts.length < 5) continue;
    if (parts[0].toUpperCase() !== 'TCP') continue;
    if (parts[3].toUpperCase() !== 'LISTENING') continue;
    const parsed = parseAddressPort(parts[1]);
    if (!parsed || !LOCAL_HOSTS.has(parsed.host)) continue;
    if (!Number.isInteger(parsed.port) || parsed.port < 1 || parsed.port > 65535) continue;
    const pid = Number(parts[4]);
    if (!Number.isInteger(pid) || pid <= 0) continue;

    const existing = byPort.get(parsed.port);
    // 같은 포트에 IPv4와 IPv6가 함께 열려 있으면 IPv4(127.0.0.1 / 0.0.0.0) 표시를 우선한다.
    const isIpv4 = !parsed.host.startsWith('[');
    if (!existing || (isIpv4 && existing.address.startsWith('['))) {
      byPort.set(parsed.port, {
        port: parsed.port,
        pid,
        address: parsed.host,
        processName: pidNames.get(pid) ?? '',
        url: 'http://localhost:' + parsed.port
      });
    }
  }

  return [...byPort.values()].sort((a, b) => a.port - b.port);
}

function execText(file, args, timeout = 5000) {
  return new Promise((resolve, reject) => {
    execFile(file, args, { windowsHide: true, timeout, maxBuffer: 4 * 1024 * 1024 }, (error, stdout) => {
      if (error) reject(error);
      else resolve(String(stdout ?? ''));
    });
  });
}

async function scanListeningPorts() {
  if (process.platform !== 'win32') return [];
  const [netstatOut, tasklistOut] = await Promise.all([
    execText('netstat.exe', ['-ano', '-p', 'TCP']),
    execText('tasklist.exe', ['/FO', 'CSV', '/NH']).catch(() => '')
  ]);
  return parseListeningPorts(netstatOut, tasklistOut);
}

module.exports = {
  MODEL_PRICING,
  resolvePricing,
  estimateCost,
  normalizeUsageRecord,
  summarizeUsage,
  createUsageLedger,
  parseTasklistCsv,
  parseListeningPorts,
  scanListeningPorts
};
