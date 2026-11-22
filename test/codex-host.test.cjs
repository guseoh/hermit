// 공용 Codex 서버(codex-host.cjs) 테스트. 가짜 app-server로 작업별 이벤트 분배·승인·서버 종료를 확인한다.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const os = require('node:os');
const { CodexHost } = require('../codex-host.cjs');

const fake = path.join(__dirname, 'fixtures', 'fake-codex-server.cjs');
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(check, limit = 3000) {
  const start = Date.now();
  while (!check() && Date.now() - start < limit) await sleep(20);
  return check();
}

function createHost() {
  let starts = 0;
  const broadcasts = [];
  const host = new CodexHost({
    home: os.tmpdir(),
    clientInfo: { name: 'test', title: 'test', version: '0' },
    start: async () => { starts++; return [process.execPath, [fake], {}]; },
    broadcast: event => broadcasts.push(event)
  });
  return { host, broadcasts, starts: () => starts };
}

async function openTask(host, name, cwd) {
  const events = [];
  const channel = await host.open(name, event => events.push(event));
  const result = await channel.request('thread/start', { cwd });
  channel.bind(result.thread.id);
  return { channel, events };
}

test('서버 하나로 여러 작업을 열고, 이벤트는 각자의 작업으로만 간다', async () => {
  const { host, broadcasts, starts } = createHost();
  try {
    const a = await openTask(host, 'task-a', 'C:\\a');
    const b = await openTask(host, 'task-b', 'C:\\b');
    assert.equal(starts(), 1, '서버는 한 번만 띄운다');
    assert.notEqual(a.channel.threadId, b.channel.threadId);
    await Promise.all([a, b].map(({ channel }, index) => channel.request('turn/start', {
      threadId: channel.threadId, input: [{ type: 'text', text: index ? 'beta' : 'alpha' }]
    })));
    assert.ok(await until(() => a.events.some(e => e.method === 'turn/completed') && b.events.some(e => e.method === 'turn/completed')));
    const text = events => events.filter(e => e.method === 'item/completed').map(e => e.params.item.text);
    assert.deepEqual(text(a.events), ['echo:alpha']);
    assert.deepEqual(text(b.events), ['echo:beta']);
    assert.equal(a.channel.turnId, null, '턴이 끝나면 turnId를 비운다');
    assert.ok(broadcasts.some(e => e.method === 'account/rateLimits/updated'), '작업에 속하지 않는 사용량 이벤트는 broadcast로');
    assert.equal((await host.request('account/rateLimits/read')).rateLimits.primary.usedPercent, 12);
  } finally { await host.shutdown(); }
});

test('승인 요청은 그 작업으로 가고, 그 작업 채널로만 답할 수 있다', async () => {
  const { host } = createHost();
  try {
    const a = await openTask(host, 'task-a', 'C:\\a');
    const b = await openTask(host, 'task-b', 'C:\\b');
    await a.channel.request('turn/start', { threadId: a.channel.threadId, input: [{ type: 'text', text: 'APPROVE please' }] });
    assert.ok(await until(() => a.events.some(e => e.method === 'approval')));
    assert.equal(b.events.filter(e => e.method === 'approval').length, 0);
    const approval = a.events.find(e => e.method === 'approval').params;
    assert.equal(a.channel.approvals.size, 1);
    assert.throws(() => b.channel.resolve(approval.id, true), /no longer pending/);
    a.channel.resolve(approval.id, true);
    assert.ok(await until(() => a.events.some(e => e.method === 'turn/completed')));
    assert.equal(a.channel.approvals.size, 0);
  } finally { await host.shutdown(); }
});

test('서버가 죽으면 모든 작업에 끊김을 알리고, 다음 연결에서 서버를 다시 띄운다', async () => {
  const { host, starts } = createHost();
  try {
    const a = await openTask(host, 'task-a', 'C:\\a');
    const b = await openTask(host, 'task-b', 'C:\\b');
    await a.channel.request('turn/start', { threadId: a.channel.threadId, input: [{ type: 'text', text: 'CRASH' }] }).catch(() => {});
    assert.ok(await until(() => [a, b].every(({ events }) => events.some(e => e.method === 'disconnected'))));
    assert.equal(a.channel.closed && b.channel.closed, true);
    await assert.rejects(a.channel.request('turn/start', {}), /disconnected/);
    const again = await openTask(host, 'task-a', 'C:\\a');
    assert.equal(starts(), 2, '서버를 다시 띄운다');
    await again.channel.request('turn/start', { threadId: again.channel.threadId, input: [{ type: 'text', text: 'back' }] });
    assert.ok(await until(() => again.events.some(e => e.method === 'turn/completed')));
  } finally { await host.shutdown(); }
});

test('작업을 닫으면 그 작업 이벤트만 끊기고 서버는 남는다', async () => {
  const { host } = createHost();
  try {
    const a = await openTask(host, 'task-a', 'C:\\a');
    const b = await openTask(host, 'task-b', 'C:\\b');
    const threadA = a.channel.threadId;
    await a.channel.close();
    assert.equal(host.running, true);
    await assert.rejects(a.channel.request('turn/start', {}), /disconnected/);
    await b.channel.request('turn/start', { threadId: b.channel.threadId, input: [{ type: 'text', text: 'still' }] });
    assert.ok(await until(() => b.events.some(e => e.method === 'turn/completed')));
    assert.equal(a.events.filter(e => e.method === 'disconnected').length, 0, '직접 닫은 작업에는 끊김 알림을 보내지 않는다');
    assert.equal(host.threads.has(threadA), false);
  } finally { await host.shutdown(); }
});

test('작업 폴더를 지우기 전에, 그 폴더의 thread가 남아 있으면 서버를 다시 시작한다', async () => {
  const { host, starts } = createHost();
  try {
    const worktree = path.join(os.tmpdir(), 'repo.worktrees', 'task-1');
    const a = await openTask(host, 'task-a', worktree);
    a.channel.bind(a.channel.threadId, worktree);
    const b = await openTask(host, 'task-b', 'C:\\other');
    b.channel.bind(b.channel.threadId, 'C:\\other');
    assert.equal(await host.releaseFolder(path.join(os.tmpdir(), 'unrelated')), false, '상관없는 폴더면 그대로 둔다');
    assert.equal(host.running, true);
    await a.channel.close();
    assert.equal(host.lingering.size, 1, '닫은 작업의 thread 폴더를 잠시 기억한다');
    assert.equal(await host.releaseFolder(path.dirname(worktree)), true, '하위 폴더의 thread도 해당한다');
    assert.equal(host.running, false);
    assert.ok(await until(() => b.events.some(e => e.method === 'disconnected')), '다른 작업은 끊김 알림을 받아 다시 붙는다');
    assert.equal(b.events.find(e => e.method === 'disconnected').params.message, '작업 폴더를 정리하려고 Codex 서버를 다시 시작합니다.');
    await openTask(host, 'task-b', 'C:\\other');
    assert.equal(starts(), 2);
  } finally { await host.shutdown(); }
});

test('동시에 여러 작업이 열려도 서버는 한 번만 시작한다', async () => {
  const { host, starts } = createHost();
  try {
    await Promise.all(['x', 'y', 'z'].map(name => openTask(host, name, 'C:\\' + name)));
    assert.equal(starts(), 1);
  } finally { await host.shutdown(); }
});
