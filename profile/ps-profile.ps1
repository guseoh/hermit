# PowerShell 편의성 프로필 v0.1
# Windows PowerShell 5.1과 PowerShell 7 양쪽에서 동작하도록 작성했다.
# 실제 $PROFILE에는 이 파일을 dot-source 하는 한 줄만 둔다 (install.ps1이 처리).
# 개인 설정은 같은 폴더의 profile.local.ps1에 두면 마지막에 불러온다 (git에 넣지 않는다).

$script:ProfileTimer = [Diagnostics.Stopwatch]::StartNew()
$ProfileRoot = $PSScriptRoot

# ─────────────────────────────────────────────────────────────
# 0. 비대화형 실행이면 아무것도 하지 않는다 (스크립트·에이전트 실행 속도 보호)
# ─────────────────────────────────────────────────────────────
$cmdArgs = [Environment]::GetCommandLineArgs()
$hasNoExit = [bool]($cmdArgs -match '^-NoE')
$isNonInteractive = (-not [Environment]::UserInteractive) -or
    [bool]($cmdArgs -match '^-NonI') -or
    ((-not $hasNoExit) -and [bool]($cmdArgs -match '^-(Command|c|EncodedCommand|ec|File|f)$'))
if ($isNonInteractive -and $env:PROFILE_FORCE -ne '1') { return }
Remove-Variable cmdArgs, hasNoExit, isNonInteractive -ErrorAction SilentlyContinue

function global:Test-Cmd([string]$Name) { [bool](Get-Command $Name -ErrorAction SilentlyContinue) }

