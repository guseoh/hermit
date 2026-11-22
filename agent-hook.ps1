# 에이전트 TUI(Claude Code hooks, Codex notify)가 부르는 스크립트. 앱이 연 이름 있는 파이프로 상태를 한 줄 보낸다.
# 앱이 띄운 에이전트 터미널에만 WORKBENCH_HOOK_* 환경 변수가 있다. 없으면 아무것도 하지 않는다.
# 에이전트 쪽 진행을 막지 않도록 출력 없이 빨리 끝내고, 실패해도 0으로 끝낸다.
param([string]$Event, [Parameter(ValueFromRemainingArguments = $true)]$Rest)
$pipe = $env:WORKBENCH_HOOK_PIPE
if (-not $pipe -or -not $Event) { exit 0 }
try {
    $client = New-Object System.IO.Pipes.NamedPipeClientStream('.', $pipe, [System.IO.Pipes.PipeDirection]::Out)
    $client.Connect(1500)
    $writer = New-Object System.IO.StreamWriter($client)
    $writer.WriteLine((@{ token = $env:WORKBENCH_HOOK_TOKEN; pane = $env:WORKBENCH_PANE; event = $Event } | ConvertTo-Json -Compress))
    $writer.Flush()
    $client.Dispose()
} catch { }
exit 0
