// 에이전트 설정 허브(renderer/views/settings-hub.mjs) 스모크 시나리오.
module.exports = async ({ evaluate, waitFor, assert, shot }) => {
  assert.equal(await evaluate('typeof window.hermitSettingsHub?.selectTab'), 'function');
  assert.equal(await evaluate('typeof workbench.agentHubInstructions'), 'function');
  assert.equal(await evaluate('typeof workbench.agentHubMcp'), 'function');

  // 설정 대화상자를 열고 기존 DOM ID들이 그대로 살아 있는지 확인한다.
  await evaluate('byId("open-chat-settings").click(); 0');
  await waitFor(() => evaluate('byId("chat-settings").open === true'), 'settings hub opened');

  const preserved = await evaluate(`({
    hasHubClass: byId('chat-settings').classList.contains('settings-hub'),
    hasLaunchModes: !!byId('chat-launch-modes'),
    hasApprovalBtn: !!byId('open-approval-rules'),
    hasContrastValue: !!byId('chat-contrast-value'),
    tabCount: document.querySelectorAll('#chat-settings .settings-hub-tab').length
  })`);
  assert.equal(preserved.hasHubClass, true);
  assert.equal(preserved.hasLaunchModes, true);
  assert.equal(preserved.hasApprovalBtn, true);
  assert.equal(preserved.hasContrastValue, true);
  assert.equal(preserved.tabCount, 7);

  // 지침·규칙 탭과 MCP 탭 전환 확인
  await evaluate('hermitSettingsHub.selectTab("instructions"); 0');
  await waitFor(() => evaluate('document.querySelectorAll("#chat-settings .settings-hub-file-item").length >= 3'), 'instruction files loaded');
  await shot('30-settings-hub-instructions');

  await evaluate('hermitSettingsHub.selectTab("mcp"); 0');
  await waitFor(() => evaluate('document.querySelectorAll("#chat-settings .settings-hub-sources .settings-hub-row").length >= 3'), 'mcp sources loaded');

  await evaluate('hermitSettingsHub.selectTab("shortcuts"); 0');
  assert.ok(await evaluate('document.querySelectorAll("#chat-settings [data-settings-pane=shortcuts] .settings-hub-row").length >= 10'));

  await evaluate('byId("chat-settings").close(); 0');
};
