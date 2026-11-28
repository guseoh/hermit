// 에이전트 설정 허브 IPC: 허용된 지침·규칙 파일 목록/읽기/쓰기와 MCP 서버 목록 조회.
const agentHub = require('../agent-hub.cjs');

module.exports = ({ handle }) => {
  handle('agent-hub-instructions', cwd => agentHub.listInstructions(cwd));
  handle('agent-hub-read', (cwd, filePath) => agentHub.readInstructionFile(cwd, filePath));
  handle('agent-hub-write', (cwd, filePath, content) => agentHub.writeInstructionFile(cwd, filePath, content));
  handle('agent-hub-mcp', cwd => agentHub.listMcpServers(cwd));
};
