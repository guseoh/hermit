#requires -Version 5.1
<#
.SYNOPSIS
    PowerShell 편의성 프로필 설치 스크립트 v0.1

.DESCRIPTION
    1) winget으로 CLI 도구 설치: starship(또는 oh-my-posh), zoxide, fzf, fd, ripgrep
    2) PowerShell 모듈 설치: PSReadLine 최신, PSFzf, Terminal-Icons
    3) 실행 정책이 Restricted면 CurrentUser 범위만 RemoteSigned로 변경
    4) $PROFILE 에 이 폴더의 ps-profile.ps1 을 불러오는 블록만 추가 (기존 내용은 유지, .bak 백업)

    Windows PowerShell 5.1 프로필을 기준으로 처리한다. PowerShell 7 프로필도 연결하려면 -IncludePwsh7 을 쓴다.
    먼저 -WhatIf 로 무엇이 바뀌는지 확인할 수 있다.

.EXAMPLE
    .\install.ps1 -WhatIf          # 바뀌는 내용만 미리 보기
    .\install.ps1                  # 기본 설치 (기존 프롬프트 유지)
    .\install.ps1 -Prompt starship # Starship 설치 후 사용
    .\install.ps1 -Prompt ohmyposh # oh-my-posh 사용 (테마는 $env:PROFILE_POSH_CONFIG)
    .\install.ps1 -SkipTools       # winget 도구 설치 건너뛰기
    .\install.ps1 -Uninstall       # $PROFILE 에서 블록만 제거
#>
[CmdletBinding(SupportsShouldProcess)]
param(
    [ValidateSet('keep', 'starship', 'ohmyposh', 'none')]
    [string]$Prompt = 'keep',
    [switch]$SkipTools,
    [switch]$SkipModules,
    [switch]$IncludeNerdFont,
    [switch]$IncludePwsh7,
    [switch]$Uninstall
)

$ErrorActionPreference = 'Stop'
$root        = $PSScriptRoot
$profileFile = Join-Path $root 'ps-profile.ps1'
$beginMark   = '# >>> powershell-profile >>>'
$endMark     = '# <<< powershell-profile <<<'
$utf8Bom     = New-Object Text.UTF8Encoding $true

function Step($msg) { Write-Host "`n== $msg" -ForegroundColor Cyan }
function Info($msg) { Write-Host "   $msg" -ForegroundColor DarkGray }

# 대상 프로필 경로 (OneDrive로 문서 폴더가 옮겨진 경우도 MyDocuments가 따라간다)
$docs = [Environment]::GetFolderPath('MyDocuments')
$targets = @(
    @{ Name = 'Windows PowerShell 5.1'; Path = Join-Path $docs 'WindowsPowerShell\Microsoft.PowerShell_profile.ps1'; Exe = 'powershell' }
)
$pwsh = Get-Command pwsh -ErrorAction SilentlyContinue
if ($IncludePwsh7 -and $pwsh) {
    $targets += @{ Name = 'PowerShell 7'; Path = Join-Path $docs 'PowerShell\Microsoft.PowerShell_profile.ps1'; Exe = 'pwsh' }
}

function Remove-ProfileBlock([string]$text) {
    $pattern = '(?s)\r?\n?' + [regex]::Escape($beginMark) + '.*?' + [regex]::Escape($endMark) + '\r?\n?'
    return [regex]::Replace($text, $pattern, "`r`n").TrimEnd()
}

# ── 제거 모드 ───────────────────────────────────────────────
if ($Uninstall) {
    Step '프로필 블록 제거'
    foreach ($t in $targets) {
        if (-not (Test-Path $t.Path)) { continue }
        $text = [IO.File]::ReadAllText($t.Path)
        if ($text -notmatch [regex]::Escape($beginMark)) { Info "$($t.Name): 블록 없음"; continue }
        if ($PSCmdlet.ShouldProcess($t.Path, '블록 제거')) {
            Copy-Item $t.Path "$($t.Path).bak-$(Get-Date -Format yyyyMMdd-HHmmss)"
            [IO.File]::WriteAllText($t.Path, (Remove-ProfileBlock $text) + "`r`n", $utf8Bom)
            Info "$($t.Name): 제거함"
        }
    }
    Write-Host "`n도구와 모듈은 그대로 두었다. 필요하면 winget uninstall / Uninstall-Module 로 지운다." -ForegroundColor Yellow
    return
}

