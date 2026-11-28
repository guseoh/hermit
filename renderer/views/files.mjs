// 파일 탐색·내용 검색(검토 패널의 "파일"·"검색" 탭)과 소스 탭.
// 트리는 폴더를 펼칠 때 한 단계씩 불러오고, 검색은 rg(없으면 git grep)로 작업 폴더 안만 찾는다.
// 파일을 누르면 메인 작업 영역에 읽기 전용 소스 탭으로 열고, 선택한 줄을 대화에 첨부할 수 있다.
const tree = byId('files-tree');
const rootLabel = byId('files-root');
const expanded = new Map(); // root → Set(펼친 폴더 경로)
const listings = new Map(); // root|path → 항목 목록(새로 고칠 때까지 캐시)
let currentRoot = null;
let renderToken = 0;

function filesRoot() {
  return reviewCwd() ?? null;
}

async function listing(root, path) {
  const key = root + '|' + path;
  if (!listings.has(key)) listings.set(key, api.filesList(root, path).catch(error => { listings.delete(key); throw error; }));
  return listings.get(key);
}

function rowFor(root, entry, depth) {
  const row = document.createElement('button');
  row.type = 'button';
  row.className = 'files-row';
  row.dataset.path = entry.path;
  row.dataset.ignored = String(!!entry.ignored);
  row.style.setProperty('--depth', depth);
  row.setAttribute('role', 'treeitem');
  const open = entry.dir && expanded.get(root)?.has(entry.path);
  if (entry.dir) row.setAttribute('aria-expanded', String(!!open));
  const icon = document.createElement('span');
  setPanelIcon(icon, entry.dir ? (open ? 'folder-open' : 'folder') : 'files');
  const name = document.createElement('span');
  name.className = 'files-name';
  name.textContent = entry.name;
  row.append(icon, name);
  row.title = entry.path;
  row.onclick = () => {
    if (!entry.dir) return openSourceTab(root, entry.path).catch(report);
    const set = expanded.get(root) ?? new Set();
    expanded.set(root, set);
    if (!set.delete(entry.path)) set.add(entry.path);
    renderTree().catch(report);
  };
  return row;
}

async function renderTree() {
  const token = ++renderToken;
  const root = filesRoot();
  if (root !== currentRoot) currentRoot = root;
  rootLabel.textContent = root ? root.split(/[\\/]/).filter(Boolean).at(-1) ?? root : '작업 폴더 없음';
  rootLabel.title = root ?? '';
  if (!root) { tree.replaceChildren(); return; }
  const rows = [];
  async function walk(path, depth) {
    const result = await listing(root, path);
    for (const entry of result.entries) {
      rows.push(rowFor(root, entry, depth));
      if (entry.dir && expanded.get(root)?.has(entry.path)) await walk(entry.path, depth + 1);
    }
    if (result.truncated) {
      const more = document.createElement('p');
      more.className = 'files-note';
      more.style.setProperty('--depth', depth);
      more.textContent = '항목이 많아 처음 2000개만 보여 줍니다.';
      rows.push(more);
    }
  }
  try { await walk('', 0); }
  catch (error) {
    if (token !== renderToken) return;
    const note = document.createElement('p');
    note.className = 'files-note';
    note.textContent = ipcMessage(error);
    tree.replaceChildren(note);
    return;
  }
  if (token !== renderToken) return;
  const focused = document.activeElement?.closest?.('.files-row')?.dataset.path;
  tree.replaceChildren(...rows);
  if (focused) tree.querySelector('.files-row[data-path="' + CSS.escape(focused) + '"]')?.focus({ preventScroll: true });
}

function refreshFilesView(force = false) {
  if (force) for (const key of [...listings.keys()]) if (key.startsWith(filesRoot() + '|')) listings.delete(key);
  return renderTree().catch(report);
}

byId('refresh-files').onclick = () => refreshFilesView(true);

// 작업·패널을 바꾸면(검토 대상 폴더가 바뀌면) 그 폴더의 트리를 보여 준다.
function filesRootMaybeChanged() {
  if (byId('results-panel').dataset.review === 'files' && filesRoot() !== currentRoot) refreshFilesView();
}

// ── 내용 검색 ─────────────────────────────────────────────────────────────────
const searchInput = byId('search-query');
const searchSummary = byId('search-summary');
const searchResults = byId('search-results');
let searchTimer = 0;
let searchSerial = 0;

function highlightMatch(text, query, options) {
  const fragment = document.createDocumentFragment();
  let pattern;
  try {
    pattern = new RegExp(options.regex ? query : query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), options.caseSensitive ? 'g' : 'gi');
  } catch { fragment.append(text); return fragment; }
  let last = 0;
  for (const match of text.matchAll(pattern)) {
    if (!match[0]) break;
    fragment.append(text.slice(last, match.index));
    const mark = document.createElement('mark');
    mark.textContent = match[0];
    fragment.append(mark);
    last = match.index + match[0].length;
  }
  fragment.append(text.slice(last));
  return fragment;
}

