param([ValidateSet('codex', 'claude')][string]$WorkbenchStartup, [string]$WorkbenchExecutable)

$global:WorkbenchOriginalPrompt = $Function:prompt
$global:WorkbenchLastHistoryId = $null

function global:prompt {
    $rendered = & $global:WorkbenchOriginalPrompt
    $historyEntry = Get-History -Count 1
    $marker = "$([char]27)]777;workbench-prompt"
    if ($null -ne $global:WorkbenchLastHistoryId -and $historyEntry -and
        $historyEntry.Id -ne $global:WorkbenchLastHistoryId) {
        $bytes = [Text.Encoding]::UTF8.GetBytes($historyEntry.CommandLine)
        $marker += ';' + [Convert]::ToBase64String($bytes)
    }
    $global:WorkbenchLastHistoryId = if ($historyEntry) { $historyEntry.Id } else { 0 }
    $marker + [char]7 + ($rendered -join '')
}


if ($WorkbenchStartup) {
    $launcher = if ($WorkbenchExecutable) { Get-Command -Name $WorkbenchExecutable -ErrorAction SilentlyContinue } else { Get-Command -Name $WorkbenchStartup -ErrorAction SilentlyContinue }
    if ($launcher) {
        Write-Host "$([char]27)]777;workbench-agent;started$([char]7)" -NoNewline
        & $launcher
        Write-Host "$([char]27)]777;workbench-agent;returned$([char]7)" -NoNewline
    } else {
        Write-Host "$([char]27)]777;workbench-agent;missing$([char]7)" -NoNewline
        Write-Warning "$WorkbenchStartup was not found in this PowerShell session."
    }
}