# ── 1. CLI 도구 ─────────────────────────────────────────────
if (-not $SkipTools) {
    Step 'CLI 도구 설치 (winget)'
    if (-not (Get-Command winget -ErrorAction SilentlyContinue)) {
        Write-Warning 'winget이 없다. Microsoft Store에서 "앱 설치 관리자"를 설치한 뒤 다시 실행하거나 -SkipTools 를 쓴다.'
    } else {
        $packages = [ordered]@{
            'ajeetdsouza.zoxide'          = 'zoxide'
            'junegunn.fzf'                = 'fzf'
            'sharkdp.fd'                  = 'fd'
            'BurntSushi.ripgrep.MSVC'     = 'rg'
        }
        if ($Prompt -eq 'starship') { $packages['Starship.Starship']      = 'starship' }
        if ($Prompt -eq 'ohmyposh') { $packages['JanDeDobbeleer.OhMyPosh'] = 'oh-my-posh' }
        if ($IncludeNerdFont)       { $packages['DEVCOM.JetBrainsMonoNerdFont'] = $null }

        foreach ($id in $packages.Keys) {
            $cmd = $packages[$id]
            if ($cmd -and (Get-Command $cmd -ErrorAction SilentlyContinue)) { Info "$id 이미 있음"; continue }
            if ($PSCmdlet.ShouldProcess($id, 'winget install')) {
                winget install --id $id -e --source winget --accept-package-agreements --accept-source-agreements --silent
                if ($LASTEXITCODE -ne 0) { Write-Warning "$id 설치 실패 (exit $LASTEXITCODE). 나머지는 계속한다." }
            }
        }
        # 새로 설치한 도구가 이 창에서도 보이도록 PATH 새로고침
        $env:Path = [Environment]::GetEnvironmentVariable('Path', 'Machine') + ';' +
                    [Environment]::GetEnvironmentVariable('Path', 'User')
    }
}