async function runSearch() {
  const root = filesRoot();
  const query = searchInput.value;
  const options = { caseSensitive: byId('search-case').checked, regex: byId('search-regex').checked };
  const serial = ++searchSerial;
  if (!root || !query.trim()) {
    searchSummary.textContent = root ? '' : '작업을 열면 그 폴더에서 찾습니다.';
    searchResults.replaceChildren();
    return;
  }
  searchSummary.textContent = '찾는 중…';
  let result;
  try { result = await api.filesSearch(root, query, options); }
  catch (error) {
    if (serial !== searchSerial) return;
    searchSummary.textContent = ipcMessage(error);
    searchResults.replaceChildren();
    return;
  }
  if (serial !== searchSerial) return;
  const groups = new Map();
  for (const match of result.matches) {
    if (!groups.has(match.path)) groups.set(match.path, []);
    groups.get(match.path).push(match);
  }
  searchSummary.textContent = result.matches.length
    ? '파일 ' + groups.size + '개 · ' + result.matches.length + '곳' + (result.truncated ? ' (처음 ' + result.matches.length + '곳만)' : '') + (result.engine === 'git' ? ' · git grep' : '')
    : '일치하는 내용이 없습니다.';
  if (result.warning) {
    searchSummary.textContent += ' · 일부 파일은 읽지 못했습니다';
    searchSummary.title = result.warning;
  } else searchSummary.title = '';
  searchResults.replaceChildren(...[...groups].map(([path, matches]) => {
    const group = document.createElement('details');
    group.open = true;
    group.className = 'search-group';
    const summary = document.createElement('summary');
    const name = document.createElement('span');
    name.textContent = path.split('/').at(-1);
    const folder = document.createElement('small');
    folder.textContent = path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '';
    const count = document.createElement('span');
    count.className = 'search-count';
    count.textContent = matches.length;
    summary.append(name, folder, count);
    summary.title = path;
    group.append(summary, ...matches.map(match => {
      const row = button('', () => openSourceTab(root, path, match.line).catch(report));
      row.className = 'search-match';
      const line = document.createElement('span');
      line.className = 'search-line';
      line.textContent = match.line;
      const text = document.createElement('span');
      text.className = 'search-text';
      text.append(highlightMatch(match.text.trimStart(), query, options));
      row.append(line, text);
      row.title = path + ':' + match.line;
      return row;
    }));
    return group;
  }));
}

byId('search-form').onsubmit = event => { event.preventDefault(); clearTimeout(searchTimer); runSearch(); };
searchInput.addEventListener('input', () => { clearTimeout(searchTimer); searchTimer = setTimeout(runSearch, 300); });
for (const id of ['search-case', 'search-regex']) byId(id).addEventListener('change', runSearch);

// ── 소스 탭: 줄 번호와 구문 강조가 있는 읽기 전용 보기 ──────────────────────────────
const sourceTabs = new Map(); // root|path → tab
const languageOf = path => {
  const ext = path.split('.').at(-1).toLowerCase();
  return { js: 'js', mjs: 'js', cjs: 'js', jsx: 'js', ts: 'ts', tsx: 'ts', json: 'json', py: 'py', ps1: 'ps', psm1: 'ps', sh: 'sh', go: 'go', rs: 'rust',
    java: 'java', kt: 'java', cs: 'java', c: 'java', h: 'java', cpp: 'java', css: 'css', scss: 'css', html: 'html', xml: 'html', vue: 'html', sql: 'sql',
    yml: 'yaml', yaml: 'yaml', toml: 'toml', md: 'text' }[ext] ?? 'text';
};

function lineOf(code, node, offset) {
  const range = document.createRange();
  range.setStart(code, 0);
  range.setEnd(node, offset);
  return range.toString().split('\n').length;
}

function revealLine(tab, line) {
  const view = tab.host.querySelector('.source-scroll');
  const marker = tab.host.querySelector('.source-current');
  const height = Number.parseFloat(getComputedStyle(tab.host.querySelector('.source-code')).lineHeight) || 18;
  marker.hidden = !line;
  if (!line) return;
  marker.style.top = (line - 1) * height + 'px';
  marker.style.height = height + 'px';
  view.scrollTop = Math.max(0, (line - 1) * height - view.clientHeight / 3);
  tab.sourceLine = line;
}

