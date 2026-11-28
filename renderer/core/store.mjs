const api = window.workbench;
const stateKeyPattern = /^(?:agent-|workbench[.-]|collapsed-)[\w.:-]{1,200}$/;
function stateSnapshot() {
  const values = {};
  for (let index = 0; index < localStorage.length; index++) {
    const key = localStorage.key(index);
    if (stateKeyPattern.test(key)) values[key] = localStorage.getItem(key);
  }
  return values;
}

function initializeStore() {
  let saved = null;
  try { saved = api.readState(); } catch (error) { console.error('상태 파일을 읽지 못했습니다.', error); }
  if (saved) {
    for (const key of Object.keys(stateSnapshot())) if (!Object.hasOwn(saved, key)) localStorage.removeItem(key);
    for (const [key, value] of Object.entries(saved)) localStorage.setItem(key, value);
  }
  let dirty = !saved;
  let writing = false;
  let timer;

  function schedule() {
    clearTimeout(timer);
    timer = setTimeout(save, 1000);
  }
  async function save() {
    if (writing || !dirty) return;
    writing = true;
    dirty = false;
    try { await api.writeState(stateSnapshot()); }
    catch (error) {
      dirty = true;
      console.error('상태 파일을 저장하지 못했습니다.', error);
    } finally {
      writing = false;
      if (dirty) schedule();
    }
  }
  for (const name of ['setItem', 'removeItem', 'clear']) {
    const original = Storage.prototype[name];
    Storage.prototype[name] = function (...args) {
      const tracked = this === localStorage && (name === 'clear' || stateKeyPattern.test(args[0]));
      const previous = tracked && name !== 'clear' ? this.getItem(args[0]) : null;
      const result = original.apply(this, args);
      if (tracked && (name === 'clear' || previous !== this.getItem(args[0]))) {
        dirty = true;
        schedule();
      }
      return result;
    };
  }
  if (dirty) schedule();
  addEventListener('beforeunload', () => {
    if (dirty || writing) api.flushState(stateSnapshot());
  });
}
initializeStore();
