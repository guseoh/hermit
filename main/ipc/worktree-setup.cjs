// Stage C 트랙 2: 작업 worktree 환경 자동화(.worktreeinclude 복사, 공유 폴더 정션).
// 렌더러가 넘긴 경로를 그대로 믿지 않고, git worktree 목록으로 원래 저장소와 대상 worktree를 다시 확인한다.
const path = require('node:path');
const setup = require('../worktree-setup.cjs');

const samePath = (first, second) => path.resolve(first).toLowerCase() === path.resolve(second).toLowerCase();

module.exports = ({ handle, changes }) => {
  async function mainRoot(cwd) {
    if (typeof cwd !== 'string' || !path.isAbsolute(cwd)) throw new Error('작업 폴더가 올바르지 않습니다.');
    const list = await changes.worktrees(cwd);
    if (!list[0]?.path || list[0].bare) throw new Error('기본 worktree를 확인할 수 없습니다.');
    return { root: path.resolve(list[0].path), list };
  }

  // 작업 런처 미리보기: 이 저장소에서 새 worktree로 복사될 .worktreeinclude 파일 수.
  handle('worktree-setup-preview', async cwd => {
    let found;
    try { found = await mainRoot(cwd); }
    catch { return { repository: false }; }
    const plan = await setup.planInclude(found.root);
    return { repository: true, root: found.root, exists: plan.exists, count: plan.files.length, totalBytes: plan.totalBytes,
      truncated: plan.truncated, skipped: plan.skipped.length, files: plan.files.slice(0, 20).map(file => file.path) };
  });

  // 새 worktree를 만든 직후: 파일 복사와 (켠 경우) 정션 연결.
  handle('worktree-setup-apply', async (cwd, directory, options) => {
    const { root, list } = await mainRoot(cwd);
    if (typeof directory !== 'string' || !list.slice(1).some(entry => entry.path && samePath(entry.path, directory))) {
      throw new Error('이 저장소의 worktree가 아닙니다.');
    }
    const worktree = path.resolve(directory);
    const plan = await setup.planInclude(root);
    const include = await setup.copyIncluded(root, worktree, plan);
    const share = options?.share === true ? await setup.linkShared(root, worktree, options.dirs) : { linked: [], skipped: [] };
    return { root, worktree, copied: include.copied, copySkipped: include.skipped, truncated: plan.truncated,
      linked: share.linked, linkSkipped: share.skipped };
  });
};
