# 설치 파일·자동 업데이트·코드 서명

## 빌드

```powershell
npm run pack   # dist\win-unpacked\ 에 풀린 형태로 빌드(설치 없이 실행해 보기)
npm run dist   # dist\AgentWorkbench-Setup-<버전>.exe 설치 파일과 latest.yml
```

- 설치 파일은 사용자 단위(관리자 권한 불필요)로 설치되고, 설치 폴더를 고를 수 있으며 바탕 화면 바로 가기를 만든다.
- 설치본은 asar로 묶지 않는다(`build.asar: false`). node-pty의 출력 워커(worker_threads)와 PowerShell(.ps1)이 asar 안의 파일을 읽지 못하기 때문이다.
- `build.npmRebuild: false`: node-pty는 Electron용으로 이미 빌드된 것(prebuilds)을 그대로 쓴다. Electron 버전을 올리면 Visual Studio Build Tools를 설치한 뒤 `npx @electron/rebuild`로 다시 빌드하고 `npm run pack`으로 터미널이 동작하는지 확인한다.
- 앱 데이터 폴더는 `%APPDATA%\powershell-workbench`로 고정했다(`productName`을 넣어도 기존 작업·설정·상태 파일을 그대로 쓴다).

## 버전 올리기와 배포(자동 업데이트)

설치한 앱은 시작 10초 뒤와 6시간마다 GitHub Releases(`guseoh/powershell-workbench`)를 확인해 새 버전을 받아 두고,
"다시 시작해 설치" 토스트를 띄운다(누르지 않으면 앱을 끌 때 설치). 설정의 "자동 업데이트"로 끌 수 있다. 개발 실행(`npm start`)에서는 확인하지 않는다.

1. `package.json`의 `version`을 올린다(예: `0.2.0`).
2. `npm run dist`
3. GitHub에 릴리스를 만들고 세 파일을 올린다. 태그는 `v<버전>`.

```powershell
gh release create v0.2.0 dist\AgentWorkbench-Setup-0.2.0.exe dist\AgentWorkbench-Setup-0.2.0.exe.blockmap dist\latest.yml --title "v0.2.0" --notes "변경 내용"
```

또는 `GH_TOKEN`을 설정하고 `npx electron-builder --win --publish always`로 빌드와 업로드를 한 번에 한다.

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
