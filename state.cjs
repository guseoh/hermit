// 앱 상태(작업 목록, 열린 탭, 레이아웃, 메모 등)를 사용자 데이터 폴더의 JSON 파일에 저장한다.
// 렌더러의 localStorage는 빠르게 읽고 쓰는 캐시로 두고, 이 파일을 기준으로 시작할 때 복원한다.
const fs = require('node:fs');
const path = require('node:path');

const version = 1;
const maxBytes = 8 * 1024 * 1024;
const keyPattern = /^(?:agent-|workbench[.-]|collapsed-)[\w.:-]{1,200}$/;

function sanitize(values) {
  if (!values || typeof values !== 'object' || Array.isArray(values)) throw new Error('잘못된 상태 형식입니다.');
  const clean = {};
  let bytes = 0;
  for (const [key, value] of Object.entries(values)) {
    if (!keyPattern.test(key) || typeof value !== 'string') continue;
    bytes += Buffer.byteLength(key) + Buffer.byteLength(value);
    if (bytes > maxBytes) throw new Error('저장할 상태가 8MB를 넘습니다.');
    clean[key] = value;
  }
  return clean;
}

// 파일이 없으면 null. 깨진 파일은 옆에 보관하고 null을 돌려준다(localStorage 내용으로 다시 만든다).
function read(file) {
  let text;
  try { text = fs.readFileSync(file, 'utf8'); }
  catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
  try {
    const data = JSON.parse(text);
    if (data?.version !== version) throw new Error('지원하지 않는 상태 파일 버전입니다.');
    return sanitize(data.values);
  } catch {
    try { fs.renameSync(file, file + '.corrupt-' + Date.now()); } catch { /* 보관에 실패해도 시작은 계속한다. */ }
    return null;
  }
}

// 임시 파일에 쓴 뒤 바꿔치기해서, 쓰는 도중에 꺼져도 이전 파일이 남게 한다.
function write(file, values) {
  const clean = sanitize(values);
  const text = JSON.stringify({ version, savedAt: new Date().toISOString(), values: clean }, null, 1);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temporary = file + '.tmp';
  fs.writeFileSync(temporary, text, 'utf8');
  fs.renameSync(temporary, file);
  return Object.keys(clean).length;
}

module.exports = { read, write, sanitize, keyPattern };
