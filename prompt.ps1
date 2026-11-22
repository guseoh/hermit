param([ValidateSet('codex', 'claude')][string]$WorkbenchStartup, [string]$WorkbenchExecutable, [string]$WorkbenchResumeId, [switch]$WorkbenchLogin, [string]$WorkbenchHookSettings)

# Windows PowerShell 5.1의 기본 콘솔 코드 페이지(949 등)를 UTF-8로 바꾼다.
# git·codex 같은 외부 명령의 한글 출력과, 파이프로 외부 명령에 넘기는 한글이 깨지지 않게 한다.
# 입력 인코딩은 5.1 PSReadLine의 한글 입력 문제를 피하려고 그대로 둔다.
$utf8 = New-Object System.Text.UTF8Encoding $false
[Console]::OutputEncoding = $utf8
$global:OutputEncoding = $utf8
Remove-Variable utf8

$global:WorkbenchOriginalPrompt = $Function:prompt
$global:WorkbenchLastHistoryId = $null

function global:prompt {
    # Capturing $? in a parameter default leaves it intact for the user's own prompt,
    # which may colour itself by the last command's success.
    param($WorkbenchSucceeded = $?)
    $rendered = & $global:WorkbenchOriginalPrompt
    $historyEntry = Get-History -Count 1
    $marker = "$([char]27)]777;workbench-prompt"
    if ($null -ne $global:WorkbenchLastHistoryId -and $historyEntry -and
        $historyEntry.Id -ne $global:WorkbenchLastHistoryId) {
        $bytes = [Text.Encoding]::UTF8.GetBytes($historyEntry.CommandLine)
        $marker += ';' + [Convert]::ToBase64String($bytes)
        $elapsed = 0
        try { $elapsed = [int][Math]::Round(($historyEntry.EndExecutionTime - $historyEntry.StartExecutionTime).TotalMilliseconds) } catch {}
        $marker += ';' + $(if ($WorkbenchSucceeded) { '1' } else { '0' }) + ';' + $elapsed
    }
    $global:WorkbenchLastHistoryId = if ($historyEntry) { $historyEntry.Id } else { 0 }
    $marker + [char]7 + ($rendered -join '')
}


if ($WorkbenchStartup) {
    $launcher = if ($WorkbenchExecutable) { Get-Command -Name $WorkbenchExecutable -ErrorAction SilentlyContinue } else { Get-Command -Name $WorkbenchStartup -ErrorAction SilentlyContinue }
    if ($launcher) {
        # 앱이 띄운 에이전트 터미널이면 상태 알림을 붙인다(작업 폴더의 설정 파일은 건드리지 않는다).
        # Claude Code: --settings로 hooks, Codex: -c notify=[...]. 큰따옴표는 5.1이 외부 명령에 넘길 때 깨지므로 TOML 작은따옴표를 쓴다.
        $agentArgs = @()
        if ($env:WORKBENCH_HOOK_PIPE -and -not $WorkbenchLogin) {
            if ($WorkbenchStartup -eq 'claude' -and $WorkbenchHookSettings) { $agentArgs = @('--settings', $WorkbenchHookSettings) }
            if ($WorkbenchStartup -eq 'codex') {
                $hook = (Join-Path $PSScriptRoot 'agent-hook.ps1') -replace '\\', '/'
                # TOML 작은따옴표 문자열은 작은따옴표를 담을 수 없다. 경로에 있으면 상태 알림 없이 실행한다.
                if ($hook -notmatch "'") {
                    $agentArgs = @('-c', "notify=['powershell.exe','-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File','$hook','codex-turn']")
                }
            }
        }
        Write-Host "$([char]27)]777;workbench-agent;started$([char]7)" -NoNewline
        if ($WorkbenchLogin) {
            & $launcher auth login
            exit $LASTEXITCODE
        }
        if ($WorkbenchResumeId) {
            # Codex: codex resume <id>, Claude Code: claude --resume <id>
            if ($WorkbenchStartup -eq 'claude') { & $launcher @agentArgs --resume $WorkbenchResumeId } else { & $launcher @agentArgs resume $WorkbenchResumeId }
            exit $LASTEXITCODE
        }
        & $launcher @agentArgs
        Write-Host "$([char]27)]777;workbench-agent;returned$([char]7)" -NoNewline
    } else {
        Write-Host "$([char]27)]777;workbench-agent;missing$([char]7)" -NoNewline
        Write-Warning "$WorkbenchStartup was not found in this PowerShell session."
        if ($WorkbenchResumeId -or $WorkbenchLogin) { exit 1 }
    }
}
