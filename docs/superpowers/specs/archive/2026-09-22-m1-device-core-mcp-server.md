---
id: m1-device-core-mcp-server
title: M1 — 기기 코어와 MCP 서버
status: implemented
verified: 2026-09-23
scope: [main, renderer, preload, mcp, android, build]
hosts: [macos]
supersedes:
superseded_by:
related_adr: [ADR-0001, ADR-0002, ADR-0003, ADR-0004, ADR-0005, ADR-0006, ADR-0007]
related_spec:
related_architecture:
related_plan: [m1-1-foundation-and-adb, m1-2-android-device, m1-3-mcp-server, m1-4-electron-shell-ui, m1-5-integration-verification]
related_code:
tags: [spec, m1, mcp, android]
---

# Spec: M1 — 기기 코어와 MCP 서버

## 목표

Android 에뮬레이터를 제어하는 MCP 서버를 Electron 앱 안에 만든다. 외부 에이전트가 붙어서 앱을
설치하고, 화면을 읽고, 조작하고, 로그를 확인할 수 있게 하는 것이 목적이다. 사람은 같은 앱에서
기기 상태와 에이전트가 무엇을 했는지를 본다.

## 전체 마일스톤에서의 위치

이 스펙은 M1 하나만 다룬다. 전체 계획은 다음과 같고, 각 마일스톤이 자기 스펙과 계획을 가진다.

- **M1 — 기기 코어와 MCP 서버** (이 문서)
- **M2 — 실시간 스트리밍과 사람 입력** — `scrcpy-server.jar` 통신, WebCodecs 디코딩, 입력 주입
- **M3 — 로그·이벤트 패널** — logcat 실시간 tail, 필터, 툴 호출 타임라인 상세
- **M4 — iOS 어댑터** — `simctl` 기반 `Device` 구현체
- **M5 — Windows 호스트 지원**

## 범위

**포함**

- macOS 호스트, Android 에뮬레이터 타깃.
- MCP 툴 네 묶음: 기기 수명주기, 앱 설치·실행, UI 상호작용, 관찰(스크린샷·로그).
- Electron main 안에서 도는 Streamable HTTP MCP 서버. 루프백 바인드, 토큰 인증, `Origin` 검사.
- 최소 renderer UI: 기기 패널, 정지 스크린샷, 툴 호출 활동 목록, 엔드포인트 카드.
- Android SDK 탐색과 미발견 시 안내 화면.
- M2의 기술 위험을 확인하는 스파이크 (결과물은 버린다).

**제외**

- iOS와 Windows (M4·M5).
- 실시간 화면 스트리밍과 사람 입력 주입 (M2).
- logcat 실시간 tail, 로그 필터 UI, 활동 상세·검색 (M3).
- 원격 접속, 다중 사용자, 인증 체계 확장.
- 테스트 스크립트 녹화·재생.
- 리포트 생성. 이 앱은 툴과 뷰어를 제공하고 리포트는 붙은 에이전트가 쓴다.
- 코드 서명·공증.

## 구조

main 프로세스를 여섯 층으로 쌓는다. 근거는 [ADR-0005](../../../adr/0005-device-interface-abstraction.md).

| 층 | 책임 | 아는 것 |
|---|---|---|
| `adbClient` | adb 바이너리 실행 | adb 문법 |
| `AndroidDevice` | adb 출력에 의미 부여 | Android 도메인 |
| `DeviceRegistry` | 연결된 기기와 활성 기기 관리 | `Device` 인터페이스 |
| `mcpTools` | 툴 정의와 응답 크기 제어 | MCP 규격 |
| `mcpHttpServer` | 전송, 세션, 인증 | HTTP |
| `ipcBridge` | renderer로 상태·이벤트 전달 | Electron IPC |

**위층은 바로 아래층만 부른다.** `mcpTools`가 `adbClient`를 직접 부르지 않는다.

`Device` 인터페이스는 이 스펙에서 정의하되 구현체는 `AndroidDevice` 하나만 만든다. 인터페이스는
Android 구현이 실제로 필요로 하는 만큼만 넓힌다.

## 인터페이스

### adbClient

두 가지 모양만 노출한다.

```ts
interface AdbClient {
  exec(serial: string | null, args: string[], opts?: ExecOpts): Promise<ExecResult>
  stream(serial: string | null, args: string[]): AdbStream
}
```