# ─────────────────────────────────────────────────────────────
# 1. 인코딩: 한글 출력과 외부 도구(git, node, claude 등) 파이프를 UTF-8로 통일
# ─────────────────────────────────────────────────────────────
try {
    [Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
    $OutputEncoding = [Text.UTF8Encoding]::new($false)
} catch { }
if ($PSVersionTable.PSVersion.Major -lt 6) {
    # 5.1에서 Out-File / > 기본값이 UTF-16이라 다른 도구와 섞이면 깨진다
    $PSDefaultParameterValues['Out-File:Encoding']    = 'utf8'
    $PSDefaultParameterValues['Set-Content:Encoding'] = 'utf8'
    $PSDefaultParameterValues['Add-Content:Encoding'] = 'utf8'
}

# ─────────────────────────────────────────────────────────────
# 2. PSReadLine: 예측, 목록형 제안, 히스토리 검색
# ─────────────────────────────────────────────────────────────
$psrl = Get-Module PSReadLine -ListAvailable | Sort-Object Version -Descending | Select-Object -First 1
if ($psrl) {
    Import-Module PSReadLine -RequiredVersion $psrl.Version -ErrorAction SilentlyContinue

    $opts = @{
        EditMode                      = 'Windows'
        HistoryNoDuplicates           = $true
        HistorySearchCursorMovesToEnd = $true
        MaximumHistoryCount           = 20000
        BellStyle                     = 'None'
    }
    Set-PSReadLineOption @opts

    # 예측은 VT를 지원하지 않거나 출력이 리디렉션된 호스트에서 오류가 나므로 따로 시도한다
    if ($psrl.Version -ge [version]'2.1.0') {
        try {
            Set-PSReadLineOption -PredictionSource 'History' -ErrorAction Stop
            if ($psrl.Version -ge [version]'2.2.0') { Set-PSReadLineOption -PredictionViewStyle 'ListView' -ErrorAction Stop }
        } catch { }
    }

    # 비밀번호·토큰이 들어간 줄은 히스토리 파일에 남기지 않는다
    Set-PSReadLineOption -AddToHistoryHandler {
        param([string]$line)
        if ($line -match '(?i)(password|passwd|secret|token|apikey|api_key|bearer)\s*[:=]') { return $false }
        return $true
    }

    # ↑/↓ : 입력한 앞부분으로 시작하는 히스토리만 탐색
    Set-PSReadLineKeyHandler -Key UpArrow   -Function HistorySearchBackward
    Set-PSReadLineKeyHandler -Key DownArrow -Function HistorySearchForward
    # Tab : 후보 메뉴 / Shift+Tab : 역방향
    Set-PSReadLineKeyHandler -Key Tab       -Function MenuComplete
    Set-PSReadLineKeyHandler -Key Shift+Tab -Function TabCompletePrevious
    # → 또는 End : 회색 예측 전체 수락 / Ctrl+→ : 한 단어만 수락
    Set-PSReadLineKeyHandler -Key RightArrow      -Function ForwardChar
    Set-PSReadLineKeyHandler -Key Ctrl+RightArrow -Function ForwardWord
    # F2 : 인라인 ↔ 목록 예측 보기 전환
    if ($psrl.Version -ge [version]'2.2.0') {
        Set-PSReadLineKeyHandler -Key F2 -Function SwitchPredictionView
    }
    # Ctrl+d : 빈 줄에서 셸 종료 (bash 습관)
    Set-PSReadLineKeyHandler -Key Ctrl+d -Function DeleteCharOrExit
    # Alt+w : 현재 줄을 실행하지 않고 히스토리에만 저장
    Set-PSReadLineKeyHandler -Key Alt+w -BriefDescription SaveInHistory -ScriptBlock {
        $line = $null; $cursor = $null
        [Microsoft.PowerShell.PSConsoleReadLine]::GetBufferState([ref]$line, [ref]$cursor)
        [Microsoft.PowerShell.PSConsoleReadLine]::AddToHistory($line)
        [Microsoft.PowerShell.PSConsoleReadLine]::RevertLine()
    }
}

# ─────────────────────────────────────────────────────────────
# 3. fzf + PSFzf : Ctrl+r 퍼지 히스토리, Ctrl+t 퍼지 파일 선택
#    (설치돼 있지 않으면 PSReadLine 기본 Ctrl+r 역검색이 그대로 동작)
# ─────────────────────────────────────────────────────────────
if ((Test-Cmd fzf) -and (Get-Module PSFzf -ListAvailable)) {
    Import-Module PSFzf -ErrorAction SilentlyContinue
    if (Get-Command Set-PsFzfOption -ErrorAction SilentlyContinue) {
        Set-PsFzfOption -PSReadlineChordProvider 'Ctrl+t' -PSReadlineChordReverseHistory 'Ctrl+r'
        # Alt+c : 하위 폴더를 퍼지 검색해서 이동
        Set-PsFzfOption -PSReadlineChordSetLocation 'Alt+c'
    }
    $env:FZF_DEFAULT_OPTS = '--height 40% --layout=reverse --border'
    if (Test-Cmd fd) { $env:FZF_DEFAULT_COMMAND = 'fd --type f --hidden --exclude .git --exclude node_modules' }
}

# ─────────────────────────────────────────────────────────────
# 4. zoxide : `z 폴더일부` 로 자주 가는 폴더 이동, `zi` 는 fzf로 선택
# ─────────────────────────────────────────────────────────────
if (Test-Cmd zoxide) {
    Invoke-Expression (& { (zoxide init powershell | Out-String) })
}

# ─────────────────────────────────────────────────────────────
# 5. 프롬프트
#    기본값: 기존 $PROFILE이 이미 프롬프트를 바꿨으면(예: oh-my-posh 사용자 테마) 그대로 둔다.
#    바뀐 게 없으면 Starship > oh-my-posh > 내장 프롬프트 순서로 고른다.
#    $env:PROFILE_PROMPT = 'keep' | 'starship' | 'ohmyposh' | 'builtin' 으로 강제 가능
#    oh-my-posh 테마는 $env:PROFILE_POSH_CONFIG 로 지정 (없으면 oh-my-posh 기본 테마)
# ─────────────────────────────────────────────────────────────
$promptChoice = $env:PROFILE_PROMPT
if (-not $promptChoice) {
    $currentPrompt = "$((Get-Item function:prompt -ErrorAction SilentlyContinue).ScriptBlock)"
    $isDefaultPrompt = $currentPrompt -match 'PS \$\(\$executionContext\.SessionState\.Path\.CurrentLocation\)'
    $promptChoice = if (-not $isDefaultPrompt) { 'keep' }
                    elseif (Test-Cmd starship) { 'starship' }
                    elseif (Test-Cmd oh-my-posh) { 'ohmyposh' }
                    else { 'builtin' }
    Remove-Variable currentPrompt, isDefaultPrompt
}
switch ($promptChoice) {
    'starship' {
        $cfg = Join-Path $ProfileRoot 'starship.toml'
        if (-not $env:STARSHIP_CONFIG -and (Test-Path $cfg)) { $env:STARSHIP_CONFIG = $cfg }
        Invoke-Expression (& starship init powershell --print-full-init | Out-String)
    }
    'ohmyposh' {
        if ($env:PROFILE_POSH_CONFIG -and (Test-Path $env:PROFILE_POSH_CONFIG)) {
            oh-my-posh init pwsh --config $env:PROFILE_POSH_CONFIG | Invoke-Expression
        } else { oh-my-posh init pwsh | Invoke-Expression }
    }
    'keep' { }
    default {
        function global:prompt {
            $ok   = $?
            $path = $ExecutionContext.SessionState.Path.CurrentLocation.Path.Replace($HOME, '~')
            $branch = $null
            if (Test-Cmd git) { $branch = git branch --show-current 2>$null }
            $esc = [char]27
            $out = "$esc[36m$path$esc[0m"
            if ($branch) { $out += " $esc[35m($branch)$esc[0m" }
            $mark = if ($ok) { "$esc[32m❯$esc[0m" } else { "$esc[31m❯$esc[0m" }
            "$out`n$mark "
        }
    }
}

# ─────────────────────────────────────────────────────────────
# 6. 아이콘 (선택) : Nerd Font가 있을 때 ls 결과에 파일 아이콘 표시
#    느린 편이라 $env:PROFILE_ICONS = '1' 일 때만 불러온다
# ─────────────────────────────────────────────────────────────
if ($env:PROFILE_ICONS -eq '1' -and (Get-Module Terminal-Icons -ListAvailable)) {
    Import-Module Terminal-Icons -ErrorAction SilentlyContinue
}

# 기존 $PROFILE에 같은 이름의 함수·alias가 있으면 그쪽을 살린다 (아래 11번 직전에 복원)
$preExistingFunctions = @{}
Get-ChildItem function: | ForEach-Object { $preExistingFunctions[$_.Name] = $_.ScriptBlock }

# ─────────────────────────────────────────────────────────────
# 7. 탐색·파일 함수
# ─────────────────────────────────────────────────────────────
function global:..   { Set-Location .. }
function global:...  { Set-Location ..\.. }
function global:.... { Set-Location ..\..\.. }
function global:ll   { Get-ChildItem @args | Format-Table Mode, LastWriteTime, Length, Name -AutoSize }
function global:la   { Get-ChildItem -Force @args }
function global:mkcd([Parameter(Mandatory)][string]$Path) {
    New-Item -ItemType Directory -Path $Path -Force | Out-Null; Set-Location $Path
}
function global:touch([Parameter(Mandatory)][string]$Path) {
    if (Test-Path $Path) { (Get-Item $Path).LastWriteTime = Get-Date }
    else { New-Item -ItemType File -Path $Path | Out-Null }
}
function global:which([Parameter(Mandatory)][string]$Name) {
    Get-Command $Name -All | Select-Object CommandType, Name, Source, Version
}
function global:open([string]$Path = '.') { Invoke-Item $Path }   # 탐색기/기본 앱으로 열기
function global:size([string]$Path = '.') {
    $bytes = (Get-ChildItem $Path -Recurse -File -Force -ErrorAction SilentlyContinue | Measure-Object Length -Sum).Sum
    '{0:N1} MB' -f ($bytes / 1MB)
}
# grep 대용: rg가 있으면 rg, 없으면 Select-String
if (-not (Test-Cmd rg)) {
    function global:grep { param([Parameter(Mandatory)]$Pattern, $Path = '.'); Get-ChildItem $Path -Recurse -File | Select-String $Pattern }
}

# ─────────────────────────────────────────────────────────────
# 8. 프로필 관리
# ─────────────────────────────────────────────────────────────
# 프로필 다시 불러오기는 함수로 감싸면 스코프 문제가 생겨서 직접 실행한다:  . $PROFILE
function global:ep {
    $editor = if (Test-Cmd code) { 'code' } else { 'notepad' }
    & $editor (Join-Path $ProfileRoot 'ps-profile.ps1')
}
function global:Measure-Profile {
    # 프로필 로딩 시간 5회 평균 (ms)
    $exe = (Get-Process -Id $PID).Path
    $env:PROFILE_FORCE = '1'
    $times = 1..5 | ForEach-Object { (Measure-Command { & $exe -NoLogo -Command 'exit' }).TotalMilliseconds }
    $base  = 1..5 | ForEach-Object { (Measure-Command { & $exe -NoLogo -NoProfile -Command 'exit' }).TotalMilliseconds }
    Remove-Item Env:PROFILE_FORCE -ErrorAction SilentlyContinue
    '프로필 포함 {0:N0}ms / 미포함 {1:N0}ms' -f ($times | Measure-Object -Average).Average, ($base | Measure-Object -Average).Average
}

# ─────────────────────────────────────────────────────────────
# 9. Git 단축 함수 (PowerShell 기본 alias gl/gp/gc/gm과 겹치지 않는 이름만 사용)
# ─────────────────────────────────────────────────────────────
if (Test-Cmd git) {
    function global:g     { git @args }
    function global:gst   { git status -sb @args }
    function global:gd    { git diff @args }
    function global:gds   { git diff --staged @args }
    function global:gco   { git checkout @args }
    function global:gsw   { git switch @args }
    function global:gaa   { git add -A @args }
    function global:gcmsg { git commit -m @args }
    function global:glog  { git log --oneline --graph --decorate -n 30 @args }
    function global:gpl   { git pull --ff-only @args }
    function global:gpsh  { git push @args }
    function global:groot { Set-Location (git rev-parse --show-toplevel) }

    # 에이전트 작업용 worktree : 형제 폴더 <repo>-<branch> 에 만들고 이동
    function global:gwt([Parameter(Mandatory)][string]$Branch, [string]$Base = 'HEAD') {
        $root = git rev-parse --show-toplevel 2>$null
        if (-not $root) { Write-Warning 'git 저장소 안이 아니다.'; return }
        $safe = $Branch -replace '[\\/:*?"<>|]', '-'
        $dir  = Join-Path (Split-Path $root -Parent) ("{0}-{1}" -f (Split-Path $root -Leaf), $safe)
        $exists = git -C $root branch --list $Branch
        if ($exists) { git -C $root worktree add $dir $Branch }
        else         { git -C $root worktree add -b $Branch $dir $Base }
        if ($LASTEXITCODE -eq 0) { Set-Location $dir }
    }
    function global:gwtl { git worktree list @args }
}

# ─────────────────────────────────────────────────────────────
# 10. 개발 유틸
# ─────────────────────────────────────────────────────────────
function global:ports {
    # 열려 있는 LISTEN 포트와 프로세스
    Get-NetTCPConnection -State Listen -ErrorAction SilentlyContinue |
        Sort-Object LocalPort -Unique |
        Select-Object LocalAddress, LocalPort,
            @{ n = 'PID';     e = { $_.OwningProcess } },
            @{ n = 'Process'; e = { (Get-Process -Id $_.OwningProcess -ErrorAction SilentlyContinue).ProcessName } }
}
function global:killport([Parameter(Mandatory)][int]$Port) {
    $procIds = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue |
               Select-Object -ExpandProperty OwningProcess -Unique
    if (-not $procIds) { Write-Host "포트 $Port 를 쓰는 프로세스가 없다."; return }
    foreach ($p in $procIds) {
        $proc = Get-Process -Id $p -ErrorAction SilentlyContinue
        Stop-Process -Id $p -Confirm
        if ($proc) { Write-Host "종료 요청: $($proc.ProcessName) (PID $p)" }
    }
}
function global:envs([string]$Filter = '') {
    Get-ChildItem env: | Where-Object Name -like "*$Filter*" | Sort-Object Name
}
function global:path { $env:Path -split ';' | Where-Object { $_ } }

# 에이전트 CLI 단축 (설치돼 있을 때만)
if (Test-Cmd claude) { function global:cc { claude @args } }
if (Test-Cmd codex)  { function global:cx { codex @args } }

foreach ($name in @($preExistingFunctions.Keys)) {
    $now = Get-Item "function:$name" -ErrorAction SilentlyContinue
    if ($now -and "$($now.ScriptBlock)" -ne "$($preExistingFunctions[$name])") {
        Set-Item "function:global:$name" $preExistingFunctions[$name]
    }
}

# ─────────────────────────────────────────────────────────────
# 11. 개인 설정 (선택)
# ─────────────────────────────────────────────────────────────
$local = Join-Path $ProfileRoot 'profile.local.ps1'
if (Test-Path $local) { . $local }

$script:ProfileTimer.Stop()
if ($script:ProfileTimer.ElapsedMilliseconds -gt 800) {
    Write-Host ("프로필 로딩 {0}ms (느리면 Measure-Profile 로 확인)" -f $script:ProfileTimer.ElapsedMilliseconds) -ForegroundColor DarkYellow
}
foreach ($v in 'psrl', 'opts', 'promptChoice', 'cfg', 'local', 'preExistingFunctions', 'name', 'now') {
    if (Test-Path "variable:$v") { Remove-Variable $v }
}
