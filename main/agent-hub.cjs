// 에이전트 설정 허브 백엔드:
// 1) 프로젝트/전역 에이전트 지침·규칙 파일(CLAUDE.md, AGENTS.md, .agents/**/*.md, ~/.claude/CLAUDE.md, ~/.codex/AGENTS.md, ~/.gemini/antigravity-cli/settings.json)
//    탐색 및 엄격한 allowlist 기반 읽기·쓰기.
// 2) MCP 서버 설정(.mcp.json, ~/.claude.json, ~/.claude/settings.json, ~/.codex/config.toml) 탐색 및 파싱.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const MAX_FILE_BYTES = 512 * 1024;
const MAX_AGENTS_DEPTH = 4;
const MAX_AGENTS_FILES = 60;

function normalizePathKey(filePath) {
  const resolved = path.resolve(filePath);
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

function isInsideDir(baseDir, candidatePath) {
  const rel = path.relative(path.resolve(baseDir), path.resolve(candidatePath));
  return Boolean(rel) && !rel.startsWith('..') && !path.isAbsolute(rel);
}

function safeRealpath(targetPath) {
  try { return fs.realpathSync(targetPath); }
  catch { return null; }
}

function resolveProjectRoot(cwd) {
  if (typeof cwd !== 'string' || !cwd.trim() || cwd.includes('\0')) return null;
  const resolved = path.resolve(cwd);
  try {
    return fs.statSync(resolved).isDirectory() ? resolved : null;
  } catch {
    return null;
  }
}

function globalAllowlist(homeDir = os.homedir()) {
  const home = path.resolve(homeDir);
  return [
    {
      id: 'global:claude-md',
      label: '~/.claude/CLAUDE.md',
      scope: 'global',
      kind: 'claude',
      format: 'markdown',
      writable: true,
      path: path.join(home, '.claude', 'CLAUDE.md')
    },
    {
      id: 'global:codex-agents',
      label: '~/.codex/AGENTS.md',
      scope: 'global',
      kind: 'codex',
      format: 'markdown',
      writable: true,
      path: path.join(home, '.codex', 'AGENTS.md')
    },
    {
      id: 'global:antigravity-settings',
      label: '~/.gemini/antigravity-cli/settings.json',
      scope: 'global',
      kind: 'antigravity',
      format: 'json',
      writable: true,
      path: path.join(home, '.gemini', 'antigravity-cli', 'settings.json')
    }
  ];
}

function walkAgentsMarkdown(agentsDir, rootDir) {
  const results = [];
  const rootReal = safeRealpath(agentsDir);
  if (!rootReal) return results;

  function visit(currentDir, depth) {
    if (depth > MAX_AGENTS_DEPTH || results.length >= MAX_AGENTS_FILES) return;
    let entries;
    try { entries = fs.readdirSync(currentDir, { withFileTypes: true }); }
    catch { return; }
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      if (results.length >= MAX_AGENTS_FILES) break;
      if (entry.name.startsWith('.') && entry.name !== '.agents') continue;
      const fullPath = path.join(currentDir, entry.name);
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) {
        visit(fullPath, depth + 1);
      } else if (entry.isFile() && /\.md$/i.test(entry.name)) {
        const real = safeRealpath(fullPath);
        if (!real || !isInsideDir(rootReal, real)) continue;
        const rel = path.relative(rootDir, fullPath).replace(/\\/g, '/');
        results.push({
          id: 'project:' + rel,
          label: rel,
          scope: 'project',
          kind: 'agents',
          format: 'markdown',
          writable: true,
          path: fullPath
        });
      }
    }
  }

  visit(agentsDir, 0);
  return results;
}

