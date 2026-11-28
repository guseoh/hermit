// 승인 정책: 에이전트의 명령 실행·도구 사용 승인 요청을 규칙(명령 접두사 허용·거부 목록)과 비교한다.
// DOM에 의존하지 않는 순수 함수만 두어 node --test로 직접 검증한다. 브라우저에서는 window.approvalPolicy로 쓴다.

// 셸 래퍼(powershell -Command '…', cmd /c …, bash -lc '…')를 벗겨 실제 명령만 남긴다.
const shellWrapper = /^(?:"[^"]*?(?:powershell|pwsh|cmd|bash|sh)(?:\.exe)?"|\S*?(?:powershell|pwsh|cmd|bash|sh)(?:\.exe)?)\s+(?:(?:-NoProfile|-NoLogo|-NonInteractive|-ExecutionPolicy\s+\S+|-l)\s+)*(?:-Command|-c|-lc|\/c|\/s\s+\/c)\s+([\s\S]+)$/i;

export function normalizeCommand(command) {
  let text = Array.isArray(command) ? command.join(' ') : String(command ?? '');
  text = text.trim();
  for (let depth = 0; depth < 3; depth++) {
    const wrapped = shellWrapper.exec(text);
    if (!wrapped) break;
    text = wrapped[1].trim();
    const quote = text[0];
    if ((quote === '"' || quote === "'") && text.endsWith(quote) && text.length > 1) text = text.slice(1, -1).trim();
  }
  return text.replace(/\s+/g, ' ');
}

// 승인 요청을 비교 가능한 대상으로 바꾼다. kind: command(명령 실행) · file(파일 변경) · tool(그 밖의 Claude 도구)
export function approvalSubject(request) {
  if (request.method === 'item/commandExecution/requestApproval') {
    return { kind: 'command', command: normalizeCommand(request.command), label: '명령 실행' };
  }
  if (request.method === 'claude/approval') {
    const tool = String(request.tool ?? request.reason ?? 'tool');
    const command = request.input?.command;
    if (/^(?:Bash|PowerShell)$/i.test(tool) && typeof command === 'string') {
      return { kind: 'command', tool, command: normalizeCommand(command), label: tool + ' 명령' };
    }
    return { kind: 'tool', tool, label: tool + ' 도구' };
  }
  return { kind: 'file', label: '파일 변경' };
}

// &&, ||, ;, | 로 이어진 명령은 조각마다 판단한다(따옴표 안의 기호는 그대로 둔다).
export function commandSegments(command) {
  const segments = [];
  let current = '';
  let quote = null;
  for (let index = 0; index < command.length; index++) {
    const char = command[index];
    if (quote) {
      if (char === quote) quote = null;
      current += char;
    } else if (char === '"' || char === "'") {
      quote = char;
      current += char;
    } else if (char === ';' || char === '|' || (char === '&' && command[index + 1] === '&')) {
      if (current.trim()) segments.push(current.trim());
      current = '';
      if ((char === '&' || char === '|') && command[index + 1] === char) index++;
    } else current += char;
  }
  if (current.trim()) segments.push(current.trim());
  return segments;
}

function ruleMatches(rule, subject, segment) {
  const text = String(rule).trim();
  if (!text) return false;
  const tool = /^tool:\s*(.+)$/i.exec(text);
  if (tool) return !!subject.tool && subject.tool.toLowerCase() === tool[1].trim().toLowerCase();
  if (segment === undefined) return false;
  const prefix = normalizeCommand(text).toLowerCase();
  const value = segment.toLowerCase();
  return value === prefix || value.startsWith(prefix + ' ');
}

export function emptyPolicy() {
  return { global: { allow: [], deny: [] }, projects: {} };
}

