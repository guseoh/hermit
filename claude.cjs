const { killProcessTree } = require('./process-tree.cjs');
const { spawn } = require('node:child_process');
const { randomUUID } = require('node:crypto');
const { saveHistory } = require('./main/claude-history-sync.cjs');
const fs = require('node:fs');
const { createInterface } = require('node:readline');

// Claude Code 채팅 세션. claude -p --input-format stream-json 프로세스 하나를 세션 동안 유지하고,
// 메시지마다 stdin으로 사용자 턴을 보낸다(턴마다 새로 띄우면 2~5초씩 걸린다).
// 모델·추론 수준이 바뀌면 다시 띄우고, 유휴 시간이 지나면 내린 뒤 다음 메시지에서 --resume으로 이어 간다.
const idleShutdownMs = 15 * 60 * 1000;
const startTimeoutMs = 30000;
const initializeArgs = ['--print', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose'];

function modelCatalog(data) {
  const models = [];
  let defaultModel;
  for (const entry of Array.isArray(data?.models) ? data.models : []) {
    if (!entry || typeof entry.value !== 'string' || !entry.value) continue;
    const versionedId = String(entry.resolvedModel ?? '').replace(/-\d{8}$/, '');
    const version = /^claude-[a-z]+-(\d+(?:-\d+)+)$/i.exec(versionedId)?.[1]?.replace(/-/g, '.');
    const model = {
      id: entry.value,
      name: entry.displayName || entry.value,
      resolved: entry.resolvedModel,
      efforts: Array.isArray(entry.supportedEffortLevels) ? entry.supportedEffortLevels.filter(value => typeof value === 'string') : []
    };
    if (version && entry.value !== 'default' && !model.name.includes(version)) model.name += ' ' + version;
    if (entry.value === 'default') defaultModel = model;
    else models.push(model);
  }
  return { models, defaultModel, cliVersion: data?.claude_code_version };
}

function probeModels(file, cwd) {
  return new Promise((resolve, reject) => {
    const id = randomUUID();
    const child = spawn(file, [...initializeArgs, '--bare', '--strict-mcp-config', '--no-session-persistence'],
      { cwd, windowsHide: true, stdio: ['pipe', 'pipe', 'ignore'] });
    const timer = setTimeout(() => finish(new Error('Claude 초기화 확인 시간이 초과되었습니다.')), 12000);
    const lines = createInterface({ input: child.stdout });
    let settled = false;
    function finish(error, data) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      lines.close();
      killProcessTree(child);
      if (error) reject(error);
      else resolve(modelCatalog(data));
    }
    lines.on('line', line => {
      let response;
      try { response = JSON.parse(line).response; } catch { return; }
      if (response?.request_id !== id) return;
      if (response.subtype === 'success') finish(null, response.response);
      else finish(new Error('Claude 초기화 요청이 거절되었습니다.'));
    });
    child.on('error', finish);
    child.on('close', () => finish(new Error('Claude 초기화 응답을 받지 못했습니다.')));
    child.stdin.on('error', () => {});
    child.stdin.end(JSON.stringify({ type: 'control_request', request_id: id, request: { subtype: 'initialize' } }) + '\n');
  });
}

class ClaudeSession {
  constructor(file, cwd, historyFile, history, emit) {
    this.file = file;
    this.cwd = cwd;
    this.historyFile = historyFile;
    this.emit = emit;
    this.history = history;
    this.threadId = history.sessionId ?? history.reservedSessionId ?? randomUUID();
    this.approvals = new Map();
    this.child = null;
    this.turn = null;
    this.turnId = null;
    this.idleTimer = null;
  }

