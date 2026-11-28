// Stage C 트랙 2: 전역 지식 검색(대화·명령 출력) & 관측성(예상 비용 리포트·localhost 포트 현황) 스모크.
const http = require('node:http');

module.exports = async ({ evaluate, waitFor, shot, assert }) => {
  // 1) 전역 지식 검색: 대화·명령 출력 색인 후 검색·필터링 확인
  await evaluate(`(async () => {
    await api.knowledgeClear();
    await api.knowledgeAppend({
      id: 'smoke-chat-1', kind: 'chat', role: 'assistant', taskId: '', taskName: 'JWT 인증 점검',
      provider: 'claude', project: 'C:\\\\Projects\\\\hermit-demo', title: 'JWT 인증 점검',
      text: '토큰 만료 오류(TOKEN_EXPIRED)는 refresh 엔드포인트에서 재발급합니다.', at: Date.now() - 2000
    });
    await api.knowledgeAppend({
      id: 'smoke-cmd-1', kind: 'command', role: 'command', taskId: '', taskName: 'PowerShell',
      provider: 'shell', project: 'C:\\\\Projects\\\\hermit-demo', title: 'npm test',
      text: 'npm test\\nPASS all 12 tests including TOKEN_EXPIRED retry', at: Date.now() - 1000
    });
    showKnowledgeSearch('TOKEN_EXPIRED');
  })()`);
  await waitFor(() => evaluate('byId("knowledge-search-results")?.querySelectorAll(".knowledge-result").length === 2'), 'knowledge search results');
  await shot('50-knowledge-search');
  await evaluate('byId("knowledge-search-kind").value = "command"; byId("knowledge-search-kind").dispatchEvent(new Event("change")); 0');
  await waitFor(() => evaluate('byId("knowledge-search-results")?.querySelectorAll(".knowledge-result").length === 1'), 'knowledge search filtered to command');
  assert.match(await evaluate('byId("knowledge-search-results").textContent'), /npm test/);

  // 2) 관측성: 예상 비용 리포트 & 실행 중인 localhost 포트 탐지
  const server = http.createServer((req, res) => { res.writeHead(200); res.end('ok'); });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  try {
    await evaluate(`(async () => {
      await api.observabilityRecordUsage({
        id: 'smoke-usage-1', provider: 'claude', model: 'claude-sonnet-4',
        project: 'C:\\\\Projects\\\\hermit-demo', taskName: 'JWT 인증 점검',
        inputTokens: 200000, outputTokens: 20000, cacheReadTokens: 100000, cacheWriteTokens: 0, at: Date.now()
      });
      showObservability();
    })()`);
    await waitFor(() => evaluate('byId("obs-cost-body")?.textContent.includes("hermit-demo")'), 'observability cost breakdown');
    await waitFor(() => evaluate('byId("obs-ports-body")?.textContent.includes(":' + port + '")'), 'observability localhost port detected');
    assert.match(await evaluate('byId("obs-cost-body").textContent'), /\$\d+\.\d+/);
    await shot('50-observability');
  } finally {
    server.close();
  }
  await evaluate('byId("workbench-tools-dialog").close(); 0');
};
