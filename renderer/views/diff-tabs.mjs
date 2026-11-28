// diff 탭: 변경 파일마다 메인 작업 영역에 따로 여는 읽기 전용 diff. Unified와 좌우(Side-by-Side)를 전환한다.
// 검토 패널의 diff(줄 선택·노트)와 별개로 여러 파일을 나란히 열어 둘 수 있고, 재시작하면 배치와 함께 복원된다.
const modeKey = 'workbench.diff-mode';
const kindLabels = { staged: '스테이징됨', unstaged: '작업 트리', new: '새 파일', conflict: '충돌' };
const diffTabs = new Map(); // cwd|kind|name → tab

function languageFor(name) {
  const ext = name.split('.').at(-1).toLowerCase();
  return { js: 'js', mjs: 'js', cjs: 'js', jsx: 'js', ts: 'ts', tsx: 'ts', json: 'json', py: 'py', ps1: 'ps', sh: 'sh', go: 'go', rs: 'rust',
    java: 'java', kt: 'java', cs: 'java', css: 'css', html: 'html', sql: 'sql' }[ext] ?? 'text';
}

function codeCell(row, lang) {
  const cell = document.createElement('span');
  cell.className = 'diff-code';
  if (!row) return cell;
  const text = row.type === 'hunk' ? row.text : row.text.slice(1);
  for (const token of markdown.highlightTokens(text, lang)) {
    if (token.type === 'plain') cell.append(token.text);
    else {
      const span = document.createElement('span');
      span.className = 'tok-' + token.type;
      span.textContent = token.text;
      cell.append(span);
    }
  }
  return cell;
}

function numberCell(value) {
  const cell = document.createElement('span');
  cell.className = 'diff-number';
  cell.textContent = value ?? '';
  return cell;
}

function renderDiff(tab) {
  const body = tab.host.querySelector('.diff-tab-body');
  const mode = localStorage.getItem(modeKey) === 'split' ? 'split' : 'unified';
  tab.host.dataset.mode = mode;
  for (const toggle of tab.host.querySelectorAll('[data-diff-mode]')) toggle.setAttribute('aria-pressed', String(toggle.dataset.diffMode === mode));
  const content = tab.diffContent ?? '';
  if (!/^@@ /m.test(content)) {
    const note = document.createElement('p');
    note.className = 'diff-empty';
    note.textContent = content.trim() || '표시할 텍스트 변경이 없습니다.';
    body.replaceChildren(note);
    return;
  }
  const { rows, truncated } = diffView.parsePatch(content);
  const lang = languageFor(tab.diffEntry.name);
  const fragment = document.createDocumentFragment();
  if (mode === 'unified') {
    for (const row of rows) {
      const line = document.createElement('div');
      line.className = 'diff-line ' + row.type;
      if (row.type === 'hunk') {
        const header = document.createElement('span');
        header.className = 'diff-hunk';
        header.textContent = '@@ ' + row.header;
        line.append(header);
      } else line.append(numberCell(row.oldNumber), numberCell(row.newNumber), codeCell(row, lang));
      fragment.append(line);
    }
  } else {
    for (const pair of diffView.sideBySide(rows)) {
      const line = document.createElement('div');
      if (pair.hunk) {
        line.className = 'diff-line hunk';
        const header = document.createElement('span');
        header.className = 'diff-hunk';
        header.textContent = '@@ ' + pair.hunk.header;
        line.append(header);
      } else {
        line.className = 'diff-pair';
        const side = (row, which) => {
          const half = document.createElement('span');
          half.className = 'diff-half ' + (row ? (row.type === 'context' ? 'context' : row.type) : 'blank');
          half.append(numberCell(row ? (which === 'left' ? row.oldNumber : row.newNumber) : ''), codeCell(row, lang));
          return half;
        };
        line.append(side(pair.left, 'left'), side(pair.right, 'right'));
      }
      fragment.append(line);
    }
  }
  if (truncated) {
    const note = document.createElement('p');
    note.className = 'diff-empty';
    note.textContent = '처음 2,500줄을 표시합니다.';
    fragment.append(note);
  }
  body.replaceChildren(fragment);
}

async function loadDiff(tab) {
  const { cwd, name, kind } = tab.diffEntry;
  try { tab.diffContent = await api.gitDiff(cwd, name, kind); }
  catch (error) { tab.diffContent = ipcMessage(error); }
  if (tab.workArea) renderDiff(tab);
}

async function openDiffTab(cwd, entry, area = workAreaFor(), saved) {
  const key = cwd + '|' + entry.kind + '|' + entry.name;
  const existing = diffTabs.get(key);
  if (existing?.workArea) {
    if (!saved) activateWorkAreaTab(existing);
    loadDiff(existing);
    return existing;
  }
  const host = document.createElement('section');
  host.className = 'work-document diff-tab';
  const header = document.createElement('header');
  header.className = 'source-header';
  const title = document.createElement('span');
  title.textContent = entry.name;
  title.title = cwd + ' · ' + entry.name;
  const kind = document.createElement('small');
  kind.textContent = kindLabels[entry.kind] ?? '';
  const modes = document.createElement('div');
  modes.className = 'segmented';
  modes.setAttribute('role', 'group');
  modes.setAttribute('aria-label', 'diff 보기 방식');
  for (const [value, label] of [['unified', '한 줄'], ['split', '좌우']]) {
    const toggle = button(label, () => {
      localStorage.setItem(modeKey, value);
      for (const open of diffTabs.values()) if (open.workArea) renderDiff(open);
    });
    toggle.dataset.diffMode = value;
    modes.append(toggle);
  }
  const refresh = button('', () => loadDiff(tab));
  refresh.className = 'icon-button';
  refresh.title = refresh.ariaLabel = 'diff 새로 고침';
  setPanelIcon(refresh, 'refresh');
  header.append(title, kind, modes, refresh);
  const body = document.createElement('div');
  body.className = 'diff-tab-body';
  host.append(header, body);
  const tab = { name: 'diff · ' + entry.name.split('/').at(-1), icon: 'branch', host, cwd, diffEntry: { cwd, name: entry.name, kind: entry.kind } };
  tab.onClose = () => diffTabs.delete(key);
  diffTabs.set(key, tab);
  attachWorkAreaTab(tab, area, !saved);
  if (!saved) activateWorkAreaTab(tab);
  await loadDiff(tab);
  return tab;
}

window.openDiffTab = openDiffTab;
