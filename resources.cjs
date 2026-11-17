const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const exec = promisify(execFile);

async function terminalResources(shell, sessions) {
  if (!sessions.size) return [];
  const args = ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command',
    'ConvertTo-Json -Compress -InputObject @(Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,WorkingSetSize)'];
  const { stdout } = await exec(shell, args, { windowsHide: true, timeout: 6000, maxBuffer: 1024 * 1024 });
  const processes = JSON.parse(stdout);
  const byPid = new Map(processes.map(entry => [entry.ProcessId, entry]));
  const children = new Map();
  for (const entry of processes) {
    const parent = entry.ParentProcessId;
    if (!children.has(parent)) children.set(parent, []);
    children.get(parent).push(entry.ProcessId);
  }
  return [...sessions].map(([id, session]) => {
    if (!byPid.has(session.pid)) return { id, bytes: null, count: 0 };
    const seen = new Set();
    const queue = [session.pid];
    let bytes = 0;
    while (queue.length) {
      const pid = queue.pop();
      if (seen.has(pid)) continue;
      seen.add(pid);
      bytes += Number(byPid.get(pid)?.WorkingSetSize) || 0;
      queue.push(...(children.get(pid) ?? []));
    }
    return { id, bytes, count: seen.size };
  });
}

module.exports = terminalResources;
