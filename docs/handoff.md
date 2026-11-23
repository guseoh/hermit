# 인수인계: 에이전트 작업 화면 개선 (0.1.7)

2026-11-23 기준이다. 다음 작업자는 이 문서와 `docs/release.md`(빌드·배포), `docs/design/`(디자인 방향)을 먼저 읽는다.

## 현재 상태

| 항목 | 값 |
|---|---|
| 배포 버전 | **0.1.7** ([릴리스](https://github.com/guseoh/hermit-releases/releases/tag/v0.1.7), Actions 실행 #5 성공) |
| 기준 커밋 | `c2b467a` 에이전트 탭 통합, Claude 모델 표시, 이어받기와 작업 현황 개선 |
| 설치 위치 | `C:\Users\guseo\IdeaProjects\Hermit` (앱 설치 폴더, 소스 아님) |
| 소스 저장소 | `C:\Users\guseo\IdeaProjects\powershell-workbench` → `guseoh/hermit`(비공개) |
| 앱 데이터 | `%APPDATA%\powershell-workbench` (`workbench-state.json`). 경로와 appId는 바꾸지 않는다 |
| 커밋 작성자 | `guseoh <81723538+guseoh@users.noreply.github.com>` (다른 이메일 사용 금지) |

설치본은 0.1.6 → 0.1.7 자동 업데이트를 "앱 종료 시 설치" 경로로 실제 확인했다(다운로드 18:14:07, 설치 완료 18:15:39).

## 제품 목표 (요약 PRD)

Hermit은 Codex와 Claude Code를 한 화면에서 함께 쓰는 Windows용 에이전트 작업대다. Electron을 유지하고, UI·UX는 Orca를 주 참고로 삼는다(단색 위주, 순수 CSS, Geist·Pretendard, Lucide 아이콘).

이번 개선의 원칙은 **반복되는 문제는 겉모양이 아니라 구조를 고친다**였다. 탭이 대표적이다. 채팅은 `selectedTask`와 별도 패널로, 터미널·문서는 분할 영역의 탭 목록으로 관리돼 이동·분할·높이가 따로 놀았다. 이를 하나의 탭 모델로 합쳤다.

### 사용자 요구사항과 반영 결과

| # | 요구 | 반영 | 위치 |
|---|---|---|---|
| 1 | 에이전트 현황판을 칸반으로 | 작업 상태별 열(작업 중·입력/승인 대기·대기·완료·실패/중단)에 카드 배치 | `workspace.js` 현황판(약 200~250행) |
| 2 | 사용량 클릭 시 상세, 에이전트별 구분 | 하단 사용량 클릭 시 상세 대화상자. Codex 계정 한도·초기화 시각, Claude 요청 후 한도, 이 PC에서 관측한 일별 토큰·캐시 누계(누적값 중복 집계 방지) | `recordUsage`, `recordCodexUsage`, `renderUsageTotals`, `updateClaudeUsage` |
| 3 | 터미널 전체 선택·출력 지우기 | 복사 메뉴에 "전체 선택"(스크롤백 포함), "현재 터미널 출력 지우기"(해당 터미널 화면·스크롤백만) 추가. 기존 복사 유지 | `workbench-tools.js` 약 429행 |
| 4 | 글머리 Enter | 채팅 입력: 글머리 줄 Enter → 다음 항목, 빈 항목 Enter → 목록 종료. 노트 편집기도 확인 | `composer.js` `continueList` |
| 5 | 오케스트레이션 검토 | 병렬: 같은 요청을 Codex·Claude에 각자 worktree로 보내고 **에이전트별 역할 지시** 입력 가능, 결과 비교. 순차: 선행 턴이 **성공**하면 다음 에이전트로 자동 이어받기 | `task-compare`, `openCompare`, `runScheduledHandoff` |
| 6·7 | 에이전트 탭 이동·분할, 탭 UI 통일 | 채팅도 터미널·노트·미리보기·diff와 같은 분할 영역 탭 목록에 들어간다. 탭 줄에 놓으면 이동·정렬, 가장자리에 놓으면 분할. 이동해도 세션·초안 유지 | `panels.js`(탭 이동·분할), `workspace.js` `openSplitChat`·`closeSplitChat` |
| 8 | 모델 선택·추론 슬라이더 | Claude 초기화 응답의 실제 모델 목록·버전(예: Opus 5.5)과 모델별 지원 추론 단계를 사용. 추론은 지원 단계만 오가는 슬라이더(방향키 지원), 모델 변경 시 무효 값은 기본값으로 | `claude.cjs` `modelCatalog`·`probeModels`, `workspace.js` `renderModelPicker` |
| 9 | 에이전트 간 이어받기 | Codex ↔ Claude 양방향. 원래 요청·최근 대화 10개·브랜치·변경 파일·검증 기록·작업 메모·미전송 초안을 미리 보여주고, 사용자가 고친 내용을 대상 에이전트의 새 채팅에 넣는다. 실행 중이면 "현재 턴 성공 후 전송"으로 예약 | `openHandoff`, `createHandoffTask` |

### 목록 밖에서 함께 고친 기본 공백

- **작업 대상 일치**: Git 변경 패널·PR·파일 열기가 포커스한 탭의 작업을 따라간다(`reviewCwd()`).
- **재시작 복원**: 채팅·PowerShell 분할·노트·웹 미리보기·diff 탭의 순서, 분할 비율, 활성 탭을 복원한다(`saveChatLayout`/`restoreChatLayout`, 저장 키 `agent-workspace-layout-v2`, 이전 키 `agent-chat-layout-v1`도 읽음).
- **전송 실패 복구**: 초안과 전송 대기열을 저장하고, 실패한 요청을 따로 재시도할 수 있다(`flushQueue`).
- **Claude 연결 상태**: "준비됨"을 세션 객체 생성 시점이 아니라 실제 초기화 성공 뒤에 표시하고, 설치·로그인·초기화·실패를 구분한다.
- **Git 흐름**: 변경 검토 → 커밋 → 푸시 → PR의 진행·실패 단계를 표시한다.
- **프로젝트 제거**: 프로젝트 행의 `×`는 목록에서만 뺀다. 열린 작업·소스·worktree는 그대로이고 실행 취소·같은 폴더 재추가로 복원된다.

## 구조 메모 (다음 작업자가 알아야 할 것)

- **탭 모델**: 분할 영역(`.workspace-panel`) → `workArea`(`tabs`, `tabOrder`, `current`) → 탭. 채팅 탭은 `tab.chatTask`, 셸 탭은 `tab.panes`, 노트는 `tab.icon === 'note'`, 미리보기는 `'web'`, diff는 `tab.diffEntry`로 구분한다. 새 탭 종류를 추가하면 `saveChatLayout`의 `describeTab`과 복원 경로(`workbench-tools.js` `restoreContentTab`)에 같이 넣어야 재시작 후 사라지지 않는다.
- **주 채팅 영역**: `primaryChatPanel`은 항상 존재하는 기본 영역이다. 분할로 떼어낸 채팅은 `splitChats`(작업 ID → 탭)에 있다.
- **이어받기 예약 상태**: `task.handoffSchedule.state`는 `waiting → preparing → submitted`, 실패 시 `paused`(원본 턴 실패) 또는 `draft`(자동 전송 실패, 초안으로 남김)다. 같은 계열 작업은 `handoffGroup`으로 묶는다.
- **Claude 모델**: 고정 별칭 목록을 쓰지 않는다. CLI 초기화 응답에서 받은 값을 그대로 전송해야 `[1m]` 같은 옵션이 보존된다.

## 검증 현황

| 검증 | 결과 |
|---|---|
| `npm test` (70개) | CI 통과. 이 PC에서는 `checkpoints.test.cjs`가 60초 제한에 걸리는 경우가 있다(아래 알려진 문제) |
| `node test/ui-smoke.cjs` | 통과(약 7초). 일회용 프로필로 Electron을 띄워 탭 분할 이동, Git 대상 전환, 글머리 Enter(채팅·노트), 재시작 복원, 사용량 누계, 양방향 이어받기 대상을 확인한다. 에이전트 CLI가 없는 환경에서도 통과하며 릴리스 워크플로에서 빌드 전에 실행된다 |
| 실제 에이전트 | 격리 프로필에서 실제 Claude 모델 조회, Claude → Codex → Claude 이어받기 실응답 확인(이전 세션). CI에는 실제 에이전트 검증이 없다 |
| 자동 업데이트 | 종료 시 설치 경로 확인. 10분 유휴 후 자동 설치는 아직 실제로 확인하지 않았다 |

## 남은 일과 알려진 문제

우선순위 순이다. 사용자 요청으로 0.1.7 이후 개발은 멈춘 상태다.

1. **업데이트 설치가 보이지 않는다.** 종료 시 설치는 `/S`로 조용히 돌아 진행 표시가 없고, 끝나도 앱을 다시 실행하지 않는다(사용자가 "설치가 안 나온다"고 착각함). 종료 시 "업데이트 설치 중" 알림과 설치 후 재실행을 검토한다. 트레이 "업데이트 설치 후 다시 시작"과 토스트 "지금 설치"는 이미 재실행한다(`main.cjs` `installUpdateNow`).
2. **유휴 설치 조건이 PC 전체 기준이다.** `powerMonitor.getSystemIdleTime()`을 쓰므로 PC를 계속 쓰면 자동 설치가 일어나지 않는다. 또 확인 주기가 시작 10초 뒤 + 6시간이라, 앱을 켠 직후 배포된 버전은 최대 6시간 늦게 받는다. 확인 주기 단축이나 "Hermit 창이 오래 비활성" 조건을 검토한다.
3. **`checkpoints.test.cjs` 지연.** 이 PC에서 "작업마다 최근 체크포인트만 남긴다" 한 테스트가 약 48초(git 호출 다수) 걸려 전체 실행 시 파일 단위 60초 제한에 걸린다. CI는 통과한다. 테스트를 줄이거나 제한을 늘린다.
4. **GitHub Actions Node 20 경고.** `actions/checkout@v4`, `actions/setup-node@v4`가 Node 24로 강제 실행된다는 경고가 나온다. 새 메이저로 올린다.
5. **오케스트레이션 확장.** 지금은 "선행 턴 성공 → 다음 에이전트 1단계 자동 전송"까지다. 여러 단계 연쇄, 실패 시 재시도 정책, 병렬 결과 중 하나를 골라 반영하는 단계는 없다.
6. **사용량 누계의 범위.** 누계는 이 PC의 Hermit이 관측한 값이다. 계정 전체 기간 사용량은 제공자 API가 없으면 보여줄 수 없다.
7. **코드 서명 없음.** 첫 설치 시 SmartScreen 경고가 뜬다(`docs/release.md` 코드 서명 절 참고).
8. **T3 Code 참고 항목.** 모델 정규화, 사용량 증가분 계산, 에이전트 응답 재생 테스트는 참고만 했고 코드는 가져오지 않았다. 가져오면 MIT 저작권·허가 고지를 유지한다([소스, 커밋 37b316a](https://github.com/pingdotgg/t3code/tree/37b316ac314ebb991c498492b5f1eb036a0eed6c)).
9. **정리 대상.** 저장소 루트의 `output/pdf/agent-workbench-prd.pdf`는 추적하지 않는 파일이다. 보관할지 정한다.

## 작업 방법

- 개발 확인은 설치 없이 `npm start` 후 F5로 한다. 설치 파일은 릴리스로만 만든다.
- main에 푸시하면 테스트 → Electron 스모크 → 빌드 → `guseoh/hermit-releases` 릴리스가 자동으로 진행된다. 버전은 `0.1.<실행 번호 + 2>`다. `docs/`와 `*.md`만 바꾼 푸시는 배포하지 않는다.
- 설치본을 재시작·교체하기 전에 Hermit에서 에이전트 턴이 진행 중인지 확인한다(현황판 또는 프로세스 CPU 사용).