function projectAllowlist(cwd) {
  const root = resolveProjectRoot(cwd);
  if (!root) return [];
  const list = [
    {
      id: 'project:CLAUDE.md',
      label: 'CLAUDE.md',
      scope: 'project',
      kind: 'claude',
      format: 'markdown',
      writable: true,
      path: path.join(root, 'CLAUDE.md')
    },
    {
      id: 'project:AGENTS.md',
      label: 'AGENTS.md',
      scope: 'project',
      kind: 'codex',
      format: 'markdown',
      writable: true,
      path: path.join(root, 'AGENTS.md')
    }
  ];
  const agentsDir = path.join(root, '.agents');
  try {
    if (fs.lstatSync(agentsDir).isDirectory()) {
      list.push(...walkAgentsMarkdown(agentsDir, root));
    }
  } catch { /* .agents 폴더가 없으면 건너뛴다 */ }
  return list;
}

function statMeta(entry) {
  try {
    const st = fs.statSync(entry.path);
    if (!st.isFile()) return { ...entry, exists: false, size: 0, mtimeMs: 0 };
    return { ...entry, exists: true, size: st.size, mtimeMs: st.mtimeMs };
  } catch {
    return { ...entry, exists: false, size: 0, mtimeMs: 0 };
  }
}

function listInstructions(cwd, { homeDir = os.homedir() } = {}) {
  const root = resolveProjectRoot(cwd);
  const items = [
    ...projectAllowlist(root),
    ...globalAllowlist(homeDir)
  ].map(statMeta);
  return { cwd: root, items };
}

function resolveAllowedInstruction(cwd, targetPath, { homeDir = os.homedir() } = {}) {
  if (typeof targetPath !== 'string' || !targetPath.trim() || targetPath.includes('\0')) {
    throw new Error('허용되지 않은 파일 경로입니다.');
  }
  const normalizedTarget = normalizePathKey(targetPath);
  const root = resolveProjectRoot(cwd);
  const known = [...projectAllowlist(root), ...globalAllowlist(homeDir)];
  const matched = known.find(entry => normalizePathKey(entry.path) === normalizedTarget);
  if (matched) return matched;

  // 프로젝트 .agents/ 아래의 새/기존 .md 파일도 엄격한 경계 검사 후 허용한다.
  if (root) {
    const agentsDir = path.join(root, '.agents');
    const resolvedTarget = path.resolve(targetPath);
    if (isInsideDir(agentsDir, resolvedTarget) && /\.md$/i.test(resolvedTarget)) {
      const agentsReal = safeRealpath(agentsDir);
      if (agentsReal) {
        const existingReal = safeRealpath(resolvedTarget);
        if (existingReal && !isInsideDir(agentsReal, existingReal)) {
          throw new Error('허용되지 않은 심볼릭 링크 경로입니다.');
        }
        const rel = path.relative(root, resolvedTarget).replace(/\\/g, '/');
        return {
          id: 'project:' + rel,
          label: rel,
          scope: 'project',
          kind: 'agents',
          format: 'markdown',
          writable: true,
          path: resolvedTarget
        };
      }
    }
  }
  throw new Error('허용된 에이전트 지침·설정 파일만 읽거나 쓸 수 있습니다.');
}

function readInstructionFile(cwd, targetPath, options = {}) {
  const entry = resolveAllowedInstruction(cwd, targetPath, options);
  const meta = statMeta(entry);
  if (!meta.exists) return { ...meta, content: '' };
  if (meta.size > MAX_FILE_BYTES) throw new Error('파일이 너무 커서 열 수 없습니다(512KB 초과).');
  const content = fs.readFileSync(entry.path, 'utf8');
  return { ...meta, content };
}

function writeInstructionFile(cwd, targetPath, content, options = {}) {
  const entry = resolveAllowedInstruction(cwd, targetPath, options);
  if (!entry.writable) throw new Error('이 설정 파일은 읽기 전용입니다.');
  if (typeof content !== 'string') throw new Error('문자열 내용만 저장할 수 있습니다.');
  if (Buffer.byteLength(content, 'utf8') > MAX_FILE_BYTES) {
    throw new Error('저장할 내용이 너무 큽니다(512KB 초과).');
  }
  if (entry.format === 'json') {
    try {
      JSON.parse(content);
    } catch (error) {
      throw new Error('유효한 JSON 형식이 아닙니다: ' + error.message);
    }
  }
  fs.mkdirSync(path.dirname(entry.path), { recursive: true });
  fs.writeFileSync(entry.path, content, 'utf8');
  return { ...statMeta(entry), saved: true };
}

