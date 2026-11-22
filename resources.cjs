const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const exec = promisify(execFile);

// Private working set matches Task Manager's default "Memory" column. Plain working set
// counts shared DLL pages once per process, so summing it overstates the real footprint.
const query = [
  '$private = @{}',
  'Get-CimInstance Win32_PerfRawData_PerfProc_Process -Property IDProcess,WorkingSetPrivate |',
  '  Where-Object IDProcess | ForEach-Object { $private[[int]$_.IDProcess] = [double]$_.WorkingSetPrivate }',
  'ConvertTo-Json -Compress -InputObject @(Get-CimInstance Win32_Process -Property ProcessId,ParentProcessId |',
  '  ForEach-Object { @{ id = [int]$_.ProcessId; parent = [int]$_.ParentProcessId; bytes = $private[[int]$_.ProcessId] } })'
].join('\n');

async function snapshot(shell, appPids, sessions) {
  const args = ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', query];
  const { stdout } = await exec(shell, args, { windowsHide: true, timeout: 6000, maxBuffer: 2 * 1024 * 1024 });
  const processes = JSON.parse(stdout);
  const byPid = new Map(processes.map(entry => [entry.id, entry]));
  const children = new Map();
  for (const entry of processes) {
    if (!children.has(entry.parent)) children.set(entry.parent, []);
    children.get(entry.parent).push(entry.id);
  }
  const bytesOf = pid => Number(byPid.get(pid)?.bytes) || 0;

  const app = { bytes: 0, count: 0 };
  for (const pid of appPids) {
    if (!byPid.has(pid)) continue;
    app.bytes += bytesOf(pid);
    app.count++;
  }

  const terminals = [...sessions].map(([id, session]) => {
    if (!byPid.has(session.pid)) return { id, bytes: null, count: 0 };
    const seen = new Set();
    const queue = [session.pid];
    let bytes = 0;
    while (queue.length) {
      const pid = queue.pop();
      if (seen.has(pid)) continue;
      seen.add(pid);
      bytes += bytesOf(pid);
      queue.push(...(children.get(pid) ?? []));
    }
    return { id, bytes, count: seen.size };
  });
  return { app, terminals };
}

module.exports = snapshot;
