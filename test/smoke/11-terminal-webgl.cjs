// 터미널 WebGL 렌더러(renderer/core/terminal-webgl.mjs).
// 애드온이 설치돼 있고 WebGL을 쓸 수 있으면 새 터미널은 WebGL, 아니면 DOM 렌더러로 열리고 앱은 그대로 동작해야 한다.
// WebGL이면 컨텍스트를 일부러 잃게 해 DOM으로 돌아가는지 본다(애드온은 복구를 3초 기다린 뒤 onContextLoss를 낸다).
module.exports = async ({ evaluate, waitFor, assert }) => {
  await waitFor(() => evaluate('window.hermitTerminalRenderer && hermitTerminalRenderer.state !== "loading"'), 'WebGL addon load attempt');
  const loader = await evaluate('({ state: hermitTerminalRenderer.state, reason: hermitTerminalRenderer.reason })');
  console.log('terminal renderer:', loader.state, loader.reason);
  const id = await evaluate('newShellTab().then(pane => pane.id)');
  await waitFor(() => evaluate(`panes.get(${JSON.stringify(id)})?.running === true`), 'shell for renderer check');
  const pane = await evaluate(`(()=>{const p=panes.get(${JSON.stringify(id)}); return { renderer: p.renderer, reason: p.rendererReason, canvases: p.host.querySelectorAll('canvas').length };})()`);
  console.log('new pane renderer:', pane.renderer, pane.reason);
  assert.ok(['webgl', 'dom'].includes(pane.renderer));
  if (loader.state !== 'ready') assert.equal(pane.renderer, 'dom', 'without the addon the pane stays on the DOM renderer');
  // 어느 렌더러든 출력이 화면 버퍼에 들어온다.
  await evaluate(`panes.get(${JSON.stringify(id)}).terminal.write('hermit-renderer-check\\r\\n'); 0`);
  await waitFor(() => evaluate(`(()=>{const b=panes.get(${JSON.stringify(id)}).terminal.buffer.active; for (let i=0;i<b.length;i++) if (b.getLine(i)?.translateToString(true).includes('hermit-renderer-check')) return true; return false;})()`), 'terminal output in buffer');
  if (pane.renderer === 'webgl') {
    assert.ok(pane.canvases > 0, 'WebGL renderer draws on a canvas');
    await evaluate(`(()=>{const p=panes.get(${JSON.stringify(id)}); for (const c of p.host.querySelectorAll('canvas')) { const gl=c.getContext('webgl2'); gl?.getExtension('WEBGL_lose_context')?.loseContext(); } return 0;})()`);
    await waitFor(() => evaluate(`panes.get(${JSON.stringify(id)}).renderer === 'dom'`), 'DOM fallback after context loss');
    assert.equal(await evaluate(`panes.get(${JSON.stringify(id)}).webgl`), null);
    assert.ok(await evaluate(`!!panes.get(${JSON.stringify(id)}).host.querySelector('.xterm-rows')`), 'DOM renderer rows are back');
  }
  await evaluate(`(()=>{const p=panes.get(${JSON.stringify(id)}); if (p) closeTab(p.tab); return 0;})()`);
};