`exec`은 한 번 실행하고 결과를 준다. `stream`은 장시간 프로세스를 띄우고 출력 이벤트를 흘린다.
adb 미발견, 기기 끊김, 타임아웃을 여기서 타입 있는 에러로 바꾼다. 위층은 raw stderr를 해석하지 않는다.

### Device

```ts
interface Device {
  readonly serial: string
  info(): Promise<DeviceInfo>
  install(apkPath: string, opts?: InstallOpts): Promise<string | null>
  uninstall(pkg: string): Promise<void>
  launch(pkg: string, activity?: string): Promise<void>
  stop(pkg: string): Promise<void>
  clearData(pkg: string): Promise<void>
  grantPermission(pkg: string, permission: string): Promise<void>
  tap(x: number, y: number): Promise<void>
  swipe(x1: number, y1: number, x2: number, y2: number, durationMs: number): Promise<void>
  inputText(text: string): Promise<void>
  pressKey(key: KeyName): Promise<void>
  dumpUi(): Promise<UiNode[]>
  screenshot(opts?: ScreenshotOpts): Promise<ScreenshotResult>
  readLogs(opts?: LogOpts): Promise<LogReadResult>
  clearLogs(): Promise<void>
}
```

`dumpUi`는 이미 요약된 `UiNode[]`를 돌려준다. 원본 XML은 이 경계를 넘지 않는다.
`install`은 설치된 패키지명을 돌려준다. 재설치라 패키지 목록이 그대로여서 이름을 특정할 수
없으면 `null`이다 — 빈 문자열로 말하면 호출부가 그것을 유효한 패키지명으로 착각한다.
`readLogs`가 돌려주는 `LogReadResult`는 줄 배열과 함께 잘림 여부를 담는다 — 잘림은 에러가 아니라
성공 응답의 필드다.

### MCP 툴

이름은 `<대상>_<동작>` 한 결이다. 모든 툴이 `serial`을 선택 인자로 받는다. 근거는
[ADR-0004](../../../adr/0004-hybrid-mcp-tool-surface.md).

**기기 수명주기**

| 툴 | 인자 | 반환 |
|---|---|---|
| `device_list` | — | AVD 목록과 실행 중 기기, 각각의 상태 |
| `device_boot` | `avd` | 부팅 완료 후 기기 정보 |
| `device_shutdown` | `serial?` | — |
| `device_select` | `serial` | 새 활성 기기 |
| `device_info` | `serial?` | 해상도, API 레벨, 모델 |

**앱**

| 툴 | 인자 | 반환 |
|---|---|---|
| `app_install` | `apkPath`, `reinstall?`, `serial?` | 설치된 패키지명 |
| `app_uninstall` | `pkg`, `serial?` | — |
| `app_launch` | `pkg`, `activity?`, `serial?` | — |
| `app_stop` | `pkg`, `serial?` | — |
| `app_clear_data` | `pkg`, `serial?` | — |
| `app_grant_permission` | `pkg`, `permission`, `serial?` | — |
| `app_reset_and_launch` | `pkg`, `serial?` | — |

`app_reset_and_launch`는 force-stop → 데이터 삭제 → 실행 → 첫 화면 안정 대기를 한 번에 한다.
안정 판정은 `app.ts`의 `waitForSettle`이 UI 덤프의 요소 구성이 연속 두 번 같은지로 본다. 이 기준은
실제 앱으로 검증하지 못했다(아래 "열린 질문").

`app_launch`에서 `activity`를 생략하면 `androidDevice.ts`의 `resolveLauncherComponent`가
`cmd package resolve-activity --brief -c android.intent.category.LAUNCHER <pkg>`로 런처 액티비티를
찾아 `am start -n`으로 띄운다. 처음에 쓰던 `monkey` 방식은 API 36 에뮬레이터에서 실패했다(검증 결과 참고).

`device_boot`는 `avdController.ts`에서 `sys.boot_completed`가 `1`이 될 때까지 기다린다. 검증에서는 이것만으로
부팅 직후 `screenshot`이 완성된 홈 화면을 찍었다. 부팅 직후 곧바로 설치하는 경우(패키지 매니저 준비)는
확인하지 못했다.

**UI**

