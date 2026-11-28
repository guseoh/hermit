// Stage C 트랙 2: worktree 환경 자동화. 설정 화면 → 작업 런처 요약 → worktree 생성 시 .worktreeinclude 복사·
// node_modules 정션·postCreate 실행 → 정리 후에도 원본 node_modules가 남는지 확인한다.
const { execFileSync } = require('node:child_process');

module.exports = async ({ evaluate, waitFor, shot, assert, fs, path, profile }) => {
  const repo = path.join(profile, 'wt-smoke');
  const git = (...args) => execFileSync('git', ['-C', repo, ...args], { stdio: 'ignore' });
  fs.mkdirSync(path.join(repo, 'node_modules', 'pkg'), { recursive: true });
  git('init', '-q', '-b', 'main');
  git('config', 'user.email', 'smoke@example.com');
  git('config', 'user.name', 'smoke');
  fs.writeFileSync(path.join(repo, '.gitignore'), 'node_modules/\n.env\nhermit-postcreate.txt\n');
  fs.writeFileSync(path.join(repo, '.worktreeinclude'), '.env\n');
  fs.writeFileSync(path.join(repo, 'readme.txt'), 'smoke\n');
  git('add', '.');
  git('commit', '-qm', 'init');
  fs.writeFileSync(path.join(repo, '.env'), 'SMOKE=1\n');
  const original = path.join(repo, 'node_modules', 'pkg', 'index.js');
  fs.writeFileSync(original, 'module.exports = 1;\n');
  const R = JSON.stringify(repo);

  // 1) 설정 화면: 미리보기(복사될 파일 1개)를 보여 주고, 정션 공유와 postCreate를 저장한다.
  await evaluate('showWorktreeSetup(' + R + '); 0');
  await waitFor(() => evaluate('!!byId("worktree-setup-save")'), 'worktree setup form');
  assert.match(await evaluate('byId("workbench-tools-body").textContent'), /복사될 파일 1개/);
  await shot('40-worktree-setup');
  await evaluate('byId("worktree-setup-share").checked = true; byId("worktree-setup-command").value = "Set-Content -Path hermit-postcreate.txt -Value ok"; byId("worktree-setup-save").click(); 0');
  await waitFor(() => evaluate('!byId("workbench-tools-dialog").open'), 'setup saved');
  const saved = JSON.parse(await evaluate('localStorage.getItem("agent-worktree-setup-v1")'));
  assert.deepEqual(Object.values(saved), [{ share: true, dirs: ['node_modules'], postCreate: 'Set-Content -Path hermit-postcreate.txt -Value ok' }]);

  // 2) 작업 런처 요약: 이 저장소에 적용될 내용을 한 줄로. (앞 시나리오가 worktree 기본값을 껐을 수 있어 초기화한다.)
  await evaluate('localStorage.removeItem(taskWorktreeKey); connectTask = async () => {}; whenSettled = async () => {}; newTask("codex", ' + R + ', undefined, ""); 0');
  await waitFor(() => evaluate('!byId("task-worktree-setup").hidden'), 'launcher summary');
  const summary = await evaluate('byId("task-worktree-setup").textContent');
  assert.match(summary, /\.worktreeinclude 파일 1개 복사/);
  assert.match(summary, /node_modules 정션 공유/);
  assert.match(summary, /만든 뒤 실행: Set-Content/);
  await shot('40-task-launcher-setup');
  // worktree를 끄면 요약을 숨긴다.
  await evaluate('byId("task-worktree").checked = false; byId("task-worktree").dispatchEvent(new Event("change")); 0');
  await waitFor(() => evaluate('byId("task-worktree-setup").hidden'), 'summary hidden without worktree');
  await evaluate('byId("task-worktree").checked = true; byId("task-worktree").dispatchEvent(new Event("change")); byId("task-name").value = "smoke worktree setup"; byId("task-dialog").querySelector("form").requestSubmit(); 0');
  const created = await waitFor(() => evaluate('JSON.stringify(tasks.find(task => task.name === "smoke worktree setup" && task.worktree)?.worktree ?? "")').then(value => value && value !== '""' && JSON.parse(value)), 'worktree task');

  // 3) 파일 복사·정션·postCreate
  assert.equal(fs.readFileSync(path.join(created.path, '.env'), 'utf8'), 'SMOKE=1\n');
  assert.ok(fs.lstatSync(path.join(created.path, 'node_modules')).isSymbolicLink(), 'node_modules는 정션');
  await waitFor(() => fs.existsSync(path.join(created.path, 'hermit-postcreate.txt')), 'postCreate command ran in the new worktree');
  assert.equal(await evaluate('[...tabs.values()].some(tab => tab.name === "postCreate · smoke worktree setup")'), true);

  // 4) 정리: 터미널을 닫고 강제 정리해도 원본 node_modules는 남는다.
  await evaluate('[...tabs.values()].filter(tab => tab.name === "postCreate · smoke worktree setup").forEach(closeTab); 0');
  const result = JSON.parse(await evaluate('(async () => { const task = tasks.find(item => item.name === "smoke worktree setup"); '
    + 'const value = await api.taskWorktreeRemove(task.id, task.worktree.path, task.worktree.branch, true, task.worktree.base); '
    + 'closeWorkTab(task); tasks = tasks.filter(item => item !== task); closedTasks.delete(task.id); runtimes.delete(task.id); '
    + 'persist(); tasksSidebar(); return JSON.stringify(value); })()'));
  assert.equal(result.removed, true);
  assert.ok(!fs.existsSync(created.path), 'worktree 폴더가 지워진다');
  assert.ok(fs.existsSync(original), '원본 node_modules 파일이 남아 있다');
};
