# virtual-device-helper

Android·iOS 가상 기기를 MCP로 제어하고, 화면·로그·이벤트를 한 화면에서 보는 Electron 데스크탑 앱.

현재 상태: v0.1.0 — macOS(Apple Silicon) 호스트, Android 에뮬레이터, MCP 서버, 기기 스크린샷, 툴 호출 기록,
에이전트 안내 탭. 실시간 화면 스트리밍과 화면 직접 조작은 아직 없다(M2).
검증 결과와 남은 결함은 [M1 스펙](docs/superpowers/specs/archive/2026-09-22-m1-device-core-mcp-server.md)의
"검증 결과"에 있다.

## 필요한 것

- macOS
- Android Studio와 Android SDK, 부팅 가능한 AVD 하나
- Node.js

이 앱은 Android SDK를 번들하지 않는다. 이유는
[ADR-0003](docs/adr/0003-no-bundled-android-sdk.md)에 있다.

## 설치

[Releases](https://github.com/citytexi/virtual-device-helper/releases)에서
`virtual-device-helper-<버전>-arm64.dmg`를 받아 Applications로 옮긴다. Apple Silicon Mac 전용이다.

앱은 서명·공증되지 않았다. 이유는 [ADR-0009](docs/adr/0009-unsigned-arm64-mac-distribution.md)에 있다.
처음 열 때 macOS가 "손상되었다" 또는 "확인할 수 없는 개발자"라며 막으면 격리 속성을 지운다.

```bash
xattr -dr com.apple.quarantine /Applications/virtual-device-helper.app
```

받은 파일은 릴리스 노트의 SHA-256과 비교해 확인할 수 있다.

```bash
shasum -a 256 virtual-device-helper-<버전>-arm64.dmg
```

## 소스에서 실행

```bash
npm install
node node_modules/electron/install.js   # Electron 실행 파일을 받는다 (처음 한 번)
npm run dev
```

Electron은 `npm install` 때 실행 파일을 받지 않는다. 받지 않은 채 `npm run dev`를 하면
`Error: Electron uninstall`로 멈춘다. `node_modules`를 지우고 다시 설치했을 때도 두 번째 줄을 다시 실행한다.

## 에이전트로 테스트하기

다른 프로젝트에서 만든 Android 앱을 Claude Code로 테스트하는 흐름이다.

1. 이 앱을 켜고 기기 목록에서 AVD를 부팅한다.
2. 테스트할 앱의 프로젝트 폴더에서 Claude Code를 켠다.
3. 이 앱의 **에이전트** 탭에서 "명령 복사"를 누르고 터미널에서 실행한다.

   ```bash
   claude mcp add --transport http virtual-device-helper http://127.0.0.1:<port>/mcp --header "Authorization: Bearer <token>"
   ```

4. 에이전트 탭에서 용도에 맞는 프롬프트를 골라 "프롬프트 복사"를 누르고 Claude Code에 붙인다.

서버는 `127.0.0.1`에만 열리고 토큰을 요구한다. 토큰은 앱을 켤 때마다 새로 만들어진다. 앱을 다시 켰으면
`claude mcp remove virtual-device-helper`를 실행한 뒤 새 명령을 다시 등록한다. 앱을 닫으면 서버도 닫힌다.

Claude Code가 아닌 MCP 클라이언트는 상단 바의 "설정 JSON 복사"로 받은 `mcpServers` 설정을 쓴다.

### 프롬프트

에이전트 탭에 세 가지가 있다. 본문은 앱에서 복사한다. 원문은 `src/shared/agentGuide.ts`다.

| 프롬프트 | 쓰는 때 |
|---|---|
| 스모크 테스트 | 설치하고 실행했을 때 죽지 않는지만 빠르게 본다 |
| 시나리오 E2E | 적어 둔 사용자 시나리오를 단계마다 확인하며 끝까지 수행한다 |
| 버그 재현 | 증상을 재현하고 스크린샷과 로그를 모은다 |

`<패키지명>`·`<APK 경로>` 같은 꺾쇠 칸은 직접 채우거나, 비워 두고 에이전트가 프로젝트에서 찾게 한다.
프롬프트에는 토큰이 들어가지 않는다.

연결하면 서버가 툴 사용 규칙을 MCP `instructions`로 보낸다. 프롬프트 없이 붙여도 에이전트는 기본 규칙을 안다.

### 툴

| 묶음 | 툴 | 하는 일 |
|---|---|---|
| device | `device_list` | AVD 목록, 실행 중인 기기, 활성 기기. 다른 툴보다 먼저 부른다 |
| device | `device_boot` | AVD를 부팅하고 끝날 때까지 기다린다 |
| device | `device_shutdown` | 실행 중인 에뮬레이터를 끈다 |
| device | `device_select` | 활성 기기를 정한다. serial을 생략한 호출은 이 기기로 간다 |
| device | `device_info` | 모델명, API 레벨, 화면 크기 |
| app | `app_install` | APK를 설치하고 패키지명을 돌려준다. 호스트의 절대 경로를 준다 |
| app | `app_uninstall` | 패키지를 완전히 지운다 |
| app | `app_launch` | 앱을 실행한다. activity를 생략하면 런처 진입점을 찾는다 |
| app | `app_stop` | 앱을 강제 종료한다 |
| app | `app_clear_data` | 앱 데이터를 지워 첫 실행 상태로 되돌린다 |
| app | `app_grant_permission` | 런타임 권한을 미리 준다 |
| app | `app_reset_and_launch` | 종료, 데이터 삭제, 재실행 후 첫 화면이 안정될 때까지 기다린다 |
| ui | `ui_find` | 화면 요소와 누를 좌표. 조작 전에 먼저 부른다 |
| ui | `ui_tap` | 좌표를 누른다. `ui_find`의 x, y를 그대로 쓴다 |
| ui | `ui_swipe` | 스와이프. 스크롤에 쓴다 |
| ui | `ui_text` | 포커스된 입력 칸에 ASCII 텍스트를 넣는다 |
| ui | `ui_key` | back, home, enter, tab 키 |
| observe | `screenshot` | 지금 화면. 기본으로 축소해서 준다 |
| observe | `log_read` | logcat을 읽는다. 잘리면 `truncated`가 true다 — filter로 좁혀 다시 부른다 |
| observe | `log_clear` | logcat 버퍼를 비운다. 시나리오 직전에 부른다 |

전형적인 흐름은 빌드 → `app_install` → `log_clear` → `app_launch` → `ui_find` → `ui_tap`·`ui_text` →
`screenshot` → `log_read`다.

### 자주 나는 실패

툴이 실패하면 응답에 `kind`, `message`, `hint`가 온다. 에이전트는 `hint`를 따라 복구한다.

| `kind` | 뜻 | 할 일 |
|---|---|---|
| `sdk_not_found`, `adb_not_found` | Android SDK나 adb를 못 찾았다 | Android Studio를 설치하거나 `ANDROID_HOME`을 지정하고 앱을 다시 켠다 |
| `no_device` | 대상 기기가 없다 | `device_list`로 확인하고 `device_boot` 또는 `device_select` |
| `ambiguous_device` | 기기가 여럿인데 대상을 정하지 않았다 | `device_select`로 하나를 고른다 |
| `package_not_found` | 기기에 그 패키지가 없다 | 패키지명을 확인하고 `app_install`을 먼저 한다 |
| `apk_path_invalid` | APK 경로가 틀렸다 | 빌드를 먼저 하고 호스트의 절대 경로를 준다 |
| `device_unresponsive` | 기기가 응답하지 않는다 | `device_shutdown` 후 `device_boot`로 다시 켠다 |
| `command_failed` | 그 밖의 명령 실패 | `hint`와 `details`의 stderr를 읽는다 |

## 개발

```bash
npm test                   # 단위 테스트 (에뮬레이터 불필요)
npm run test:integration   # 실기기 테스트 (에뮬레이터 필요)
npm run typecheck
npm run build
npm run dist               # macOS arm64 dmg·zip을 dist/에 만든다 (서명 없음)
```

`npm run test:integration`은 연결된 에뮬레이터가 하나뿐이면 그 기기를 쓴다. 에뮬레이터가 여럿이거나
물리 기기로 돌리려면 `VDH_TEST_SERIAL`로 serial을 지정한다. 물리 기기는 암묵적으로 고르지 않는다.

```bash
VDH_TEST_SERIAL=emulator-5554 npm run test:integration
```

## 문서

`docs/`에 있다. 찾을 때는 grep보다 `python3 docs/script/docs.py find "<주제>"`를 먼저 쓴다.
