# virtual-device-helper

Android·iOS 가상 기기를 MCP로 제어하고, 화면·로그·이벤트를 한 화면에서 보는 Electron 데스크탑 앱.

현재 상태: M1 완료 — macOS 호스트, Android 에뮬레이터, MCP 서버와 최소 UI.
검증 결과와 남은 결함은 [M1 스펙](docs/superpowers/specs/archive/2026-09-22-m1-device-core-mcp-server.md)의
"검증 결과"에 있다.

## 필요한 것

- macOS
- Android Studio와 Android SDK, 부팅 가능한 AVD 하나
- Node.js

이 앱은 Android SDK를 번들하지 않는다. 이유는
[ADR-0003](docs/adr/0003-no-bundled-android-sdk.md)에 있다.

## 실행

```bash
npm install
npm run dev
```

## 에이전트 붙이기

앱의 엔드포인트 카드에서 "설정 JSON 복사"를 누르고 MCP 클라이언트 설정에 붙인다.
서버는 `127.0.0.1`에만 열리고 토큰을 요구한다. 토큰은 앱을 켤 때마다 새로 만들어지므로, 앱을
다시 켜면 설정 JSON도 다시 복사한다. 앱을 닫으면 서버도 닫힌다.

## 개발

```bash
npm test                   # 단위 테스트 (에뮬레이터 불필요)
npm run test:integration   # 실기기 테스트 (에뮬레이터 필요)
npm run typecheck
npm run build
```

`npm run test:integration`은 연결된 에뮬레이터가 하나뿐이면 그 기기를 쓴다. 에뮬레이터가 여럿이거나
물리 기기로 돌리려면 `VDH_TEST_SERIAL`로 serial을 지정한다. 물리 기기는 암묵적으로 고르지 않는다.

```bash
VDH_TEST_SERIAL=emulator-5554 npm run test:integration
```

## 문서

`docs/`에 있다. 찾을 때는 grep보다 `python3 docs/script/docs.py find "<주제>"`를 먼저 쓴다.
