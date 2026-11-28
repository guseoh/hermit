// 채팅 입력창 도우미: 커서 앞의 @파일·/명령 찾기, 파일 후보 순위, 명령 목록.
// 렌더러(window.composerAssist)와 Node 테스트(require) 양쪽에서 쓴다.
(function (root) {
  const commands = [
    { name: 'terminal', label: '터미널로 이어 열기', hint: '같은 대화를 에이전트 TUI에서 이어 갑니다' },
    { name: 'stop', label: '실행 중인 작업 중단', hint: '에이전트의 현재 턴을 멈춥니다' },
    { name: 'changes', label: '변경사항 보기', hint: '오른쪽 검토 패널에서 diff를 엽니다' },
    { name: 'notes', label: '리뷰 노트 보내기', hint: '모은 diff 리뷰 노트를 한 번에 보냅니다' },
    { name: 'model', label: '모델 고르기', hint: '이 작업의 모델을 바꿉니다' },
    { name: 'queue', label: '대기열 비우기', hint: '보내지 않은 대기 메시지를 지웁니다' },
    { name: 'templates', label: '프롬프트 템플릿 관리', hint: '자주 쓰는 요청을 템플릿으로 저장합니다' }
  ];

  // 기본 프롬프트 템플릿. 입력창 첫머리에서 /이름(또는 한글 제목)으로 고른다. 첫 ": " 줄 끝에 커서를 둔다.
  const templates = [
    { name: 'bug', title: '버그 수정', body: '버그를 고쳐 주세요.\n증상: \n재현 방법: \n기대 동작: \n\n원인을 먼저 찾아 설명하고, 고친 뒤 관련 테스트를 실행해 결과를 알려 주세요.' },
    { name: 'review', title: '코드 리뷰', body: '현재 변경사항을 리뷰해 주세요.\n중점: \n\n정확성 문제, 놓친 경계 조건, 테스트 공백을 심각한 순서로 정리하고, 각 항목에 파일과 줄을 적어 주세요. 코드는 고치지 마세요.' },
    { name: 'test', title: '테스트 작성', body: '테스트를 추가해 주세요.\n대상: \n\n정상 경로와 경계 조건, 실패 경로를 나눠 작성하고, 실행 결과를 알려 주세요. 기존 테스트 스타일을 따르세요.' },
    { name: 'refactor', title: '리팩터링', body: '동작을 바꾸지 않고 정리해 주세요.\n대상: \n목표: \n\n바꾸기 전후로 테스트를 실행해 동작이 같은지 확인하세요.' },
    { name: 'explain', title: '코드 설명', body: '이 코드가 어떻게 동작하는지 설명해 주세요.\n대상: \n\n흐름, 핵심 자료 구조, 주의할 점을 순서대로 짚고, 코드는 고치지 마세요.' }
  ];

  // 커서 앞의 토큰: 입력 첫머리의 /명령, 또는 공백 뒤(또는 처음)의 @파일.
  function findToken(text, caret = text.length) {
    const before = text.slice(0, caret);
    const command = /^\/([^\s/]*)$/.exec(before);
    if (command) return { kind: 'command', query: command[1].toLowerCase(), start: 0, end: caret };
    const file = /(^|\s)@([^\s@]*)$/.exec(before);
    if (file) return { kind: 'file', query: file[2], start: caret - file[2].length - 1, end: caret };
    return null;
  }

  // 파일 후보: 파일 이름이 검색어로 시작 > 파일 이름에 포함 > 경로에 포함 > 글자 순서대로 포함. 같은 점수면 짧은 경로.
  function rankFiles(files, query, limit = 8) {
    const needle = String(query ?? '').toLowerCase().replace(/\\/g, '/');
    const scored = [];
    for (const file of files) {
      const path = file.toLowerCase();
      const name = path.slice(path.lastIndexOf('/') + 1);
      let score;
      if (!needle) score = 4;
      else if (name.startsWith(needle)) score = 0;
      else if (name.includes(needle)) score = 1;
      else if (path.includes(needle)) score = 2;
      else if (subsequence(path, needle)) score = 3;
      else continue;
      scored.push([score, file.length, file]);
    }
    scored.sort((a, b) => a[0] - b[0] || a[1] - b[1] || a[2].localeCompare(b[2]));
    return scored.slice(0, limit).map(entry => entry[2]);
  }

  function subsequence(text, needle) {
    let index = 0;
    for (const character of text) if (character === needle[index]) index++;
    return index === needle.length;
  }

  // 템플릿: 이름이 검색어로 시작하거나 제목에 검색어가 들어 있으면 고른다.
  function matchTemplates(list, query) {
    const needle = String(query ?? '').toLowerCase();
    return list.filter(template => String(template.name).toLowerCase().startsWith(needle) || String(template.title).toLowerCase().includes(needle));
  }

  // 템플릿 본문으로 /토큰을 바꾸고, 첫 ": "로 끝나는 줄(채울 자리)에 커서를 둔다.
  function applyTemplate(text, token, body) {
    const value = body + text.slice(token.end);
    const blank = body.indexOf(': \n');
    return { value, caret: blank >= 0 ? blank + 2 : body.length };
  }

  function matchCommands(query) {
    const needle = String(query ?? '').toLowerCase();
    return commands.filter(command => command.name.startsWith(needle) || command.label.includes(needle));
  }

  // 선택한 후보로 토큰을 바꾼 새 글과 커서 위치. 파일은 "@경로 ", 명령은 지운다(실행은 호출한 쪽에서).
  function applyChoice(text, token, choice) {
    const replacement = token.kind === 'file' ? '@' + (/\s/.test(choice) ? '"' + choice + '"' : choice) + ' ' : '';
    const value = text.slice(0, token.start) + replacement + text.slice(token.end);
    return { value, caret: token.start + replacement.length };
  }

  function continueList(text, start, end) {
    if (start !== end) return null;
    const lineStart = text.lastIndexOf('\n', start - 1) + 1;
    const lineEnd = text.indexOf('\n', start);
    const line = text.slice(lineStart, lineEnd === -1 ? text.length : lineEnd);
    const match = /^([ \t]*)([-*+]|\d+[.)])([ \t]+)(.*)$/.exec(line);
    if (!match || start < lineStart + match[1].length + match[2].length + match[3].length) return null;
    const [, indent, marker, space, body] = match;
    if (!body.trim()) return { start: lineStart, end: lineStart + line.length, text: indent };
    const nextMarker = /^\d/.test(marker) ? String(Number.parseInt(marker, 10) + 1) + marker.at(-1) : marker;
    return { start, end, text: '\n' + indent + nextMarker + space };
  }

  // @ 멘션의 맥락 후보(터미널·작업·노트·규칙). 범주 이름으로 시작하면 그 범주 전체를, 아니면 이름으로 찾는다.
  const mentionWords = {
    terminal: ['터미널', 'terminal', 'term'],
    task: ['작업', 'task'],
    note: ['노트', 'note', 'notes'],
    rule: ['규칙', 'rule', 'rules', 'agents']
  };
  const categoryOrder = ['terminal', 'task', 'note', 'rule'];
  function rankMentions(entries, query, limit = 8) {
    const needle = String(query ?? '').toLowerCase();
    const scored = [];
    for (const entry of entries) {
      const name = String(entry.name ?? '').toLowerCase();
      const words = mentionWords[entry.category] ?? [];
      let score;
      if (!needle) score = 3;
      else if (words.some(word => word.startsWith(needle) || needle.startsWith(word))) score = 0;
      else if (name.startsWith(needle)) score = 1;
      else if (name.includes(needle)) score = 2;
      else continue;
      scored.push({ entry, score, order: categoryOrder.indexOf(entry.category) });
    }
    // 검색어가 없으면 범주마다 고르게 보여 준다.
    if (!needle) {
      const picked = [];
      for (const category of categoryOrder) picked.push(...scored.filter(item => item.entry.category === category).slice(0, 2));
      return picked.slice(0, limit).map(item => item.entry);
    }
    scored.sort((a, b) => a.score - b.score || a.order - b.order);
    return scored.slice(0, limit).map(item => item.entry);
  }

  // 멘션 토큰을 지우고 그 자리에 맥락 블록을 넣는다. 앞뒤 글과는 빈 줄로 띄운다.
  function insertBlock(text, token, block) {
    const before = text.slice(0, token.start).replace(/[ \t]+$/, '');
    const after = text.slice(token.end).replace(/^[ \t]+/, '');
    const lead = before && !before.endsWith('\n\n') ? (before.endsWith('\n') ? '\n' : '\n\n') : '';
    const trail = after.startsWith('\n') ? '' : '\n';
    const value = before + lead + block + trail + after;
    return { value, caret: (before + lead + block + trail).length };
  }

  const api = { commands, templates, matchTemplates, applyTemplate, findToken, rankFiles, matchCommands, applyChoice, continueList, rankMentions, insertBlock };
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.composerAssist = api;
})(globalThis);
