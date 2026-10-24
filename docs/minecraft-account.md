# Minecraft Java 계정 연결

MC DevKit은 Microsoft의 기기 코드 로그인으로 Minecraft Java 계정을 연결합니다. 비밀번호는 앱에 입력하지 않으며 Microsoft의 공식 웹사이트에서 로그인합니다. Java Edition 이용 권한과 Java 프로필을 모두 확인한 계정만 게임 실행에 사용합니다.

## 앱 배포자가 먼저 준비할 사항

1. Microsoft Entra에 **직접 소유한 앱**을 등록하고 개인 Microsoft 계정 로그인을 지원하도록 설정합니다. 이 기능은 `consumers` 테넌트를 사용합니다.
2. 앱의 인증 설정에서 **Allow public client flows**를 활성화합니다. 앱에 클라이언트 시크릿을 넣지 않습니다.
3. 해당 앱의 Minecraft Java Game Service API 접근 등록/승인을 완료합니다. 안내 및 신청: <https://aka.ms/mce-reviewappid>.
4. Application (client) ID를 계정 화면에 설정합니다. 배포 시 `package.json`의 `minecraftClientId`에 설정하거나, 개발 시 아래 환경변수를 사용할 수도 있습니다. 다른 런처의 클라이언트 ID는 사용하지 않습니다.

```powershell
$env:DEVKIT_MICROSOFT_CLIENT_ID = '직접-등록한-앱의-GUID'
npm start
```

클라이언트 ID는 비밀 값이 아닙니다. 시크릿, Microsoft 비밀번호 또는 기존 런처의 토큰을 복사하는 기능은 제공하지 않습니다. 유효한 앱 ID와 Minecraft API 승인이 준비되지 않은 배포본은 실제 연결을 완료할 수 없습니다. Microsoft 로그인에 성공해도 Minecraft API에서 접근을 거절할 수 있습니다.

## 계정 연결과 실행

계정 연결을 시작하면 짧은 코드와 Microsoft 인증 주소가 표시됩니다. 코드를 Microsoft 화면에 입력한 뒤 본인의 계정으로 로그인하고 요청 권한을 확인합니다. 앱은 `XboxLive.signin offline_access` 권한으로 로그인하며, 연결 취소 및 코드 만료 시 대기를 중단합니다.

승인 후 Xbox Live, XSTS, Minecraft 인증을 차례로 수행하고 Minecraft Java 권한과 프로필을 확인합니다. Java 프로필이 없다면 공식 런처에서 프로필을 만든 뒤 다시 연결해야 합니다. Xbox 프로필 또는 가족 설정 때문에 연결이 거절되는 경우에는 Microsoft/Xbox의 해당 계정 설정을 먼저 확인합니다.

게임 실행 전에 Microsoft 토큰을 갱신하고 Java 이용 권한과 프로필을 다시 확인합니다. 권한 확인이나 갱신에 실패하면 인증된 게임 실행을 중단합니다. 계정 연결은 Minecraft 구매 권한이나 Microsoft API 접근 승인을 대신하지 않습니다.

## 저장과 보안

- Microsoft refresh token은 Electron `safeStorage`의 OS 암호화로만 저장합니다. Minecraft access token과 중간 Xbox 토큰은 메인 프로세스 메모리에만 보관합니다.
- 저장 파일은 앱 사용자 데이터 폴더의 `minecraft-account.json`입니다. 여기에 공개 클라이언트 ID, 플레이어 이름/UUID, 암호화된 refresh token만 저장됩니다.
- OS 암호화가 불가능하거나 Linux 저장소가 `basic_text`이면 토큰을 디스크에 저장하지 않습니다. 현재 앱 실행 중에는 연결할 수 있지만, 앱을 다시 열면 재로그인이 필요합니다. 계정 상태의 `persistent: false`로 구분합니다.
- 화면/IPC에는 계정 이름/UUID, 공개 로그인 코드/인증 주소, 진행 상태와 정제된 오류만 전달합니다. 토큰과 원본 HTTP 오류를 전달하거나 기록하지 않습니다.
- 연결 해제는 로컬 계정과 저장된 토큰을 지웁니다. Microsoft 계정 자체의 앱 동의/다른 기기 세션을 취소하는 동작은 Microsoft 계정 설정에서 처리합니다.

## 개발자 API

```javascript
const MinecraftAccount = require('./core/minecraft-account');
const account = new MinecraftAccount(app.getPath('userData'), {
  secureStorage: safeStorage,
  onChange: publicStatus => sendAccountStatus(publicStatus),
});
await account.init();
await account.configure(clientId); // 공개 앱 GUID 설정, 이전 연결 해제
await account.beginLogin();       // 코드 수신 후 즉시 반환, 이후 백그라운드 대기
account.cancelLogin();
const session = await account.getSession(); // 메인 프로세스 내부의 게임 실행 코드만 호출
await account.logout();
account.close();
```

`status()`와 변경 이벤트는 `{configured, clientId, account, pending, busy, error?}`를 반환합니다. `account`는 `{id, name, persistent}`, `pending`은 `{userCode, verificationUri, expiresAt}` 또는 `null`입니다. `getSession()`은 `{accessToken, uuid, name, userType: 'msa', expiresAt, clientId, xuid}`를 반환하며 **IPC/웹 API로 노출하면 안 됩니다**.

## 근거 자료와 검증 범위

- [Microsoft 기기 코드 로그인 규약](https://learn.microsoft.com/en-us/entra/identity-platform/v2-oauth2-device-code): 공개 클라이언트, 코드 발급, 폴링/만료 및 refresh token 동작.
- [Microsoft 앱 등록](https://learn.microsoft.com/en-us/entra/identity-platform/quickstart-register-app): 앱 ID 및 지원 계정 유형 설정.
- [Minecraft Game Service API 접근 신청](https://aka.ms/mce-reviewappid).
- [Electron 29 safeStorage 문서](https://github.com/electron/electron/blob/v29.4.6/docs/api/safe-storage.md): OS별 저장소 및 `basic_text` 동작. 이 프로젝트의 Electron 29 API에 맞춰 동기 암호화 어댑터를 사용합니다.

자동 테스트는 실제 계정 대신 모의 Microsoft/Xbox/Minecraft 응답으로 권한 확인, 암호화 저장, 토큰 갱신, 연결 취소·해제 경쟁 상태를 검증합니다. 실제 계정 로그인과 승인된 앱의 운영 환경 검증은 별도로 필요합니다.
