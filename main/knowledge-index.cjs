// Stage C 트랙 2: 전역 대화·명령 출력 검색용 경량 JSONL 색인.
// Electron userData 아래 knowledge-index.jsonl에 append-only로 쌓고, 크기/건수 상한을 넘으면 원자적으로 압축한다.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const DEFAULT_MAX_RECORDS = 4000;
const DEFAULT_MAX_TEXT_LENGTH = 8000;
const DEFAULT_MAX_TITLE_LENGTH = 240;
const DEFAULT_MAX_FILE_BYTES = 6 * 1024 * 1024;
const VALID_KINDS = new Set(['chat', 'command']);
const VALID_ROLES = new Set(['user', 'assistant', 'command', '']);

function clampString(value, maxLength) {
  if (typeof value !== 'string') return '';
  const trimmed = value.trim();
  return trimmed.length > maxLength ? trimmed.slice(0, maxLength) : trimmed;
}

function normalizeRecord(input, { maxTextLength = DEFAULT_MAX_TEXT_LENGTH } = {}) {
  if (!input || typeof input !== 'object') return null;
  const kind = VALID_KINDS.has(input.kind) ? input.kind : null;
  if (!kind) return null;
  const title = clampString(input.title, DEFAULT_MAX_TITLE_LENGTH);
  const text = clampString(input.text, maxTextLength);
  if (!title && !text) return null;
  const role = VALID_ROLES.has(input.role) ? input.role : (kind === 'command' ? 'command' : '');
  const project = clampString(input.project, 512);
  const taskId = clampString(input.taskId, 128);
  const taskName = clampString(input.taskName, 160);
  const provider = clampString(input.provider, 40);
  const at = Number.isFinite(input.at) && input.at > 0 ? Math.floor(input.at) : Date.now();
  const rawId = clampString(input.id, 180);
  const id = rawId || (kind + ':' + crypto.createHash('sha1').update(`${project}\0${taskId}\0${title}\0${text.slice(0, 512)}`).digest('hex').slice(0, 16));
  return { id, kind, role, taskId, taskName, provider, project, title, text, at };
}

function tokenizeQuery(query) {
  if (typeof query !== 'string') return [];
  const trimmed = query.trim().toLowerCase();
  if (!trimmed) return [];
  const tokens = [];
  const seen = new Set();
  for (const part of trimmed.split(/\s+/)) {
    if (!part || seen.has(part)) continue;
    seen.add(part);
    tokens.push(part);
    if (tokens.length >= 12) break;
  }
  return tokens;
}

function extractSnippet(text, terms, radius = 90) {
  const source = String(text ?? '').replace(/\r?\n+/g, ' ').replace(/\s+/g, ' ').trim();
  if (!source) return '';
  if (!terms.length) return source.length > radius * 2 ? source.slice(0, radius * 2).trimEnd() + '…' : source;
  const lower = source.toLowerCase();
  let firstIndex = -1;
  for (const term of terms) {
    const idx = lower.indexOf(term);
    if (idx >= 0 && (firstIndex === -1 || idx < firstIndex)) firstIndex = idx;
  }
  if (firstIndex === -1) return source.length > radius * 2 ? source.slice(0, radius * 2).trimEnd() + '…' : source;
  const start = Math.max(0, firstIndex - Math.floor(radius * 0.6));
  const end = Math.min(source.length, start + radius * 2);
  const prefix = start > 0 ? '…' : '';
  const suffix = end < source.length ? '…' : '';
  return prefix + source.slice(start, end).trim() + suffix;
}

function normalizeProjectKey(project) {
  return String(project ?? '').trim().replace(/[\\/]+$/, '').toLowerCase();
}

