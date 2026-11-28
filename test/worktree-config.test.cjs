// 프로젝트별 worktree 환경 설정(renderer/core/worktree-config.mjs) 테스트.
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const load = () => import(pathToFileURL(path.join(__dirname, '..', 'renderer', 'core', 'worktree-config.mjs')).href);
const memory = () => {
  const values = new Map();
  return { getItem: key => values.get(key) ?? null, setItem: (key, value) => values.set(key, String(value)), values };
};

test('공유 폴더 목록: 잘못된 경로는 따로 알리고 중복을 없앤다', async () => {
  const { parseDirs } = await load();
  const parsed = parseDirs('node_modules\n.\\apps\\web\\node_modules\\\n../outside\nNODE_MODULES, C:/abs\n.git');
  assert.deepEqual(parsed.dirs, ['node_modules', 'apps/web/node_modules']);
  assert.deepEqual(parsed.invalid, ['../outside', 'C:/abs', '.git']);
  assert.equal(parseDirs(Array.from({ length: 12 }, (_, index) => 'd' + index).join('\n')).overflow, true);
});

test('설정 정규화: 기본값, 여러 줄 명령 거부, 기본값과 같으면 저장하지 않는다', async () => {
  const { normalizeConfig, saveConfig, configFor, storageKey, validCommand } = await load();
  assert.deepEqual(normalizeConfig(null), { share: false, dirs: ['node_modules'], postCreate: '' });
  assert.deepEqual(normalizeConfig({ share: 'yes', dirs: ['../x'], postCreate: 'npm ci\nrm -rf /' }), { share: false, dirs: ['node_modules'], postCreate: '' });
  assert.equal(validCommand('npm ci'), true);
  assert.equal(validCommand('a\rb'), false);
  const storage = memory();
  saveConfig(storage, 'c:\\repo', { share: true, dirs: ['node_modules', '.venv'], postCreate: ' npm ci ' });
  assert.deepEqual(configFor(storage, 'c:\\repo'), { share: true, dirs: ['node_modules', '.venv'], postCreate: 'npm ci' });
  assert.deepEqual(configFor(storage, 'c:\\other'), { share: false, dirs: ['node_modules'], postCreate: '' });
  saveConfig(storage, 'c:\\repo', { share: false, dirs: ['node_modules'], postCreate: '' });
  assert.equal(storage.getItem(storageKey), '{}');
  storage.setItem(storageKey, 'not json');
  assert.deepEqual(configFor(storage, 'c:\\repo').dirs, ['node_modules']);
});

test('작업 런처 요약과 생성 결과 문구', async () => {
  const { launcherSummary, resultSummary } = await load();
  const config = { share: true, dirs: ['node_modules'], postCreate: 'npm ci' };
  assert.equal(launcherSummary(config, { repository: true, exists: true, count: 3 }),
    '.worktreeinclude 파일 3개 복사 · node_modules 정션 공유 · 만든 뒤 실행: npm ci');
  assert.equal(launcherSummary({ share: false, dirs: [], postCreate: '' }, { repository: true, exists: false }), '');
  assert.equal(launcherSummary({ share: false, dirs: [], postCreate: '' }, { repository: true, exists: true, count: 0 }), '.worktreeinclude에 맞는 파일 없음');
  assert.equal(resultSummary({ copied: ['.env'], linked: ['node_modules'], linkSkipped: [{ path: 'dist', reason: '원본 폴더가 없음' }, { path: 'x', reason: '이미 있음' }] }),
    '파일 1개 복사 · node_modules 정션 연결 · 연결 안 함: dist(원본 폴더가 없음)');
  assert.equal(resultSummary({ error: '실패' }), 'worktree 환경 준비 실패: 실패');
  assert.equal(resultSummary({ copied: [], linked: [], linkSkipped: [] }), '');
});