// ── MCP 설정 탐색 및 경량 파서 ──

function summarizeServer(name, cfg, source, sourcePath, scope) {
  if (!cfg || typeof cfg !== 'object') return null;
  const command = typeof cfg.command === 'string' ? cfg.command.trim() : '';
  const args = Array.isArray(cfg.args) ? cfg.args.map(String) : [];
  const url = typeof cfg.url === 'string' ? cfg.url.trim()
    : typeof cfg.serverUrl === 'string' ? cfg.serverUrl.trim() : '';
  const transport = url ? 'http' : command ? 'stdio' : 'unknown';
  const target = url || [command, ...args].filter(Boolean).join(' ');
  const enabled = cfg.disabled === true ? false : cfg.enabled === false ? false : true;
  const envKeys = cfg.env && typeof cfg.env === 'object' ? Object.keys(cfg.env) : [];
  return {
    name: String(name),
    source,
    sourcePath,
    scope,
    transport,
    target,
    enabled,
    envKeys
  };
}

function parseJsonMcpObject(obj, source, sourcePath, scope, cwd) {
  const servers = [];
  if (!obj || typeof obj !== 'object') return servers;
  if (obj.mcpServers && typeof obj.mcpServers === 'object') {
    for (const [name, cfg] of Object.entries(obj.mcpServers)) {
      const entry = summarizeServer(name, cfg, source, sourcePath, scope);
      if (entry) servers.push(entry);
    }
  }
  // ~/.claude.json은 projects[cwd].mcpServers에도 프로젝트별 서버를 둘 수 있다.
  if (cwd && obj.projects && typeof obj.projects === 'object') {
    const cwdKey = normalizePathKey(cwd);
    for (const [projPath, projCfg] of Object.entries(obj.projects)) {
      if (normalizePathKey(projPath) !== cwdKey) continue;
      if (projCfg?.mcpServers && typeof projCfg.mcpServers === 'object') {
        for (const [name, cfg] of Object.entries(projCfg.mcpServers)) {
          const entry = summarizeServer(name, cfg, source + ' (프로젝트)', sourcePath, 'project');
          if (entry) servers.push(entry);
        }
      }
    }
  }
  return servers;
}

function stripTomlComment(line) {
  let inSingle = false;
  let inDouble = false;
  let escaped = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (escaped) { escaped = false; continue; }
    if (inDouble && ch === '\\') { escaped = true; continue; }
    if (!inDouble && ch === "'") { inSingle = !inSingle; continue; }
    if (!inSingle && ch === '"') { inDouble = !inDouble; continue; }
    if (!inSingle && !inDouble && ch === '#') return line.slice(0, i);
  }
  return line;
}

