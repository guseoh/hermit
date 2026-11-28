// 이미지 첨부(main/attachments.cjs) 테스트: 형식·크기 제한, 첨부 폴더 밖 경로 거부, 오래된 파일 정리.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { saveAttachment, checkedImages, pruneAttachments, maxBytes } = require('../main/attachments.cjs');

const fresh = () => fs.mkdtempSync(path.join(os.tmpdir(), 'hermit-attach-'));

test('이미지를 저장하고, 보낼 때는 첨부 폴더 안의 이미지만 받는다', () => {
  const directory = path.join(fresh(), 'attachments');
  const saved = saveAttachment(directory, new Uint8Array([1, 2, 3]), 'image/png');
  assert.equal(path.dirname(saved.path), directory);
  assert.deepEqual(checkedImages(directory, [saved.path]), [{ path: saved.path, mime: 'image/png' }]);
  assert.deepEqual(checkedImages(directory, undefined), []);
  const outside = path.join(path.dirname(directory), 'secret.png');
  fs.writeFileSync(outside, 'x');
  assert.throws(() => checkedImages(directory, [outside]), /찾을 수 없습니다/);
  assert.throws(() => checkedImages(directory, [path.join(directory, '..', 'attachments', '..', 'secret.png')]), /찾을 수 없습니다/);
  assert.throws(() => checkedImages(directory, [path.join(directory, 'missing.png')]), /찾을 수 없습니다/);
  assert.throws(() => checkedImages(directory, Array(9).fill(saved.path)), /8장/);
});

test('형식과 크기를 제한한다', () => {
  const directory = fresh();
  assert.throws(() => saveAttachment(directory, new Uint8Array([1]), 'image/svg+xml'), /PNG/);
  assert.throws(() => saveAttachment(directory, new Uint8Array([]), 'image/png'), /빈 이미지/);
  assert.throws(() => saveAttachment(directory, new Uint8Array(maxBytes + 1), 'image/jpeg'), /10MB/);
});

test('7일 지난 첨부만 지운다', () => {
  const directory = fresh();
  const old = saveAttachment(directory, new Uint8Array([1]), 'image/png').path;
  const recent = saveAttachment(directory, new Uint8Array([1]), 'image/webp').path;
  const eightDaysAgo = (Date.now() - 8 * 24 * 60 * 60 * 1000) / 1000;
  fs.utimesSync(old, eightDaysAgo, eightDaysAgo);
  assert.equal(pruneAttachments(directory), 1);
  assert.deepEqual([fs.existsSync(old), fs.existsSync(recent)], [false, true]);
  assert.equal(pruneAttachments(path.join(directory, 'none')), 0);
});
