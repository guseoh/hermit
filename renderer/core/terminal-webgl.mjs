// 터미널 WebGL 렌더러(@xterm/addon-webgl). 출력이 많은 에이전트 TUI에서 DOM 렌더러보다 가볍다.
// 애드온 파일이 없거나(설치 전), WebGL을 만들 수 없거나, 컨텍스트를 잃으면 그 터미널은 xterm 기본 DOM 렌더러로 남는다.
// 브라우저는 WebGL 컨텍스트 수를 제한하므로(약 16개) 터미널이 많으면 오래된 것부터 컨텍스트를 잃고 DOM으로 돌아간다.
const addonScript = 'node_modules/@xterm/addon-webgl/lib/addon-webgl.js';
let state = 'loading';   // loading → ready | unavailable
let reason = '';
const waiting = new Set();

function useDom(pane, why) {
  pane.renderer = 'dom';
  pane.rendererReason = why;
}

function attach(pane) {
  if (!pane?.terminal || pane.webgl || pane.renderer === 'webgl') return pane?.renderer;
  if (state === 'loading') { waiting.add(pane); useDom(pane, '불러오는 중'); return 'dom'; }
  if (state !== 'ready') { useDom(pane, reason); return 'dom'; }
  if (!pane.terminal.element) { useDom(pane, '터미널이 아직 열리지 않음'); return 'dom'; }
  let addon;
  try {
    addon = new globalThis.WebglAddon.WebglAddon();
    pane.terminal.loadAddon(addon);
  } catch (error) {
    try { addon?.dispose(); } catch {}
    useDom(pane, 'WebGL을 시작하지 못함: ' + (error?.message ?? error));
    return 'dom';
  }
  pane.webgl = addon;
  pane.renderer = 'webgl';
  pane.rendererReason = '';
  addon.onContextLoss(() => {
    // 컨텍스트를 잃으면 애드온을 버린다. xterm이 DOM 렌더러로 다시 그린다.
    if (pane.webgl !== addon) return;
    pane.webgl = null;
    try { addon.dispose(); } catch {}
    useDom(pane, 'WebGL 컨텍스트를 잃음');
    try { pane.terminal.refresh(0, pane.terminal.rows - 1); } catch {}
  });
  return 'webgl';
}

function finish(next, why = '') {
  state = next;
  reason = why;
  for (const pane of waiting) if (typeof panes !== 'undefined' && panes.get(pane.id) === pane) attach(pane);
  waiting.clear();
}

function load() {
  if (globalThis.WebglAddon?.WebglAddon) { finish('ready'); return; }
  const probe = document.createElement('canvas').getContext('webgl2');
  if (!probe) { finish('unavailable', '이 환경에서 WebGL2를 쓸 수 없음'); return; }
  probe.getExtension('WEBGL_lose_context')?.loseContext();   // 확인용 컨텍스트가 자리를 차지하지 않게
  const tag = document.createElement('script');
  tag.src = addonScript;
  tag.onload = () => globalThis.WebglAddon?.WebglAddon ? finish('ready') : finish('unavailable', '애드온을 읽지 못함');
  tag.onerror = () => finish('unavailable', '@xterm/addon-webgl이 설치되지 않음');
  document.head.append(tag);
}

// 이 모듈보다 먼저 열린 터미널(재시작 복원)에도 붙인다.
if (typeof panes !== 'undefined') for (const pane of panes.values()) attach(pane);
load();

window.hermitTerminalRenderer = {
  attach,
  get state() { return state; },
  get reason() { return reason; }
};
