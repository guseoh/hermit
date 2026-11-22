// diff 줄별 리뷰 노트: 위치 표기, 정렬, 에이전트에게 한 번에 보낼 메시지.
// 렌더러(window.reviewNotes)와 Node 테스트(require) 양쪽에서 쓴다.
(function (root) {
  const maxNotes = 200;
  const maxBody = 4000;
  const maxMessage = 40000;
  const kinds = { staged: '스테이징됨', unstaged: '작업 트리', new: '새 파일', conflict: '충돌' };

  // lines: [{ side: 'new'|'old', line, text }] — 선택한 diff 줄(text는 +/-/공백 표시 포함).
  function createNote({ file, kind, lines, body, id, now = Date.now() }) {
    if (typeof file !== 'string' || !file || !Array.isArray(lines) || !lines.length) throw new Error('노트를 달 줄을 선택하세요.');
    const text = String(body ?? '').trim();
    if (!text) throw new Error('노트 내용을 입력하세요.');
    if (text.length > maxBody) throw new Error('노트는 ' + maxBody + '자까지 쓸 수 있습니다.');
    const clean = lines.slice(0, 200).map(item => ({
      side: item.side === 'old' ? 'old' : 'new', line: Number(item.line), text: String(item.text ?? '').slice(0, 500)
    })).filter(item => Number.isSafeInteger(item.line) && item.line > 0);
    if (!clean.length) throw new Error('노트를 달 줄을 선택하세요.');
    return { id: id ?? 'n' + now.toString(36) + Math.random().toString(36).slice(2, 7), file, kind: kind ?? '', lines: clean, body: text, at: now };
  }

  function addNote(notes, note) {
    if (notes.length >= maxNotes) throw new Error('리뷰 노트는 ' + maxNotes + '개까지 모을 수 있습니다. 먼저 보내거나 지우세요.');
    return [...notes, note];
  }

  // 노트를 표시할 기준 줄: 선택한 줄 중 마지막(새 쪽 줄을 우선).
  function anchor(note) {
    const side = note.lines.some(item => item.side === 'new') ? 'new' : 'old';
    const numbers = note.lines.filter(item => item.side === side).map(item => item.line);
    return { side, line: Math.max(...numbers) };
  }

  // "src/a.js:12-15", 삭제된 줄만 있으면 "src/a.js (삭제된 줄 10-11)".
  function location(note) {
    const range = side => {
      const numbers = note.lines.filter(item => item.side === side).map(item => item.line);
      if (!numbers.length) return '';
      const low = Math.min(...numbers);
      const high = Math.max(...numbers);
      return low === high ? String(low) : low + '-' + high;
    };
    const added = range('new');
    const removed = range('old');
    if (added) return note.file + ':' + added + (removed ? ' (삭제된 줄 ' + removed + ' 포함)' : '');
    return note.file + ' (삭제된 줄 ' + removed + ')';
  }

  function sortNotes(notes) {
    return [...notes].sort((a, b) => a.file.localeCompare(b.file) || anchor(a).line - anchor(b).line || a.at - b.at);
  }

  function composeMessage(notes) {
    const sorted = sortNotes(notes);
    const parts = [
      '변경사항을 검토하고 diff에 리뷰 노트 ' + sorted.length + '개를 남겼습니다.',
      '각 노트를 반영해 코드를 고쳐 주세요. 이미 반영됐거나 동의하지 않는 노트는 이유를 짧게 설명해 주세요.'
    ];
    let file = null;
    sorted.forEach((note, index) => {
      if (note.file !== file) {
        file = note.file;
        parts.push('', '## ' + file);
      }
      parts.push('', (index + 1) + '. ' + location(note) + (kinds[note.kind] ? ' · ' + kinds[note.kind] : ''));
      parts.push('```diff', ...note.lines.map(item => item.text), '```');
      parts.push('노트: ' + note.body.split('\n').join('\n      '));
    });
    let message = parts.join('\n');
    if (message.length > maxMessage) message = message.slice(0, maxMessage) + '\n\n(길어서 뒷부분을 생략했습니다.)';
    return message;
  }

  // 저장된 값(JSON)을 읽을 때 형식이 맞는 노트만 남긴다.
  function load(value) {
    let parsed;
    try { parsed = JSON.parse(value ?? '{}'); } catch { return {}; }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    const result = {};
    for (const [key, notes] of Object.entries(parsed)) {
      if (!Array.isArray(notes)) continue;
      const valid = notes.filter(note => note && typeof note.id === 'string' && typeof note.file === 'string' &&
        typeof note.body === 'string' && Array.isArray(note.lines) && note.lines.length).slice(0, maxNotes);
      if (valid.length) result[key] = valid;
    }
    return result;
  }

  const api = { createNote, addNote, anchor, location, sortNotes, composeMessage, load, maxNotes };
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.reviewNotes = api;
})(globalThis);
