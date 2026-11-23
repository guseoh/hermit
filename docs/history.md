# 작업 기록 (PR #1~#5)

2026-11-23 저장소를 새로 만들면서(커밋 작성자 이메일 정리) GitHub PR 페이지가 사라져, 제목·설명·댓글을 여기에 옮겨 둔다. 커밋 해시는 기록을 다시 쓰기 전 값이다.

## #1 UI/UX 개선: 하단 터미널, 명령 팔레트, 명령 결과 블록, diff·채팅 개선

- 브랜치: `ui-layout-pass-1` → `main` · 병합: 11/18/2026 05:34:30

#### 요약

실제 앱 실행 검토에서 나온 UI/UX 문제를 단계별로 고쳤습니다. 커밋은 단계별로 나뉘어 있습니다.

| 커밋 | 내용 |
|---|---|
| 8be9dcf | 터미널을 하단 전체 폭 패널로, 좌우 패널 크기 조절, 중복 헤더 제거, Ctrl+Shift+P 명령 팔레트, 파란 강조색, 리소스 관리자를 고유 메모리(Private Working Set) 기준으로 |
| e1e3307 | 새 PowerShell을 하단 패널로 통일, 작업을 바꾸면 그 폴더의 터미널만 표시, Ctrl+` / Ctrl+Shift+` |
| 8493423 | 명령 결과에 성공/실패·실행 시간·출력 미리보기, 터미널 프롬프트 줄의 상태 칩 |
| 6478aac | 변경사항을 종류별로 묶고 +/− 줄 수 표시, diff 줄 번호 정리, diff를 편집 영역 탭으로 열기 |
| e47b7eb | 채팅 도구 단계에 입력과 결과 표시, 토큰 수에서 캐시 재사용분 분리, Codex 한도 상태 구분 |
| 112b4d5 | Claude 자동 연결·Codex는 첫 요청 때 연결, 로그인 종료 후 재확인, 지정 실행 파일을 채팅 연결에도 사용 |
| 91fa571 | 글자 크기 4단계·헤더 높이 토큰, 탭 폭 축소, SVG 아이콘 |

#### 검증

- 단계마다 Electron 앱을 별도 프로필로 실행해 Playwright(CDP)로 조작하고 DOM 상태와 화면을 확인했습니다. 콘솔 오류는 없었습니다.
- 확인하지 못한 것: `claude auth login` 종료 후 자동 재확인(실제 재로그인이 필요). 자동 테스트는 아직 없습니다.

