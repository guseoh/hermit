const { spawn } = require('node:child_process');
const { randomUUID } = require('node:crypto');
const fs = require('node:fs/promises');
const { createInterface } = require('node:readline');

class ClaudeSession {
  constructor(file, cwd, historyFile, history, emit) {
    this.file = file;
    this.cwd = cwd;
    this.historyFile = historyFile;
    this.emit = emit;
    this.history = history;
    this.threadId = history.sessionId ?? randomUUID();
    this.approvals = new Map();
  }

  send(text, userId, { model, effort } = {}) {
    const turnId = randomUUID();
    const args = ['--print', '--input-format', 'stream-json', '--output-format', 'stream-json',
      '--verbose', '--include-partial-messages', '--permission-mode', 'manual', '--permission-prompt-tool', 'stdio'];
    if (model) args.push('--model', model);
    if (effort) args.push('--effort', effort);
    args.push((this.history.sessionId ? '--resume=' : '--session-id=') + this.threadId);
    const child = spawn(this.file, args, { cwd: this.cwd, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    this.child = child;
    this.turnId = turnId;
    this.stopped = false;
    const items = [{ id: userId, type: 'userMessage', content: [{ text }] }];
    let resumeAccepted = false;
    let diagnostic = '';
    let result;
    let streamId;
    let streamText = '';
    const initializeId = randomUUID();
    const startTimeout = setTimeout(() => {
      diagnostic ||= 'Claude Code 연결 시간이 초과되었습니다.';
      child.kill();
    }, 30000);

    const emitItem = item => {
      items.push(item);
      this.emit({ method: 'item/completed', params: { item } });
    };
    const finishText = text => {
      if (text) emitItem({ id: streamId ?? randomUUID(), type: 'agentMessage', text });
      streamId = undefined;
      streamText = '';
    };
    createInterface({ input: child.stdout }).on('line', line => {
      let message;
      try { message = JSON.parse(line); } catch { return; }
      if (message.type === 'control_response' && message.response?.request_id === initializeId) {
        clearTimeout(startTimeout);
        if (message.response.subtype !== 'success') {
          diagnostic = message.response.error ?? 'Claude Code 연결에 실패했습니다.';
          child.stdin.end();
          return;
        }
        this.write({ type: 'user', session_id: '', parent_tool_use_id: null,
          message: { role: 'user', content: [{ type: 'text', text }] } });
      } else if (message.type === 'system' && message.subtype === 'init') {
        resumeAccepted = message.session_id === this.threadId;
      } else if (message.type === 'stream_event' && message.event?.delta?.type === 'text_delta') {
        streamId ??= randomUUID();
        const delta = message.event.delta.text;
        streamText += delta;
        this.emit({ method: 'item/agentMessage/delta', params: { itemId: streamId, delta } });
      } else if (message.type === 'assistant') {
        const blocks = message.message?.content ?? [];
        const text = blocks.filter(block => block.type === 'text').map(block => block.text).join('\n\n');
        if (text || streamText) finishText(text || streamText);
        for (const block of blocks.filter(value => value.type === 'tool_use')) {
          emitItem({ id: block.id, type: 'toolUse', title: block.name, input: block.input ?? {} });
        }
      } else if (message.type === 'user') {
        // Tool results come back as user-role blocks; attach them to the matching tool step.
        for (const block of (message.message?.content ?? []).filter(value => value?.type === 'tool_result')) {
          const index = items.findIndex(item => item.id === block.tool_use_id);
          if (index < 0) continue;
          const content = typeof block.content === 'string' ? block.content :
            (block.content ?? []).filter(part => part.type === 'text').map(part => part.text).join('\n');
          items[index] = { ...items[index], output: content.length > 20000 ? content.slice(0, 20000) + '\n… (잘림)' : content,
            isError: block.is_error === true };
          this.emit({ method: 'item/completed', params: { item: items[index] } });
        }
      } else if (message.type === 'control_request') {
        const request = message.request;
        if (request?.subtype !== 'can_use_tool' || this.stopped) {
          this.write({ type: 'control_response', response: {
            subtype: 'error', request_id: message.request_id, error: 'This request is unavailable in Agent Workbench.'
          } });
          return;
        }
        this.approvals.set(message.request_id, request);
        this.emit({ method: 'approval', params: { id: message.request_id, method: 'claude/approval',
          reason: request.title ?? request.tool_name, command: JSON.stringify(request.input ?? {}, null, 2) } });
      } else if (message.type === 'control_cancel_request') {
        this.approvals.delete(message.request_id);
        this.emit({ method: 'approval/cancelled', params: { id: message.request_id } });
      } else if (message.type === 'rate_limit_event') {
        this.emit({ method: 'usage/claude', params: { limit: message.rate_limit_info } });
      } else if (message.type === 'result') {
        result = message;
        child.stdin.end();
      }
    });
    child.stderr.on('data', chunk => { diagnostic = (diagnostic + chunk).slice(-2000); });
    child.stdin.on('error', error => { diagnostic ||= error.message; });
    child.on('error', error => { diagnostic ||= error.message; });
    child.on('close', async code => {
      clearTimeout(startTimeout);
      finishText(streamText || (result?.is_error || items.some(item => item.type === 'agentMessage') ? '' : result?.result));
      if (result?.usage) this.emit({ method: 'usage/claude', params: { tokens: result.usage } });
      const status = this.stopped ? 'interrupted' : code === 0 && result && !result.is_error ? 'completed' : 'failed';
      let error = status === 'failed' ? result?.errors?.join('\n') || result?.result || diagnostic.trim() || 'Claude Code가 응답을 완료하지 못했습니다.' : '';
      const authRequired = status === 'failed' && /failed to authenticate|oauth.*(?:expired|refresh)|not logged in|please run \/login|authentication_error/i.test(error);
      if (authRequired) this.loggedIn = false;
      if (resumeAccepted && !authRequired && !this.closed) {
        this.history = { sessionId: this.threadId, items: [...this.history.items, ...items].slice(-100) };
        try {
          await fs.writeFile(this.historyFile + '.tmp', JSON.stringify(this.history), 'utf8');
          await fs.rename(this.historyFile + '.tmp', this.historyFile);
        } catch (saveError) { error ||= 'Claude 채팅 기록 저장 실패 · ' + saveError.message; }
      }
      this.approvals.clear();
      this.child = null;
      this.turnId = null;
      this.emit({ method: 'turn/completed', params: { turn: { id: turnId, status, authRequired, error: error ? { message: error } : undefined } } });
    });
    this.emit({ method: 'turn/started', params: { turn: { id: turnId } } });
    this.write({ type: 'control_request', request_id: initializeId, request: { subtype: 'initialize' } });
    return turnId;
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

  stop() {
    if (!this.child || this.stopped) return;
    this.stopped = true;
    this.write({ type: 'control_request', request_id: randomUUID(), request: { subtype: 'interrupt' } });
    const child = this.child;
    const timer = setTimeout(() => { if (this.child === child) child.kill(); }, 3000);
    child.once('close', () => clearTimeout(timer));
  }

  close() {
    this.closed = true;
    this.child?.kill();
  }
}

module.exports = ClaudeSession;
