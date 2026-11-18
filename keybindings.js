// One table for every app-level shortcut. The listener runs in the capture phase on window, so it
// sees keys before xterm's textarea does, and each binding states when a focused terminal keeps the
// key instead (the same idea as t3 code's `when: "!terminalFocus"` and Orca's terminal/app context).
//
// when:
//   'always'            - fires even while typing in a terminal
//   '!agentTerminal'    - a terminal running the Claude/Codex CLI keeps the key (they use it)
//   '!terminalFocus'    - any focused terminal keeps the key (shell editing keys such as Ctrl+L, Ctrl+K)
//   'shellTerminal'     - only while a plain PowerShell terminal (no CLI agent) has focus
const keybindings = [
  { keys: 'Ctrl+T', when: '!agentTerminal', run: () => newTabFromShortcut() },
  { keys: 'Ctrl+Shift+P', when: 'always', run: () => openPalette() },
  { keys: 'F1', when: 'always', run: () => openPalette() },
  { keys: 'Ctrl+K', when: '!terminalFocus', run: () => openPalette('tasks') },
  { keys: 'Ctrl+Alt+A', when: 'always', run: () => toggleTerminalPanel() },
  { keys: 'Ctrl+`', when: 'always', run: () => toggleTerminalPanel() },
  { keys: 'Ctrl+Shift+`', when: 'always', run: () => newDockTerminal() },
  { keys: 'Ctrl+B', when: '!terminalFocus', run: () => byId('toggle-workspaces-panel').click() },
  { keys: 'Ctrl+L', when: '!terminalFocus', run: () => byId('toggle-results-panel').click() },
  { keys: 'Ctrl+Shift+M', when: '!terminalFocus', run: () => openChatPicker('chat-model') },
  { keys: 'Ctrl+Shift+E', when: '!terminalFocus', run: () => openChatPicker('chat-effort') },
  { keys: 'Ctrl+ArrowUp', when: 'shellTerminal', run: () => scrollToCommand(-1) },
  { keys: 'Ctrl+ArrowDown', when: 'shellTerminal', run: () => scrollToCommand(1) }
];

const keyCodes = { '`': 'Backquote', F1: 'F1' };
function parseKeys(keys) {
  const parts = keys.split('+');
  const key = parts.pop();
  return {
    ctrl: parts.includes('Ctrl'), shift: parts.includes('Shift'), alt: parts.includes('Alt'),
    code: keyCodes[key] ?? (key.length === 1 ? 'Key' + key.toUpperCase() : key)
  };
}
for (const binding of keybindings) binding.match = parseKeys(binding.keys);

function openChatPicker(id) {
  const task = typeof actionTask === 'function' ? actionTask() : null;
  const get = task && splitChats.has(task.id) ? splitChats.get(task.id).getChatPart : byId;
  const select = get(id);
  if (!select || select.hidden || select.disabled) return;
  select.focus();
  try { select.showPicker(); } catch { /* focus alone still lets arrow keys change it */ }
}

window.addEventListener('keydown', event => {
  // Never steal keys mid-composition (Korean IME), and leave modal dialogs alone.
  if (event.isComposing || event.keyCode === 229 || event.metaKey || document.querySelector('dialog[open]')) return;
  const binding = keybindings.find(({ match }) => match.code === event.code && match.ctrl === event.ctrlKey &&
    match.shift === event.shiftKey && match.alt === event.altKey);
  if (!binding) return;
  const pane = panes.get(document.activeElement?.closest?.('.terminal-pane')?.dataset.paneId);
  if (pane && binding.when === '!terminalFocus') return;
  const agentTerminal = pane && (pane.launcher !== 'shell' || pane.agentState === 'started');
  if (agentTerminal && binding.when === '!agentTerminal') return;
  if (binding.when === 'shellTerminal' && (!pane || agentTerminal)) return;
  event.preventDefault();
  event.stopPropagation();
  Promise.resolve().then(binding.run).catch(report);
}, true);