  // images: main이 확인한 첨부 이미지 [{ path, mime }]. stream-json의 base64 이미지 블록으로 보낸다.
  send(text, userId, { model, effort, images = [] } = {}) {
    if (this.turn) throw new Error('A turn is already active.');
    if (this.closed) throw new Error('Claude 세션이 닫혔습니다.');
    clearTimeout(this.idleTimer);
    const turnId = randomUUID();
    this.turnId = turnId;
    this.stopped = false;
    const imageBlocks = images.map(image => ({ type: 'image', source: { type: 'base64', media_type: image.mime, data: fs.readFileSync(image.path).toString('base64') } }));
    this.turn = { id: turnId, text, imageBlocks, items: [{ id: userId, type: 'userMessage', content: [{ text }, ...images.map(image => ({ type: 'image', path: image.path }))] }],
      streamId: undefined, streamText: '', result: null };
    this.emit({ method: 'turn/started', params: { turn: { id: turnId } } });
    const options = JSON.stringify([model ?? '', effort ?? '']);
    if (!this.child || this.options !== options) this.spawn(options, model, effort);
    else this.writeTurn();
    return turnId;
  }

  spawn(options, model, effort) {
    if (this.child) this.retire(this.child);
    const args = [...initializeArgs, '--include-partial-messages', '--permission-mode', 'manual', '--permission-prompt-tool', 'stdio'];
    if (model) args.push('--model', model);
    if (effort) args.push('--effort', effort);
    args.push((this.history.sessionId ? '--resume=' : '--session-id=') + this.threadId);
    const child = spawn(this.file, args, { cwd: this.cwd, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    this.child = child;
    this.options = options;
    child.ready = false;
    child.diagnostic = '';
    child.resumeAccepted = false;
    const initializeId = randomUUID();
    child.startTimer = setTimeout(() => {
      child.diagnostic ||= 'Claude Code 연결 시간이 초과되었습니다.';
      killProcessTree(child);
    }, startTimeoutMs);
    createInterface({ input: child.stdout }).on('line', line => {
      let message;
      try { message = JSON.parse(line); } catch { return; }
      if (this.child !== child) return;
      if (message.type === 'control_response' && message.response?.request_id === initializeId) {
        clearTimeout(child.startTimer);
        if (message.response.subtype !== 'success') {
          child.diagnostic = message.response.error ?? 'Claude Code 연결에 실패했습니다.';
          child.stdin.end();
          return;
        }
        child.ready = true;
        this.emit({ method: 'claude/initialized', params: modelCatalog(message.response.response) });
        if (this.turn) this.writeTurn();
        return;
      }
      this.receive(child, message);
    });
    child.stderr.on('data', chunk => { child.diagnostic = (child.diagnostic + chunk).slice(-2000); });
    child.stdin.on('error', error => { child.diagnostic ||= error.message; });
    child.on('error', error => { child.diagnostic ||= error.message; });
    child.on('close', code => {
      clearTimeout(child.startTimer);
      if (this.child !== child) return;
      this.child = null;
      // 턴 도중에 프로세스가 끝났으면 그 턴은 실패(또는 중단)로 마친다.
      if (this.turn) this.finishTurn(code === 0 && this.turn.result ? null : child.diagnostic.trim());
    });
    this.write({ type: 'control_request', request_id: initializeId, request: { subtype: 'initialize' } });
  }

  writeTurn() {
    if (!this.child?.ready || !this.turn || this.turn.written) return;
    this.turn.written = true;
    this.write({ type: 'user', session_id: '', parent_tool_use_id: null,
      message: { role: 'user', content: [{ type: 'text', text: this.turn.text }, ...(this.turn.imageBlocks ?? [])] } });
  }

  receive(child, message) {
    const turn = this.turn;
    if (message.type === 'system' && message.subtype === 'init') {
      child.resumeAccepted = message.session_id === this.threadId;
      return;
    }
    if (message.type === 'rate_limit_event') {
      this.emit({ method: 'usage/claude', params: { limit: message.rate_limit_info } });
      return;
    }
    if (!turn) return;
    const emitItem = item => {
      turn.items.push(item);
      this.emit({ method: 'item/completed', params: { item } });
    };
    const finishText = text => {
      if (text) emitItem({ id: turn.streamId ?? randomUUID(), type: 'agentMessage', text });
      turn.streamId = undefined;
      turn.streamText = '';
    };
    if (message.type === 'stream_event' && message.event?.delta?.type === 'thinking_delta') {
      // 생각(thinking)도 Codex의 reasoning 항목처럼 흘려보낸다.
      turn.thinkingId ??= randomUUID();
      this.emit({ method: 'item/reasoning/textDelta', params: { itemId: turn.thinkingId, delta: message.event.delta.thinking ?? '' } });
    } else if (message.type === 'stream_event' && message.event?.delta?.type === 'text_delta') {
      turn.streamId ??= randomUUID();
      const delta = message.event.delta.text;
      turn.streamText += delta;
      this.emit({ method: 'item/agentMessage/delta', params: { itemId: turn.streamId, delta } });
    } else if (message.type === 'assistant') {
      // 마지막 API 호출의 입력(캐시 포함)과 출력이 지금 대화가 차지한 컨텍스트다(result.usage는 턴 전체 합계).
      const usage = message.message?.usage;
      if (usage) turn.contextTokens = (usage.input_tokens ?? 0) + (usage.cache_read_input_tokens ?? 0) + (usage.cache_creation_input_tokens ?? 0) + (usage.output_tokens ?? 0);
      const blocks = message.message?.content ?? [];
      const thinking = blocks.filter(block => block.type === 'thinking').map(block => block.thinking ?? '').join('\n\n').trim();
      if (thinking) emitItem({ id: turn.thinkingId ?? randomUUID(), type: 'reasoning', summary: [], content: [thinking] });
      turn.thinkingId = undefined;
      const text = blocks.filter(block => block.type === 'text').map(block => block.text).join('\n\n');
      if (text || turn.streamText) finishText(text || turn.streamText);
      for (const block of blocks.filter(value => value.type === 'tool_use')) {
        emitItem({ id: block.id, type: 'toolUse', title: block.name, input: block.input ?? {} });
      }
    } else if (message.type === 'user') {
      // 도구 결과는 user 역할 블록으로 돌아온다. 같은 도구 단계에 붙인다.
      for (const block of (message.message?.content ?? []).filter(value => value?.type === 'tool_result')) {
        const index = turn.items.findIndex(item => item.id === block.tool_use_id);
        if (index < 0) continue;
        const content = typeof block.content === 'string' ? block.content :
          (block.content ?? []).filter(part => part.type === 'text').map(part => part.text).join('\n');
        turn.items[index] = { ...turn.items[index], output: content.length > 20000 ? content.slice(0, 20000) + '\n… (잘림)' : content,
          isError: block.is_error === true };
        this.emit({ method: 'item/completed', params: { item: turn.items[index] } });
      }
    } else if (message.type === 'control_request') {
      const request = message.request;
      if (request?.subtype !== 'can_use_tool' || this.stopped) {
        this.write({ type: 'control_response', response: {
          subtype: 'error', request_id: message.request_id, error: 'This request is unavailable in Hermit.'
        } });
        return;
      }
      this.approvals.set(message.request_id, request);
      this.emit({ method: 'approval', params: { id: message.request_id, method: 'claude/approval',
        reason: request.title ?? request.tool_name, tool: request.tool_name, input: request.input ?? {},
        command: JSON.stringify(request.input ?? {}, null, 2) } });
    } else if (message.type === 'control_cancel_request') {
      this.approvals.delete(message.request_id);
      this.emit({ method: 'approval/cancelled', params: { id: message.request_id } });
    } else if (message.type === 'result') {
      turn.result = message;
      finishText(turn.streamText || (message.is_error || turn.items.some(item => item.type === 'agentMessage') ? '' : message.result));
      this.finishTurn(null);
    }
  }

  // 턴을 마친다. failure가 있으면 프로세스가 중간에 끝난 경우의 진단 문구다.
  async finishTurn(failure) {
    const turn = this.turn;
    if (!turn) return;
    this.turn = null;
    this.turnId = null;
    const result = turn.result;
    if (turn.streamText) {
      turn.items.push({ id: turn.streamId ?? randomUUID(), type: 'agentMessage', text: turn.streamText });
      this.emit({ method: 'item/completed', params: { item: turn.items.at(-1) } });
    }
    const contextWindow = Object.values(result?.modelUsage ?? {}).map(entry => entry?.contextWindow).find(Number.isFinite);
    const context = Number.isFinite(turn.contextTokens) ? { used: turn.contextTokens, window: contextWindow ?? null } : undefined;
    if (result?.usage) this.emit({ method: 'usage/claude', params: { tokens: result.usage, turnId: turn.id, context } });
    const status = this.stopped ? 'interrupted' : result && !result.is_error && failure === null ? 'completed' : 'failed';
    let error = status === 'failed'
      ? result?.errors?.join('\n') || (result?.is_error ? result?.result : '') || failure || 'Claude Code가 응답을 완료하지 못했습니다.'
      : '';
    const authRequired = status === 'failed' && /failed to authenticate|oauth.*(?:expired|refresh)|not logged in|please run \/login|authentication_error/i.test(error);
    if (authRequired) this.loggedIn = false;
    this.approvals.clear();
    const child = this.child;
    if (child?.resumeAccepted && !authRequired && !this.closed) {
      this.history = { sessionId: this.threadId, items: [...this.history.items, ...turn.items].slice(-100) };
      try {
        await saveHistory(this.historyFile, this.history);
      } catch (saveError) { error ||= 'Claude 채팅 기록 저장 실패 · ' + saveError.message; }
    }
    this.emit({ method: 'turn/completed', params: { turn: { id: turn.id, status, authRequired, error: error ? { message: error } : undefined } } });
    // 로그인 문제나 프로세스 오류 뒤에는 다음 메시지에서 새로 띄운다.
    if (authRequired || status === 'failed') { if (this.child) this.retire(this.child); }
    else this.scheduleIdle();
  }

  scheduleIdle() {
    clearTimeout(this.idleTimer);
    this.idleTimer = setTimeout(() => { if (!this.turn && this.child) this.retire(this.child); }, idleShutdownMs);
  }

  // 프로세스를 내린다. stdin을 닫으면 Claude가 스스로 끝나고, 3초 안에 안 끝나면 강제로 끝낸다.
  retire(child) {
    clearTimeout(child.startTimer);
    if (this.child === child) this.child = null;
    try { child.stdin.end(); } catch { /* 이미 닫힘 */ }
    const timer = setTimeout(() => killProcessTree(child), 3000);
    child.once('close', () => clearTimeout(timer));
  }

  write(message) {
    if (this.child?.stdin.writable) this.child.stdin.write(JSON.stringify(message) + '\n');
  }

  reply(id, response) {
    this.write({ type: 'control_response', response: { subtype: 'success', request_id: id, response } });
  }

  // decision: true·'accept'·'session'은 허용(세션 허용은 Hermit이 기억한다), 그 밖은 거절.
  resolve(id, decision) {
    const request = this.approvals.get(id);
    if (!request) throw new Error('승인 요청이 이미 종료되었습니다.');
    this.approvals.delete(id);
    this.reply(id, decision === true || decision === 'accept' || decision === 'session'
      ? { behavior: 'allow', updatedInput: request.input }
      : { behavior: 'deny', message: '사용자가 이번 도구 실행을 거절했습니다.' });
  }

  // 중단: interrupt를 보내 Claude가 턴을 끝내게 한다. 5초 안에 안 끝나면 프로세스를 끝낸다(다음 메시지에서 다시 띄움).
  stop() {
    if (!this.turn || this.stopped) return;
    this.stopped = true;
    const turn = this.turn;
    this.write({ type: 'control_request', request_id: randomUUID(), request: { subtype: 'interrupt' } });
    setTimeout(() => {
      if (this.turn === turn && this.child) killProcessTree(this.child);
      else if (this.turn === turn) this.finishTurn('중단했습니다.');
    }, 5000);
  }

  close() {
    this.closed = true;
    clearTimeout(this.idleTimer);
    const child = this.child;
    this.child = null;
    if (child) clearTimeout(child.startTimer);
    return killProcessTree(child);
  }
}

module.exports = ClaudeSession;
module.exports.probeModels = probeModels;
