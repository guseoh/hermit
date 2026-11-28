// 프로젝트(저장소 루트)별 worktree 환경 설정: 정션 공유 여부, 공유할 폴더, 만든 뒤 실행할 명령(postCreate).
// 저장은 localStorage 'agent-worktree-setup-v1'(상태 파일로 함께 저장됨)에 { 프로젝트 키: 설정 } 형태로 한다.
export const storageKey = 'agent-worktree-setup-v1';
export const maxDirs = 10;

export function defaultConfig() {
  return { share: false, dirs: ['node_modules'], postCreate: '' };
}

// main/worktree-setup.cjs의 safeRelative와 같은 규칙(렌더러에서 먼저 걸러 입력 오류를 바로 보여 준다).
export function safeDir(value) {
  if (typeof value !== 'string') return null;
  const text = value.trim().replace(/\\/g, '/').replace(/\/+$/, '').replace(/^\.\//, '');
  if (!text || text.length > 260 || /[\x00-\x1f:*?"<>|]/.test(text) || text.startsWith('/')) return null;
  const parts = text.split('/');
  if (parts.some(part => !part || part === '.' || part === '..' || part.toLowerCase() === '.git' || /[. ]$/.test(part))) return null;
  return parts.join('/');
}

// 한 줄에 하나(쉼표도 허용). 잘못된 줄은 invalid로 돌려준다.
export function parseDirs(text) {
  const dirs = [];
  const invalid = [];
  for (const line of String(text ?? '').split(/[\n,]/).map(item => item.trim()).filter(Boolean)) {
    const dir = safeDir(line);
    if (!dir) invalid.push(line);
    else if (!dirs.some(item => item.toLowerCase() === dir.toLowerCase())) dirs.push(dir);
  }
  return { dirs: dirs.slice(0, maxDirs), invalid, overflow: dirs.length > maxDirs };
}

export function validCommand(command) {
  return typeof command === 'string' && command.length <= 500 && !/[\x00-\x1f\x7f]/.test(command);
}

export function normalizeConfig(value) {
  const base = defaultConfig();
  if (!value || typeof value !== 'object') return base;
  const dirs = Array.isArray(value.dirs) ? parseDirs(value.dirs.join('\n')).dirs : base.dirs;
  const postCreate = validCommand(value.postCreate) ? value.postCreate.trim() : '';
  return { share: value.share === true, dirs: dirs.length ? dirs : base.dirs, postCreate };
}

export function loadConfigs(storage) {
  try {
    const parsed = JSON.parse(storage.getItem(storageKey) ?? '{}');
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch { return {}; }
}

export function configFor(storage, key) {
  return normalizeConfig(loadConfigs(storage)[key]);
}

// 기본값과 같으면 지워서 저장 파일을 작게 둔다.
export function saveConfig(storage, key, config) {
  const all = loadConfigs(storage);
  const next = normalizeConfig(config);
  const plain = !next.share && !next.postCreate && next.dirs.join('\n') === defaultConfig().dirs.join('\n');
  if (plain) delete all[key];
  else all[key] = next;
  storage.setItem(storageKey, JSON.stringify(all));
  return next;
}

// 작업 런처에 보여 줄 한 줄. preview는 main의 worktree-setup-preview 결과.
export function launcherSummary(config, preview) {
  const parts = [];
  if (preview?.repository && preview.exists) {
    parts.push(preview.count ? '.worktreeinclude 파일 ' + preview.count + '개' + (preview.truncated ? '+' : '') + ' 복사'
      : '.worktreeinclude에 맞는 파일 없음');
  }
  if (config.share) parts.push(config.dirs.join(', ') + ' 정션 공유');
  if (config.postCreate) parts.push('만든 뒤 실행: ' + config.postCreate);
  return parts.join(' · ');
}

// worktree를 만든 뒤 알림 문구. result는 worktree-setup-apply 결과.
export function resultSummary(result) {
  if (!result) return '';
  if (result.error) return 'worktree 환경 준비 실패: ' + result.error;
  const parts = [];
  if (result.copied?.length) parts.push('파일 ' + result.copied.length + '개 복사');
  if (result.linked?.length) parts.push(result.linked.join(', ') + ' 정션 연결');
  const skippedLinks = (result.linkSkipped ?? []).filter(entry => entry.reason !== '이미 있음');
  if (skippedLinks.length) parts.push('연결 안 함: ' + skippedLinks.map(entry => entry.path + '(' + entry.reason + ')').join(', '));
  if (result.truncated) parts.push('복사 제한에 걸려 일부만 복사');
  return parts.join(' · ');
}
