// 채팅 이미지 첨부: 렌더러가 보낸 바이트를 앱 데이터의 attachments 폴더에 저장하고, 보낼 때 다시 확인한다.
// 경로는 이 폴더 안의 파일만 받는다(렌더러가 임의의 파일을 에이전트에 넘기지 못하게).
const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');

const maxBytes = 10 * 1024 * 1024;
const maxAgeMs = 7 * 24 * 60 * 60 * 1000;
const types = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/gif': 'gif', 'image/webp': 'webp' };
const mimeOf = Object.fromEntries(Object.entries(types).map(([mime, ext]) => [ext, mime]));

function saveAttachment(directory, bytes, mime) {
  const ext = types[mime];
  if (!ext) throw new Error('PNG·JPEG·GIF·WebP 이미지만 첨부할 수 있습니다.');
  const data = Buffer.from(bytes);
  if (!data.length) throw new Error('빈 이미지입니다.');
  if (data.length > maxBytes) throw new Error('이미지는 10MB까지 첨부할 수 있습니다.');
  fs.mkdirSync(directory, { recursive: true });
  const file = path.join(directory, randomUUID() + '.' + ext);
  fs.writeFileSync(file, data);
  return { path: file, mime, size: data.length };
}

// 보내기 직전에 경로를 확인한다: 첨부 폴더 바로 아래의 이미지 파일만, 최대 8장.
function checkedImages(directory, paths) {
  if (paths === undefined || paths === null) return [];
  if (!Array.isArray(paths) || paths.length > 8) throw new Error('이미지는 한 번에 8장까지 보낼 수 있습니다.');
  const root = path.resolve(directory).toLowerCase();
  return paths.map(value => {
    const file = path.resolve(String(value));
    const ext = path.extname(file).slice(1).toLowerCase();
    if (path.dirname(file).toLowerCase() !== root || !mimeOf[ext] || !fs.existsSync(file)) throw new Error('첨부 이미지를 찾을 수 없습니다.');
    return { path: file, mime: mimeOf[ext] };
  });
}

function pruneAttachments(directory, now = Date.now()) {
  let removed = 0;
  let entries = [];
  try { entries = fs.readdirSync(directory, { withFileTypes: true }); } catch { return 0; }
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    const file = path.join(directory, entry.name);
    try {
      if (now - fs.statSync(file).mtimeMs > maxAgeMs) { fs.unlinkSync(file); removed++; }
    } catch { /* 다른 곳에서 지웠거나 잠김 */ }
  }
  return removed;
}

module.exports = { saveAttachment, checkedImages, pruneAttachments, maxBytes };
