// 에이전트 CLI 확인 캐시(agent.cjs probe) 테스트. 가짜 CLI(.cmd)로 실제 agent-probe.ps1을 돌린다.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const agent = require('../agent.cjs');

const shell = path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
const windows = process.platform === 'win32' && fs.existsSync(shell);
let base;
let fake;
let cacheFile;

before(() => {
  base = fs.mkdtempSync(path.join(os.tmpdir(), 'workbench-probe-'));
  fake = path.join(base, 'fake-codex.cmd');
  fs.writeFileSync(fake, '@echo codex-cli 9.9.1\r\n');
  cacheFile = path.join(base, 'agents.json');
  agent.useProbeCache(cacheFile);
});

after(() => {
  agent.useProbeCache(null);
  fs.rmSync(base, { recursive: true, force: true });
});

test('처음에는 확인해서 저장하고, 실행 파일이 그대로면 다시 확인하지 않는다', { skip: !windows && 'Windows 전용' }, async () => {
  const first = await agent.probe(shell, 'codex', base, fake);
  assert.equal(first.version, 'codex-cli 9.9.1');
  const saved = JSON.parse(fs.readFileSync(cacheFile, 'utf8'));
  const key = 'codex|' + path.resolve(fake).toLowerCase();
  assert.equal(saved[key].version, 'codex-cli 9.9.1');

  const start = Date.now();
  const cached = await agent.probe(shell, 'codex', base, fake);
  assert.ok(Date.now() - start < 300, '캐시에서 바로 돌려준다');
  assert.deepEqual(cached, { file: first.file, version: first.version });

  // 실행 파일이 바뀌면(크기·수정 시각) 다시 확인한다.
  fs.writeFileSync(fake, '@echo codex-cli 9.9.2 (updated)\r\n');
  assert.equal((await agent.probe(shell, 'codex', base, fake)).version, 'codex-cli 9.9.2 (updated)');

  // refresh는 캐시를 건너뛴다.
  const stamp = JSON.parse(fs.readFileSync(cacheFile, 'utf8'))[key].at;
  await new Promise(resolve => setTimeout(resolve, 20));
  await agent.probe(shell, 'codex', base, fake, { refresh: true });
  assert.notEqual(JSON.parse(fs.readFileSync(cacheFile, 'utf8'))[key].at, stamp);
});

test('찾지 못하면 null을 돌려주고 캐시에서 지운다', { skip: !windows && 'Windows 전용' }, async () => {
  const missing = path.join(base, 'missing-codex.cmd');
  fs.writeFileSync(missing, '@echo codex-cli 1.0.0\r\n');
  assert.ok(await agent.probe(shell, 'codex', base, missing));
  fs.rmSync(missing);
  assert.equal(await agent.probe(shell, 'codex', base, missing), null);
  assert.equal(JSON.parse(fs.readFileSync(cacheFile, 'utf8'))['codex|' + path.resolve(missing).toLowerCase()], undefined);
});

test('알 수 없는 도구는 거부한다', async () => {
  await assert.rejects(agent.probe(shell, 'other', base), /Unknown agent/);
});
