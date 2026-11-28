// 도메인별 IPC 등록(main/ipc/index.cjs): 폴더의 모듈을 이름순으로 불러 같은 context로 등록한다.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

test('main/ipc의 모듈이 모두 함수를 내보내고, 채널 이름이 겹치지 않는다', () => {
  const { registerAll } = require('../main/ipc/index.cjs');
  const channels = [];
  const names = registerAll({ handle: channel => channels.push(channel), app: {}, shell: {}, dialog: {}, getWindow: () => null, send() {} });
  const files = fs.readdirSync(path.join(__dirname, '..', 'main', 'ipc')).filter(name => name.endsWith('.cjs') && name !== 'index.cjs').sort();
  assert.deepEqual(names, files);
  assert.equal(new Set(channels).size, channels.length, '같은 채널을 두 번 등록하지 않는다');
});
