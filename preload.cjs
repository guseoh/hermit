const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('workbench', {

  agentProbe: (...args) => ipcRenderer.invoke('agent-probe', ...args),
  claudeHelp: () => ipcRenderer.invoke('claude-help'),
  agentBrowse: () => ipcRenderer.invoke('agent-browse'),
  chatConnect: task => ipcRenderer.invoke('chat-connect', task),
  chatSend: (...args) => ipcRenderer.invoke('chat-send', ...args),
  chatStop: id => ipcRenderer.invoke('chat-stop', id),
  chatApprove: (...args) => ipcRenderer.invoke('chat-approve', ...args),
  chatClose: id => ipcRenderer.invoke('chat-close', id),
  onChat: callback => ipcRenderer.on('chat-event', (_, id, event) => callback(id, event)),
  gitStatus: cwd => ipcRenderer.invoke('git-status', cwd),
  gitDiff: (...args) => ipcRenderer.invoke('git-diff', ...args),

  home: () => ipcRenderer.invoke('home'),
  folder: () => ipcRenderer.invoke('folder'),
  spawn: (...args) => ipcRenderer.invoke('spawn', ...args),
  input: (id, value) => ipcRenderer.invoke('input', id, value),
  resize: (...args) => ipcRenderer.invoke('resize', ...args),
  close: id => ipcRenderer.invoke('close-terminal', id),
  copy: text => ipcRenderer.invoke('copy', text),
  save: text => ipcRenderer.invoke('save', text),
  onData: callback => ipcRenderer.on('terminal-data', (_, id, value) => callback(id, value)),
  onExit: callback => ipcRenderer.on('terminal-exit', (_, id, value) => callback(id, value))
});
