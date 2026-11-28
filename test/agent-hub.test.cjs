// 에이전트 설정 허브 백엔드(main/agent-hub.cjs) 단위 테스트.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const agentHub = require('../main/agent-hub.cjs');

function makeTempEnv() {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'hermit-agent-hub-'));
  const project = path.join(base, 'project');
  const home = path.join(base, 'home');
  fs.mkdirSync(project, { recursive: true });
  fs.mkdirSync(home, { recursive: true });
  return {
    base,
    project,
    home,
    cleanup: () => fs.rmSync(base, { recursive: true, force: true })
  };
}

test('프로젝트와 전역 에이전트 지침 파일을 탐색하고 안전하게 읽고 쓴다', () => {
  const env = makeTempEnv();
  try {
    fs.writeFileSync(path.join(env.project, 'CLAUDE.md'), '# Project Claude\n', 'utf8');
    fs.mkdirSync(path.join(env.project, '.agents', 'skills', 'demo'), { recursive: true });
    fs.writeFileSync(path.join(env.project, '.agents', 'skills', 'demo', 'SKILL.md'), '# Skill\n', 'utf8');
    fs.writeFileSync(path.join(env.project, '.agents', 'ignore.txt'), 'not markdown', 'utf8');

    const listed = agentHub.listInstructions(env.project, { homeDir: env.home });
    const labels = listed.items.map(item => item.label);
    assert.ok(labels.includes('CLAUDE.md'));
    assert.ok(labels.includes('AGENTS.md'));
    assert.ok(labels.includes('.agents/skills/demo/SKILL.md'));
    assert.ok(!labels.some(label => label.endsWith('ignore.txt')));
    assert.ok(labels.includes('~/.claude/CLAUDE.md'));
    assert.ok(labels.includes('~/.codex/AGENTS.md'));
    assert.ok(labels.includes('~/.gemini/antigravity-cli/settings.json'));

    const claudeFile = listed.items.find(item => item.label === 'CLAUDE.md');
    assert.equal(claudeFile.exists, true);
    const read = agentHub.readInstructionFile(env.project, claudeFile.path, { homeDir: env.home });
    assert.equal(read.content, '# Project Claude\n');

    // 전역 파일이 아직 없어도 allowlist 대상이면 생성·저장할 수 있다.
    const globalCodex = listed.items.find(item => item.label === '~/.codex/AGENTS.md');
    assert.equal(globalCodex.exists, false);
    const saved = agentHub.writeInstructionFile(env.project, globalCodex.path, '# Global Codex\n', { homeDir: env.home });
    assert.equal(saved.saved, true);
    assert.equal(fs.readFileSync(globalCodex.path, 'utf8'), '# Global Codex\n');

    // settings.json은 유효한 JSON만 저장한다.
    const agySettings = listed.items.find(item => item.label === '~/.gemini/antigravity-cli/settings.json');
    assert.throws(
      () => agentHub.writeInstructionFile(env.project, agySettings.path, '{ invalid json', { homeDir: env.home }),
      /유효한 JSON/
    );
    agentHub.writeInstructionFile(env.project, agySettings.path, '{"theme":"dark"}\n', { homeDir: env.home });
    assert.equal(agentHub.readInstructionFile(env.project, agySettings.path, { homeDir: env.home }).content, '{"theme":"dark"}\n');
  } finally {
    env.cleanup();
  }
});

test('허용 목록 밖의 임의 파일 읽기·쓰기와 경로 탈출을 차단한다', () => {
  const env = makeTempEnv();
  try {
    const secret = path.join(env.project, '.env');
    fs.writeFileSync(secret, 'API_KEY=secret', 'utf8');
    assert.throws(() => agentHub.readInstructionFile(env.project, secret, { homeDir: env.home }), /허용된/);
    assert.throws(() => agentHub.writeInstructionFile(env.project, secret, 'hacked', { homeDir: env.home }), /허용된/);

    const traversal = path.join(env.project, '.agents', '..', 'README.md');
    assert.throws(() => agentHub.readInstructionFile(env.project, traversal, { homeDir: env.home }), /허용된/);

    const nonMdInAgents = path.join(env.project, '.agents', 'script.js');
    assert.throws(() => agentHub.writeInstructionFile(env.project, nonMdInAgents, 'alert(1)', { homeDir: env.home }), /허용된/);
  } finally {
    env.cleanup();
  }
});

test('MCP 서버를 .mcp.json, ~/.claude.json, ~/.claude/settings.json, ~/.codex/config.toml에서 탐색한다', () => {
  const env = makeTempEnv();
  try {
    fs.writeFileSync(path.join(env.project, '.mcp.json'), JSON.stringify({
      mcpServers: {
        filesystem: { command: 'npx', args: ['-y', '@modelcontextprotocol/server-filesystem', '.'] },
        disabledSrv: { command: 'node', args: ['srv.js'], disabled: true }
      }
    }), 'utf8');

    fs.writeFileSync(path.join(env.home, '.claude.json'), JSON.stringify({
      mcpServers: {
        remoteDocs: { url: 'https://docs.example.com/mcp', env: { API_TOKEN: 'secret-value-hidden' } }
      }
    }), 'utf8');

    fs.mkdirSync(path.join(env.home, '.claude'), { recursive: true });
    fs.writeFileSync(path.join(env.home, '.claude', 'settings.json'), JSON.stringify({
      mcpServers: {
        github: { command: 'gh-mcp', args: ['serve'] }
      }
    }), 'utf8');

    fs.mkdirSync(path.join(env.home, '.codex'), { recursive: true });
    fs.writeFileSync(path.join(env.home, '.codex', 'config.toml'), [
      '# Codex config',
      '[mcp_servers.context7]',
      'command = "npx"',
      'args = ["-y", "@upstash/context7-mcp"]',
      'enabled = true',
      '',
      '[mcp_servers.context7.env]',
      'CONTEXT7_KEY = "do-not-leak"',
      '',
      '[mcp_servers."my-http"]',
      'url = "http://localhost:8787/mcp"',
      'enabled = false'
    ].join('\n'), 'utf8');

    const result = agentHub.listMcpServers(env.project, { homeDir: env.home });
    const byName = new Map(result.servers.map(s => [s.name, s]));

    assert.equal(byName.get('filesystem').enabled, true);
    assert.equal(byName.get('filesystem').transport, 'stdio');
    assert.match(byName.get('filesystem').target, /npx -y/);

    assert.equal(byName.get('disabledSrv').enabled, false);

    assert.equal(byName.get('remoteDocs').transport, 'http');
    assert.equal(byName.get('remoteDocs').target, 'https://docs.example.com/mcp');
    assert.deepEqual(byName.get('remoteDocs').envKeys, ['API_TOKEN']);
    // 비밀 환경변수 값은 노출하지 않는다.
    assert.ok(!JSON.stringify(result).includes('secret-value-hidden'));
    assert.ok(!JSON.stringify(result).includes('do-not-leak'));

    assert.equal(byName.get('github').source, '~/.claude/settings.json');

    assert.equal(byName.get('context7').source, '~/.codex/config.toml');
    assert.equal(byName.get('context7').enabled, true);
    assert.deepEqual(byName.get('context7').envKeys, ['CONTEXT7_KEY']);

    assert.equal(byName.get('my-http').transport, 'http');
    assert.equal(byName.get('my-http').enabled, false);
  } finally {
    env.cleanup();
  }
});