| 툴 | 인자 | 반환 |
|---|---|---|
| `ui_tap` | `x`, `y`, `serial?` | — |
| `ui_swipe` | `x1`, `y1`, `x2`, `y2`, `durationMs`, `serial?` | — |
| `ui_text` | `text`, `serial?` | — |
| `ui_key` | `name` (back/home/enter/tab), `serial?` | — |
| `ui_find` | `query?`, `serial?` | 요소 배열 |

**관찰**

| 툴 | 인자 | 반환 |
|---|---|---|
| `screenshot` | `scale?`, `serial?` | 이미지 |
| `log_read` | `filter?`, `since?`, `limit?`, `serial?` | 로그 줄 배열, 잘림 여부 |
| `log_clear` | `serial?` | — |

## 응답 크기 규칙

툴 하나가 뱉는 양이 이 서버의 쓸모를 정한다. 세 가지를 `mcpTools` 층에서 강제한다.

- **`ui_find`는 XML을 반환하지 않는다.** 요소 배열로 요약한다. 각 요소는 인덱스, 표시 텍스트,
  `content-desc`, `resource-id` 꼬리, 클래스 짧은 이름, 중심 좌표, 클릭 가능 여부를 가진다.
  화면 밖이거나 보이지 않는 노드는 버린다. `query`를 주면 텍스트·id 부분일치로 더 거른다.
  에이전트는 받은 중심 좌표를 `ui_tap`에 그대로 넣는다.
  버리는 기준은 `uiDump.ts`의 `parseUiDump`에 있다. 크기가 없는 노드, 중심이 화면 밖인 노드, 그리고
  텍스트·`content-desc`·`resource-id`가 모두 없고 누를 수도 없는 노드(레이아웃 컨테이너)를 버리고,
  남은 노드는 트리 없이 평평하게 늘어놓는다. 검증에서는 이 기준만으로 에이전트가 필요한 요소(런처
  아이콘, 설정 검색창, `EditText`)를 찾았고, 컨테이너를 따로 접을 필요는 관찰되지 않았다.
- **`screenshot`은 기본으로 축소한다.** 긴 변 기준으로 줄여 보낸다. `scale`로 올릴 수 있으나
  기본값이 작다. 원본 해상도가 필요한 쪽은 사람이고, 사람은 앱 화면으로 본다.
- **`log_read`는 기본 limit과 상한을 함께 가진다.** 인자로도 상한을 넘을 수 없다. 잘렸으면
  잘렸다는 사실과 남은 양을 함께 돌려준다. 줄 수만으로는 크기가 막히지 않으므로 세 가지를 더 한다.
  각 줄은 객체가 아니라 `MM-DD HH:MM:SS.mmm L tag(pid): message` 한 문자열이고(`observe.ts`의
  `formatLogLine`), 응답 JSON은 들여쓰지 않는다. 긴 메시지는 코드포인트 단위로 잘라 `…(+N자)`로
  표시한다(`LOG_MESSAGE_MAX_CODEPOINTS`). 직렬화한 응답 전체가 `LOG_READ_RESPONSE_BUDGET_CHARS`를
  넘으면 가장 오래된 줄부터 더 버리고 그만큼 `truncated`·`droppedCount`에 넣는다. 기본값과 상한은
  `LOG_READ_DEFAULT_LIMIT`·`LOG_READ_MAX_LIMIT`이다. 근거는 검증에서 들여쓴 JSON 응답이 클라이언트의
  인라인 한도를 넘었던 관찰이다.

## 동작 / 상태

### 활성 기기

모든 툴이 `serial`을 생략할 수 있고, 생략하면 활성 기기로 간다.

활성 기기는 **명시적으로 고른 기기**만 가리킨다. 아무도 고르지 않았을 때 어느 기기로 갈지는
`DeviceRegistry`의 `resolve`가 호출 시점에 정한다. 자동으로 활성 자리를 채우지 않는 이유는,
채우고 나면 기기가 둘일 때 "활성이 정해지지 않음"이라는 상태 자체가 사라져 아래 두 번째 줄의
후보 목록 에러에 영원히 닿지 못하기 때문이다.

- `serial`을 생략했고 기기가 하나면 그 기기로 간다. 활성 자리는 비어 있어도 된다.
- 기기가 둘 이상이고 활성이 정해지지 않았는데 `serial`을 생략하면, 후보 목록을 담은 에러를 돌려준다.
- 활성 기기가 사라지면 활성이 해제된다. 남은 기기가 하나면 그 기기로 가지만, 활성 자리는 비어 있다.
- `device_select`와 앱 UI의 기기 선택은 같은 상태를 바꾼다.

