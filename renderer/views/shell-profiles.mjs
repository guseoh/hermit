// 새 탭 메뉴의 추가 터미널 프로필: PowerShell 7(pwsh)과 WSL 배포판. 설치돼 있을 때만 "Windows PowerShell 5.1" 아래에 나온다.
// 탐지는 main/shells.cjs가 하고, 여기서는 메뉴 항목을 만들고 그 탭 영역에서 연다.
let entries = [];

function profileFolder(area) {
  return area.current?.activePane?.cwd ?? area.current?.cwd ?? actionTask()?.cwd ?? currentPane()?.cwd ?? api.home();
}

async function openProfile(entry, area) {
  const target = area && panelTree.contains(area.panel) ? area
    : tabMenuArea && panelTree.contains(tabMenuArea.panel) ? tabMenuArea : workArea(primaryChatPanel);
  const cwd = await profileFolder(target);
  return openWorkspace(cwd, entry.launcher, undefined, entry.option, target);
}

function renderEntries() {
  const anchor = byId('menu-shell');
  if (!anchor) return;
  for (const old of anchor.parentElement.querySelectorAll('[data-shell-profile]')) old.remove();
  let after = anchor;
  for (const entry of entries) {
    const item = document.createElement('button');
    item.type = 'button';
    item.dataset.shellProfile = entry.launcher + (entry.option ? ':' + entry.option : '');
    item.dataset.search = entry.launcher === 'pwsh' ? 'pwsh powershell 7 terminal 터미널' : 'wsl linux bash ubuntu terminal 터미널 ' + (entry.option ?? '');
    item.title = entry.launcher === 'pwsh' ? 'PowerShell ' + entry.detail + '에서 새 터미널을 엽니다'
      : entry.detail + ' 배포판의 기본 셸을 엽니다(명령 기록·작업 폴더 표시는 없습니다)';
    const icon = document.createElement('span');
    icon.setAttribute('aria-hidden', 'true');
    setPanelIcon(icon, 'terminal');
    const label = document.createElement('span');
    label.textContent = entry.name;
    item.append(icon, label);
    item.onclick = () => { tabMenu.hidePopover(); Promise.resolve().then(() => openProfile(entry)).catch(report); };
    after.after(item);
    after = item;
  }
}

async function refreshProfiles(refresh = false) {
  entries = await api.shellProfiles(refresh).catch(() => []);
  renderEntries();
  return entries;
}

refreshProfiles();

window.hermitShellProfiles = {
  refresh: refreshProfiles,
  open: openProfile,
  get entries() { return entries; }
};
