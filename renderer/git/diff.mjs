// git diff 텍스트를 줄 단위로 해석하고(Unified), 좌우 비교(Side-by-Side) 짝으로 바꾼다. DOM에 의존하지 않는다.

// rows: { type: 'hunk' | 'add' | 'remove' | 'context', oldNumber, newNumber, text, header }
export function parsePatch(content, limit = 2500) {
  const lines = String(content ?? '').split(/\r?\n/);
  const rows = [];
  let oldLine;
  let newLine;
  let index = 0;
  for (const text of lines) {
    if (rows.length >= limit) return { rows, truncated: true };
    const position = index++;
    if (text === '') continue;
    const hunk = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@(.*)$/.exec(text);
    if (hunk) {
      oldLine = Number(hunk[1]);
      newLine = Number(hunk[2]);
      rows.push({ type: 'hunk', index: position, text, header: hunk[3].trim() || '변경 구간 ' + hunk[2] + '행부터', oldNumber: '', newNumber: '' });
      continue;
    }
    // "diff --git", "index", "---", "+++" 머리는 제목과 같으므로 건너뛴다. "\ No newline at end of file"도 줄이 아니다.
    if (oldLine === undefined || text.startsWith('\\')) continue;
    const code = text[0];
    if (code === '-') rows.push({ type: 'remove', index: position, text, oldNumber: oldLine++, newNumber: '' });
    else if (code === '+') rows.push({ type: 'add', index: position, text, oldNumber: '', newNumber: newLine++ });
    else if (code === ' ') rows.push({ type: 'context', index: position, text, oldNumber: oldLine++, newNumber: newLine++ });
  }
  return { rows, truncated: false };
}

// 좌우 비교: 이어진 삭제 줄과 추가 줄을 순서대로 짝짓고, 남는 쪽은 빈칸으로 둔다.
export function sideBySide(rows) {
  const pairs = [];
  let removed = [];
  let added = [];
  const flush = () => {
    for (let i = 0; i < Math.max(removed.length, added.length); i++) pairs.push({ left: removed[i] ?? null, right: added[i] ?? null });
    removed = [];
    added = [];
  };
  for (const row of rows) {
    if (row.type === 'remove') { if (added.length) flush(); removed.push(row); }
    else if (row.type === 'add') added.push(row);
    else {
      flush();
      pairs.push(row.type === 'hunk' ? { hunk: row } : { left: row, right: row });
    }
  }
  flush();
  return pairs;
}

if (typeof window !== 'undefined') window.diffView = { parsePatch, sideBySide };