`DeviceRegistry`의 `getActive`는 명시적 선택만 돌려주므로, 기기가 하나 붙어 있고 아무도 고르지
않았으면 비어 있다. 활성 기기 변경 이벤트와 이 스냅샷이 같은 뜻을 갖게 하려는 의도다 — 파생값을
스냅샷에 섞으면 이벤트 없이 값만 바뀌는 순간이 생긴다. 그래서 "지금 명령이 갈 기기"를 화면에
표시하는 쪽은 선택이 없을 때 기기가 하나뿐이면 그 기기를 쓰는 파생 규칙을 직접 적용한다.

### 명령 직렬화

세션은 여럿 허용한다. 그러나 **한 기기의 명령은 큐 하나로 순서대로 실행한다.** 두 에이전트가
같은 기기에 동시에 명령을 보내도 결과가 엉키지 않는다. 다른 기기끼리는 병렬로 돈다.

예외로, `device.ts`의 `device_shutdown`은 `device_unresponsive` 복구 경로이므로 이 큐를 거치지
않고 바로 실행한다. 막힌 명령 뒤에 줄을 서면 복구 자체가 그 명령의 타임아웃만큼 늦어지기 때문이다.

### 서버 수명

서버는 앱과 함께 살고 함께 죽는다. 앱을 닫으면 진행 중이던 요청을 종료 에러로 마감한다.

### 포트와 토큰

기본 포트가 점유되어 있으면 다음 빈 포트로 넘어간다. 실제로 열린 포트를 UI에 표시한다.
토큰은 앱 실행 시 무작위로 만든다. 세부는 [ADR-0001](../../../adr/0001-mcp-transport-http-in-app.md).

### SDK 탐색

앱 시작 시 `ANDROID_HOME` → `ANDROID_SDK_ROOT` → macOS 기본 위치 → `PATH` 순으로 찾는다.
못 찾으면 안내 화면을 띄운다. 세부는 [ADR-0003](../../../adr/0003-no-bundled-android-sdk.md).

### 상태의 단일 출처

main이 유일한 진실원이다. renderer는 켜질 때 스냅샷을 한 번 받고 이후 이벤트로 갱신한다.
renderer가 자기만의 기기 상태를 따로 추론하지 않는다.

## 실패 처리

툴 실패는 예외가 아니라 구조화된 결과로 돌아간다. 에이전트가 읽고 복구할 수 있어야 한다.
각 에러는 다음에 무엇을 하면 되는지를 한 줄로 달고 온다.

| 종류 | 사용자/에이전트가 보는 것 | 복구 경로 |
|---|---|---|
| adb 미발견 | 무엇을 설치해야 하는지와 탐색한 경로 목록 | SDK 설치 후 재탐색 |
| 기기 없음 | 연결된 기기가 없다 | `device_list` → `device_boot` |
| 기기 모호 | 후보 serial 목록 | `serial` 지정 또는 `device_select` |
| 패키지 없음 | 해당 패키지가 기기에 없다 | `app_install` |
| APK 경로 오류 | 경로가 없거나 `.apk`가 아니다 | 경로 확인 |
| 기기 무응답 | 타임아웃, 어떤 명령이었는지 | 재시도 또는 `device_shutdown` 후 재부팅 |
| 명령 실패 | 원문 stderr 첨부 | 명령별로 다름 |

`app_install`의 서명·버전 충돌(`INSTALL_FAILED_UPDATE_INCOMPATIBLE`·`INSTALL_FAILED_VERSION_DOWNGRADE`)은
`kind`를 `command_failed`로 둔 채 구체적인 메시지, `details.reason`, 그리고 `app_uninstall` 뒤 다시
설치하라는 힌트(앱 데이터가 지워진다는 경고 포함)를 단다. `androidDevice.ts`의 `rethrowInstallFailure`가
맡는다. `ToolErrorKind`를 늘리지 않은 것은 ADR-0004의 공개 인터페이스를 건드리지 않기 위해서다.

응답 잘림은 위 표에 넣지 않는다. 에러가 아니라 성공 응답의 필드다. `log_read`는 `truncated`와
버려진 줄 수를 함께 돌려주고, 에이전트는 `limit`·`filter`로 좁혀 다시 부른다.

