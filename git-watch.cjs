// 변경 패널이 보고 있는 저장소 하나를 파일 감시한다. git status를 주기적으로 돌리는 대신,
// 작업 트리나 git 메타데이터(index, HEAD, refs)가 바뀌었을 때만 렌더러에 알린다.
const fs = require('node:fs');
const path = require('node:path');

const debounceMs = 300;

const slash = name => String(name ?? '').replace(/\\/g, '/');

// 작업 트리 쪽 변경 중 git status에 영향이 없는 것은 거른다.
function relevantWorkTreeChange(name) {
  const file = slash(name);
  if (!file) return true;
  if (file === '.git' || file.startsWith('.git/')) return relevantGitDirChange(file.slice(5));
  return !/(^|\/)node_modules(\/|$)/.test(file);
}

// git 폴더 안에서는 상태에 영향을 주는 파일만 본다(objects·잠금 파일은 무시).
function relevantGitDirChange(name) {
  const file = slash(name);
  if (!file) return true;
  if (file.endsWith('.lock')) return false;
  return ['index', 'HEAD', 'ORIG_HEAD', 'MERGE_HEAD', 'CHERRY_PICK_HEAD', 'REVERT_HEAD', 'packed-refs', 'logs/HEAD'].includes(file) ||
    file.startsWith('refs/');
}

// resolve(cwd) → { root, gitDir } | null, notify(root) 는 바뀌었을 때 부른다.
function createGitWatcher(resolve, notify) {
  let current = null;

  function stop() {
    if (!current) return;
    clearTimeout(current.timer);
    for (const watcher of current.watchers) watcher.close();
    current = null;
  }

  async function watch(cwd) {
    if (cwd === null || cwd === undefined) { stop(); return null; }
    if (typeof cwd !== 'string' || !path.isAbsolute(cwd)) throw new Error('잘못된 폴더입니다.');
    const paths = await resolve(cwd).catch(() => null);
    if (!paths) { stop(); return null; }
    const root = path.resolve(paths.root);
    if (current?.root.toLowerCase() === root.toLowerCase()) return { root, watching: true };
    stop();
    const entry = { root, watchers: [], timer: null };
    const schedule = () => {
      clearTimeout(entry.timer);
      entry.timer = setTimeout(() => { if (current === entry) notify(root); }, debounceMs);
    };
    try {
      entry.watchers.push(fs.watch(root, { recursive: true }, (event, name) => { if (relevantWorkTreeChange(name)) schedule(); }));
      // worktree는 git 폴더(<저장소>/.git/worktrees/<이름>)가 작업 트리 밖에 있으므로 따로 본다.
      const gitDir = paths.gitDir && path.resolve(paths.gitDir);
      const inside = gitDir && !path.relative(root, gitDir).startsWith('..') && !path.isAbsolute(path.relative(root, gitDir));
      if (gitDir && !inside) {
        entry.watchers.push(fs.watch(gitDir, { recursive: true }, (event, name) => { if (relevantGitDirChange(name)) schedule(); }));
      }
    } catch {
      for (const watcher of entry.watchers) watcher.close();
      return { root, watching: false };
    }
    for (const watcher of entry.watchers) {
      watcher.on('error', () => { if (current === entry) { stop(); notify(root); } });
    }
    current = entry;
    return { root, watching: true };
  }

  return { watch, stop };
}

module.exports = { createGitWatcher, relevantWorkTreeChange, relevantGitDirChange };
