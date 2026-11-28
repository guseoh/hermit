// 작업 영역 탭 탐색: Ctrl+Tab / Ctrl+Shift+Tab은 최근 사용 순서(MRU)로, Ctrl+1~9는 탭 줄 순서로 이동한다.
// Ctrl을 누른 채 Tab을 거듭 누르면 MRU를 따라 더 이전 탭으로 가고, Ctrl을 떼는 순간 그 탭이 최근 탭으로 확정된다.
let cycle = null;

function currentArea() {
  return workAreaFor();
}

// 탭 줄에 보이는 순서 그대로의 탭 목록.
function orderedTabs(area) {
  return [...area.strip.children].map(row => row.workspaceTab).filter(tab => tab && area.tabs.has(tab) && tabVisible(tab));
}

function recordRecentTab(area, tab) {
  if (!tab || cycle) return;
  area.recent = [tab, ...(area.recent ?? []).filter(item => item !== tab)];
}

function recentTabs(area) {
  const ordered = orderedTabs(area);
  const live = (area.recent ?? []).filter(tab => ordered.includes(tab));
  // 아직 한 번도 열지 않은 탭은 탭 줄 순서대로 뒤에 붙인다.
  const list = [...live, ...ordered.filter(tab => !live.includes(tab))];
  if (area.current && list[0] !== area.current && list.includes(area.current)) {
    list.splice(list.indexOf(area.current), 1);
    list.unshift(area.current);
  }
  return list;
}

function cycleWorkTab(direction = 1) {
  const area = cycle?.area ?? currentArea();
  if (!cycle) {
    const list = recentTabs(area);
    if (list.length < 2) return;
    cycle = { area, list, index: 0 };
  }
  const { list } = cycle;
  cycle.index = (cycle.index + direction + list.length) % list.length;
  activateWorkAreaTab(list[cycle.index], false);
}

function commitCycle() {
  if (!cycle) return;
  const { area, list, index } = cycle;
  cycle = null;
  recordRecentTab(area, list[index]);
  activateWorkAreaTab(list[index]);
}

// Ctrl+1~8은 n번째 탭, Ctrl+9는 마지막 탭(브라우저·VS Code와 같은 규칙).
function jumpToWorkTab(number) {
  const ordered = orderedTabs(currentArea());
  const tab = number === 9 ? ordered.at(-1) : ordered[number - 1];
  if (tab) activateWorkAreaTab(tab);
}

addEventListener('keyup', event => { if (event.key === 'Control') commitCycle(); }, true);
addEventListener('blur', commitCycle);

Object.assign(window, { recordRecentTab, cycleWorkTab, jumpToWorkTab, commitWorkTabCycle: commitCycle });