# ── 2. PowerShell 모듈 ──────────────────────────────────────
if (-not $SkipModules) {
    Step 'PowerShell 모듈 설치 (CurrentUser 범위)'
    $modules = @('PSReadLine', 'PSFzf', 'Terminal-Icons')

    $installScript = {
        param([string[]]$Names)
        [Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12
        if ($PSVersionTable.PSVersion.Major -lt 6) {
            if (-not (Get-PackageProvider -ListAvailable -Name NuGet -ErrorAction SilentlyContinue | Where-Object Version -ge '2.8.5.201')) {
                Install-PackageProvider -Name NuGet -MinimumVersion 2.8.5.201 -Scope CurrentUser -Force | Out-Null
            }
        }
        foreach ($n in $Names) {
            $have   = Get-Module $n -ListAvailable | Sort-Object Version -Descending | Select-Object -First 1
            $online = Find-Module $n -Repository PSGallery -ErrorAction SilentlyContinue
            if ($have -and $online -and $have.Version -ge $online.Version) { Write-Host "   $n $($have.Version) 최신"; continue }
            Install-Module $n -Scope CurrentUser -Force -AllowClobber -SkipPublisherCheck -Repository PSGallery
            Write-Host "   $n 설치/업데이트 완료"
        }
    }

    foreach ($t in $targets) {
        if ($PSCmdlet.ShouldProcess($t.Name, "Install-Module $($modules -join ', ')")) {
            Info "$($t.Name)"
            # 각 셸은 모듈 폴더가 다르므로 해당 셸로 따로 설치한다 (PSReadLine이 로드 중이라 별도 프로세스 사용)
            & $t.Exe -NoLogo -NoProfile -ExecutionPolicy Bypass -Command $installScript -args (,$modules)
            if ($LASTEXITCODE -and $LASTEXITCODE -ne 0) { Write-Warning "$($t.Name) 모듈 설치 중 오류. 위 메시지를 확인한다." }
        }
    }
}

# ── 3. 실행 정책 ────────────────────────────────────────────
Step '실행 정책 확인'
# -ExecutionPolicy Bypass 로 실행하면 Process 범위가 Bypass로 보이므로, Process를 뺀 범위로 판단한다
$scopes = @{}
Get-ExecutionPolicy -List | ForEach-Object { $scopes["$($_.Scope)"] = "$($_.ExecutionPolicy)" }
$gpo = @($scopes['MachinePolicy'], $scopes['UserPolicy']) | Where-Object { $_ -and $_ -ne 'Undefined' } | Select-Object -First 1
$policy = @($scopes['CurrentUser'], $scopes['LocalMachine']) | Where-Object { $_ -and $_ -ne 'Undefined' } | Select-Object -First 1
if (-not $policy) { $policy = 'Restricted' }   # 클라이언트 Windows 기본값
Info "CurrentUser/LocalMachine 기준: $policy$(if ($gpo) { " (그룹 정책: $gpo)" })"
if ($gpo) {
    Info '그룹 정책이 정해져 있어 바꾸지 않는다.'
} elseif ($policy -in 'Restricted', 'AllSigned') {
    if ($PSCmdlet.ShouldProcess('CurrentUser', 'Set-ExecutionPolicy RemoteSigned')) {
        try {
            Set-ExecutionPolicy RemoteSigned -Scope CurrentUser -Force
            Info 'CurrentUser 범위를 RemoteSigned로 변경함'
        } catch { Write-Warning "실행 정책을 바꾸지 못했다 (그룹 정책일 수 있음): $($_.Exception.Message)" }
    }
}
# 인터넷에서 받은 파일 표시(Zone.Identifier)가 있으면 RemoteSigned에서 막히므로 해제
Get-ChildItem $root -Filter *.ps1 | ForEach-Object {
    if ($PSCmdlet.ShouldProcess($_.Name, 'Unblock-File')) { Unblock-File $_.FullName }
}

# ── 4. $PROFILE 연결 ────────────────────────────────────────
Step '$PROFILE 에 불러오기 블록 추가'
$promptLine = switch ($Prompt) {
    'none'     { "`$env:PROFILE_PROMPT = 'builtin'`r`n" }
    'ohmyposh' { "`$env:PROFILE_PROMPT = 'ohmyposh'`r`n" }
    'starship' { "`$env:PROFILE_PROMPT = 'starship'`r`n" }
    default    { '' }
}
$block = "$beginMark`r`n$promptLine. '$($profileFile.Replace("'", "''"))'`r`n$endMark"

foreach ($t in $targets) {
    $dir = Split-Path $t.Path -Parent
    $text = if (Test-Path $t.Path) { [IO.File]::ReadAllText($t.Path) } else { '' }
    $newText = ((Remove-ProfileBlock $text) + "`r`n`r`n" + $block + "`r`n").TrimStart()
    if ($newText -eq $text) { Info "$($t.Name): 변경 없음"; continue }
    if ($PSCmdlet.ShouldProcess($t.Path, '블록 추가/갱신')) {
        if (-not (Test-Path $dir)) { New-Item -ItemType Directory -Path $dir -Force | Out-Null }
        if (Test-Path $t.Path) {
            $bak = "$($t.Path).bak-$(Get-Date -Format yyyyMMdd-HHmmss)"
            Copy-Item $t.Path $bak
            Info "백업: $bak"
        }
        [IO.File]::WriteAllText($t.Path, $newText, $utf8Bom)
        Info "$($t.Name): $($t.Path)"
    }
}

if ($WhatIfPreference) {
    Write-Host "`n미리 보기만 했다. 실제로 적용하려면 -WhatIf 없이 다시 실행한다." -ForegroundColor Yellow
    return
}
Write-Host "`n완료. 새 터미널을 열거나 '. `$PROFILE' 를 실행한다." -ForegroundColor Green
if ($Prompt -eq 'starship' -and -not $IncludeNerdFont) {
    Write-Host '아이콘이 깨져 보이면 -IncludeNerdFont 로 다시 실행하고 터미널 글꼴을 JetBrainsMono Nerd Font로 바꾼다.' -ForegroundColor DarkGray
}