renderer 쪽 실패는 조용히 사라지지 않는다. SDK 미발견은 전용 안내 화면, 나머지는 기기 패널의
상태 표시로 드러난다.

## renderer UI

M1의 UI는 작게 만들되 M2·M3이 들어올 자리를 미리 비운다.

- **왼쪽 기기 패널** — AVD 목록과 실행 중 기기, 활성 기기 선택, 부팅·종료 버튼. 그 아래 정지
  스크린샷과 새로고침 버튼. **이 스크린샷 자리가 M2에서 스트리밍 캔버스로 바뀐다.** 바깥을
  "기기 화면 영역" 컴포넌트로 두고, 그 안의 내용만 M2에서 교체한다.
- **오른쪽 작업 영역** — 탭 구조. M1에는 **활동** 탭 하나뿐이다. MCP 툴 호출이 시각·툴 이름·
  인자 요약·성공 여부·소요 시간으로 한 줄씩 쌓인다. 필터·검색·상세는 M3다. M1에서 이것이
  필요한 이유는 디버깅이다. 에이전트가 무엇을 하는지 안 보이면 개발이 안 된다.
- **엔드포인트 카드** — URL, 토큰, 복사 버튼, 클라이언트 설정 JSON 통째 복사 버튼.

## IPC

Electron 보안 기본값을 켠다: `contextIsolation: true`, `nodeIntegration: false`, `sandbox: true`.
renderer는 Node를 보지 못한다.

preload는 `contextBridge`로 **좁은 API만** 노출한다. 임의 채널을 뚫는 범용 `invoke(channel, ...)`를
만들지 않는다. 채널은 화이트리스트이고 각 채널이 자기 인자 타입을 가진다.

- renderer → main (요청·응답): 스냅샷 조회, 기기 선택, 부팅, 종료, 스크린샷 갱신.
- main → renderer (일방 이벤트): 기기 연결·해제, 활성 기기 변경, 툴 호출 발생, 서버 상태 변경.

**renderer가 받는 권한은 위 목록이 전부다.** 임의 셸 실행이나 임의 adb 명령을 renderer에 열지
않는다. M2에서 입력 주입이 추가되지만 그것도 "이 기기에 이 좌표 탭"이라는 좁은 채널로 들어간다.

## 스파이크 — M1 초반, 버리는 코드

질문 하나만 답한다. **고정한 버전의 `scrcpy-server.jar`을 기기에 푸시하고 비디오 소켓을 열어서,
첫 H.264 키프레임을 받아 renderer의 WebCodecs `VideoDecoder`로 디코딩해 한 프레임을 그릴 수 있나?**

- 성공 기준은 화면에 기기 화면 한 장이 뜨는 것까지다. 거기서 멈춘다.
- 코드는 버린다. M2에서 처음부터 다시 쓴다.
- M1 끝이 아니라 초반에 한다. 실패하면 M2 설계를 통째로 다시 해야 하고, 늦게 알수록 비싸다.
- 실패 시 후퇴안: main에서 ffmpeg 디코딩, 또는 screencap 폴링. 둘 다 M2의 모양이 달라지며
  [ADR-0002](../../../adr/0002-screen-streaming-via-scrcpy-server.md)를 대체한다.

### 스파이크 결과 (2026-09-22)

- scrcpy 릴리스: `v4.1` (`vendor/scrcpy/VERSION`에 태그와 jar의 SHA-256을 고정했다.
  해시는 릴리스의 `SHA256SUMS.txt`와 일치한다)
- 소켓 연결: 성공 — `adb forward tcp:27183 localabstract:scrcpy` 뒤
  `app_process`로 `com.genymobile.scrcpy.Server`를 띄우고 `tunnel_forward=true`로
  붙었다. 서버가 dummy byte와 기기 이름 `SM-A356N`을 먼저 보냈다.
- H.264 수신: 성공 — codec id `h264`, session meta `472x1024`를 받은 뒤
  config 패킷 38바이트와 첫 키프레임 21927바이트가 왔다.
- WebCodecs 디코딩: 성공 — Electron renderer의 `VideoDecoder`를 `avc1.640020`으로
  `configure`하고 config 패킷 + 키프레임을 하나의 key `EncodedVideoChunk`로 넣으니
  output 콜백이 `472x1024` 프레임을 한 장 내놨다. 캔버스에 그린 결과가 기기 홈 화면이다.
