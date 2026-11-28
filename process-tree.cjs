const { execFile } = require('node:child_process');
const path = require('node:path');

function killProcessTree(child) {
  if (!child?.pid || child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
  if (process.platform !== 'win32') {
    child.kill();
    return Promise.resolve();
  }
  const taskkill = path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'taskkill.exe');
  return new Promise(resolve => execFile(taskkill, ['/PID', String(child.pid), '/T', '/F'],
    { windowsHide: true, timeout: 5000 }, () => {
      if (child.exitCode === null && child.signalCode === null) child.kill();
      resolve();
    }));
}

module.exports = { killProcessTree };
