// 로컬 개발 서버 포트 감지(renderer/core/port-detect.mjs) 단위 테스트.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

let mod;
async function load() {
  if (!mod) mod = await import(pathToFileURL(path.join(__dirname, '..', 'renderer', 'core', 'port-detect.mjs')).href);
  return mod;
}

test('ANSI 색상과 OSC 777 시퀀스를 벗겨낸다', async () => {
  const { stripAnsi } = await load();
  const sample = '\x1b]777;workbench-directory;Qzpc\x07\x1b[32m➜\x1b[39m  \x1b[1mLocal:\x1b[22m   \x1b[36mhttp://localhost:\x1b[1m5173\x1b[22m/\x1b[39m\r\n';
  assert.equal(stripAnsi(sample), '➜  Local:   http://localhost:5173/\n');
});

test('localhost, 127.0.0.1, 0.0.0.0, [::1] 주소를 정규화해 감지한다', async () => {
  const { detectLocalUrls } = await load();
  assert.deepEqual(
    detectLocalUrls('  ➜  Local:   \x1b[36mhttp://localhost:5173/\x1b[0m\n').map(x => x.url),
    ['http://localhost:5173']
  );
  assert.deepEqual(
    detectLocalUrls('Started on http://127.0.0.1:8080/app?dev=1.').map(x => x.url),
    ['http://127.0.0.1:8080/app?dev=1']
  );
  assert.deepEqual(
    detectLocalUrls('Listening on http://0.0.0.0:3000 and http://[::1]:4000/docs').map(x => x.url),
    ['http://localhost:3000', 'http://localhost:4000/docs']
  );
  assert.deepEqual(
    detectLocalUrls('HTTPS dev server at https://localhost:8443').map(x => x.url),
    ['https://localhost:8443']
  );
});

test('스킴 없는 host:port 및 dev 서버 listening 줄을 감지하고 잡음을 무시한다', async () => {
  const { detectLocalUrls } = await load();
  assert.deepEqual(detectLocalUrls('Serving at localhost:4321').map(x => x.url), ['http://localhost:4321']);
  assert.deepEqual(detectLocalUrls('Server listening on port 3001').map(x => x.url), ['http://localhost:3001']);
  assert.deepEqual(detectLocalUrls('ready on port 8000').map(x => x.url), ['http://localhost:8000']);
  // 잘못된 포트, 외부 도메인, 자격 증명 포함 URL, 너무 작은 포트 번호는 무시한다.
  assert.deepEqual(detectLocalUrls('http://example.com:8080 http://user:pass@localhost:3000 http://localhost:99999 listening on port 2'), []);
});

test('스트림 감지기: 청크 경계에 걸친 URL을 이어 붙이고 중복·닫힘 상태를 기억한다', async () => {
  const { createPortDetector } = await load();
  const seen = [];
  const detector = createPortDetector({ onDetect: entry => seen.push(entry.url) });

  assert.deepEqual(detector.push('VITE v6.0.0 ready in 120 ms\n  Local: http://loca'), []);
  const hit = detector.push('lhost:5173/\n');
  assert.equal(hit.length, 1);
  assert.equal(hit[0].url, 'http://localhost:5173');
  assert.deepEqual(seen, ['http://localhost:5173']);

  // 같은 주소가 다시 출력돼도 중복 알림을 내지 않는다.
  assert.deepEqual(detector.push('still at http://localhost:5173\n'), []);

  // 닫은(dismiss) 주소는 다시 출력돼도 띄우지 않는다.
  detector.dismiss(hit[0].key);
  assert.deepEqual(detector.list(), []);
  assert.deepEqual(detector.push('reprinted http://localhost:5173\n'), []);

  // 다른 포트는 새로 감지한다.
  const second = detector.push('API listening on port 4000\n');
  assert.equal(second.length, 1);
  assert.equal(second[0].url, 'http://localhost:4000');

  // clear 후에는 처음부터 다시 감지한다.
  detector.clear();
  assert.equal(detector.push('http://localhost:5173\n').length, 1);
});
