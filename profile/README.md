# PowerShell 편의성 프로필 v0.1

Windows PowerShell 5.1 기준 프로필이다. PowerShell 7에서도 깨지지 않게 썼지만, 설치는 `-IncludePwsh7`을 줄 때만 7 프로필에 연결한다. Agent Workbench 터미널(5.1, 프로필 로드됨)에서도 그대로 동작한다.

## 파일

| 파일 | 역할 |
|---|---|
| `ps-profile.ps1` | 실제 설정. `$PROFILE`이 이 파일을 dot-source 한다 |
| `install.ps1` | 도구·모듈 설치, 실행 정책, `$PROFILE` 연결 |
| `starship.toml` | Starship 프롬프트 설정 (Nerd Font 없이도 깨지지 않음) |
| `profile.local.ps1` | (선택, 직접 생성) 개인 설정. 마지막에 불러온다 |

## 설치

```powershell
powershell -ExecutionPolicy Bypass -File .\install.ps1 -WhatIf   # 미리 보기
powershell -ExecutionPolicy Bypass -File .\install.ps1           # 설치
```

옵션: `-Prompt keep|starship|ohmyposh|none` (기본 `keep`: 기존 프롬프트 유지), `-IncludePwsh7`, `-SkipTools`, `-SkipModules`, `-IncludeNerdFont`, `-Uninstall`.
기존 `$PROFILE` 내용은 지우지 않고 `# >>> powershell-profile >>>` 블록만 추가한다. 바꾸기 전에 `.bak-날짜` 백업을 만든다.

## 키 바인딩

| 키 | 동작 |
|---|---|
| `↑` / `↓` | 입력한 앞부분으로 시작하는 히스토리만 탐색 |
| `→` / `End` | 회색 예측 전체 수락 |
| `Ctrl+→` | 예측에서 한 단어만 수락 |
| `F2` | 인라인 ↔ 목록 예측 전환 (PSReadLine 2.2+) |
| `Tab` / `Shift+Tab` | 후보 메뉴 |
| `Ctrl+r` | 퍼지 히스토리 검색 (fzf+PSFzf, 없으면 기본 역검색) |
| `Ctrl+t` | 퍼지 파일 선택 후 커서 위치에 삽입 |
| `Alt+c` | 하위 폴더 퍼지 검색 후 이동 |
| `Alt+w` | 현재 줄을 실행하지 않고 히스토리에만 저장 |
| `Ctrl+d` | 빈 줄에서 종료 |

## 명령

- 이동: `..` `...` `....` `z <일부>` `zi` `mkcd <폴더>` `groot`
- 파일: `ll` `la` `touch` `open [경로]` `size [경로]` `which <명령>` `grep`(rg 없을 때)
- Git: `g` `gst` `gd` `gds` `gco` `gsw` `gaa` `gcmsg "메시지"` `glog` `gpl` `gpsh`
- 에이전트용 worktree: `gwt <브랜치> [기준]` → 형제 폴더 `<repo>-<브랜치>`에 만들고 이동, `gwtl` 목록
- 개발: `ports` `killport <포트>` `envs [필터]` `path`
- 에이전트: `cc` (claude), `cx` (codex)
- 프로필: `ep` 편집, `. $PROFILE` 다시 불러오기, `Measure-Profile` 로딩 시간 측정

PowerShell 기본 alias(`gl` `gp` `gc` `gm` 등)는 덮어쓰지 않는다. 기존 `$PROFILE`에 같은 이름의 함수나 alias가 있으면 기존 것이 이긴다.

## 환경 변수 스위치

- `PROFILE_PROMPT` = `keep` | `starship` | `ohmyposh` | `builtin` (비어 있으면 기존 프롬프트가 바뀌어 있을 때 유지)
- `PROFILE_POSH_CONFIG` = oh-my-posh 테마 파일 경로
- `PROFILE_ICONS=1` → Terminal-Icons 로드 (느려서 기본 꺼짐)
- `PROFILE_FORCE=1` → `-Command`/`-File` 같은 비대화형 실행에서도 프로필 적용 (기본은 건너뜀)

## 동작 메모

- 예측 기능은 VT를 지원하지 않거나 출력이 리디렉션된 호스트에서 조용히 꺼진다.
- `-NonInteractive`, 또는 `-NoExit` 없이 `-Command`/`-File`로 실행된 셸은 프로필을 건너뛴다. Codex 같은 에이전트가 PowerShell 명령을 실행할 때 느려지거나 출력이 섞이지 않게 하려는 것이다.
- 5.1에서 `Out-File`, `Set-Content`, `>` 기본 인코딩을 UTF-8로 바꾼다. 콘솔 출력도 UTF-8로 맞춘다.
- 비밀번호·토큰 패턴이 들어간 줄은 히스토리 파일에 남기지 않는다.
- 파일은 UTF-8 BOM으로 저장했다. 5.1은 BOM이 없으면 한글 주석과 문자열을 잘못 읽는다.