async function openSourceTab(root, path, line, area = workAreaFor(), saved) {
  const key = root + '|' + path;
  const existing = sourceTabs.get(key);
  if (existing?.workArea) {
    if (!saved) activateWorkAreaTab(existing);
    // 바로 이동한다. 탭을 막 앞에 띄운 직후라도 크기 계산은 동기적으로 되고, 가려진 창에서는 rAF가 멈추기 때문이다.
    revealLine(existing, line);
    return existing;
  }
  const file = await api.filesRead(root, path);
  const host = document.createElement('section');
  host.className = 'work-document source-document';
  const header = document.createElement('header');
  header.className = 'source-header';
  const title = document.createElement('span');
  title.textContent = file.path;
  title.title = root + '\\' + file.path.replace(/\//g, '\\');
  const lines = file.text.split('\n');
  const info = document.createElement('small');
  info.textContent = lines.length + '줄';
  const attach = button('선택한 줄을 대화에 첨부', () => {
    const selection = getSelection();
    const code = host.querySelector('.source-code');
    if (!selection.rangeCount || !code.contains(selection.anchorNode)) return status('첨부할 줄을 먼저 선택하세요.');
    const range = selection.getRangeAt(0);
    const first = lineOf(code, range.startContainer, range.startOffset);
    const last = Math.max(first, lineOf(code, range.endContainer, range.endOffset) - (range.toString().endsWith('\n') ? 1 : 0));
    const fence = '```' + (languageOf(file.path) === 'text' ? '' : languageOf(file.path));
    appendToDraft(file.path + ':' + first + (last > first ? '-' + last : '') + '\n' + fence + '\n' + lines.slice(first - 1, last).join('\n') + '\n```');
  });
  attach.className = 'ghost';
  header.append(title, info, editorButton(() => ({ root, path: file.path, line: tab.sourceLine ?? topLine() })), attach);
  const scroll = document.createElement('div');
  scroll.className = 'source-scroll';
  // 표시 중인 맨 윗줄: 검색으로 간 줄이 없을 때 편집기에서 여기서부터 연다.
  const topLine = () => Math.max(1, Math.floor(scroll.scrollTop / 18) + 1);
  const gutter = document.createElement('pre');
  gutter.className = 'source-gutter';
  gutter.setAttribute('aria-hidden', 'true');
  gutter.textContent = lines.map((_, index) => index + 1).join('\n');
  const body = document.createElement('div');
  body.className = 'source-body';
  const current = document.createElement('div');
  current.className = 'source-current';
  current.hidden = true;
  const pre = document.createElement('pre');
  const code = document.createElement('code');
  code.className = 'source-code';
  // 큰 파일은 강조 없이 보여 준다(렌더링 비용을 줄이려고).
  const tokens = file.text.length <= 300000 ? markdown.highlightTokens(file.text, languageOf(file.path)) : [{ type: 'plain', text: file.text }];
  for (const token of tokens) {
    if (token.type === 'plain') code.append(token.text);
    else {
      const span = document.createElement('span');
      span.className = 'tok-' + token.type;
      span.textContent = token.text;
      code.append(span);
    }
  }
  pre.append(code);
  body.append(current, pre);
  scroll.append(gutter, body);
  host.append(header, scroll);
  // 아이콘 'note'는 Markdown 노트 탭이 쓰므로 소스 탭은 'files'를 쓴다.
  const tab = { name: file.path.split('/').at(-1), icon: 'files', host, cwd: root, sourceFile: { root, path: file.path } };
  tab.onClose = () => sourceTabs.delete(key);
  sourceTabs.set(key, tab);
  attachWorkAreaTab(tab, area, !saved);
  if (!saved) activateWorkAreaTab(tab);
  revealLine(tab, line);
  return tab;
}

// ── 외부 편집기: 설치된 VS Code·Cursor·Antigravity 중 고른 것(기본은 처음 찾은 것)으로 파일을 그 줄에 연다 ──
const editorKey = 'workbench.editor';
let editorList;
function installedEditors() {
  editorList ??= api.editorsList().catch(() => []);
  return editorList;
}
// target(): { root, path, line, gitRoot } — 누르는 순간의 위치(소스 탭은 표시 중인 줄).
function editorButton(target) {
  const wrap = document.createElement('span');
  wrap.className = 'editor-open';
  const open = button('편집기에서 열기', async () => {
    const { root, path, line, gitRoot } = target();
    try {
      const result = await api.editorOpen(picker.value || null, root, path, line, gitRoot === true);
      status(result.editor ? result.editor + '에서 ' + path + (line ? ':' + line : '') + '을 열었습니다.' : '기본 앱으로 ' + path + '을 열었습니다.');
    } catch (error) { report(error); }
  });
  open.className = 'ghost';
  const picker = document.createElement('select');
  picker.setAttribute('aria-label', '열 편집기');
  picker.hidden = true;
  picker.onchange = () => { try { localStorage.setItem(editorKey, picker.value); } catch {} };
  installedEditors().then(list => {
    picker.replaceChildren(...list.map(editor => new Option(editor.name, editor.id)));
    let saved = null;
    try { saved = localStorage.getItem(editorKey); } catch {}
    if (list.some(editor => editor.id === saved)) picker.value = saved;
    picker.hidden = list.length < 2;
    open.textContent = list.length ? '편집기에서 열기' : '기본 앱으로 열기';
    open.title = list.length ? '선택한 편집기에서 이 줄로 엽니다' : '설치된 VS Code·Cursor·Antigravity가 없어 기본 앱으로 엽니다';
  });
  wrap.append(picker, open);
  return wrap;
}

Object.assign(window, { refreshFilesView, openSourceTab, filesRootMaybeChanged, editorButton });
