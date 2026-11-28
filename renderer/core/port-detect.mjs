// 터미널 출력 스트림에서 로컬 개발 서버 주소(localhost/127.0.0.1/0.0.0.0/[::1]:포트)를 찾는다.
// 순수 모듈(DOM 의존 없음)이라 Node 단위 테스트와 렌더러 둘 다에서 그대로 불러 쓴다.

const ANSI_OSC = /\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g;
const ANSI_CSI = /\x1b\[[0-?]*[ -/]*[@-~]/g;
const ANSI_SINGLE = /\x1b[@-Z\\-_]/g;

export function stripAnsi(text) {
  return String(text ?? '')
    .replace(ANSI_OSC, '')
    .replace(ANSI_CSI, '')
    .replace(ANSI_SINGLE, '')
    .replace(/\r/g, '');
}

const TRAILING_PUNCT = /[.,;:!?'"`)\]}]+$/;

function validPort(portText) {
  if (!/^\d{1,5}$/.test(portText)) return null;
  const port = Number(portText);
  return port >= 1 && port <= 65535 ? port : null;
}

export function normalizeLocalUrl(raw) {
  if (typeof raw !== 'string') return null;
  const cleaned = raw.trim().replace(TRAILING_PUNCT, '');
  if (!cleaned) return null;
  const withScheme = /^https?:\/\//i.test(cleaned) ? cleaned : 'http://' + cleaned;
  let parsed;
  try {
    parsed = new URL(withScheme);
  } catch {
    return null;
  }
  if (!['http:', 'https:'].includes(parsed.protocol)) return null;
  if (parsed.username || parsed.password) return null;
  const port = validPort(parsed.port);
  if (!port) return null;

  const rawHost = parsed.hostname.toLowerCase();
  if (!['localhost', '127.0.0.1', '0.0.0.0', '[::1]', '::1'].includes(rawHost)) return null;
  // 0.0.0.0과 ::1은 브라우저·미리보기 CSP(localhost / 127.0.0.1)에서 열 수 있게 localhost로 바꾼다.
  const host = rawHost === '127.0.0.1' ? '127.0.0.1' : 'localhost';
  parsed.hostname = host;

  const key = `${parsed.protocol}//${host}:${port}`;
  const pathPart = parsed.pathname === '/' && !parsed.search ? '' : parsed.pathname + parsed.search;
  return {
    url: `${key}${pathPart}`,
    key,
    protocol: parsed.protocol,
    host,
    port
  };
}

const EXPLICIT_URL_RE = /\bhttps?:\/\/(?:localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\]):(\d{1,5})(?:\/[^\s"'<>)\]},;]*)?/gi;
const BARE_HOST_RE = /(?:^|[\s(=,'"`])((?:localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\]):(\d{1,5})(?:\/[^\s"'<>)\]},;]*)?)/gi;
const LISTEN_LINE_RE = /\b(?:listening|running|started|ready|serving)\s+(?:on|at)\s+(?:port\s+|:)(\d{2,5})\b/gi;

export function detectLocalUrls(chunk) {
  const clean = stripAnsi(chunk);
  if (!clean) return [];
  const found = new Map();
  const seenPorts = new Set();
  const add = candidate => {
    const info = normalizeLocalUrl(candidate);
    if (!info) return;
    seenPorts.add(info.port);
    const existing = found.get(info.key);
    // 같은 호스트:포트라면 경로가 더 구체적인 쪽이나 먼저 나온 쪽을 유지한다.
    if (!existing || (existing.url === existing.key && info.url.length > existing.url.length)) {
      found.set(info.key, info);
    }
  };

  for (const match of clean.matchAll(EXPLICIT_URL_RE)) add(match[0]);
  for (const match of clean.matchAll(BARE_HOST_RE)) add(match[1]);
  for (const match of clean.matchAll(LISTEN_LINE_RE)) {
    const port = validPort(match[1]);
    if (port && port >= 80 && !seenPorts.has(port)) add(`http://localhost:${port}`);
  }
  return [...found.values()];
}

export function createPortDetector({ onDetect, maxCarry = 256 } = {}) {
  let carry = '';
  const detected = new Map();
  const dismissed = new Set();

  function push(chunk) {
    const clean = stripAnsi(chunk);
    if (!clean) return [];
    const combined = carry + clean;
    // 줄바꿈 이후의 마지막 조각만 carry로 남겨 청크 경계에 걸친 URL을 이어 붙인다.
    const lastNewline = combined.lastIndexOf('\n');
    carry = (lastNewline >= 0 ? combined.slice(lastNewline + 1) : combined).slice(-maxCarry);

    const fresh = [];
    for (const entry of detectLocalUrls(combined)) {
      if (dismissed.has(entry.key)) continue;
      const prev = detected.get(entry.key);
      if (prev && prev.url === entry.url) continue;
      detected.set(entry.key, entry);
      fresh.push(entry);
      onDetect?.(entry);
    }
    return fresh;
  }

  function dismiss(key) {
    dismissed.add(key);
    detected.delete(key);
  }

  function clear() {
    carry = '';
    detected.clear();
    dismissed.clear();
  }

  function list() {
    return [...detected.values()];
  }

  return { push, dismiss, clear, list };
}