- 판정: ADR-0002 유지
- M2 설계의 전제: 비디오 소켓은 길이 선두 프레이밍이라 Annex-B start code를 스캔할 필요가
  없다. 패킷 헤더 12바이트는 `ptsAndFlags` 8바이트(big-endian, bit 62 = config, bit 61 =
  키프레임, 하위 비트 = PTS 마이크로초)와 페이로드 길이 4바이트로 이루어진다. 그 앞에는
  dummy byte 1바이트, 기기 이름 64바이트, codec id 4바이트, session meta 12바이트가
  순서대로 온다. SPS/PPS는 첫 config 패킷에 Annex-B로 들어 있고, WebCodecs는 `description`을
  주지 않으면 Annex-B로 해석하므로 config 패킷을 키프레임 앞에 그대로 이어 붙이면 된다.
  `codec` 문자열은 SPS의 `profile_idc`·`constraint_flags`·`level_idc`에서 만든다.
  이 헤더 순서는 `send_dummy_byte`·`send_device_meta`·`send_stream_meta`·`send_frame_meta`가
  모두 기본값 true일 때의 것이고, 릴리스마다 달라질 수 있어 버전 고정이 전제다.

## 테스트

외부와 닿는 지점이 `adbClient` 하나다. 그것만 가짜로 바꾸면 위 다섯 층이 실기기 없이 덮인다.

- **단위** — `adbClient`를 가짜로 둔 상태에서 `AndroidDevice`, `DeviceRegistry`, `mcpTools`를 덮는다.
- **파싱 픽스처** — adb 출력 파싱은 **실제 출력을 떠서** 테스트한다. `adb devices -l` 출력,
  uiautomator XML 한 판, logcat 몇 줄. 손으로 지어낸 샘플로 검증하면 현실에서 깨진다.
- **툴 end-to-end** — MCP SDK의 인메모리 전송으로 HTTP 없이 툴 호출 전 경로를 돌린다.
- **보안 회귀** — 토큰 누락·오류 거부, 브라우저 `Origin` 거부, 루프백 외 바인드 없음을 고정한다.
- **응답 크기 회귀** — `ui_find` 요약 결과에 XML이 섞이지 않음, `screenshot` 기본 축소,
  `log_read` 상한을 고정한다.
- **통합** — 실제 에뮬레이터로 `adbClient`만, 적은 수로. 로컬에서 돌고 CI에서는 건너뛴다.

## 완료 조건

M1이 끝났다는 것은 아래가 성립한다는 뜻이다.

**에이전트 경로 (주된 기준).** Claude Code에 이 앱의 MCP 설정을 붙이고 다음 지시가 사람 개입
없이 끝까지 돈다.

> "이 APK를 설치하고 켜서, 로그인 화면 이메일 칸에 텍스트를 넣고, 화면을 찍어서 보여주고,
> 에러 로그가 있으면 알려줘."

`app_install` → `app_launch` → `ui_find` → `ui_tap` → `ui_text` → `screenshot` → `log_read`가
순서대로 성공하고, 그 호출들이 앱의 활동 탭에 순서대로 쌓여 있다.

**사람 경로.** 앱을 켜면 AVD 목록이 보인다. 하나를 골라 부팅하면 완료 시점에 상태가 바뀐다.
스크린샷이 뜨고 새로고침하면 갱신된다. 엔드포인트 카드에서 설정 JSON이 복사된다. SDK를 못
찾으면 무엇을 설치해야 하는지와 어디를 뒤졌는지가 뜬다.

**실패 경로.** 기기 없이 툴을 부르면 구조화된 에러가 온다. 기기가 둘인데 `serial`을 빼면 후보
목록이 온다. 토큰이 틀리면 거부된다. 브라우저 `Origin`을 달고 오면 거부된다.

**스파이크.** WebCodecs 디코딩 가능 여부에 대한 답이 나와 있고, 그 답이 M2 설계의 전제로 기록되어 있다.

### 검증 결과 (2026-09-23)

