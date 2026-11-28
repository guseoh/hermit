const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const exec = promisify(execFile);

// Electron reports PROCESS_MEMORY_COUNTERS_EX.PrivateUsage in KiB.
// Win32_Process.PrivatePageCount reports private committed memory in bytes.
const query = [
  "$ErrorActionPreference = 'Stop';",
  'ConvertTo-Json -Compress -InputObject @(Get-CimInstance Win32_Process',
  '  -Property ProcessId,ParentProcessId,PrivatePageCount -Filter "ProcessId <> 0" |',
  '  ForEach-Object { @{ id = $_.ProcessId; parent = $_.ParentProcessId; bytes = $_.PrivatePageCount } })'
].join(' ');

async function snapshot(shell, metrics, sessions) {
  const appProcesses = metrics.length;
  const appBytes = metrics.every(entry => Number.isFinite(entry.memory?.privateBytes))
    ? metrics.reduce((sum, entry) => sum + entry.memory.privateBytes * 1024, 0) : null;
  const roots = [...sessions].map(([id, session]) => ({ id, pid: session.pid }));
  if (!roots.length) return { appBytes, appProcesses, terminals: [] };

  const args = ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', query];
  let processes;
  try {
    const { stdout } = await exec(shell, args, { windowsHide: true, timeout: 15000, maxBuffer: 2 * 1024 * 1024 });
    processes = JSON.parse(stdout);
  } catch {
    return { appBytes, appProcesses, terminals: roots.map(({ id }) => ({ id, bytes: null, count: 0 })) };
  }
  const byPid = new Map(processes.map(entry => [entry.id, entry]));
  const children = new Map();
  for (const entry of processes) {
    if (!children.has(entry.parent)) children.set(entry.parent, []);
    children.get(entry.parent).push(entry.id);
  }

  const terminals = roots.map(({ id, pid: root }) => {
    if (!byPid.has(root)) return { id, bytes: null, count: 0 };
    const seen = new Set();
    const queue = [root];
    let bytes = 0;
    while (queue.length) {
      const pid = queue.pop();
      if (seen.has(pid)) continue;
      seen.add(pid);
      bytes += byPid.get(pid).bytes ?? NaN;
      queue.push(...(children.get(pid) ?? []));
    }
    return { id, bytes: Number.isFinite(bytes) ? bytes : null, count: seen.size };
  });
  return { appBytes, appProcesses, terminals };
}

module.exports = snapshot;
