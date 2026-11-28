// 업데이트 안내(renderer/views/update-notice.mjs): 받아 둔 업데이트가 있으면 상태 표시줄 버튼과 토스트가 보인다.
// 개발 실행에는 updater가 없으므로 설치는 일어나지 않고 "설치할 업데이트가 없습니다"로 끝나야 한다.
module.exports = async ({ evaluate, waitFor, assert, shot }) => {
  assert.equal(await evaluate('typeof window.hermitUpdateNotice?.show'), 'function');
  assert.deepEqual(await evaluate('workbench.updateState()'), { version: '', packaged: false });
  assert.equal(await evaluate('!!byId("update-ready-button")'), false, '받은 업데이트가 없으면 버튼이 없다');
  await evaluate('hermitUpdateNotice.show("9.9.9"); 0');
  const segment = await evaluate('(()=>{const b=byId("update-ready-button"); return b && { text: b.textContent, parent: b.parentElement.className, title: b.title };})()');
  assert.equal(segment.text, '업데이트 준비됨 · 다시 시작');
  assert.equal(segment.parent, 'system-segments');
  assert.match(segment.title, /v9\.9\.9/);
  assert.ok(await evaluate('[...document.querySelectorAll("#toasts .toast")].some(t => /업데이트 준비됨 · v9\\.9\\.9/.test(t.dataset.text) && t.querySelector(".toast-action")?.textContent === "지금 다시 시작")'),
    'toast offers restart');
  await shot('10-update-notice');
  await evaluate('byId("update-ready-button").click(); 0');
  await waitFor(() => evaluate('[...document.querySelectorAll("#toasts .toast")].some(t => t.dataset.text.startsWith("설치할 업데이트가 없습니다"))'), 'no-update message in dev run');
  // 정리: 다음 시나리오가 깨끗한 표시줄을 보게 한다.
  await evaluate('byId("update-ready-button").remove(); document.querySelectorAll("#toasts .toast").forEach(t => t.remove()); 0');
};
