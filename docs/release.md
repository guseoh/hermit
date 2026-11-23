# 설치 파일·자동 업데이트·코드 서명

## 빌드

```powershell
npm run pack   # dist\win-unpacked\ 에 풀린 형태로 빌드(설치 없이 실행해 보기)
npm run dist   # dist\Hermit-Setup-<버전>.exe 설치 파일과 latest.yml
```

- 설치 파일은 사용자 단위(관리자 권한 불필요)로 설치되고, 설치 폴더를 고를 수 있으며 바탕 화면 바로 가기를 만든다.
- 설치본은 asar로 묶지 않는다(`build.asar: false`). node-pty의 출력 워커(worker_threads)와 PowerShell(.ps1)이 asar 안의 파일을 읽지 못하기 때문이다.
- `build.npmRebuild: false`: node-pty는 Electron용으로 이미 빌드된 것(prebuilds)을 그대로 쓴다. Electron 버전을 올리면 Visual Studio Build Tools를 설치한 뒤 `npx @electron/rebuild`로 다시 빌드하고 `npm run pack`으로 터미널이 동작하는지 확인한다.
- 앱 데이터 폴더는 `%APPDATA%\powershell-workbench`로 고정했다(`productName`을 넣어도 기존 작업·설정·상태 파일을 그대로 쓴다).

## 노트 편집기 묶음(vendor)

노트의 실시간 서식 편집기(TipTap)는 ESM 패키지라 `vendor-src/rich-editor.mjs`를 esbuild로 한 파일로 묶어 `vendor/rich-editor.js`(약 440KB)로 커밋해 둔다. 앱은 노트를 처음 열 때만 이 파일을 불러온다.
TipTap 버전을 올리거나 `vendor-src`를 고치면 `npm run build:vendor`로 다시 묶고 결과 파일을 함께 커밋한다. 설치본에는 `vendor/`만 들어가고 `vendor-src/`와 devDependencies는 빠진다.
## 배포와 자동 업데이트

**배포는 자동이다.** main에 푸시하면 GitHub Actions(`.github/workflows/release.yml`)가 Windows에서 테스트 → 빌드 → 공개 릴리스 저장소(`guseoh/hermit-releases`)에 릴리스를 만든다. 문서(`docs/`, `*.md`)만 바뀐 푸시는 빌드하지 않는다. Actions 화면의 "Run workflow"로 직접 돌릴 수도 있다.

- 버전: `package.json`의 앞 두 자리 + 실행 번호. `0.1.<실행 번호 + 2>`처럼 매번 올라간다. 앞 두 자리를 바꾸려면 `package.json`의 `version`을 고친다(예: `0.2.0`).
- 소스 저장소(`guseoh/hermit`)는 비공개라 설치본이 그쪽 릴리스를 받을 수 없다. 릴리스는 반드시 `hermit-releases`에 만든다.
- 시크릿 `RELEASES_TOKEN`: `hermit-releases` 한 저장소의 Contents 읽기·쓰기만 가진 fine-grained 토큰(기한 1년). 만료되면 워크플로가 "RELEASES_TOKEN이 만료됐거나…" 오류로 멈춘다. 새 토큰을 만들어 `gh secret set RELEASES_TOKEN --repo guseoh/hermit`으로 다시 등록한다.

**설치한 앱의 업데이트도 자동이다.**

1. 시작 10초 뒤와 6시간마다 `hermit-releases`의 최신 릴리스를 확인해 받아 둔다("새 버전을 받았습니다" 토스트).
2. 받아 둔 업데이트는 **에이전트가 작업 중이거나 승인·입력을 기다리지 않고, 컴퓨터를 10분 이상 쓰지 않을 때** 조용히 설치하고 다시 시작한다. 시작하면 마지막 작업이 다시 열린다. 열려 있던 PowerShell 세션은 끝난다.
3. 바로 설치하려면 토스트의 "지금 설치"나 트레이 메뉴의 "업데이트 설치 후 다시 시작"을 누른다. 앱을 종료해도 설치된다.
4. 설정의 "자동 업데이트"를 끄면 확인·설치를 모두 하지 않는다. 개발 실행(`npm start`)에서는 확인하지 않는다.

손으로 배포해야 할 때(Actions를 못 쓸 때):

```powershell
npm version 0.1.50 --no-git-tag-version   # 마지막 릴리스보다 큰 버전
npm run dist
gh release create v0.1.50 dist\Hermit-Setup-0.1.50.exe dist\Hermit-Setup-0.1.50.exe.blockmap dist\latest.yml --repo guseoh/hermit-releases --title "Hermit 0.1.50" --notes "변경 내용"
```
## 코드 서명

지금은 서명하지 않는다(인증서 없음). 서명하지 않은 설치 파일은 처음 실행할 때 Windows SmartScreen이 "알 수 없는 게시자" 경고를 띄운다
("추가 정보 → 실행"으로 진행). 자동 업데이트는 서명 없이도 동작한다.

서명하려면 다음 중 하나를 준비한다.

- **코드 서명 인증서(.pfx)**: 빌드할 때 환경 변수로 넘긴다. 저장소에 넣지 않는다.
  ```powershell
  $env:CSC_LINK = 'C:\secure\codesign.pfx'
  $env:CSC_KEY_PASSWORD = '<암호>'   # 실제 값은 터미널에서만 입력
  npm run dist
  ```
- **Azure Trusted Signing**: `build.win.azureSignOptions`(endpoint, certificateProfileName, codeSigningAccountName)를 설정하고
  `AZURE_TENANT_ID`·`AZURE_CLIENT_ID`·`AZURE_CLIENT_SECRET` 환경 변수로 빌드한다.

서명을 시작한 뒤에는 `build.win.publisherName`에 인증서의 게시자 이름을 넣으면, 자동 업데이트가 같은 게시자의 파일만 설치한다.