function createKnowledgeIndex(filePath, options = {}) {
  const maxRecords = options.maxRecords ?? DEFAULT_MAX_RECORDS;
  const maxTextLength = options.maxTextLength ?? DEFAULT_MAX_TEXT_LENGTH;
  const maxFileBytes = options.maxFileBytes ?? DEFAULT_MAX_FILE_BYTES;
  const byId = new Map();
  let loaded = false;
  let lineCount = 0;

  function load() {
    if (loaded) return;
    loaded = true;
    byId.clear();
    lineCount = 0;
    if (!filePath || !fs.existsSync(filePath)) return;
    let raw = '';
    try { raw = fs.readFileSync(filePath, 'utf8'); } catch { return; }
    for (const line of raw.split(/\r?\n/)) {
      if (!line.trim()) continue;
      lineCount++;
      try {
        const record = normalizeRecord(JSON.parse(line), { maxTextLength });
        if (record) byId.set(record.id, record);
      } catch {
        // 손상되거나 잘린 줄은 건너뛴다.
      }
    }
  }

  function compact() {
    if (!filePath) return;
    const sorted = [...byId.values()].sort((a, b) => b.at - a.at).slice(0, maxRecords).reverse();
    byId.clear();
    for (const record of sorted) byId.set(record.id, record);
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    const temp = filePath + '.' + process.pid + '.' + Date.now() + '.tmp';
    const content = sorted.map(record => JSON.stringify(record)).join('\n') + (sorted.length ? '\n' : '');
    fs.writeFileSync(temp, content, 'utf8');
    fs.renameSync(temp, filePath);
    lineCount = sorted.length;
  }

  function maybeCompact() {
    if (!filePath) return;
    let bytes = 0;
    try { bytes = fs.statSync(filePath).size; } catch { bytes = 0; }
    if (byId.size > maxRecords || lineCount > Math.floor(maxRecords * 1.25) || bytes > maxFileBytes) {
      compact();
    }
  }

  function append(input) {
    load();
    const record = normalizeRecord(input, { maxTextLength });
    if (!record) return { ok: false, reason: 'invalid' };
    const prev = byId.get(record.id);
    if (prev && prev.text === record.text && prev.title === record.title) {
      return { ok: true, id: record.id, deduplicated: true };
    }
    byId.set(record.id, record);
    if (filePath) {
      fs.mkdirSync(path.dirname(filePath), { recursive: true });
      fs.appendFileSync(filePath, JSON.stringify(record) + '\n', 'utf8');
      lineCount++;
      maybeCompact();
    }
    return { ok: true, id: record.id, deduplicated: false };
  }

  function search(options = {}) {
    load();
    const query = typeof options.query === 'string' ? options.query : '';
    const terms = tokenizeQuery(query);
    const kind = VALID_KINDS.has(options.kind) ? options.kind : 'all';
    const projectFilter = normalizeProjectKey(options.project);
    const limit = Math.min(200, Math.max(1, Number(options.limit) || 50));
    const phrase = query.trim().toLowerCase();

    const matched = [];
    for (const record of byId.values()) {
      if (kind !== 'all' && record.kind !== kind) continue;
      if (projectFilter) {
        const recProj = normalizeProjectKey(record.project);
        if (recProj !== projectFilter && !recProj.startsWith(projectFilter + '\\') && !recProj.startsWith(projectFilter + '/')) continue;
      }
      const titleLower = record.title.toLowerCase();
      const haystack = (record.title + '\n' + record.text + '\n' + record.taskName + '\n' + record.project).toLowerCase();
      if (terms.length && !terms.every(term => haystack.includes(term))) continue;

      let score = 0;
      if (terms.length) {
        for (const term of terms) {
          if (titleLower.includes(term)) score += 4;
          else score += 1;
        }
        if (phrase.length >= 2 && haystack.includes(phrase)) score += 6;
      }
      matched.push({ record, score });
    }

    matched.sort((a, b) => b.score - a.score || b.record.at - a.record.at);
    const items = matched.slice(0, limit).map(({ record }) => ({
      ...record,
      snippet: extractSnippet(record.text || record.title, terms)
    }));

    return { items, total: matched.length, terms };
  }

  function stats() {
    load();
    let chatCount = 0;
    let commandCount = 0;
    const projectLatest = new Map();
    for (const record of byId.values()) {
      if (record.kind === 'chat') chatCount++;
      else if (record.kind === 'command') commandCount++;
      if (record.project) {
        const key = normalizeProjectKey(record.project);
        const existing = projectLatest.get(key);
        if (!existing || record.at > existing.at) projectLatest.set(key, { path: record.project, at: record.at });
      }
    }
    const projects = [...projectLatest.values()].sort((a, b) => b.at - a.at).map(entry => entry.path);
    return { total: byId.size, chatCount, commandCount, projects };
  }

  function clear() {
    loaded = true;
    byId.clear();
    lineCount = 0;
    if (filePath && fs.existsSync(filePath)) {
      try { fs.unlinkSync(filePath); } catch {}
    }
    return { ok: true };
  }

  return { append, search, stats, clear, compact };
}

module.exports = {
  createKnowledgeIndex,
  normalizeRecord,
  tokenizeQuery,
  extractSnippet
};
