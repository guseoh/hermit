const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { createInterface } = require('node:readline');

const uuid = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;

function historyPath(directory, id) {
  if (typeof id !== 'string' || !uuid.test(id)) throw new Error('잘못된 작업 ID입니다.');
  return path.join(directory, id + '.json');
}

async function readHistory(file) {
  try { return JSON.parse(await fs.readFile(file, 'utf8')); }
  catch (error) {
    if (error.code === 'ENOENT') return { items: [] };
    throw error;
  }
}

async function saveHistory(file, history) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file + '.tmp', JSON.stringify(history), 'utf8');
  await fs.rename(file + '.tmp', file);
}

async function transcript(cwd, sessionId) {
  if (!uuid.test(sessionId)) throw new Error('잘못된 Claude 세션 ID입니다.');
  const projects = path.join(process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude'), 'projects');
  const name = sessionId + '.jsonl';
  const encoded = path.resolve(cwd).replace(/[^a-z0-9]/gi, '-');
  async function open(directory) {
    try { return await fs.open(path.join(projects, directory, name), 'r'); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  const direct = await open(encoded);
  if (direct) return direct;
  // Claude 버전·worktree에 따라 프로젝트 폴더 인코딩이 달라질 수 있다.
  let folders;
  try { folders = await fs.readdir(projects, { withFileTypes: true }); }
  catch (error) { if (error.code === 'ENOENT') return; throw error; }
  for (const folder of folders) {
    if (!folder.isDirectory() || folder.name === encoded) continue;
    const file = await open(folder.name);
    if (file) return file;
  }
}

function appendRecord(items, record, sessionId) {
  if (record.sessionId !== sessionId || !record.uuid || record.isSidechain || record.isMeta ||
      !['user', 'assistant'].includes(record.type)) return;
  const content = record.message?.content;
  const blocks = typeof content === 'string' ? [{ type: 'text', text: content }] : content;
  if (!Array.isArray(blocks)) return;
  for (const [index, block] of blocks.entries()) {
    const id = 'tui-' + record.uuid + '-' + index;
    let item;
    if (block?.type === 'text' && typeof block.text === 'string' && block.text) {
      item = record.type === 'user' ? { id, type: 'userMessage', content: [{ text: block.text }] } :
        { id, type: 'agentMessage', text: block.text };
    } else if (block?.type === 'tool_use' && block.id) {
      item = { id: block.id, type: 'toolUse', title: block.name, input: block.input ?? {} };
    } else if (block?.type === 'tool_result') {
      const tool = items.get(block.tool_use_id);
      if (tool?.type === 'toolUse') {
        const text = Array.isArray(block.content) ? block.content.filter(v => v?.type === 'text').map(v => v.text).join('\n') : block.content;
        tool.output = String(text ?? '').slice(0, 20000);
        tool.isError = block.is_error === true;
      }
    }
    if (item) items.set(item.id, item);
    if (items.size > 100) items.delete(items.keys().next().value);
  }
}

async function syncHistory(file, cwd) {
  const history = await readHistory(file);
  if (!history.tui) return history;
  const { sessionId, offset } = history.tui;
  const handle = await transcript(cwd, sessionId);
  if (handle) {
    try {
      const { size } = await handle.stat();
      const start = offset <= size ? offset : 0;
      if (start < size) {
        const stream = handle.createReadStream({ start, end: size - 1, autoClose: false });
        const lines = createInterface({ input: stream, crlfDelay: Infinity });
        const items = new Map(history.items.map(item => [item.id, item]));
        try {
          for await (const line of lines) {
            if (!line.trim()) continue;
            const record = JSON.parse(line);
            appendRecord(items, record, sessionId);
            if (!record.isSidechain && record.sessionId === sessionId && ['assistant', 'user'].includes(record.type)) history.sessionId = sessionId;
          }
        } finally { lines.close(); stream.destroy(); }
        history.items = [...items.values()];
      }
    } finally { await handle.close(); }
  }
  delete history.tui;
  await saveHistory(file, history);
  return history;
}

async function prepareTerminal(file, cwd) {
  const history = await syncHistory(file, cwd);
  const sessionId = history.sessionId || history.reservedSessionId || randomUUID();
  const handle = await transcript(cwd, sessionId);
  let offset = 0;
  try { if (handle) offset = (await handle.stat()).size; }
  finally { await handle?.close(); }
  if (!history.sessionId) history.reservedSessionId = sessionId;
  history.tui = { sessionId, offset };
  await saveHistory(file, history);
  return { sessionId, resume: !!history.sessionId };
}

module.exports = { historyPath, prepareTerminal, syncHistory, saveHistory };
