// 업데이트 안내: 새 버전을 받아 두면 상태 표시줄에 "업데이트 준비됨 · 다시 시작"을 남기고 토스트로 한 번 알린다.
// 누르면 바로 설치하고 새 버전으로 다시 연다(main.cjs installUpdateNow). 누르지 않아도 종료할 때 설치 여부를 묻는다.
let readyVersion = '';
let segment = null;

function restartNow() {
  return api.installUpdate().then(started => {
    if (!started) status('설치할 업데이트가 없습니다. 설치한 앱에서만 업데이트를 받습니다.', 'warn');
  });
}

function ensureSegment() {
  if (segment?.isConnected) return segment;
  const host = document.querySelector('#agent-usage .system-segments');
  if (!host) return null;
  segment = document.createElement('button');
  segment.type = 'button';
  segment.id = 'update-ready-button';
  segment.className = 'update-ready-segment';
  const icon = document.createElement('span');
  icon.className = 'update-ready-icon';
  setPanelIcon(icon, 'download');
  const label = document.createElement('span');
  label.className = 'update-ready-label';
  segment.append(icon, label);
  segment.onclick = () => restartNow().catch(report);
  host.prepend(segment);
  return segment;
}

function showUpdateReady(version, { announce = true } = {}) {
  readyVersion = String(version ?? '');
  const node = ensureSegment();
  if (node) {
    node.querySelector('.update-ready-label').textContent = '업데이트 준비됨 · 다시 시작';
    node.title = (readyVersion ? 'v' + readyVersion + ' ' : '') + '업데이트를 설치하고 Hermit을 다시 엽니다. 누르지 않으면 종료할 때 설치 여부를 묻습니다.';
    node.setAttribute('aria-label', node.title);
  }
  if (announce) {
    toast('업데이트 준비됨' + (readyVersion ? ' · v' + readyVersion : '') + '. 지금 다시 시작하거나, 종료할 때 설치할 수 있습니다.', {
      kind: 'success', timeout: 60000, action: { label: '지금 다시 시작', run: restartNow }
    });
  }
}

api.onUpdateReady(version => showUpdateReady(version));
// F5로 다시 불러온 경우: 이미 받아 둔 업데이트가 있으면 표시줄 버튼만 되살린다(토스트는 다시 띄우지 않는다).
api.updateState?.().then(state => { if (state?.version) showUpdateReady(state.version, { announce: false }); }).catch(() => {});

// 스모크 시나리오용: 설치본이 아니어도 표시를 확인할 수 있게 연다.
window.hermitUpdateNotice = { show: showUpdateReady, get version() { return readyVersion; } };