function parseTomlString(raw) {
  const trimmed = raw.trim();
  if (trimmed.startsWith('"') && trimmed.endsWith('"') && trimmed.length >= 2) {
    try { return JSON.parse(trimmed); }
    catch { return trimmed.slice(1, -1); }
  }
  if (trimmed.startsWith("'") && trimmed.endsWith("'") && trimmed.length >= 2) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

function parseTomlValue(raw) {
  const trimmed = raw.trim();
  if (!trimmed) return '';
  if (trimmed === 'true') return true;
  if (trimmed === 'false') return false;
  if (/^-?\d+$/.test(trimmed)) return Number(trimmed);
  if ((trimmed.startsWith('"') && trimmed.endsWith('"')) || (trimmed.startsWith("'") && trimmed.endsWith("'"))) {
    return parseTomlString(trimmed);
  }
  if (trimmed.startsWith('[') && trimmed.endsWith(']')) {
    const inner = trimmed.slice(1, -1).trim();
    if (!inner) return [];
    const items = [];
    let current = '';
    let inSingle = false;
    let inDouble = false;
    let escaped = false;
    for (let i = 0; i < inner.length; i++) {
      const ch = inner[i];
      if (escaped) { current += ch; escaped = false; continue; }
      if (inDouble && ch === '\\') { current += ch; escaped = true; continue; }
      if (!inDouble && ch === "'") { inSingle = !inSingle; current += ch; continue; }
      if (!inSingle && ch === '"') { inDouble = !inDouble; current += ch; continue; }
      if (!inSingle && !inDouble && ch === ',') {
        if (current.trim()) items.push(parseTomlValue(current));
        current = '';
        continue;
      }
      current += ch;
    }
    if (current.trim()) items.push(parseTomlValue(current));
    return items;
  }
  return trimmed;
}

// ~/.codex/config.toml의 [mcp_servers.<name>] 및 [mcp_servers.<name>.env] 섹션을 파싱한다.
function parseCodexTomlMcp(text) {
  const servers = Object.create(null);
  let currentServer = null;
  let inEnv = false;

  for (const rawLine of String(text ?? '').split(/\r?\n/)) {
    const line = stripTomlComment(rawLine).trim();
    if (!line) continue;
    const sectionMatch = /^\[([^\]]+)\]$/.exec(line);
    if (sectionMatch) {
      const header = sectionMatch[1].trim();
      const mcpMatch = /^mcp_servers\.("([^"]+)"|'([^']+)'|([^.\s]+))(?:\.(env))?$/.exec(header);
      if (mcpMatch) {
        const name = mcpMatch[2] ?? mcpMatch[3] ?? mcpMatch[4];
        currentServer = name;
        inEnv = mcpMatch[5] === 'env';
        if (!servers[name]) servers[name] = {};
        if (inEnv && !servers[name].env) servers[name].env = {};
      } else {
        currentServer = null;
        inEnv = false;
      }
      continue;
    }
    if (!currentServer) continue;
    const eqIndex = line.indexOf('=');
    if (eqIndex <= 0) continue;
    const key = parseTomlString(line.slice(0, eqIndex));
    const value = parseTomlValue(line.slice(eqIndex + 1));
    if (inEnv) servers[currentServer].env[key] = true;
    else servers[currentServer][key] = value;
  }
  return servers;
}

function listMcpServers(cwd, { homeDir = os.homedir() } = {}) {
  const root = resolveProjectRoot(cwd);
  const home = path.resolve(homeDir);
  const candidates = [
    ...(root ? [{ source: '프로젝트 .mcp.json', scope: 'project', format: 'json', path: path.join(root, '.mcp.json') }] : []),
    { source: '~/.claude.json', scope: 'global', format: 'json', path: path.join(home, '.claude.json') },
    { source: '~/.claude/settings.json', scope: 'global', format: 'json', path: path.join(home, '.claude', 'settings.json') },
    { source: '~/.codex/config.toml', scope: 'global', format: 'toml', path: path.join(home, '.codex', 'config.toml') }
  ];

  const servers = [];
  const sources = [];

  for (const item of candidates) {
    let exists = false;
    let error = null;
    let count = 0;
    try {
      if (fs.existsSync(item.path) && fs.statSync(item.path).isFile()) {
        exists = true;
        const raw = fs.readFileSync(item.path, 'utf8');
        if (item.format === 'json') {
          const parsed = JSON.parse(raw);
          const found = parseJsonMcpObject(parsed, item.source, item.path, item.scope, root);
          servers.push(...found);
          count = found.length;
        } else {
          const parsed = parseCodexTomlMcp(raw);
          for (const [name, cfg] of Object.entries(parsed)) {
            const entry = summarizeServer(name, cfg, item.source, item.path, item.scope);
            if (entry) { servers.push(entry); count++; }
          }
        }
      }
    } catch (err) {
      error = err.message || String(err);
    }
    sources.push({ source: item.source, scope: item.scope, path: item.path, exists, count, error });
  }

  return { cwd: root, servers, sources };
}

module.exports = {
  listInstructions,
  readInstructionFile,
  writeInstructionFile,
  listMcpServers,
  parseCodexTomlMcp,
  resolveAllowedInstruction
};
