const { spawn } = require('node:child_process');
const { randomUUID } = require('node:crypto');
const fs = require('node:fs/promises');
const { createInterface } = require('node:readline');

// Claude Code 채팅 세션. claude -p --input-format stream-json 프로세스 하나를 세션 동안 유지하고,
// 메시지마다 stdin으로 사용자 턴을 보낸다(턴마다 새로 띄우면 2~5초씩 걸린다).
// 모델·추론 수준이 바뀌면 다시 띄우고, 유휴 시간이 지나면 내린 뒤 다음 메시지에서 --resume으로 이어 간다.
const idleShutdownMs = 15 * 60 * 1000;
const startTimeoutMs = 30000;

class ClaudeSession {
  constructor(file, cwd, historyFile, history, emit) {
    this.file = file;
    this.cwd = cwd;
    this.historyFile = historyFile;
    this.emit = emit;
    this.history = history;
    this.threadId = history.sessionId ?? randomUUID();
    this.approvals = new Map();
    this.child = null;
    this.turn = null;
    this.turnId = null;
    this.idleTimer = null;
  }

  send(text, userId, { model, effort } = {}) {
    if (this.turn) throw new Error('A turn is already active.');
    if (this.closed) throw new Error('Claude 세션이 닫혔습니다.');
    clearTimeout(this.idleTimer);
    const turnId = randomUUID();
    this.turnId = turnId;
    this.stopped = false;
    this.turn = { id: turnId, text, items: [{ id: userId, type: 'userMessage', content: [{ text }] }],
      streamId: undefined, streamText: '', result: null };
    this.emit({ method: 'turn/started', params: { turn: { id: turnId } } });
    const options = JSON.stringify([model ?? '', effort ?? '']);
    if (!this.child || this.options !== options) this.spawn(options, model, effort);
    else this.writeTurn();
    return turnId;
  }

  spawn(options, model, effort) {
    if (this.child) this.retire(this.child);
    const args = ['--print', '--input-format', 'stream-json', '--output-format', 'stream-json',
      '--verbose', '--include-partial-messages', '--permission-mode', 'manual', '--permission-prompt-tool', 'stdio'];
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
      child.kill();
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
      message: { role: 'user', content: [{ type: 'text', text: this.turn.text }] } });
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
    if (message.type === 'stream_event' && message.event?.delta?.type === 'text_delta') {
      turn.streamId ??= randomUUID();
      const delta = message.event.delta.text;
      turn.streamText += delta;
      this.emit({ method: 'item/agentMessage/delta', params: { itemId: turn.streamId, delta } });
    } else if (message.type === 'assistant') {
      const blocks = message.message?.content ?? [];
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
        reason: request.title ?? request.tool_name, command: JSON.stringify(request.input ?? {}, null, 2) } });
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
    if (result?.usage) this.emit({ method: 'usage/claude', params: { tokens: result.usage } });
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
        await fs.writeFile(this.historyFile + '.tmp', JSON.stringify(this.history), 'utf8');
        await fs.rename(this.historyFile + '.tmp', this.historyFile);
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
    if (this.child === child) this.child = null;
    try { child.stdin.end(); } catch { /* 이미 닫힘 */ }
    const timer = setTimeout(() => child.kill(), 3000);
    child.once('close', () => clearTimeout(timer));
  }

  write(message) {
    if (this.child?.stdin.writable) this.child.stdin.write(JSON.stringify(message) + '\n');
  }

  reply(id, response) {
    this.write({ type: 'control_response', response: { subtype: 'success', request_id: id, response } });
  }

  resolve(id, accept) {
    const request = this.approvals.get(id);
    if (!request) throw new Error('승인 요청이 이미 종료되었습니다.');
    this.approvals.delete(id);
    this.reply(id, accept === true
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
      if (this.turn === turn && this.child) this.child.kill();
      else if (this.turn === turn) this.finishTurn('중단했습니다.');
    }, 5000);
  }

  close() {
    this.closed = true;
    clearTimeout(this.idleTimer);
    const child = this.child;
    this.child = null;
    child?.kill();
  }
}

module.exports = ClaudeSession;
