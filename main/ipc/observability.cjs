// Stage C 트랙 2: 관측성(일별·프로젝트별 예상 비용 리포트 및 localhost 포트 현황) IPC.
const path = require('node:path');
const { createUsageLedger, scanListeningPorts } = require('../observability.cjs');

module.exports = ({ handle, app }) => {
  let ledger = null;
  function getLedger() {
    if (!ledger) {
      const file = path.join(app.getPath('userData'), 'usage-ledger.jsonl');
      ledger = createUsageLedger(file);
    }
    return ledger;
  }

  handle('observability-usage-record', entry => getLedger().record(entry));
  handle('observability-usage-report', options => getLedger().summarize(options ?? {}));
  handle('observability-ports', () => scanListeningPorts());
};
