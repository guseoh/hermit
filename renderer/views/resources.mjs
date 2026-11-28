async function refreshResources() {
  const summary = byId('resource-summary');
  const refresh = byId('refresh-resources');
  if (refresh.disabled) return;
  refresh.disabled = true;
  summary.textContent = '메모리 확인 중…';
  try {
    const snapshot = await api.resources();
    const rows = byId('resource-rows');
    rows.replaceChildren();
    const memory = bytes => Number.isFinite(bytes) ? (bytes / 1048576).toFixed(1) + ' MiB' : '—';
    const add = (name, bytes) => {
      const row = rows.insertRow();
      row.insertCell().textContent = name;
      row.insertCell().textContent = memory(bytes);
    };
    add('Workbench · 프로세스 ' + snapshot.appProcesses + '개', snapshot.appBytes);
    let total = snapshot.appBytes ?? 0;
    let partial = snapshot.appBytes === null;
    for (const terminal of snapshot.terminals) {
      const pane = panes.get(terminal.id);
      if (!pane) continue;
      if (terminal.bytes === null) partial = true;
      add(pane.tab.name + (pane.tab.panes.length > 1 ? ' · 패널 ' + (pane.tab.panes.indexOf(pane) + 1) : '')
        + (terminal.count ? ' · 프로세스 ' + terminal.count + '개' : ''), terminal.bytes);
      total += terminal.bytes ?? 0;
    }
    add(partial ? '확인된 합계' : '합계', total);
    rows.lastElementChild.className = 'resource-total';
    summary.textContent = '터미널 ' + snapshot.terminals.length + '개 · 전용 커밋 메모리 기준';
  } catch {
    byId('resource-rows').replaceChildren();
    summary.textContent = '메모리 정보를 읽지 못했습니다.';
  } finally { refresh.disabled = false; }
}
byId('refresh-resources').onclick = refreshResources;
byId('resource-menu').addEventListener('toggle', event => {
  if (event.newState === 'open') refreshResources();
});
