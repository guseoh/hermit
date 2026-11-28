// 터미널 localhost:포트 자동 감지 배너(renderer/views/port-banner.mjs) 스모크 시나리오.
module.exports = async ({ evaluate, waitFor, assert, shot }) => {
  assert.equal(await evaluate('typeof window.hermitPortBanner?.feed'), 'function');
  const id = await evaluate('newShellTab().then(pane => pane.id)');
  await waitFor(() => evaluate(`panes.get(${JSON.stringify(id)})?.running === true`), 'shell for port banner');

  // ANSI 이스케이프가 섞인 Vite 출력 주입
  await evaluate(`hermitPortBanner.feed(panes.get(${JSON.stringify(id)}), '\\x1b[32m➜\\x1b[0m Local: http://localhost:5173/\\r\\n'); 0`);
  const banner = await evaluate(`(()=>{
    const b = panes.get(${JSON.stringify(id)}).section.querySelector('.pane-port-banner');
    return b && {
      url: b.dataset.portUrl,
      preview: b.querySelector('.pane-port-preview')?.textContent,
      browser: b.querySelector('.pane-port-browser')?.textContent
    };
  })()`);
  assert.deepEqual(banner, { url: 'http://localhost:5173', preview: '미리보기', browser: '브라우저에서 열기' });
  await shot('20-port-banner');

  // 닫기 버튼으로 배너를 닫을 수 있다.
  await evaluate(`panes.get(${JSON.stringify(id)}).section.querySelector('.pane-port-dismiss').click(); 0`);
  assert.equal(await evaluate(`!!panes.get(${JSON.stringify(id)}).section.querySelector('.pane-port-banner')`), false);

  await evaluate(`(()=>{const p=panes.get(${JSON.stringify(id)}); if (p) closeTab(p.tab); return 0;})()`);
};
