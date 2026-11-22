// 앱 전체에서 codex app-server 하나를 같이 쓴다. 작업마다 thread 하나를 열고, 서버가 보내는 이벤트는
// params.threadId로 작업에 나눠 보낸다(같은 연결에서 cwd가 다른 thread를 동시에 돌릴 수 있음을 확인함).
// 작업 쪽에는 예전 CodexSession과 같은 모양의 채널(request·resolve·close·turnId·approvals)을 돌려준다.
const path = require('node:path');
const { CodexSession } = require('./agent.cjs');

const idleShutdownMs = 10 * 60 * 1000;
// thread/unsubscribe 뒤 Codex가 thread를 실제로 내리기까지 걸리는 시간(실측 약 55초)보다 넉넉히
const lingerMs = 90 * 1000;

class CodexChannel {
  constructor(host, taskId, emit) {
    this.host = host;
    this.taskId = taskId;
    this.emit = emit;
    this.threadId = null;
    this.turnId = null;
    this.completedTurn = null;
    this.sending = false;
    this.approvals = new Map();
    this.closed = false;
  }

  request(method, params) {
    if (this.closed) return Promise.reject(new Error('Codex session disconnected.'));
    return this.host.request(method, params);
  }

  // thread/start·thread/resume 결과로 받은 thread를 이 채널에 묶는다. cwd는 폴더 정리 때 쓴다.
  bind(threadId, cwd) {
    this.cwd = cwd ?? this.cwd;
    this.host.bindThread(this, threadId);
  }

  resolve(id, accept) {
    if (!this.approvals.has(id)) throw new Error('Approval is no longer pending.');
    this.approvals.delete(id);
    this.host.resolve(id, accept);
  }

  receive(event) {
    const { method, params } = event;
    if (method === 'approval') this.approvals.set(params.id, params.method);
    if (method === 'turn/started') this.turnId = params.turn?.id ?? this.turnId;
    if (method === 'turn/completed') {
      this.completedTurn = params.turn?.id ?? null;
      if (this.turnId === this.completedTurn) this.turnId = null;
      this.approvals.clear();
    }
    this.emit(event);
  }

  fail(message) {
    if (this.closed) return;
    this.closed = true;
    this.approvals.clear();
    this.turnId = null;
    this.emit({ method: 'disconnected', params: { message } });
  }

  // 작업을 닫으면 채널만 떼어 낸다. 서버는 다른 작업이 쓰고 있을 수 있다.
  close() {
    this.closed = true;
    this.approvals.clear();
    this.host.detach(this);
    return Promise.resolve();
  }
}

class CodexHost {
  // start(): Promise<[command, args, env]> — 서버 실행 명령, clientInfo: initialize에 보낼 정보,
  // broadcast(event): 특정 thread에 속하지 않는 이벤트(사용량 한도 등)를 받을 곳
  constructor({ start, clientInfo, broadcast = () => {}, home }) {
    this.start = start;
    this.clientInfo = clientInfo;
    this.broadcast = broadcast;
    this.home = home;
    this.session = null;
    this.starting = null;
    this.channels = new Set();
    this.threads = new Map();
    this.lingering = new Map();
    this.idleTimer = null;
  }

  get running() { return !!this.session && !this.session.closed; }

  async ensure() {
    if (this.running) return this.session;
    if (this.starting) return this.starting;
    this.starting = (async () => {
      const [command, args, env] = await this.start();
      const session = new CodexSession(command, args, this.home, event => this.dispatch(session, event), env);
      try {
        await session.request('initialize', { clientInfo: this.clientInfo });
        session.write({ method: 'initialized' });
      } catch (error) {
        await session.close();
        throw error;
      }
      this.session = session;
      return session;
    })();
    try { return await this.starting; } finally { this.starting = null; }
  }

  async open(taskId, emit) {
    clearTimeout(this.idleTimer);
    await this.ensure();
    const channel = new CodexChannel(this, taskId, emit);
    this.channels.add(channel);
    return channel;
  }

  async request(method, params) {
    const session = await this.ensure();
    return session.request(method, params);
  }

  resolve(id, accept) {
    if (!this.running) throw new Error('Codex session disconnected.');
    this.session.resolve(id, accept);
  }

  bindThread(channel, threadId) {
    for (const [id, owner] of this.threads) if (owner === channel) this.threads.delete(id);
    channel.threadId = threadId;
    this.threads.set(threadId, channel);
  }

  // 채널을 떼고 thread 구독을 끊는다. Codex는 구독이 없는 thread를 약 1분 뒤 내리는데, 그동안 thread의
  // 보조 프로세스(node_repl 등)가 thread 폴더를 잡고 있다. 그래서 내려가기 전까지 폴더를 기억해 둔다.
  detach(channel) {
    this.channels.delete(channel);
    if (channel.threadId && this.threads.get(channel.threadId) === channel) {
      this.threads.delete(channel.threadId);
      if (this.running) {
        this.session.request('thread/unsubscribe', { threadId: channel.threadId }).catch(() => {});
        if (channel.cwd) this.lingering.set(channel.threadId, { cwd: channel.cwd, until: Date.now() + lingerMs });
      }
    }
    if (!this.channels.size) {
      clearTimeout(this.idleTimer);
      this.idleTimer = setTimeout(() => { if (!this.channels.size) this.shutdown(); }, idleShutdownMs);
    }
  }

  dispatch(session, event) {
    if (session !== this.session && event.method !== 'disconnected') return;
    const { method, params } = event;
    if (method === 'disconnected') {
      if (session !== this.session) return;
      this.session = null;
      const channels = [...this.channels];
      this.channels.clear();
      this.threads.clear();
      // 서버 stderr(색 코드가 섞인 로그)를 그대로 보여 주지 않고 알기 쉬운 문구로 알린다.
      for (const channel of channels) channel.fail('Codex 서버 연결이 끊겼습니다.');
      return;
    }
    const threadId = params?.threadId ?? (method === 'thread/started' ? params?.thread?.id : undefined);
    if (threadId) {
      this.threads.get(threadId)?.receive(event);
      return;
    }
    if (method === 'account/rateLimits/updated') this.broadcast(event);
  }

  // 폴더(worktree)를 지우기 전에 부른다. 그 폴더 안에서 열렸던 thread가 아직 서버에 남아 있을 수 있으면
  // 서버를 다시 시작해 보조 프로세스를 끝낸다(다른 작업은 끊김 알림을 받고 자동으로 다시 붙는다).
  async releaseFolder(folder) {
    if (!this.running || typeof folder !== 'string') return false;
    const inside = cwd => {
      const relative = path.relative(path.resolve(folder), path.resolve(cwd));
      return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
    };
    const now = Date.now();
    for (const [threadId, entry] of this.lingering) if (entry.until < now) this.lingering.delete(threadId);
    const busy = [...this.channels].some(channel => channel.cwd && inside(channel.cwd)) ||
      [...this.lingering.values()].some(entry => inside(entry.cwd));
    if (!busy) return false;
    await this.shutdown('작업 폴더를 정리하려고 Codex 서버를 다시 시작합니다.');
    return true;
  }

  async shutdown(message = 'Codex 서버를 종료했습니다.') {
    clearTimeout(this.idleTimer);
    this.lingering.clear();
    const session = this.session;
    this.session = null;
    for (const channel of [...this.channels]) channel.fail(message);
    this.channels.clear();
    this.threads.clear();
    if (session) await session.close();
  }
}

module.exports = { CodexHost, CodexChannel };
