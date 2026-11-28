// 채팅 마크다운: 블록 파서(순수 함수)와 DOM 렌더러.
// 렌더러는 블록마다 원문을 기억해, 스트리밍 중 텍스트가 늘어나면 바뀐 블록부터만 다시 그린다.
// 지원: 제목, 문단, 인용, 목록(체크박스 포함), 코드 블록(언어 표시·구문 강조·복사), 표, 구분선,
// 인라인 코드·굵게·기울임·취소선·링크(http/https만).

const fence = /^\s*(`{3,}|~{3,})\s*([\w#+.-]*)/;
const listItem = /^(\s*)([-+*]|\d+[.)])\s+(.*)$/;
const cells = line => line.trim().replace(/^\||\|$/g, '').split('|').map(cell => cell.trim());
const isSeparator = line => { const parts = cells(line); return parts.length > 1 && parts.every(cell => /^:?-{3,}:?$/.test(cell)); };

export function parseBlocks(text) {
  const lines = String(text ?? '').split(/\r?\n/);
  const blocks = [];
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index];
    if (!line.trim()) continue;
    const start = index;
    const opened = fence.exec(line);
    if (opened) {
      const body = [];
      let closed = false;
      while (++index < lines.length) {
        if (new RegExp('^\\s*' + opened[1][0] + '{' + opened[1].length + ',}\\s*$').test(lines[index])) { closed = true; break; }
        body.push(lines[index]);
      }
      blocks.push({ type: 'code', lang: opened[2].toLowerCase(), text: body.join('\n'), closed, source: lines.slice(start, index + 1).join('\n') });
      continue;
    }
    if (/^\s*(?:-{3,}|\*{3,}|_{3,})\s*$/.test(line)) { blocks.push({ type: 'rule', source: line }); continue; }
    const heading = /^(#{1,6})\s+(.+?)\s*#*\s*$/.exec(line);
    if (heading) { blocks.push({ type: 'heading', level: heading[1].length, text: heading[2], source: line }); continue; }
    if (cells(line).length > 1 && lines[index + 1] !== undefined && isSeparator(lines[index + 1]) && cells(lines[index + 1]).length === cells(line).length) {
      const header = cells(line);
      const rows = [];
      index++;
      while (lines[index + 1]?.includes('|') && lines[index + 1].trim()) rows.push(cells(lines[++index]).slice(0, header.length));
      blocks.push({ type: 'table', header, rows, source: lines.slice(start, index + 1).join('\n') });
      continue;
    }
    if (/^\s*>/.test(line)) {
      const body = [line.replace(/^\s*>\s?/, '')];
      while (index + 1 < lines.length && /^\s*>/.test(lines[index + 1])) body.push(lines[++index].replace(/^\s*>\s?/, ''));
      blocks.push({ type: 'quote', text: body.join('\n'), source: lines.slice(start, index + 1).join('\n') });
      continue;
    }
    if (listItem.test(line)) {
      const items = [];
      let ordered = null;
      while (index < lines.length) {
        const match = listItem.exec(lines[index]);
        if (!match) {
          // 들여쓴 이어지는 줄은 앞 항목에 붙인다.
          if (items.length && /^\s{2,}\S/.test(lines[index])) { items.at(-1).text += '\n' + lines[index].trim(); index++; continue; }
          break;
        }
        const numbered = /\d/.test(match[2]);
        if (ordered === null) ordered = numbered;
        else if (ordered !== numbered && !match[1]) break;
        const task = /^\[([ xX])\]\s+(.*)$/.exec(match[3]);
        items.push({ depth: Math.min(4, Math.floor(match[1].replace(/\t/g, '  ').length / 2)), text: task ? task[2] : match[3],
          checked: task ? task[1] !== ' ' : undefined, start: numbered ? Number.parseInt(match[2], 10) : undefined });
        index++;
      }
      index--;
      blocks.push({ type: 'list', ordered, items, source: lines.slice(start, index + 1).join('\n') });
      continue;
    }
    const body = [line];
    while (index + 1 < lines.length && lines[index + 1].trim() && !fence.test(lines[index + 1]) && !listItem.test(lines[index + 1]) &&
      !/^(#{1,6})\s/.test(lines[index + 1]) && !/^\s*>/.test(lines[index + 1])) body.push(lines[++index]);
    blocks.push({ type: 'paragraph', text: body.join('\n'), source: body.join('\n') });
  }
  return blocks;
}

// 인라인: 코드가 가장 먼저 잡히고, 그 안은 서식을 해석하지 않는다.
const inlinePattern = /(`+)([\s\S]*?[^`])\1(?!`)|\*\*([^*]+?)\*\*|~~([^~]+?)~~|(?<![\w*])\*(?!\s)([^*]+?)(?<!\s)\*(?![\w*])|\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)|(https?:\/\/[^\s<>()]+[^\s<>().,;:!?'"`])/g;

export function parseInline(text) {
  const tokens = [];
  let last = 0;
  for (const match of String(text).matchAll(inlinePattern)) {
    if (match.index > last) tokens.push({ type: 'text', text: text.slice(last, match.index) });
    if (match[1]) tokens.push({ type: 'code', text: match[2] });
    else if (match[3] !== undefined) tokens.push({ type: 'strong', children: parseInline(match[3]) });
    else if (match[4] !== undefined) tokens.push({ type: 'del', children: parseInline(match[4]) });
    else if (match[5] !== undefined) tokens.push({ type: 'em', children: parseInline(match[5]) });
    else if (match[6] !== undefined) tokens.push({ type: 'link', href: match[7], children: parseInline(match[6]) });
    else tokens.push({ type: 'link', href: match[8], children: [{ type: 'text', text: match[8] }] });
    last = match.index + match[0].length;
  }
  if (last < text.length) tokens.push({ type: 'text', text: text.slice(last) });
  return tokens;
}

// ── 구문 강조: 언어 계열별 주석·문자열·숫자·키워드만 칠하는 가벼운 토큰화 ──────────────────
const keywordSets = {
  js: 'async await break case catch class const continue default delete do else export extends false finally for from function if import in instanceof let new null of return static super switch this throw true try typeof undefined var void while yield interface type enum implements readonly',
  py: 'and as assert async await break class continue def del elif else except False finally for from global if import in is lambda None nonlocal not or pass raise return True try while with yield',
  ps: 'begin break catch class continue data do dynamicparam else elseif end exit filter finally for foreach function if in param process return switch throw trap try until using while $true $false $null',
  sh: 'case do done elif else esac export fi for function if in local return then until while echo exit',
  go: 'break case chan const continue default defer else fallthrough for func go goto if import interface map package range return select struct switch type var true false nil',
  rust: 'as async await break const continue crate else enum extern false fn for if impl in let loop match mod move mut pub ref return self Self static struct super trait true type unsafe use where while',
  java: 'abstract boolean break case catch char class const continue default do double else enum extends final finally float for if implements import instanceof int interface long new null package private protected public return short static super switch this throw throws true false try void volatile while var',
  sql: 'select from where join left right inner outer on group by order having insert into values update set delete create table alter drop index and or not null as distinct limit',
  json: 'true false null',
  css: '',
  html: ''
};
const languageAlias = { javascript: 'js', jsx: 'js', ts: 'js', tsx: 'js', typescript: 'js', mjs: 'js', cjs: 'js', python: 'py', powershell: 'ps', pwsh: 'ps', ps1: 'ps',
  bash: 'sh', shell: 'sh', zsh: 'sh', console: 'sh', golang: 'go', rs: 'rust', kotlin: 'java', kt: 'java', cs: 'java', csharp: 'java', c: 'java', cpp: 'java',
  'c++': 'java', swift: 'java', yaml: 'py', yml: 'py', toml: 'py', xml: 'html', svg: 'html', vue: 'html', scss: 'css', less: 'css', jsonc: 'js' };

function family(lang) {
  const key = languageAlias[lang] ?? lang;
  return Object.hasOwn(keywordSets, key) ? key : null;
}

export function highlightTokens(code, lang) {
  const kind = family(lang);
  if (!kind) return [{ type: 'plain', text: code }];
  const hashComment = ['py', 'ps', 'sh'].includes(kind);
  const parts = [
    kind === 'html' ? '<!--[\\s\\S]*?-->' : null,
    kind === 'ps' ? '<#[\\s\\S]*?#>' : null,
    ['js', 'go', 'rust', 'java', 'css'].includes(kind) ? '\\/\\*[\\s\\S]*?\\*\\/' : null,
    ['js', 'go', 'rust', 'java'].includes(kind) ? '\\/\\/[^\\n]*' : null,
    hashComment ? '#[^\\n]*' : null,
    kind === 'sql' ? '--[^\\n]*' : null
  ].filter(Boolean);
  const comment = parts.length ? '(' + parts.join('|') + ')' : '([^\\s\\S])';
  const string = kind === 'js' ? '("(?:[^"\\\\\\n]|\\\\.)*"|\'(?:[^\'\\\\\\n]|\\\\.)*\'|`(?:[^`\\\\]|\\\\.)*`)' : '("(?:[^"\\\\\\n]|\\\\.)*"|\'(?:[^\'\\\\\\n]|\\\\.)*\')';
  const number = '(\\b\\d[\\d_]*(?:\\.\\d+)?(?:e[+-]?\\d+)?\\b|\\b0x[\\da-f]+\\b)';
  const words = keywordSets[kind].split(' ').filter(Boolean).map(word => word.replace(/[$]/g, '\\$'));
  const keyword = words.length ? '((?:^|(?<=[^\\w$]))(?:' + words.join('|') + ')(?![\\w$]))' : '([^\\s\\S])';
  const tag = kind === 'html' ? '(<\\/?[\\w-]+|\\/?>)' : '([^\\s\\S])';
  const variable = kind === 'ps' || kind === 'sh' ? '(\\$[\\w:]+|\\$\\{[^}]+\\})' : '([^\\s\\S])';
  const pattern = new RegExp([comment, string, number, keyword, tag, variable].join('|'), kind === 'ps' || kind === 'sql' ? 'gi' : 'g');
  const tokens = [];
  let last = 0;
  for (const match of code.matchAll(pattern)) {
    if (!match[0]) continue;
    if (match.index > last) tokens.push({ type: 'plain', text: code.slice(last, match.index) });
    const type = match[1] ? 'comment' : match[2] ? 'string' : match[3] ? 'number' : match[4] ? 'keyword' : match[5] ? 'tag' : 'variable';
    tokens.push({ type, text: match[0] });
    last = match.index + match[0].length;
  }
  if (last < code.length) tokens.push({ type: 'plain', text: code.slice(last) });
  return tokens;
}

// ── DOM 렌더링 ─────────────────────────────────────────────────────────────────
function appendInline(parent, tokens) {
  for (const token of tokens) {
    if (token.type === 'text') { parent.append(token.text); continue; }
    if (token.type === 'code') {
      const code = document.createElement('code');
      code.textContent = token.text;
      parent.append(code);
      continue;
    }
    const element = document.createElement(token.type === 'link' ? 'a' : token.type);
    if (token.type === 'link') {
      element.href = token.href;
      element.className = 'md-link';
      element.title = token.href;
      element.rel = 'noreferrer';
    }
    appendInline(element, token.children);
    parent.append(element);
  }
}

function inlineElement(tag, text) {
  const element = document.createElement(tag);
  // 문단 안의 줄바꿈은 그대로 보여 준다(에이전트 답변은 줄 단위로 쓰는 경우가 많다).
  String(text).split('\n').forEach((line, index) => {
    if (index) element.append(document.createElement('br'));
    appendInline(element, parseInline(line));
  });
  return element;
}

function codeBlock(block) {
  const wrapper = document.createElement('div');
  wrapper.className = 'md-code';
  const header = document.createElement('div');
  header.className = 'md-code-header';
  const label = document.createElement('span');
  label.textContent = block.lang || 'text';
  const copy = document.createElement('button');
  copy.type = 'button';
  copy.className = 'md-copy';
  copy.textContent = '복사';
  copy.title = '코드 복사';
  copy.addEventListener('click', async () => {
    try {
      // 창 포커스와 무관하게 main 프로세스의 클립보드로 복사한다.
      await (window.workbench?.copy ?? (text => navigator.clipboard.writeText(text)))(block.text);
      copy.textContent = '복사됨';
    } catch { copy.textContent = '복사 실패'; }
    setTimeout(() => { copy.textContent = '복사'; }, 1500);
  });
  header.append(label, copy);
  const pre = document.createElement('pre');
  const code = document.createElement('code');
  for (const token of highlightTokens(block.text, block.lang)) {
    if (token.type === 'plain') code.append(token.text);
    else {
      const span = document.createElement('span');
      span.className = 'tok-' + token.type;
      span.textContent = token.text;
      code.append(span);
    }
  }
  pre.append(code);
  wrapper.append(header, pre);
  return wrapper;
}

function listElement(block) {
  const root = document.createElement(block.ordered ? 'ol' : 'ul');
  if (block.ordered && block.items[0]?.start > 1) root.start = block.items[0].start;
  const stack = [{ depth: 0, list: root }];
  for (const item of block.items) {
    while (stack.length > 1 && item.depth < stack.at(-1).depth) stack.pop();
    if (item.depth > stack.at(-1).depth && stack.at(-1).list.lastElementChild) {
      const nested = document.createElement(block.ordered ? 'ol' : 'ul');
      stack.at(-1).list.lastElementChild.append(nested);
      stack.push({ depth: item.depth, list: nested });
    }
    const li = inlineElement('li', item.text);
    if (item.checked !== undefined) {
      li.classList.add('md-task');
      const box = document.createElement('input');
      box.type = 'checkbox';
      box.checked = item.checked;
      box.disabled = true;
      box.setAttribute('aria-label', item.checked ? '완료' : '미완료');
      li.prepend(box);
    }
    stack.at(-1).list.append(li);
  }
  return root;
}

function blockElement(block) {
  if (block.type === 'code') return codeBlock(block);
  if (block.type === 'rule') return document.createElement('hr');
  if (block.type === 'heading') return inlineElement('h' + block.level, block.text);
  if (block.type === 'quote') return inlineElement('blockquote', block.text);
  if (block.type === 'list') return listElement(block);
  if (block.type === 'table') {
    const table = document.createElement('table');
    const head = table.createTHead().insertRow();
    for (const cell of block.header) head.append(inlineElement('th', cell));
    const body = table.createTBody();
    for (const row of block.rows) {
      const tr = body.insertRow();
      for (const cell of row) tr.append(inlineElement('td', cell));
    }
    const scroll = document.createElement('div');
    scroll.className = 'md-table';
    scroll.append(table);
    return scroll;
  }
  return inlineElement('p', block.text);
}

// 같은 원문의 블록은 그대로 두고, 처음 달라진 블록부터 다시 그린다.
export function renderMarkdown(node, text) {
  if (node.dataset.source === text) return;
  node.dataset.source = text;
  const blocks = parseBlocks(text);
  const previous = node.markdownBlocks ?? [];
  let same = 0;
  while (same < previous.length && same < blocks.length && previous[same].source === blocks[same].source && previous[same].element.parentNode === node) same++;
  if (!same) node.replaceChildren();
  else for (const entry of previous.slice(same)) entry.element.remove();
  const next = previous.slice(0, same);
  for (const block of blocks.slice(same)) {
    const element = blockElement(block);
    node.append(element);
    next.push({ source: block.source, element });
  }
  node.markdownBlocks = next;
}

if (typeof document !== 'undefined') {
  // 링크는 앱 창 안에서 열지 않고 기본 브라우저로 연다.
  document.addEventListener('click', event => {
    const link = event.target.closest?.('a.md-link');
    if (!link) return;
    event.preventDefault();
    window.workbench?.openLink(link.href).catch(error => window.report?.(error));
  });
  window.markdown = { parseBlocks, parseInline, highlightTokens, renderMarkdown };
}
