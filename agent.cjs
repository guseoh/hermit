const { spawn, execFile } = require('node:child_process');
const { promisify } = require('node:util');
const { createInterface } = require('node:readline');
const path = require('node:path');
const fs = require('node:fs/promises');
const exec = promisify(execFile);

async function probe(shell, tool, cwd, executable) {
  if (!['codex', 'claude'].includes(tool)) throw new Error('Unknown agent.');
  const args = ['-NoLogo', '-NonInteractive', '-File', path.join(__dirname, 'agent-probe.ps1'), '-Tool', tool];
  if (executable) args.push('-Executable', executable);
  const { stdout } = await exec(shell, args, { cwd, windowsHide: true, timeout: 15000 });
  const line = stdout.split(/\r?\n/).findLast(value => value.startsWith('WORKBENCH_AGENT:'));
  return line ? JSON.parse(line.slice('WORKBENCH_AGENT:'.length)) : null;
}

async function serverCommand(shell, file) {
  if (/\.exe$/i.test(file)) return [file, ['app-server', '--stdio']];
  const npmEntry = path.join(path.dirname(file), 'node_modules', '@openai', 'codex', 'bin', 'codex.js');
  if (await fs.stat(npmEntry).then(stat => stat.isFile(), () => false)) {
    return [process.execPath, [npmEntry, 'app-server', '--stdio']];
  }
  return [shell, ['-NoLogo', '-NoProfile', '-NonInteractive', '-File', path.join(__dirname, 'codex-server.ps1'), '-Executable', file]];
}

async function claudeAuthStatus(file, cwd) {
  let stdout;
  try {
    ({ stdout } = await exec(file, ['auth', 'status', '--json'], { cwd, windowsHide: true, timeout: 10000 }));
  } catch (error) {
    stdout = error.stdout;
    if (!stdout) throw new Error('Claude Code 로그인 상태를 확인하지 못했습니다.');
  }
  try {
    const { loggedIn } = JSON.parse(stdout);
    return typeof loggedIn === 'boolean' ? loggedIn : null;
  } catch {
    return null;
  }
}

class CodexSession {
  constructor(command, args, cwd, emit) {
    this.emit = emit;
    this.serial = 0;
    this.pending = new Map();
    this.approvals = new Map();
    this.child = spawn(command, args, {
      cwd, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, ...(command === process.execPath ? { ELECTRON_RUN_AS_NODE: '1' } : {}) }
    });
    this.child.stderr.on('data', chunk => { this.diagnostic = ((this.diagnostic ?? '') + chunk).slice(-1500); });
    this.child.stdin.on('error', error => this.fail(error));
    this.child.on('error', error => this.fail(error));
    this.child.on('close', code => this.fail(new Error(this.diagnostic?.trim() || 'Codex App Server exited (' + code + ').')));
    createInterface({ input: this.child.stdout }).on('line', line => {
      try { this.receive(JSON.parse(line)); } catch { /* Startup may print non-protocol lines. */ }
    });
  }

  write(value) {
    if (this.closed) throw new Error('Codex session disconnected.');
    this.child.stdin.write(JSON.stringify(value) + '\n');
  }

  request(method, params) {
    if (this.closed) return Promise.reject(new Error('Codex session disconnected.'));
    const id = ++this.serial;
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(method + ' timed out. Reopen the task before retrying.'));
      }, 25000);
      this.pending.set(id, { resolve, reject, timeout });
      try { this.write({ id, method, params }); }
      catch (error) { clearTimeout(timeout); this.pending.delete(id); reject(error); }
    });
  }

  receive(message) {
    const { id, method, params, error, result } = message;
    if (method && id !== undefined) {
      if (['item/commandExecution/requestApproval', 'item/fileChange/requestApproval'].includes(method)) {
        this.approvals.set(id, method);
        this.emit({ method: 'approval', params: { id, method, ...params } });
      } else {
        this.write({ id, error: { code: -32601, message: 'This request is unavailable in Workbench.' } });
        this.emit({ method: 'notice', params: { message: '지원하지 않는 에이전트 요청: ' + method } });
      }
    } else if (method) {
      if (method === 'turn/started') this.turnId = params.turn.id;
      if (method === 'turn/completed') {
        this.completedTurn = params.turn.id;
        if (this.turnId === params.turn.id) this.turnId = null;
        this.approvals.clear();
      }
      this.emit({ method, params });
    } else {
      const request = this.pending.get(id);
      if (!request) return;
      this.pending.delete(id);
      clearTimeout(request.timeout);
      if (error) request.reject(new Error(error.message));
      else request.resolve(result);
    }
  }

  resolve(id, accept) {
    if (!this.approvals.has(id)) throw new Error('Approval is no longer pending.');
    this.write({ id, result: { decision: accept === true ? 'accept' : 'decline' } });
    this.approvals.delete(id);
  }

  fail(error) {
    if (this.closed) return;
    this.closed = true;
    for (const request of this.pending.values()) {
      clearTimeout(request.timeout);
      request.reject(error);
    }
    this.pending.clear();
    this.approvals.clear();
    this.emit({ method: 'disconnected', params: { message: error.message } });
  }

  close() {
    this.fail(new Error('Session closed.'));
    this.child.stdin.end();
    this.child.kill();
  }
}

module.exports = { probe, serverCommand, claudeAuthStatus, CodexSession };
