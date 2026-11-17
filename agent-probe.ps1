param([ValidateSet('codex','claude')][string]$Tool, [string]$Executable)
$command = if ($Executable) { Get-Command -Name $Executable -CommandType Application,ExternalScript -ErrorAction SilentlyContinue | Select-Object -First 1 } else { Get-Command -Name $Tool -CommandType Application,ExternalScript -ErrorAction SilentlyContinue | Select-Object -First 1 }
if (!$command -and $Tool -eq 'claude' -and !$Executable) {
    $candidate = Join-Path $env:USERPROFILE '.local\bin\claude.exe'
    if (Test-Path -LiteralPath $candidate -PathType Leaf) { $command = Get-Command $candidate }
}
if (!$command) { Write-Output 'WORKBENCH_AGENT:null'; exit }
$global:LASTEXITCODE = 0
$output = @(& $command --version 2>$null)
$version = $output | Where-Object { $_ -match '\d+\.\d+' } | Select-Object -First 1
if ($LASTEXITCODE -ne 0 -or !$version) { Write-Output 'WORKBENCH_AGENT:null'; exit }
$result = @{ file = $command.Source; version = [string]$version } | ConvertTo-Json -Compress
Write-Output ('WORKBENCH_AGENT:' + $result)
