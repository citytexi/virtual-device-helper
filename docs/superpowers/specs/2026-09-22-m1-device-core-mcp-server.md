---
id: m1-device-core-mcp-server
title: M1 — 기기 코어와 MCP 서버
status: draft
verified: 2026-09-22
scope: [main, renderer, preload, mcp, android, build]
hosts: [macos]
supersedes:
superseded_by:
related_adr: [ADR-0001, ADR-0002, ADR-0003, ADR-0004, ADR-0005, ADR-0006, ADR-0007]
related_spec:
related_architecture:
related_plan:
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

main 프로세스를 여섯 층으로 쌓는다. 근거는 [ADR-0005](../../adr/0005-device-interface-abstraction.md).

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
[ADR-0004](../../adr/0004-hybrid-mcp-tool-surface.md).

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
- **`screenshot`은 기본으로 축소한다.** 긴 변 기준으로 줄여 보낸다. `scale`로 올릴 수 있으나
  기본값이 작다. 원본 해상도가 필요한 쪽은 사람이고, 사람은 앱 화면으로 본다.
- **`log_read`는 기본 limit과 상한을 함께 가진다.** 인자로도 상한을 넘을 수 없다. 잘렸으면
  잘렸다는 사실과 남은 양을 함께 돌려준다.

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

### 서버 수명

서버는 앱과 함께 살고 함께 죽는다. 앱을 닫으면 진행 중이던 요청을 종료 에러로 마감한다.

### 포트와 토큰

기본 포트가 점유되어 있으면 다음 빈 포트로 넘어간다. 실제로 열린 포트를 UI에 표시한다.
토큰은 앱 실행 시 무작위로 만든다. 세부는 [ADR-0001](../../adr/0001-mcp-transport-http-in-app.md).

### SDK 탐색

앱 시작 시 `ANDROID_HOME` → `ANDROID_SDK_ROOT` → macOS 기본 위치 → `PATH` 순으로 찾는다.
못 찾으면 안내 화면을 띄운다. 세부는 [ADR-0003](../../adr/0003-no-bundled-android-sdk.md).

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
  [ADR-0002](../../adr/0002-screen-streaming-via-scrcpy-server.md)를 대체한다.

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

## 열린 질문

- `app_reset_and_launch`의 "첫 화면 안정" 판정 기준. 고정 대기, UI 덤프 변화 관찰, 또는 로그
  신호 중 무엇을 쓸지는 실제 앱으로 시도해 보고 정한다.
- `ui_find` 요약에서 버릴 노드의 기준. 보이지 않는 노드 제거만으로 충분한지, 컨테이너 노드도
  접어야 하는지는 실제 덤프를 보고 정한다.
- `device_boot`의 부팅 완료 판정. `sys.boot_completed` 하나로 충분한지, 패키지 매니저 준비까지
  봐야 하는지 확인이 필요하다.
