# MC DevKit

마인크래프트 서버를 쉽게 열고 관리할 수 있는 웹 기반 서버 관리 툴입니다.  
포트포워딩 없이 외부 접속 지원, 팀원 권한 관리, 실시간 모니터링까지 한 번에.

---

## 주요 기능

- **콘텐츠 팀 모드팩 동기화** — 승인 배포·촬영 고정·이전 배포 복원, 참가자 게임 시작 전 모드·공용 설정 자동 적용, 준비 현황 ([사용법](docs/modpack-sync.md))
- **Studio UI** — 서버 카드, 넓은 설정 화면, 모드팩 배포와 참가 서버 관리
- **최신 서버 버전 대응** — 종류별 릴리스 목록 새로고침, Paper 안정 빌드 검증, Minecraft 26.x Java 25 자동 준비

- **서버 관리** — Paper / Fabric / Forge / NeoForge / Vanilla / Arclight / Cardboard, 종류별 공식 버전·로더 조회와 원클릭 시작·중지·재시작
- **외부 접속** — playit.gg 연동, 포트포워딩 없이 외부 접속 가능 (무료)
- **팀 관리** — Owner / Admin / Member / Viewer 권한 분리, 동시 접속 지원
  신규 멤버는 기본적으로 서버 제어 권한이 없으며 호스트가 권한을 부여합니다.
- **모드 / 플러그인** — .jar 드래그앤드롭 업로드
- **성능 최적화** — Aikar's JVM 플래그 자동 적용, Lithium·FerriteCore 자동 설치
- **실시간 모니터링** — TPS·핑 실시간 표시, 로그 필터
- **명령어 자동완성** — 탭키 60개 명령어 자동완성
- **UI 커스터마이징** — 배경 이미지·불투명도·블러 설정

---

## 다운로드

[MC DevKit v1.9.1 설치파일 다운로드](https://github.com/hongseongug812-ui/mc-devkit/releases/download/v1.9.1/MC-DevKit-Setup-1.9.1.exe)

> Windows 전용 / 설치 후 바탕화면 MC DevKit 실행

설치된 앱은 시작할 때와 15분마다 업데이트를 확인하고 자동 다운로드합니다. 서버·게임·촬영 모드·터널 작업이 끝나고 앱이 트레이에 있으면 자동 설치 후 재실행합니다. 앱을 완전 종료할 때도 다운로드된 업데이트를 자동 설치합니다. 창의 X 버튼은 트레이로 숨깁니다. 기존 1.9.0 이하 앱은 한 번 재시작하거나 완전 종료해 1.9.1을 설치하면 이후 자동 설치 흐름을 사용합니다.

---

## 사용 방법

### 호스트 (서버 여는 사람)

**최초 설정 (딱 한 번)**
1. `MC DevKit` 설치 후 실행
2. [playit.gg](https://playit.gg) 회원가입 → 이메일 인증
3. DevKit에서 **▶ playit 터널 시작** 클릭
4. 로그창에 뜨는 링크 열기 → 계속하다 → 에이전트 추가
5. playit.gg → Tunnels → Create tunnel → Minecraft Java → Next → Next → Next

**매번 서버 킬 때**
1. MC DevKit 실행
2. **▶ playit 터널 시작** 클릭
3. **▶ 서버 시작** 클릭
4. 좌측 **서버 접속 주소 복사** → 친구들에게 공유

### 멤버 (접속하는 사람)

1. MC DevKit의 서버 참가에서 호스트의 참가 링크와 게임 프로필 연결
2. 참가 서버의 **게임 시작 · 자동 적용** 클릭 → 적용 완료 후 런처에서 연결한 프로필의 플레이 클릭
3. 멀티플레이 → 서버 추가 → 호스트에게 받은 Minecraft 접속 주소로 접속

---

## 개발자

**hongseongug812**  
- GitHub: [hongseongug812-ui](https://github.com/hongseongug812-ui)

---

## 라이선스

MIT License
