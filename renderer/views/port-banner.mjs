// 터미널 출력에서 로컬 서버 주소를 감지하면 해당 터미널 패널 상단에 조용한 배너를 띄운다.
// "미리보기"는 기존 웹 미리보기 탭을 재사용하고, "브라우저에서 열기"는 검증된 로컬 주소만 외부 브라우저로 연다.
import { createPortDetector, detectLocalUrls } from '../core/port-detect.mjs';

const stateByPane = new WeakMap();

function getState(pane) {
  let state = stateByPane.get(pane);
  if (state) return state;
  state = {
    detector: createPortDetector(),
    banner: null
  };
  stateByPane.set(pane, state);
  return state;
}

function openInPreview(pane, entry) {
  const area = pane.tab?.workArea && panelTree.contains(pane.tab.workArea.panel)
    ? pane.tab.workArea
    : workAreaFor();
  const tab = openPreviewPanel(area, { address: entry.url, cwd: pane.cwd });
  if (tab) activateWorkAreaTab(tab);
}

function renderBanner(pane, state) {
  const entries = state.detector.list();
  if (!entries.length) {
    if (state.banner) {
      state.banner.remove();
      state.banner = null;
      scheduleFit();
    }
    return;
  }
  const latest = entries.at(-1);
  let banner = state.banner;
  if (!banner) {
    banner = document.createElement('div');
    banner.className = 'pane-port-banner';
    banner.setAttribute('role', 'region');
    banner.setAttribute('aria-label', '감지된 로컬 서버');
    pane.header.after(banner);
    state.banner = banner;
    scheduleFit();
  }
  banner.dataset.portUrl = latest.url;
  banner.dataset.portKey = latest.key;
  banner.replaceChildren();

  const info = document.createElement('div');
  info.className = 'pane-port-info';
  const icon = document.createElement('span');
  icon.className = 'pane-port-icon';
  icon.setAttribute('aria-hidden', 'true');
  setPanelIcon(icon, 'web');
  const label = document.createElement('span');
  label.className = 'pane-port-url';
  label.textContent = latest.url;
  label.title = latest.url;
  info.append(icon, label);
  if (entries.length > 1) {
    const more = document.createElement('span');
    more.className = 'pane-port-count';
    more.textContent = `+${entries.length - 1}`;
    more.title = entries.map(item => item.url).join('\n');
    info.append(more);
  }

  const actions = document.createElement('div');
  actions.className = 'pane-port-actions';
  const previewBtn = document.createElement('button');
  previewBtn.type = 'button';
  previewBtn.className = 'pane-port-preview';
  previewBtn.textContent = '미리보기';
  previewBtn.onclick = () => {
    try { openInPreview(pane, latest); }
    catch (error) { report(error); }
  };

  const browserBtn = document.createElement('button');
  browserBtn.type = 'button';
  browserBtn.className = 'pane-port-browser ghost';
  browserBtn.textContent = '브라우저에서 열기';
  browserBtn.onclick = () => api.openLocalPreview(latest.url).catch(report);

  const dismissBtn = document.createElement('button');
  dismissBtn.type = 'button';
  dismissBtn.className = 'icon-button pane-port-dismiss';
  dismissBtn.title = '배너 닫기';
  dismissBtn.setAttribute('aria-label', '배너 닫기');
  setPanelIcon(dismissBtn, 'close');
  dismissBtn.onclick = () => {
    state.detector.dismiss(latest.key);
    renderBanner(pane, state);
  };

  actions.append(previewBtn, browserBtn, dismissBtn);
  banner.append(info, actions);
}

function feed(pane, chunk) {
  if (!pane || !chunk) return [];
  const state = getState(pane);
  const fresh = state.detector.push(chunk);
  if (fresh.length) renderBanner(pane, state);
  return fresh;
}

function dismiss(pane, key) {
  if (!pane) return;
  const state = stateByPane.get(pane);
  if (!state) return;
  if (key) state.detector.dismiss(key);
  else for (const entry of state.detector.list()) state.detector.dismiss(entry.key);
  renderBanner(pane, state);
}

function clear(pane) {
  if (!pane) return;
  const state = stateByPane.get(pane);
  if (!state) return;
  state.detector.clear();
  if (state.banner) {
    state.banner.remove();
    state.banner = null;
    scheduleFit();
  }
}

window.hermitPortBanner = {
  feed,
  dismiss,
  clear,
  detect: detectLocalUrls
};