export function parsePolicy(text) {
  try {
    const value = JSON.parse(text);
    if (!value || typeof value !== 'object') return emptyPolicy();
    const list = items => Array.isArray(items) ? items.filter(item => typeof item === 'string' && item.trim()).map(item => item.trim()) : [];
    const scope = entry => ({ allow: list(entry?.allow), deny: list(entry?.deny) });
    const projects = {};
    for (const [key, entry] of Object.entries(value.projects ?? {})) projects[key] = scope(entry);
    return { global: scope(value.global), projects };
  } catch { return emptyPolicy(); }
}

// 거부 규칙이 허용 규칙보다 우선한다. 이어진 명령은 한 조각이라도 거부면 거부, 모든 조각이 허용일 때만 허용.
export function decide(policy, projectKey, subject) {
  const scopes = [['프로젝트', policy.projects?.[projectKey]], ['전역', policy.global]].filter(([, entry]) => entry);
  const segments = subject.kind === 'command' ? commandSegments(subject.command) : [undefined];
  if (!segments.length) return null;
  for (const segment of segments) {
    for (const [scope, entry] of scopes) {
      const rule = entry.deny.find(item => ruleMatches(item, subject, segment));
      if (rule) return { action: 'deny', rule, scope };
    }
  }
  let matched = null;
  for (const segment of segments) {
    let found = null;
    for (const [scope, entry] of scopes) {
      const rule = entry.allow.find(item => ruleMatches(item, subject, segment));
      if (rule) { found = { action: 'allow', rule, scope }; break; }
    }
    if (!found) return null;
    matched ??= found;
  }
  return matched;
}

// "항상 허용"에 넣을 접두사: 첫 단어(경로·.exe 제거)와, 옵션·경로가 아닌 둘째 단어까지.
export function suggestPrefix(command) {
  const [first] = commandSegments(command);
  if (!first) return '';
  const tokens = first.split(' ');
  const head = tokens[0].replace(/^["']|["']$/g, '').split(/[\\/]/).at(-1).replace(/\.(exe|cmd|bat|ps1)$/i, '');
  const second = tokens[1];
  return second && /^[a-z][\w:.-]*$/i.test(second) ? head + ' ' + second : head;
}

const dangerPattern = /\brm\s+-[a-z]*(?:rf|fr)|\bremove-item\b[^|;]*-recurse|\bdel\s+\/[sq]|\brmdir\s+\/s|\bgit\s+push\b[^|;]*(?:--force|\s-f\b)|\bgit\s+reset\s+--hard|\bgit\s+clean\s+-[a-z]*f|\bformat(?:-volume)?\s+[a-z]:|\bset-executionpolicy\b|\b(?:curl|wget|iwr|invoke-webrequest|irm|invoke-restmethod)\b[^;]*\|\s*(?:sh|bash|iex|invoke-expression)\b|\bshutdown\b|\breg\s+delete\b/i;
const networkPattern = /\b(?:curl|wget|invoke-webrequest|iwr|invoke-restmethod|irm|npm\s+(?:install|i|add|publish)|pnpm\s+(?:install|add)|yarn\s+add|pip\s+install|git\s+(?:push|pull|fetch|clone)|gh\s+\w+)\b/i;

export function riskOf(subject) {
  if (subject.kind !== 'command') return null;
  if (dangerPattern.test(subject.command)) return { level: 'danger', label: '되돌리기 어려운 명령' };
  if (networkPattern.test(subject.command)) return { level: 'network', label: '네트워크 사용' };
  return null;
}

// Claude 세션 허용을 기억할 열쇠. 명령은 정확히 같은 명령만, 다른 도구는 도구 이름 단위로 허용한다.
export function sessionKey(subject) {
  return subject.kind === 'command' ? 'command:' + subject.command.toLowerCase()
    : subject.kind === 'tool' ? 'tool:' + subject.tool.toLowerCase() : 'file';
}

if (typeof window !== 'undefined') {
  window.approvalPolicy = { normalizeCommand, approvalSubject, commandSegments, emptyPolicy, parsePolicy, decide, suggestPrefix, riskOf, sessionKey };
}