환경: macOS 호스트, AVD Pixel_7_API_36(API 36, `emulator-5554`), 클라이언트 Claude Code 2.1.280을
`claude -p`와 `--strict-mcp-config`로 이 앱의 MCP 설정만 붙였다. APK는 다른 프로젝트의 앱
(`com.teamyg.parfait`)이다. 이 앱의 첫 화면은 온보딩과 외부(카카오) 로그인 버튼뿐이라 위 지시문의
"로그인 화면 이메일 칸"이 없다. 그래서 지시문은 "첫 화면에서 텍스트 입력 칸 하나에 `test@example.com`을
넣고"로 바꿔 줬다.

- **에이전트 경로: 부분 성공.** 수정 뒤의 실행에서 원래 APK로 `app_install` → `app_launch` → `ui_find` →
  `screenshot` → `log_read`가 사람 개입 없이 성공했다. 에이전트는 첫 화면에 `EditText`가 없다고 보고하고
  외부 로그인을 누르지 않았으므로 `ui_tap`·`ui_text`는 원래 APK로 검증하지 못했다. 대신 설정 앱 검색창으로
  `app_launch` → `ui_find` → `ui_tap` → `ui_text test@example.com` → `screenshot`이 사람 개입 없이 성공했다.
  그 전의 실행에서 세 가지 결함이 나와 고쳤다. `app_install`의 서명 충돌이 일반 힌트만 달고 와서
  에이전트가 사람에게 물었고(`b38b1db`에서 복구 힌트 추가), `app_launch`가 `monkey` 방식으로 API 36
  에뮬레이터에서 exit 251로 실패했으며(에이전트는 런처 아이콘을 `ui_tap`해 스스로 우회했다.
  `60ea4f0`에서 resolve-activity로 교체), `log_read`의 들여쓴 JSON 응답(약 56KB)을 Claude Code가
  인라인하지 않았다(`ece1be9`·`eff1106`에서 압축 포맷·상한 축소·총량 예산. 수정 뒤 limit 200 요청이
  약 20.3KB, 기본 limit이 약 12.2KB로 인라인됐다). 활동 탭은 사람이 앞의 두 실행(`60ea4f0`·`ece1be9`·`c62dec0`
  수정 전)에 대해서만 봤다. 호출이 최신순으로, 실패는 `command_failed`와 함께 빨간색으로 쌓였고 순서가
  에이전트 기록과 맞았다. 그 뒤 실행의 활동 탭은 눈으로 확인하지 않았다.
- **사람 경로: 부분 성공.** AVD 목록이 보이고, 앱에서 종료·부팅하면 상태와 화면이 바뀌고, 스크린샷이
  뜨고, 엔드포인트 카드의 설정 JSON을 그대로 외부 에이전트 설정으로 붙여 연결했다. 처음에는 스타일이
  없어 2단 구성과 활성 기기 표시가 보이지 않았다. 최소 CSS(`97cca64`, `b375082`)로 2단 구성, 활성 행
  표시, 활동 행 간격, serial 줄 바꿈을 고쳤다. 간격·줄 바꿈 수정은 사람이 명시적으로 확인하지 않았다.
  새로고침으로 갱신되는지, 기기를 바꾸면 화면이 바뀌는지(에뮬레이터가 한 대뿐이었다), SDK를 못 찾을
  때의 안내 화면은 확인하지 않았다.
- **실패 경로.** 없는 serial의 `no_device`는 `details.candidates`를 달고 왔고 에이전트가 그 목록의 serial로
  다시 불러 복구했다. 기기가 없을 때의 `no_device`는 `device_list` → `device_boot` 힌트를 달고 왔고,
  에이전트는 `device_list`까지 부른 뒤 AVD가 여럿이라 어느 것을 부팅할지 사람에게 물었다. AVD 이름을
  주자 `device_boot` → `screenshot`이 성공했다. `package_not_found`·`apk_path_invalid`는 다음 행동을
  말하는 힌트를 달고 왔다(복구할 대상이 없어 복구는 해당 없음). `log_read`의 limit이 상한을 넘으면 MCP
  입력 스키마가 -32602로 거부하고, 메시지가 상한을 말한다. 기기가 둘인데 `serial`을 뺀 경우는 에뮬레이터
  두 대를 띄우지 않아 관찰하지 못했다.
