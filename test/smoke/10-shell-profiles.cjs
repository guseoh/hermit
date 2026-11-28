// 추가 터미널 프로필(renderer/views/shell-profiles.mjs): PowerShell 7과 WSL이 있으면 새 탭 메뉴에 나온다.
module.exports = async ({ evaluate, waitFor, assert }) => {
  assert.equal(typeof await evaluate('window.hermitShellProfiles?.refresh'), 'function');
  assert.equal(typeof await evaluate('workbench.shellProfiles'), 'function');
  const profiles = await evaluate('hermitShellProfiles.refresh()');
  assert.ok(Array.isArray(profiles), 'shellProfiles returns an array');
  for (const entry of profiles) {
    assert.ok(['pwsh', 'wsl'].includes(entry.launcher), 'launcher is pwsh or wsl');
    assert.equal(typeof entry.name, 'string');
  }
  await waitFor(
    () => evaluate(`document.querySelectorAll('#new-tab-menu [data-shell-profile]').length === ${profiles.length}`),
    'menu renders detected shell profiles'
  );
  // PowerShell 7이 설치돼 있으면 열어서 실행되는지까지 본다.
  const pwsh = profiles.find(p => p.launcher === 'pwsh');
  if (pwsh) {
    const id = await evaluate(`hermitShellProfiles.open(${JSON.stringify(pwsh)}).then(p => p.id)`);
    await waitFor(() => evaluate(`panes.get(${JSON.stringify(id)})?.running === true`), 'pwsh pane started');
    assert.equal(await evaluate(`panes.get(${JSON.stringify(id)})?.launcher`), 'pwsh');
    await evaluate(`(()=>{const p=panes.get(${JSON.stringify(id)}); if (p) closeTab(p.tab); return 0;})()`);
  }
};