🤖 Generated with [Claude Code](https://claude.com/claude-code)


## #2 Orca식 레이아웃: 플로팅 터미널, 작업별 탭, 단축키 레지스트리, 상태 기호, 명령 칩 메뉴

- 브랜치: `orca-layout` → `main` · 병합: 11/18/2026 09:12:15

#### 요약

Orca·t3 code·VS Code 터미널 분석(공개 저장소)을 바탕으로 화면 구조를 정리했습니다. 커밋은 단계별로 나뉘어 있습니다.

| 커밋 | 내용 |
|---|---|
| eaf7aaf | Ctrl+T 편집 영역 탭 복원, 빠른 작업 버튼 복원, 모델·추론 수준 선택, codex.exe 숨김 직접 실행 |
| e10d257 | 단축키를 keybindings.js 한 표로 통합(터미널 포커스·CLI 에이전트 터미널에서 넘김 규칙, 한글 조합 중 보호). Ctrl+K·Ctrl+B·Ctrl+L·Ctrl+Shift+M/E 추가 |
| 41b2185 | 하단 터미널 패널을 플로팅 터미널로 대체(Ctrl+Alt+A·오른쪽 아래 버튼), 셸이 없을 때 빈 화면에 빠른 작업 |
| 5fed273 | 작업마다 편집 영역 탭과 분할을 소유, 작업 전환 시 교체, 작업 없이 연 탭은 공유 |
| 83423c1 | 작업 탭·사이드바에 작업 중 ● / 대기 ? / 완료 ✓ / 실패 ✕ 상태 기호 |
| 53a5599 | 명령 칩 메뉴(출력 복사, 명령과 출력 복사, 다시 실행, 복사 대상 선택), Ctrl+↑/↓ 명령 이동 |

#### 검증

- 단계마다 Electron 앱을 별도 프로필로 실행해 Playwright(CDP)로 조작하고 DOM 상태와 화면을 확인했습니다. 마지막 전체 흐름 검사 12개 항목 모두 통과, 콘솔 오류 없음.
- 확인하지 못한 것: Codex CLI 최대화 모드, 로그인 터미널 흐름(실제 재로그인 필요), 자동 테스트(레포에 없음).

🤖 Generated with [Claude Code](https://claude.com/claude-code)


## #3 작업별 worktree, 커밋·PR 흐름, 알림·PR 피드백 전달, diff 리뷰 노트 추가

- 브랜치: `claude/powershell-profile` → `main` · 병합: 11/22/2026 12:09:16

#### 요약

Agent Workbench를 에이전트 IDE에 가깝게 키우는 작업 중 1번, 기타, 2번, 3번, 4번 단계입니다. 별도로 PowerShell 5.1 편의성 프로필(`profile/`)도 함께 들어 있습니다.

##### 1. 작업별 브랜치·worktree
- 새 작업 창의 "새 브랜치와 worktree에서 작업"(기본 켜짐): `agent/<작업>-<id 8자>` 브랜치와 `<저장소>.worktrees\<작업>` 폴더를 만들고 그 폴더에서 에이전트를 연결합니다.
- 작업을 닫을 때 "탭만 닫기" 또는 "worktree 정리 후 종료"를 고릅니다. 정리하면 worktree를 지우고, 브랜치는 기준 브랜치에 실제로 병합된 경우에만(`merge-base --is-ancestor`로 확인) 지웁니다. 푸시만 했거나 병합되지 않은 브랜치는 남깁니다. 커밋하지 않은 변경이 있으면 한 번 더 확인합니다.
- 경로와 브랜치 이름은 메인 프로세스가 정하고, 삭제는 Workbench가 만든 형식이면서 `git worktree list`에 있는 것만 허용합니다(`changes.cjs`의 `createTaskWorktree`, `removeWorktree`).
- Codex 세션을 닫을 때 그 세션의 프로세스 트리만 `taskkill /T`로 끝냅니다. npm 설치본은 node가 `codex.exe`를 다시 띄우는데, 이전에는 `codex.exe`가 남아 작업 폴더를 잠그고 있었습니다.

##### 기타
- 앱이 스크립트를 실행하는 PowerShell 3곳(터미널, 에이전트 확인, Codex 서버)에 `-ExecutionPolicy Bypass`를 붙였습니다. 해당 프로세스에만 적용되고, 그룹 정책이 정한 정책이 우선합니다.
- `prompt.ps1` 등에서 콘솔 출력 인코딩을 UTF-8로 맞췄습니다(코드 페이지 949 → 65001). 입력 인코딩은 PSReadLine 한글 입력 문제를 피하려고 그대로 둡니다. 스크립트는 UTF-8 BOM·CRLF를 유지합니다.
- 앱 상태(작업 목록, 탭, 레이아웃, 메모 등)를 `%APPDATA%\powershell-workbench\workbench-state.json`에 저장하고 시작할 때 복원합니다(`state.cjs`). 처음 실행하면 기존 localStorage 내용을 옮깁니다.
- `npm test`(node:test): worktree, 스테이지·커밋·푸시, 상태 파일, `.ps1` BOM·5.1 구문, PR 피드백, 리뷰 노트 검사.

##### 2. 스테이지·AI 커밋 메시지·푸시·PR
- 변경 패널에 파일별 스테이지/취소와 커밋 상자(AI 메시지, 커밋, 푸시, PR 만들기)를 추가했습니다.
- AI 메시지는 작업의 에이전트가 staged diff만 보고 씁니다. 도구는 쓰지 못하게 했습니다(Claude Code `--tools ""`, Codex `exec --sandbox read-only --ephemeral`). diff는 필요한 길이(6만 자)까지만 스트림으로 읽어, 큰 변경에서도 실패하지 않습니다.
- 푸시는 upstream이 없으면 `origin`에 만들고, `main`/`master`에 바로 푸시할 때는 확인합니다. 인증 창 때문에 멈추지 않게 `GIT_TERMINAL_PROMPT=0`을 씁니다.
- PR은 `gh pr create`로 만들고, 이미 열린 PR이 있으면 그 PR을 엽니다. 기준 브랜치는 `gh repo view <저장소>`로 읽은 기본 브랜치로 채웁니다.

##### 3. Windows 알림과 PR 피드백 전달
- 창을 보고 있지 않을 때 작업 완료·실패·중단, 승인 요청, Claude 로그인 만료, PR 피드백을 Windows 알림으로 알립니다. 알림을 누르면 창이 앞으로 오고 해당 작업이 열립니다(Electron `Notification`, `setAppUserModelId`).
- 열린 작업의 현재 브랜치 PR을 90초마다 확인해 새로 실패한 체크(GitHub Actions 실패 로그 끝부분 포함), 새 리뷰, 코드 리뷰 코멘트, 댓글을 대화 입력창 위 배너로 보여 줍니다.
  - 본 항목은 작업별로 기억해 다시 알리지 않습니다. 같은 체크라도 새 커밋에서 다시 실패하면 다시 알립니다.
  - 처음 보는 PR은 기존 리뷰·코멘트를 본 것으로 치고, 지금 실패 중인 체크만 알림 없이 보여 줍니다.
- **"에이전트에게 보내기"를 눌러야만** 피드백을 한국어 요청으로 묶어 보냅니다. 자동 전송은 하지 않습니다. 리뷰 봇의 배지·HTML 장식은 걷어 냅니다.
- 채팅 설정에 "Windows 알림"과 "PR 피드백 확인" 스위치를 추가했습니다(기본 켜짐).
- 관련 파일: `pr-feedback.js`(새 항목 판별·메시지), `changes.cjs`의 `pullRequestFeedback`, `failedCheckLog`.

##### 4. diff 줄별 리뷰 노트 일괄 전송
- diff에서 줄을 하나 이상 골라 **노트 추가**로 리뷰 노트를 답니다. 노트는 해당 줄 아래 카드로 보이고 고치거나 지울 수 있습니다. 코드가 바뀌어 위치가 달라지면 카드에 표시합니다.
- 여러 파일의 노트를 저장소별로 모아 변경 패널의 **리뷰 노트 N개** 목록에 보여 주고, 항목을 누르면 그 파일·노트로 이동합니다.
- **모두 보내기**는 위치·코드 발췌(diff)·노트를 파일과 줄 순서로 묶어 작업의 에이전트에게 한 번에 보냅니다. 성공하면 노트를 비우고, 실패하면 남깁니다.
- 노트는 상태 파일에도 저장되어 재시작 후에도 남습니다(저장소마다 200개, 노트당 4,000자).
- 관련 파일: `review-notes.js`.

##### 리뷰 지적 수정(Codex 리뷰 P2 4건)
- `gh repo view`에 `--repo` 대신 저장소를 위치 인자로 넘겨, 기본 브랜치가 `main`이 아닌 저장소에서도 PR 기준 브랜치를 제대로 고릅니다.
- 이름을 바꾼 뒤 고친 파일을 스테이지할 때 옛 경로를 `git add`에 넘기지 않습니다(스테이지 취소는 두 경로 모두 되돌림).
- 작업 브랜치 삭제 전에 기준 브랜치 병합 여부를 직접 확인합니다. `git branch -d`는 upstream에 푸시만 된 브랜치도 지웠습니다.
- AI 커밋 메시지용 diff를 버퍼 한도(2MB) 전에 끊어 읽어, 큰 staged 변경에서도 실패하지 않습니다.
- 지적마다 재현 테스트를 넣었고, 고치기 전 코드에서 실패하는 것을 확인했습니다.

##### 보안
기존 방식(IPC 발신자 검사, 입력 검증, sandbox, CSP)은 그대로입니다. 새 IPC도 모두 발신자 검사를 거칩니다. 스테이지할 파일 이름은 현재 `git status`에 있는 항목과 맞을 때만 git에 넘기고, 모든 명령은 셸 없이 인자 배열로 실행합니다. 알림 요청은 메인 프로세스에서 제목·본문·작업 ID 형식을 검사하고, 체크 로그는 같은 저장소의 GitHub Actions 주소일 때만 읽습니다.

#### 확인한 것
- `npm test` 36개 통과.
- 실제 앱(Electron)에서:
  - worktree 작업 생성 → 터미널 열기 → 정리, 변경이 남은 경우의 경고
  - 상태 파일 생성·재시작 후 복원, 터미널의 한글 git 출력과 파이프
  - 스테이지 → AI 메시지(Codex) → 커밋 → 로컬 origin 푸시
  - Windows 알림 표시와 잘못된 알림 거부
  - 이 PR의 실제 리뷰 코멘트로 PR 피드백 배너 표시 → 보내기 메시지가 입력창에 채워짐
  - 두 파일에 리뷰 노트 달기·고치기·목록 이동 → 모두 보내기 메시지가 입력창에 채워짐
- `main` 병합(b1a4923) 뒤에도 위 흐름을 다시 확인했습니다.

#### 확인하지 못한 것
- 실제 GitHub에 PR을 만드는 동작(입력 검사와 PR 창만 확인).
- 앱 안에서 Claude Code로 AI 메시지 만들기(단독 실행으로만 확인).
- PR 피드백과 리뷰 노트를 실제로 에이전트에게 보내는 마지막 단계(보내면 에이전트가 저장소를 고치기 시작하므로, 입력창에 메시지가 채워지는 것까지만 확인).
- 실패한 GitHub Actions 체크의 로그 가져오기(이 저장소에 CI가 없어 실제 실패 체크로는 시험하지 못함).

#### 리뷰어 참고
- 이 브랜치는 PR #1, #2가 병합되기 전 `main`에서 나와, `main`을 병합(b1a4923)해 충돌을 정리했습니다. `main`의 그룹별 변경 목록·작업 탭 상태 기호에 이 PR의 스테이지 버튼과 worktree 정리 흐름을 붙였습니다.
- 앱에서 worktree를 정리할 때, 방금 닫은 터미널 프로세스가 늦게 끝나면 폴더 삭제를 다시 시도하느라 10초 넘게 걸릴 수 있습니다.
- `profile/`은 앱과 별개인 PowerShell 프로필입니다. 설치 스크립트는 기존 `$PROFILE`을 백업하고 표시된 블록만 추가합니다.

🤖 Generated with [Claude Code](https://claude.com/claude-code)


> **댓글** (11/22/2026 11:21:13)
>
> <!-- codex-pull-request-review-summary -->
> <!-- codex-review-state:v1 {"code_review":{"commit_sha":"0cfb40db898508755bc8d8dfba30738d1210ae25","has_any_findings":true,"has_unresolved_findings":true,"status":"completed"},"security_review":{"commit_sha":null,"has_any_findings":null,"has_unresolved_findings":null,"status":null}} -->
> 
> <details>
> <summary><strong>Codex Review Summary</strong>: ✅ Completed</summary>
> 
> This comment shows the latest Codex review activity on this pull request.
> 
> | Review | Status | Commit | Review trigger |
> | --- | --- | --- | --- |
> | 📝 **Code Review** | ✅ **Completed** <relative-time datetime="2026-11-22T11:25:26.070620Z">2026-11-22T11:25:26.070620Z</relative-time> | `0cfb40d` | PR opened |
> 
> 
> 
> <details> <summary>ℹ️ About Codex in GitHub</summary>
> <br/>
> 
> [Your team has set up Codex to review pull requests in this repo](https://chatgpt.com/codex/cloud/settings/general). Reviews are triggered when you
> - Open a pull request for review
> - Mark a draft as ready
> - Comment "@codex review" or "@codex security review".
> 
> Codex reacts with 👀 while any review is running, comments if it has suggestions, and reacts with 👍 once all reviews finish with no findings.
> 
> </details>
> 
> </details>

> **댓글** (11/22/2026 11:25:23)
>
> <!-- codex-review-receipt:v1 -->
> 
> 
> ### 💡 Codex Review
> 
> Here are some automated review suggestions for this pull request.
> 
> **Reviewed commit:** `0cfb40db89`
>     
> 
> <details> <summary>ℹ️ About Codex in GitHub</summary>
> <br/>
> 
> [Your team has set up Codex to review pull requests in this repo](https://chatgpt.com/codex/cloud/settings/general). Reviews are triggered when you
> - Open a pull request for review
> - Mark a draft as ready
> - Comment "@codex review".
> 
> If Codex has suggestions, it will comment; otherwise it will react with 👍.
> 
> 
> 
> 
> Codex can also answer questions or update the PR. Try commenting "@codex address that feedback".
>             
> </details>

> **리뷰 댓글** `changes.cjs`
> **<sub><sub>![P2 Badge](https://img.shields.io/badge/P2-yellow?style=flat)</sub></sub>  Pass the repository positionally to `gh repo view`**
> 
> For repositories whose default branch is not `main`, PR preparation always selects the wrong base because the shared `gh()` wrapper appends `--repo`, which `gh repo view` does not support. Checked the installed CLI: its help specifies `gh repo view [<repository>] [flags]`, and this invocation returns `unknown flag: --repo`. The catch silently retains `main`, so the dialog gets an incorrect base and the commit-summary lookup can also return nothing. Pass the repository as a positional argument for this subcommand instead of using the wrapper's `--repo` behavior.
> 
> Useful? React with 👍 / 👎.
> 
> <!-- codex-code-review-finding:v1 -->

> **리뷰 댓글** `changes.cjs`
> **<sub><sub>![P2 Badge](https://img.shields.io/badge/P2-yellow?style=flat)</sub></sub>  Exclude the old rename path when staging subsequent edits**
> 
> After a staged rename followed by further edits—for example, `git mv a b` and then modifying `b`—the unstaged status entry contains `name: 'b'` and `from: 'a'`. Adding both paths makes the file's stage button execute `git add -A -- b a`, but `a` no longer exists in either the index or working tree. Reproduced this through `changes.stage()`: Git rejects the operation with `fatal: pathspec 'a' did not match any files`, leaving the edits unstaged. The checked `git add -h` usage takes explicit `<pathspec>...`; staging should use the destination for this case, while retaining both paths where needed for unstaging the rename.
> 
> Useful? React with 👍 / 👎.
> 
> <!-- codex-code-review-finding:v1 -->

> **리뷰 댓글** `changes.cjs`
> **<sub><sub>![P2 Badge](https://img.shields.io/badge/P2-yellow?style=flat)</sub></sub>  Check integration into the base before deleting a task branch**
> 
> When a task branch has been pushed but not merged into its base, cleanup still deletes the local branch, contrary to `requestCloseTask()`'s assurance that unmerged branches are retained. Although the checked `git branch -h` describes `-d` as “delete fully merged branch,” a configured upstream changes which branch Git checks: a local reproduction warns that the branch is merged to `refs/remotes/origin/feature` “but not yet merged to HEAD” and deletes it anyway. Reproduced through `createTaskWorktree()` → commit → `push()` → `removeWorktree()`: the task commit was absent from `main`, yet cleanup returned `branchDeleted: true` and removed the branch. Explicitly verify ancestry against the intended base before invoking branch deletion; being fully pushed should not qualify as being integrated.
> 
> Useful? React with 👍 / 👎.
> 
> <!-- codex-code-review-finding:v1 -->

> **리뷰 댓글** `changes.cjs`
> **<sub><sub>![P2 Badge](https://img.shields.io/badge/P2-yellow?style=flat)</sub></sub>  Bound diff capture before applying the AI context limit**
> 
> When the staged text diff exceeds 2 MiB, AI commit-message generation fails instead of using the truncated context. The shared `git()` helper runs `execFile` with `maxBuffer: 2 * 1024 * 1024`, so this awaited call rejects before the subsequent 60,000-character truncation can execute. Reproduced by staging a roughly 3.4 MB generated text file and calling `commitContext()`, which throws `ERR_CHILD_PROCESS_STDIO_MAXBUFFER`. Capture the diff with bounded streaming or otherwise handle oversized output so large staged changes still produce the intended truncated context.
> 
> Useful? React with 👍 / 👎.
> 
> <!-- codex-code-review-finding:v1 -->

## #4 에이전트 IDE 재설계: 디자인·자동 연결·작업 화면·채팅·체크포인트·배포

- 브랜치: `claude/stage0-quick-fixes` → `main` · 병합: 11/22/2026 17:14:44

#### 요약

`docs/design/agent-ide-redesign.md`의 재설계를 0~6단계로 구현했습니다. 디자인과 사용성 개선, Orca·Claude 앱처럼 에이전트가 자동으로 연결되는 구조, 터미널과 채팅이 함께 있는 작업 화면, 추가 기능과 최적화, 설치 파일과 자동 업데이트입니다.

##### 0단계 · 바로 고칠 것
- 새 탭 메뉴에 Codex·Claude가 보이지 않던 문제: "채팅 UI 사용" 설정(기본 꺼짐)을 없애고 에이전트 항목을 맨 위에 항상 표시. 기본 모드를 채팅으로, 터미널 모드는 빈 PowerShell이 아니라 에이전트 TUI를 바로 실행.
- CLI 확인: 프로필 없이 먼저 확인하고 결과를 `agents.json`에 저장(약 9초 → 2초, 이후 즉시).
- 변경 패널: 3.5초 폴링 대신 파일 감시(`git-watch.cjs`). worktree는 바깥 git 폴더도 감시.

##### 1단계 · 디자인 바탕
- 디자인 토큰 v2(파란 강조색, 바탕 5단계, 모서리·간격, 한글 글꼴), 글자 기호 대신 SVG 아이콘, 버튼 단계(primary·danger·ghost), 입력·대화상자·스크롤바 통일.
- 하단 상태 글자를 토스트로. 결과가 같다고 확인된 중복 스타일 11개 정리(요소 579개의 계산된 스타일 비교로 확인).

##### 2단계 · 자동 연결
- **공용 Codex 서버**(`codex-host.cjs`): 앱 전체가 app-server 하나를 쓰고 이벤트는 `threadId`로 작업에 나눔. 사용량 조회도 이 서버로.
- **유지되는 Claude 세션**(`claude.cjs`): 메시지마다 프로세스를 띄우지 않고 세션 동안 유지(모델 변경 시 재시작, 15분 유휴 시 내림).
- 작업을 열면 바로 연결, 끊기면 1·2·5·15초 간격 재연결. worktree 정리 전에는 그 폴더의 Codex thread를 내리려고 서버를 다시 시작(다른 작업은 자동 재연결).

##### 3단계 · 작업 화면
- 작업 머리줄에 브랜치·PR 칩과 `[채팅 | 터미널]` 전환(두 에이전트 공통, `claude --resume`/`codex resume`). TUI가 끝나면 채팅으로 자동 복귀.
- 새 탭 메뉴 검색칸에 쓴 글을 첫 요청으로 새 작업 시작.

##### 4단계 · 채팅
- Enter로 보내기(Shift+Enter 줄바꿈), 작업 중 보낸 메시지 대기열, `@파일` 자동완성(`git ls-files`), `/명령`, 긴 대화는 최근 150개만 그리고 "더 보기", 도구·승인 카드 상태 색.

##### 5단계 · 기능
- **턴 체크포인트**(`checkpoints.cjs`): 요청 직전 작업 폴더를 git 객체로 저장(사용자 인덱스·브랜치는 그대로), "이 요청 전으로 되돌리기"와 "되돌리기 취소".
- **첫 실행 안내**: Codex·Claude·GitHub CLI 상태와 바로 할 일.
- **터미널 에이전트 상태 감지**(`agent-hooks.cjs`, `agent-hook.ps1`): Claude `--settings` hooks, Codex `-c notify`로 일회용 토큰 파이프에 상태 전달. 작업 폴더의 설정 파일은 건드리지 않음.
- **두 에이전트 결과 비교**: 같은 요청을 Codex·Claude에 각자 worktree로 보내고 결과를 나란히 비교, 하나를 남기면 다른 쪽 정리.

##### 6단계 · 배포
- 트레이 상주(창을 닫아도 계속 실행, 설정으로 끄기)와 단일 실행.
- electron-builder 설치 파일(`npm run dist`), electron-updater 자동 업데이트(GitHub Releases, 설치본에서만).
- 설치본은 asar로 묶지 않음(node-pty 출력 워커와 PowerShell이 asar 안 파일을 못 읽음). node-pty는 함께 든 빌드 사용(`npmRebuild: false`).
- `productName`을 넣어도 기존 데이터가 보이도록 앱 데이터 폴더를 `%APPDATA%\powershell-workbench`로 고정.

##### 보안
기존 방식(IPC 발신자 검사, 입력 검증, sandbox, CSP)은 그대로입니다. 새 IPC도 모두 발신자 검사를 거칩니다. 체크포인트 참조·worktree 경로·hook 메시지(토큰·터미널 ID)는 메인 프로세스에서 다시 검사합니다.

#### 확인한 것
- `npm test` 65개 통과(가짜 Codex 서버, 실제 PowerShell hook, 임시 Git 저장소 포함).
- 실제 앱에서: 메뉴·터미널 실행, 파일 감시 반영(0.6초), 공용 Codex 서버(작업 2개가 프로세스 1개, 각자 폴더로 답), Claude 지속 세션, 서버 강제 종료 후 자동 재연결, worktree 정리, 채팅↔터미널 전환과 자동 복귀, 대기열·자동완성·긴 대화, 체크포인트 되돌리기와 취소, 첫 실행 안내, Claude·Codex TUI 상태 감지, 결과 비교.
- 설치본(`npm run pack`)에서 기존 데이터·CLI 확인·터미널(UTF-8) 동작, 트레이로 숨기·단일 실행, `npm run dist`로 설치 파일 생성.

#### 확인하지 못한 것
- 설치 파일을 실제로 설치하는 것과 자동 업데이트(아직 릴리스 없음).
- 코드 서명(인증서 없음, 방법은 `docs/release.md`).
- Codex 쪽 채팅↔터미널 전환(시험 중 Codex 사용량 한도에 걸려 메시지를 아꼈음). Codex TUI의 "⚠ 1 warning" 내용.
- 이미지 붙여넣기와 "이 세션 동안 허용" 승인은 넣지 않음(설계 4단계 일부).

#### 리뷰어 참고
- 단계마다 `workspace.js` 같은 파일을 함께 고쳐서 구현은 커밋 하나에 담았습니다. 커밋 메시지에 단계별로 적었습니다.
- `package-lock.json` 변경이 큰 것은 electron-builder·electron-updater를 더했기 때문입니다.

🤖 Generated with [Claude Code](https://claude.com/claude-code)


> **댓글** (11/22/2026 16:46:54)
>
> <!-- codex-pull-request-review-summary -->
> <!-- codex-review-state:v1 {"code_review":{"commit_sha":"4791ff41f6fad79dd519dac5cfafe16ff5159b5e","has_any_findings":true,"has_unresolved_findings":true,"status":"completed"},"security_review":{"commit_sha":null,"has_any_findings":null,"has_unresolved_findings":null,"status":null}} -->
> 
> <details>
> <summary><strong>Codex Review Summary</strong>: ✅ Completed</summary>
> 
> This comment shows the latest Codex review activity on this pull request.
> 
> | Review | Status | Commit | Review trigger |
> | --- | --- | --- | --- |
> | 📝 **Code Review** | ✅ **Completed** <relative-time datetime="2026-11-22T16:50:13.784202Z">2026-11-22T16:50:13.784202Z</relative-time> | `4791ff4` | PR opened |
> 
> 
> 
> <details> <summary>ℹ️ About Codex in GitHub</summary>
> <br/>
> 
> [Your team has set up Codex to review pull requests in this repo](https://chatgpt.com/codex/cloud/settings/general). Reviews are triggered when you
> - Open a pull request for review
> - Mark a draft as ready
> - Comment "@codex review" or "@codex security review".
> 
> Codex reacts with 👀 while any review is running, comments if it has suggestions, and reacts with 👍 once all reviews finish with no findings.
> 
> </details>
> 
> </details>

> **댓글** (11/22/2026 16:50:11)
>
> <!-- codex-review-receipt:v1 -->
> 
> 
> ### 💡 Codex Review
> 
> Here are some automated review suggestions for this pull request.
> 
> **Reviewed commit:** `4791ff41f6`
>     
> 
> <details> <summary>ℹ️ About Codex in GitHub</summary>
> <br/>
> 
> [Your team has set up Codex to review pull requests in this repo](https://chatgpt.com/codex/cloud/settings/general). Reviews are triggered when you
> - Open a pull request for review
> - Mark a draft as ready
> - Comment "@codex review".
> 
> If Codex has suggestions, it will comment; otherwise it will react with 👍.
> 
> 
> 
> 
> Codex can also answer questions or update the PR. Try commenting "@codex address that feedback".
>             
> </details>

> **리뷰 댓글** `codex-host.cjs`
> **<sub><sub>![P1 Badge](https://img.shields.io/badge/P1-orange?style=flat)</sub></sub>  Preserve other threads' approvals in the shared Codex session**
> 
> When two Codex tasks run concurrently, completing a turn in task B invalidates any pending approval in task A. The shared `CodexSession.receive()` still calls `this.approvals.clear()` on every `turn/completed`, while this resolver delegates to that session's approval map. Task A's channel retains and displays its approval, but accepting or declining it now throws `Approval is no longer pending`, leaving its turn blocked. Scope approval cleanup to the completed thread rather than clearing the shared session's entire map.
> 
> Useful? React with 👍 / 👎.
> 
> <!-- codex-code-review-finding:v1 -->

> **리뷰 댓글** `workspace.js`
> **<sub><sub>![P2 Badge](https://img.shields.io/badge/P2-yellow?style=flat)</sub></sub>  Import Claude's terminal conversation when returning to chat**
> 
> After continuing a Claude task in the terminal and returning to chat, this reconnect cannot load the terminal conversation: the Claude branch of `chat-connect` reads only Workbench's `claude-history/<task-id>.json`, which is written exclusively by `ClaudeSession.finishTurn()`, not by the TUI. Consequently, terminal messages disappear from the displayed history. If the terminal was opened before the first chat request, that file has no session ID either, so reconnecting creates a new UUID and subsequent chat requests lose the terminal conversation's context entirely. Import the CLI session history and retain its session ID before rebuilding the chat state.
> 
> Useful? React with 👍 / 👎.
> 
> <!-- codex-code-review-finding:v1 -->

> **리뷰 댓글** `workspace.js`
> **<sub><sub>![P2 Badge](https://img.shields.io/badge/P2-yellow?style=flat)</sub></sub>  Prevent checkpoint undo from running during an active turn**
> 
> If the user sends another request after restoring a checkpoint and then clicks the toast's undo action, this callback restores files while the agent is actively editing them. Unlike `restoreTurn()`, it neither checks `state.busy` nor sets `state.restoring`, and the send paths also ignore `state.restoring`. The restore can therefore overwrite or delete the new turn's changes, or the agent can read a partially restored working tree. Apply the same busy guard to undo and serialize both restore operations against sending new turns.
> 
> Useful? React with 👍 / 👎.
> 
> <!-- codex-code-review-finding:v1 -->

## #5 Orca 디자인 체계와 Hermit으로 이름 변경

- 브랜치: `claude/orca-design-system` → `main` · 병합: 11/23/2026 06:00:31

#### 요약

앱 디자인을 Orca(MIT)의 디자인 체계로 다시 만들고, 이름을 **Hermit**으로 바꿨습니다. main의 새 기능(`e741200`: worktree 파일 탐색, 결과 비교 공통 검증, 리뷰 추적)을 병합해 두었습니다.

##### 디자인
- 디자인 토큰을 Orca 값으로 교체: 단색(색은 상태에만), 사이드바보다 밝은 작업 영역, 모서리·그림자 3단계
- Geist + Pretendard 글꼴, Lucide 아이콘(`icons.js`), Claude·Codex 브랜드 마크
- `styles.css`를 토큰 → 기본 → 부품 → 화면 순서로 다시 작성, 버튼 6변형·입력·스위치·메뉴·토스트·대화상자 통일
- 스타일 규칙 문서 `docs/STYLEGUIDE.md`, 분석 문서 `docs/design/orca-analysis.md`

##### 화면 구성
- 왼쪽 아이콘 줄 제거. Orca식 사이드바: 검색·바로가기, 프로젝트(글자 타일), 2줄 작업 카드(에이전트·이름·경과 시간 / 브랜치·상태), 하단 설정·명령 팔레트
- 오른쪽 검토 패널을 아이콘 탭으로, 커밋 영역을 메시지 칸 안 AI 버튼 + 상태에 따라 바뀌는 분할 버튼(커밋 → 브랜치 게시/푸시 → PR)으로
- 상태줄 사용량을 남은 양과 초기화까지 시간으로 표시
- 채팅: 오른쪽 말풍선, 답변 머리의 에이전트 이름, 빈 화면 안내, 입력창 아래 에이전트·폴더·브랜치 줄, 선택 상자 폭 맞춤

##### 기능
- 새 Markdown 노트는 떠 있는 창에서 열고 최대화하면 탭으로. TipTap 3 실시간 서식 편집(`vendor/rich-editor.js`, 처음 열 때만 로드) + 원본 보기
- 플로팅 터미널 최대화는 메인 탭으로 이동, 작업 탭을 끌어 놓거나 오른쪽 클릭으로 대화 분할
- 시작할 때 마지막 작업을 바로 열고, 작업이 있으면 체크 목록 대신 최근 작업 홈
- 앱 메뉴 제거(Ctrl+R은 PowerShell 기록 검색에), 개발 실행 전용 F5 새로 고침·DevTools, 시험용 데이터 폴더(`AGENT_WORKBENCH_PROFILE`, 개발 실행만)

##### 이름·아이콘
- 앱 이름 Hermit, 아이콘은 소라게 껍데기 + 커서(`assets/hermit*.svg` → `npm run build:icon` → `assets/hermit.ico`)
- 저장소 이름 `powershell-workbench` → `hermit`, 자동 업데이트 주소도 변경
- `appId`와 데이터 폴더(`%APPDATA%\powershell-workbench`)는 유지 → 기존 설치본 위에 덮어 설치, 작업·설정 유지

#### 확인한 것
- `npm test` 70개 통과(main 병합분 포함)
- 시험용 데이터로 실제 앱을 띄워 화면 확인: 사이드바·채팅·분할·플로팅 터미널 → 탭·노트(TipTap 입력과 Markdown 저장)·커밋 메뉴·시작 시 작업 복원·홈·체크 목록, Ctrl+R/F5 동작
- 설치본 빌드에 `vendor/`·글꼴 포함, `vendor-src/`·`tauri-bench/`·`output/`·devDependencies 제외

#### 확인하지 못한 것
- 실제 저장소에서 커밋 후 푸시(화면과 메뉴만 확인)
- Hermit 이름으로 만든 설치 파일로 기존 설치본 덮어쓰기
- 비공개 저장소라 자동 업데이트(GitHub Releases)는 토큰 없이는 받을 수 없음 — 별도 결정 필요

🤖 Generated with [Claude Code](https://claude.com/claude-code)


> **댓글** (11/23/2026 06:00:36)
>
> <!-- codex-pull-request-review-summary -->
> <!-- codex-review-state:v1 {"code_review":{"commit_sha":"16bf8247327d8890d65933f7f22f9fcc89af3227","has_any_findings":false,"has_unresolved_findings":false,"status":"completed"},"security_review":{"commit_sha":null,"has_any_findings":null,"has_unresolved_findings":null,"status":null}} -->
> 
> <details>
> <summary><strong>Codex Review Summary</strong>: ✅ Completed</summary>
> 
> This comment shows the latest Codex review activity on this pull request.
> 
> | Review | Status | Commit | Review trigger |
> | --- | --- | --- | --- |
> | 📝 **Code Review** | ✅ **Completed** <relative-time datetime="2026-11-23T06:01:25.565374Z">2026-11-23T06:01:25.565374Z</relative-time> | `16bf824` | PR opened |
> 
> 
> 
> <details> <summary>ℹ️ About Codex in GitHub</summary>
> <br/>
> 
> [Your team has set up Codex to review pull requests in this repo](https://chatgpt.com/codex/cloud/settings/general). Reviews are triggered when you
> - Open a pull request for review
> - Mark a draft as ready
> - Comment "@codex review" or "@codex security review".
> 
> Codex reacts with 👀 while any review is running, comments if it has suggestions, and reacts with 👍 once all reviews finish with no findings.
> 
> </details>
> 
> </details>