- **보안 기본값: 전부 확인.** 토큰 없음 401, 틀린 토큰 401, `Origin` 헤더는 틀린 토큰이든 올바른 토큰이든
  403(`Origin` 검사가 먼저다), LAN 주소(`192.168.0.28:9321`) 접속은 연결 실패, `lsof`로 본 리슨 주소는
  `127.0.0.1:9321`뿐이다. 올바른 토큰의 `initialize`는 200이었다.
- **종료.** SIGTERM 한 번에 MCP 서버는 닫히지만 Electron 프로세스가 끝나지 않아 고아 프로세스가 남았다.
  `before-quit`에서 `preventDefault` 뒤 같은 틱의 마이크로태스크에서 `app.quit()`을 다시 부르면 생기는
  현상이었고, `c62dec0`에서 재종료를 `setImmediate`로 미뤄 고쳤다. 빌드한 앱에서 SIGTERM 한 번으로
  `will-quit`까지 가고 exit 0으로 끝나는 것을 확인했다.
- **실기기 통합 테스트.** `npm run test:integration`이 실제 에뮬레이터(`emulator-5554`)로 `adbClient`를
  돌려 통과했다. 기본 `npm test`에는 들어가지 않는다. 에뮬레이터 출력으로 뜬 파서 픽스처를 실기기
  픽스처 옆에 더했다.

**남은 결함과 확인하지 못한 것.**

- `app_reset_and_launch`의 첫 화면 안정 판정(`waitForSettle`)은 어떤 실제 실행에서도 불리지 않았다.
- `ui_find`의 노드 상한(`UI_FIND_MAX_NODES`)에 닿는 화면을 만나지 못했다. 관찰한 가장 큰 응답은 홈 화면
  약 6.8KB였고, `query` 없이 부른 검색 화면의 설정 앱도 상한에 훨씬 못 미치는 노드 수였다. 상한에서의 `truncated: true`는 실기기로 관찰하지 못했다.
- 오래된 adb에서 설치 실패가 stdout에 찍히고 exit 0으로 끝나는 경우는 다루지 않는다. 이 기계의 adb에서는
  관찰되지 않았다(충돌은 non-zero exit와 stderr로 왔다). 그 경우 `AndroidDevice.install`의 패키지 목록
  비교가 새 패키지를 찾지 못해 이름을 지어내지는 않지만, 설치 실패가 실패로 보고되지는 않는다.
- `app_launch`의 `activity` 등 컴포넌트 이름이 이스케이프 없이 원격 셸로 넘어간다. 중첩 클래스 이름의
  `$`가 셸에서 해석될 수 있다.
- 에뮬레이터가 없고 AVD가 여럿이면 에이전트가 부팅할 AVD를 스스로 고르지 않고 사람에게 묻는다. 결함이라기보다
  관찰이다 — 힌트가 어느 AVD를 고르라고 말하지 않는다.
- 서버 시작 실패의 이유가 renderer에 보이지 않는다(M1-4에서 넘어온 항목).
- 앱 종료 시 `stop()`에 시간 제한이 없다. `stop`이 끝나지 않으면 종료도 끝나지 않는다. 실제로 멈춘 적은 없다.
- HTTP 수준의 `tools/call`에는 자동화된 통합 테스트가 없다. 실제 클라이언트로 손으로만 확인했다.
- 실제 실행에서 한 번도 불리지 않은 툴: `app_reset_and_launch`, `ui_swipe`, `ui_key`, `app_stop`,
  `app_clear_data`, `app_grant_permission`, `app_uninstall`, MCP를 통한 `device_shutdown`(앱의 종료
  버튼으로는 해 봤다).
- `log_read`의 `filter`는 태그·메시지 텍스트에만 걸린다. 에이전트가 로그 레벨로 거르기를 원했다.
- UI는 최소 CSS뿐이고 디자인이 아니다.

## 열린 질문

- `app_reset_and_launch`의 "첫 화면 안정" 판정 기준. 지금은 UI 덤프의 요소 구성이 연속 두 번 같으면
  안정으로 보지만(`app.ts`의 `waitForSettle`), 실제 앱으로 돌려 보지 못했다. 스플래시가 길거나 애니메이션이
  도는 앱에서 충분한지는 아직 모른다.
- `device_boot` 직후 곧바로 `app_install`을 해도 되는지. `sys.boot_completed`만으로 부팅 직후 스크린샷은
  충분했지만, 패키지 매니저 준비까지 봐야 하는지는 확인하지 못했다.
