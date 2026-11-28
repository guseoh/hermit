// Stage C 트랙 2: 전역 대화·명령 출력 검색(지식 색인) IPC.
const path = require('node:path');
const { createKnowledgeIndex } = require('../knowledge-index.cjs');

module.exports = ({ handle, app }) => {
  let index = null;
  function getIndex() {
    if (!index) {
      const file = path.join(app.getPath('userData'), 'knowledge-index.jsonl');
      index = createKnowledgeIndex(file);
    }
    return index;
  }

  handle('knowledge-append', record => getIndex().append(record));
  handle('knowledge-search', options => {
    const idx = getIndex();
    const result = idx.search(options ?? {});
    return { ...result, stats: idx.stats() };
  });
  handle('knowledge-stats', () => getIndex().stats());
  handle('knowledge-clear', () => getIndex().clear());
};
