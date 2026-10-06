---
id: m4-ios-simulator
title: M4 — iOS 시뮬레이터 지원
status: in-progress
verified: 2026-10-06
scope: [main, renderer, preload, mcp, shared, ios, streaming]
hosts: [macos]
supersedes:
superseded_by:
related_adr: [ADR-0014, ADR-0015, ADR-0016, ADR-0005, ADR-0003, ADR-0008, ADR-0010, ADR-0011, ADR-0012, ADR-0013]
related_spec: [m1-device-core-mcp-server, m2-live-streaming, m3-node-control-logs-events, agent-guide]
related_architecture: main-layers
related_plan: [m4-1-ios-foundation, m4-2-ios-input-nodes, m4-3-ios-streaming]
related_code: [device.ts#Device, device.ts#DeviceInfo, device.ts#UiNode, device.ts#AvdEntry, errors.ts#ToolErrorKind, registry.ts#createDeviceRegistry, avdController.ts#AvdController, index.ts#createDeviceStack, bootstrap.ts#assembleWithoutSdk, nodeRefs.ts, logManager.ts#LogManagerDeps, streamManager.ts#StreamManagerDeps, streamSession.ts#StreamSession, rejectingSession.ts#createPlatformStreamSession, rejectingSession.ts#createIosStreamSessionFactory, axeStreamSession.ts#createAxeStreamSession, axeControl.ts#createAxeControl, iosKeys.ts#IOS_KEY_ARGS, mjpegSplitter.ts#createMjpegSplitter, jpegRenderer.ts#createJpegRenderer, stream.ts#StreamDown, stream.ts#ControlIntent, streamDecoder.ts, layering.test.ts, agentGuide.ts]
tags: [spec, ios, simulator, axe]
---

# M4 — iOS 시뮬레이터 지원

> 상태·날짜·관련 문서는 위 frontmatter가 단일 출처. 본문은 설계 내용에 집중한다.

## 목표

iOS 시뮬레이터를 Android 에뮬레이터와 거의 같은 수준으로 다룬다. 에이전트는 MCP로 시뮬레이터를
부팅하고, 앱을 설치·실행하고, 노드로 조작하고, 스크린샷과 로그로 검증한다. 사람은 앱 창에서 iOS
화면을 실시간으로 보고 마우스로 조작한다.

로드맵은 M4를 "`simctl` 기반 `Device` 구현체"로 적었다. 그러나 `simctl`에는 입력 주입, 접근성
트리, 실시간 스트림이 없다. 이 세 가지는 AXe로 채운다([ADR-0014](../../adr/0014-ios-control-via-axe.md)).

## 범위

M4는 세 단계로 나눠 계획하고 구현한다. 스펙은 하나, 계획은 단계마다 하나다.

**M4-1 — 기반.** iOS 시뮬레이터가 기기 목록에 뜨고 앱 수명주기와 관찰이 된다.

- `Device` 인터페이스를 넓힌다([ADR-0015](../../adr/0015-platform-difference-surface.md)).
- `simctlClient`, `IosDevice`(입력·`dumpUi` 제외), simctl 추적 폴링, 시뮬레이터 목록·부팅·종료.
- MCP `log_read`와 앱 로그 패널에 iOS 로그.
- AXe 스파이크. 결과를 이 스펙의 "스파이크 결과"에 남기고 M4-2·M4-3 설계를 고친다.
- 완료 기준: 에이전트가 MCP로 시뮬레이터를 부팅하고, `.app`을 설치·실행하고, 스크린샷과 로그를
  읽는다. 앱 로그 패널에 iOS 로그가 흐른다.

**M4-2 — 입력과 노드.**

- `axeClient`, `IosDevice`의 `tap`/`swipe`/`inputText`/`pressKey`/`dumpUi`.
- `ui_find`, ref 탭, [ADR-0011](../../adr/0011-node-ref-revalidation.md) 재검증이 iOS에서 돈다.
- 완료 기준: 에이전트가 `ui_find` → `ui_tap` → `ui_text`로 iOS 앱의 입력 흐름을 끝낸다.

**M4-3 — 스트리밍과 화면 입력.**

- `StreamSession` 인터페이스, `AxeStreamSession`, renderer JPEG 경로
  ([ADR-0016](../../adr/0016-stream-codec-per-session.md)).
- 화면 `ControlIntent`를 AXe로 보낸다.
- 완료 기준: 앱 창에 iOS 화면이 실시간으로 보이고 마우스로 조작된다.

**제외**

- 실기기 iOS.
- Windows 호스트의 iOS. Windows에서는 iOS 스택을 조립하지 않는다.
- 시뮬레이터 생성·삭제(`simctl create`/`delete`). AVD 생성처럼 별도 스펙으로 둔다.
- 오디오, 녹화, 클립보드 동기화.
- 여러 기기 동시 스트림. M2 제외 범위를 그대로 따른다.

## 외부 도구

사용자가 설치한 도구를 쓴다. 번들하지 않는다. [ADR-0003](../../adr/0003-no-bundled-android-sdk.md)의
Android SDK 방침과 같다.

| 도구 | 쓰는 곳 | 없을 때 |
|---|---|---|
| Xcode의 `xcrun simctl` | 기기 추적, 수명주기, 앱, 권한, 스크린샷, 로그 | iOS 스택을 조립하지 않는다 |
| AXe (`brew install cameroncooke/axe/axe`) | 입력, 노드 트리, 스트림 | 해당 호출만 `ios_tool_not_found` |

## 인터페이스

### `Device` 변경 (M4-1)

`src/shared/types/device.ts`를 고친다. 원칙은 [ADR-0005](../../adr/0005-device-interface-abstraction.md)
그대로다. 위층은 타깃 이름으로 분기하지 않는다.

```ts
export type Platform = 'android' | 'ios'

export interface DeviceInfo {
  serial: string
  platform: Platform
  model: string
  /** 사람이 읽는 OS 버전. Android "14 (API 34)", iOS "26.0". */
  osVersion: string
  width: number
  height: number
}

export interface UiNode {
  // ...기존 필드
  /** 입력하면 text가 바뀌는 노드. 지문에서 text를 뺄지 이 필드로 정한다. */
  editable: boolean
}

export interface VirtualDeviceEntry {
  platform: Platform
  /** 부팅 대상을 가리키는 값. AVD는 이름, 시뮬레이터는 UDID다. 시뮬레이터 이름은 런타임마다 겹친다. */
  id: string
  /** 사람이 읽는 이름. AVD 이름 또는 시뮬레이터 이름. */
  name: string
  running: boolean
  serial: string | null
  osVersion: string | null
}

export interface Device {
  /** Android는 adb serial, iOS는 시뮬레이터 UDID. */
  readonly serial: string
  /** 표시와 기록에만 쓴다. 위층이 이 값으로 분기하지 않는다. */
  readonly platform: Platform
  /** .apk 파일 또는 .app 디렉토리. 반환값은 패키지명 또는 bundle id. */
  install(appPath: string, opts?: InstallOpts): Promise<string | null>
  // ...나머지 시그니처는 그대로
}
```

- `DeviceInfo.apiLevel`은 없앤다. 쓰는 곳은 `androidDevice.ts`뿐이다.
- `serial` 이름은 유지한다. 바꾸면 registry·MCP 툴·IPC·renderer를 모두 고치는데 얻는 것이 없다.
  UDID와 `emulator-5554` 형식은 겹치지 않는다.
- `AvdEntry`는 `VirtualDeviceEntry`로 바꾼다. `AvdController`는 `VirtualDeviceCatalog`의 한
  구현이 된다. 시뮬레이터 쪽 구현이 하나 더 붙는다.
- MCP `device_list`는 `virtualDevices: VirtualDeviceEntry[]`를 돌려준다. `device_boot`의 인자는
  `avd`에서 `id`로 바뀐다. 값은 `device_list`의 `id`다.
- IPC도 같이 바뀐다. 스냅샷 `avds` → `virtualDevices`, 이벤트 `avds_changed` →
  `virtual_devices_changed`, `bootAvd(name)` → `bootVirtualDevice(id)`.
- renderer 기기 패널은 두 플랫폼 항목을 한 목록에 그리고 플랫폼 라벨을 붙인다. `platform`은
  라벨로만 쓰고 분기에 쓰지 않는다.

### 에러 (M4-1)

`ToolErrorKind`에 둘을 더한다.

- `unsupported` — 이 기기가 할 수 없는 동작. 메시지에 플랫폼과 이유를 넣는다.
- `ios_tool_not_found` — `xcrun` 또는 `axe`가 없다. 메시지에 설치 안내를 넣는다.

능력 조회 API(`capabilities()`)는 만들지 않는다. 이유는 ADR-0015에 있다.

### iOS에서 달라지는 `Device` 동작

| 메서드 | iOS 동작 |
|---|---|
| `install(appPath)` | `simctl install`. `.app`의 `Info.plist`에서 `CFBundleIdentifier`를 읽어 돌려준다 |
| `uninstall` / `stop` | `simctl uninstall` / `simctl terminate` |
| `launch(pkg, activity?)` | `simctl launch`. `activity`가 오면 `unsupported` |
| `clearData(pkg)` | 앱을 종료하고 `simctl get_app_container <udid> <bundle> data` 안쪽을 비운다 |
| `grantPermission(pkg, permission)` | `simctl privacy <udid> grant <permission> <bundle>`. `permission`은 `photos`, `camera`, `location` 같은 서비스 이름 |
| `screenshot` | `simctl io <udid> screenshot --type=png <임시 파일>`을 읽는다. stdout(`-`)으로는 못 받는다(스파이크 7). 축소는 Android와 같은 `resizeImage.ts`를 쓴다 |
| `readLogs` / `clearLogs` | 아래 "로그" 절 |
| `displayFrame` | point 단위 화면 크기. `describe-ui` 루트 `AXFrame`에서 읽는다 |
| `tap` / `swipe` / `inputText` / `pressKey` / `dumpUi` | 아래 "입력과 노드" 절. M4-1에서는 `unsupported` |

`app_reset_and_launch`는 마지막에 `dumpUi`로 화면이 멎기를 기다린다. M4-1의 iOS에서는 `dumpUi`가
`unsupported`라, 이 에러일 때만 대기를 건너뛰고 `settleSkipped: 'unsupported'`를 붙여 성공으로 돌려준다.
M4-2에서 `dumpUi`가 붙으면 자연히 대기한다.

MCP 툴 인자 이름 `pkg`는 그대로 두고, 설명을 "패키지명 또는 bundle id"로 넓힌다. `app_install`의
설명과 `app_grant_permission`의 예시에 두 플랫폼을 함께 적는다. `src/shared/agentGuide.ts`에 iOS
차이(`back` 없음, `activity` 없음, 권한 이름)를 더하고 `guideConsistency.test.ts`를 통과시킨다.

## 동작

### main 층 구조

```
adbClient    → AndroidDevice ┐
simctlClient → IosDevice     ├→ DeviceRegistry → mcpTools → mcpHttpServer → ipcBridge
axeClient ───→ IosDevice     ┘
```

- `simctlClient`(`src/main/ios/simctlClient.ts`)는 `xcrun simctl` 문법을 아는 유일한 층이다.
  `exec(args)`와 `stream(args)`를 가진다. 모양은 `adbClient`와 같다.
- `axeClient`(`src/main/ios/axeClient.ts`)는 `axe` 문법을 아는 유일한 층이다. 모든 호출에
  `--udid`를 붙인다.
- 두 클라이언트 모두 셸을 거치지 않고 `execFile`/`spawn`으로 부른다.
- `IosDevice`(`src/main/device/iosDevice.ts`)가 두 클라이언트 출력을 파싱한다. 파서는
  `src/main/device/parsers/`에 둔다.
- mcp 층은 `ios/`와 `iosDevice`를 import하지 못한다. `layering.test.ts`에 규칙을 더한다.

### 기기 추적

- `simctl`에는 `track-devices` 같은 스트림이 없다. `simctl list devices booted -j`를 2초마다
  폴링하고 이전 결과와 비교해 연결·해제를 만든다.
- registry는 하나다. `DeviceRegistryDeps.track` 콜백에 `platform`을 더하고,
  `createDevice(serial, platform)`이 구현체를 고른다. 이 분기는 조립 지점(`createDeviceStack`)에만
  있다.
- 폴링이 연속 3회 실패하면 `tracking_failed`를 낸다. adb 쪽과 같은 이벤트라 renderer는 이미
  처리한다.

### 조립

- 지금 `bootstrap.ts`는 Android SDK가 없으면 `assembleWithoutSdk`로 MCP 서버 없이 앱을 띄운다.
- 바꾼 뒤에는 플랫폼마다 따로 조립한다. Android와 iOS 중 하나라도 준비되면 MCP 서버를 띄운다.
- iOS 스택 조건: `process.platform === 'darwin'`이고 `xcrun simctl help`가 성공한다.
- `axe`가 없어도 M4-1 기능은 모두 돈다. 입력·`dumpUi`·스트림만 `ios_tool_not_found`를 낸다.
- 스냅샷의 `sdk: SdkStatus`는 플랫폼별 `platforms: { android: PlatformStatus; ios: PlatformStatus }`
  로 바뀐다. 둘 다 준비되지 않았을 때만 안내 화면(`SdkMissing`)을 띄우고 두 플랫폼의 안내를 함께
  보여 준다. 하나만 준비됐으면 기기 패널 위에 빠진 쪽 안내를 한 줄로 띄운다.
- M4-1에서 iOS 기기로 스트림을 열면 조립 지점이 `unsupported`로 거절했다. M4-3부터는 AXe 스트림 세션을
  열고, AXe가 없을 때만 `ios_tool_not_found`로 거절한다. 거절되면 renderer는 기존 강등 경로대로
  스크린샷을 보여 준다.

### 로그

**MCP `log_read`**

- `readLogs`는 `simctl spawn <udid> log show --style ndjson --start <시각>`이다.
- 시작 시각은 `since`가 있으면 그것, 없으면 마지막 `clearLogs` 워터마크, 그것도 없으면 최근 5분이다.
- `filter`는 `--predicate`로 좁혀 `log show`의 비용을 줄인다. `pids`가 있으면 `processID IN {…}`(정수만)를
  predicate에 AND로 더한다. 최종 pid 판정은 줄을 파싱한 뒤 한 번 더 한다.
- 출력은 `simctl.stream`으로 줄 단위로 읽고 마지막 `limit`줄만 고리 버퍼에 남긴다. 한가한 시뮬레이터도
  5분 창이면 출력이 매우 커서 `exec`로 통째로 모으지 않는다. 제한 시간을 넘기면 스트림을 닫고
  `device_unresponsive`로 끝낸다.
- `clearLogs`는 iOS 통합 로그를 지울 수 없어서 워터마크 시각만 기록한다. 에이전트가 보는 의미는
  Android와 같다.
- 압축 형식과 예산([ADR-0008](../../adr/0008-log-read-response-shape.md))은 mcp 층에 있어 그대로다.

**`LogLine` 매핑**

| iOS ndjson | `LogLine` |
|---|---|
| `messageType` `Debug` / `Info` / `Default` / `Error` / `Fault` | `level` `D` / `I` / `I` / `E` / `F` |
| `subsystem`, 비었으면 프로세스 이름 | `tag` |
| `processID` | `pid` |
| `timestamp` (`2026-09-30 14:40:14.608720+0900`) | `timestamp`, 앞 두 부분을 `MM-DD HH:mm:ss.SSS`로 자른다. 오프셋은 epoch 계산에만 쓴다 |
| `eventMessage` | `message` |

iOS에는 W와 V에 해당하는 레벨이 없다. 쓰지 않는다.

ndjson에는 `eventType`이 `activityCreateEvent`인 줄도 섞여 나온다. 이 줄은 `messageType`과 `source`가 없고
`eventMessage`는 비어 있다. `eventType`이 `logEvent`가 아닌 줄은 버린다.

**앱 로그 패널**

- `LogManagerDeps`의 `createTail`/`seedPids`/`pidof`는 adb 전용이다. `iosLogDeps.ts`가 iOS 쪽을
  구현하고, 조립 지점의 라우터가 serial의 platform으로 고른다. `logManager` 본체는 그대로다.
- tail은 `simctl spawn <udid> log stream --style ndjson`이다. 기본은 info 이상이다.
- `seedPids`와 `pidof`는 `simctl spawn <udid> launchctl list`를 쓴다.
  `UIKitApplication:<bundle id>[...]` 줄에서 bundle id와 pid를 함께 얻는다.
- `pidTracker`는 Android `ActivityManager`의 `Start proc` 줄로 새 프로세스를 배운다. iOS에는 이 줄이
  없다. 그래서 iOS는 연결 시 seed와 `log_read`의 `pidof`(지금 떠 있는 앱)로만 pid를 안다.
  연결 뒤 실행했다가 이미 죽은 앱의 로그는 `package`로 찾지 못한다. 알려진 한계로 두고 M4-1 완료
  검증에서 실제로 문제가 되는지 본다.
- iOS 로그는 양이 많다([ADR-0013](../../adr/0013-log-transport-dedicated-port.md)). 링 버퍼 용량은
  그대로 두고, M4-1 완료 검증 때 초당 줄 수를 재어 넘치면 그때 조정한다.

### 입력과 노드 (M4-2)

**좌표.** AXe는 point 좌표를 쓴다. `IosDevice.displayFrame()`이 point 크기를 주므로 mcp 층의
`toPixel`은 고치지 않아도 point를 낸다. 스크린샷은 실제 픽셀이지만 툴 좌표가 0..1이라
([ADR-0012](../../adr/0012-normalized-tool-coordinates.md)) 상관없다.

**입력 매핑**

| `Device` | AXe |
|---|---|
| `tap(x, y)` | `tap -x -y` |
| `swipe(x1, y1, x2, y2, durationMs)` | `swipe --start-x --start-y --end-x --end-y --duration <초>` |
| `inputText(text)` | 모든 텍스트를 `simctl pbcopy <udid>`의 stdin으로 클립보드에 넣고 `key-combo --modifiers 227 --key 25`(Cmd+V)로 붙여 넣는다. 텍스트는 인자로 넘기지 않는다. `type --stdin` 갈래는 두지 않는다 — `type`은 ASCII만 받고, 시뮬레이터 키보드가 한국어면 ASCII도 활성 배열을 거쳐 깨지기 때문이다(스파이크 3) |
| `pressKey('home')` | `button home` |
| `pressKey('enter')` / `pressKey('tab')` | `key 40` / `key 43` (HID keycode) |
| `pressKey('back')` | `unsupported` |

- `inputText`는 입력할 때마다 시뮬레이터 pasteboard를 덮어쓴다. 이전 클립보드를 되돌리지 않는다. 복원은
  M4-3에서 검토하고 만들지 않기로 했다(이유와 호스트 클립보드 측정은 "M4-3 검증 결과").

**노드: `describe-ui` → `UiNode`**

| AX 속성 | `UiNode` |
|---|---|
| `type` (Button, TextField, StaticText …) | `className` |
| `AXUniqueId` (`accessibilityIdentifier`) | `resourceId` |
| `AXLabel` | `contentDesc` |
| `AXValue`, StaticText는 `AXLabel` | `text` |
| `AXFrame` ÷ `displayFrame` | `bounds` |
| `enabled` | `enabled` |
| 역할이 Button·Link·Cell·Switch·TextField 계열 | `clickable` |
| 역할이 ScrollView·Table·CollectionView | `scrollable` |
| 역할이 TextField·SecureTextField·TextView | `editable` |
| 얻을 수 없다 | `focused`는 `false` |

- 빈 Group 버리기, `index`/`parentIndex` 규칙은 Android `parseUiDump`와 같은 원칙이다.
- 실제 `describe-ui` JSON은 최상위가 배열이고 노드마다 `frame`(`x`,`y`,`width`,`height` 숫자)과
  `AXFrame`(같은 값의 문자열)을 함께 준다. 문자열을 파싱하지 않고 `frame`을 쓴다.
- `type`은 Application, Group, Image, Button, StaticText, Heading, Slider, TextField로 나왔다.
  Cell은 따로 없고 목록 한 줄이 Button이나 Group이다. 위 표의 Cell·Link 등은 방어적으로 둔다.
- 빈 TextField의 `AXValue`에는 placeholder가 들어 있다(설정 앱 검색 필드는 `검색`). 이것을 걸러 내지 않고
  `text`로 그대로 둔다. `nodeRefs.ts`의 `ownFingerprint`가 `editable` 노드의 text를 지문에서 빼므로 입력으로
  값이 바뀌어도 ref는 살아 있다. Android uiautomator도 빈 입력칸의 hint를 `text`로 내므로 두 플랫폼이 같다.
- `nodeRefs.ts`의 `ownFingerprint`는 `className`이 `EditText`로 끝나는지 대신 `UiNode.editable`로 text를 뺀다.
  Android 파서(`uiDump.ts`)는 `EditText` 계열에, iOS 파서(`axeUi.ts#parseAxeUi`)는 TextField 계열에
  `editable: true`를 채운다. ADR-0011에 이 변경을 적었다.

### 스트리밍과 화면 입력 (M4-3)

**main.** `StreamManagerDeps.createSession`이 돌려주는 타입은 `streamSession.ts`의 `StreamSession`
인터페이스(`start`/`sendControl(intent)`/`close`와 `StreamSessionHandlers`)다. `ScrcpySession`과
`axeStreamSession.ts`의 `createAxeStreamSession`이 구현한다. 재연결·포트 관리는 `streamManager` 본체에
그대로 둔다. 어느 세션을 쓸지는 조립 지점이 platform으로 고른다. `rejectingSession.ts`의
`createPlatformStreamSession`이 라우터이고, iOS 기기에는 `createIosStreamSessionFactory`가 만든 세션을,
AXe를 못 찾았으면 `ios_tool_not_found`로 거절하는 세션을 준다. `streamManager`는 플랫폼을 모른다.

`AxeStreamSession`은 `axe stream-video --udid <udid> --format mjpeg --fps <n> --scale <s> --quality <q>`
를 띄우고 stdout을 JPEG 한 장 단위로 자른다. 시작값은 fps 30, scale 0.5, quality 70이고
`axeStreamSession.ts`의 `STREAM_ARGS` 한 곳에 둔다.
stdout은 순수 JPEG 연결이 아니라 `HTTP/1.1 200 OK` 헤더로 시작하는 `multipart/x-mixed-replace`다(스파이크 4).
`mjpegSplitter.ts`의 `createMjpegSplitter`가 각 파트를 `Content-Length`로 자르고, 본문이 SOI(`FF D8`)로 시작해
EOI(`FF D9`)로 끝나는지 확인한다. 어긋난 파트는 버리고 다음 경계로 다시 맞춘다. `--scale 1.0`과
`--quality 80`(둘 다 기본값)이면 파트가 JPEG가 아니라 PNG로 나오므로 기본값에 기대지 않고 항상 명시한다.
화면 크기는 `jpegSize.ts`의 `jpegSize`가 프레임에서 읽는다. 크기가 달라진 프레임이 오면 `session`을 다시 올린다.

**포트 메시지** (`src/shared/types/stream.ts`)

```ts
export type StreamDown =
  | { type: 'status'; status: SessionStatus }
  | { type: 'session'; width: number; height: number; codec: 'h264' | 'jpeg'; keys: DeviceKey[] }
  | { type: 'packet'; config: boolean; key: boolean; ptsUs: number | null; data: Uint8Array }
  /** JPEG 한 장. 크기는 session 메시지가 이미 알렸다. */
  | { type: 'frame'; data: Uint8Array }
```

**renderer.**

- `session.codec`으로 디코더를 고른다. `h264`는 지금의 `streamDecoder`, `jpeg`는 새 `jpegRenderer`다.
- `jpegRenderer`는 `createImageBitmap(blob)`으로 디코드해 canvas에 그린다. 디코드 중 새 프레임이
  오면 최신 한 장만 남긴다. 지연이 쌓이지 않게 한다.
- 캔버스 크기는 두 코덱 경로 모두 `session`이 알린 크기를 따르고, 그릴 때는 프레임을 캔버스 크기에 맞춘다.
  프레임 크기가 `session`과 잠깐 어긋나도 입력 좌표의 기준(`session` 크기)과 화면이 같은 틀을 쓴다.
- 깨진 JPEG 한 장은 건너뛴다. 디코드·그리기가 연속으로 `jpegRenderer.ts`의 `MAX_CONSECUTIVE_FAILURES`만큼
  실패하면 h264 디코더의 치명 오류와 같은 경로로 스트림을 끝낸다. 조용히 멈춘 화면을 두지 않기 위해서다.
- 툴바 키 버튼은 `session.keys`에 있는 것만 그린다. renderer는 `platform`을 읽지 않는다.

**화면 입력.** 변환은 `axeControl.ts`의 `createAxeControl`에 모은다. Android의 `scrcpyProtocol`과 같은 자리다.

- AXe `touch`에는 move가 없고 호출마다 프로세스가 뜬다. 그래서 제스처를 main에 모은다.
  - `down`: 시작점과 시각을 적는다.
  - `move`: 끝점만 갱신한다.
  - `up`: 이동이 작으면 `tap`, 크면 `swipe`(시작점→끝점). `duration`은 `down`에서 `up`까지의 실제 경과
    시간이고 `up`을 받은 때에 잰다. 줄에서 기다린 시간은 넣지 않는다.
- 알려진 한계: 드래그가 손을 뗀 뒤에 한 번에 반영되고, 곡선 경로가 직선이 된다. 스파이크에서
  `batch --stdin`은 EOF까지 읽은 뒤에야 실행하므로(스파이크 5) 이 방식이 확정이다.
- AXe 호출은 기기당 한 줄로 세워 한 번에 하나만 돈다. 실패한 호출은 줄을 끊지 않는다.
- `VideoPoint`(JPEG 프레임 픽셀)를 `displayFrame`(point) 비율로 바꾸고 화면 안으로 자른다. `displayFrame`은
  제스처마다 `IosDevice.displayFrame`으로 다시 잰다.
- `scroll`은 그 위치의 짧은 `swipe`다. 축 의미는 Android와 같아서 양수가 뷰포트를 오른쪽·위로 보낸다.
  그래서 손가락은 `hScroll > 0`이면 왼쪽으로, `vScroll > 0`이면 아래로 간다. 이동 거리는 세로가
  `displayFrame.height × 0.15`, 가로가 `displayFrame.width × 0.15`에 `clamp(값, -1, 1)`을 곱한 것이다.
- 휠은 초당 수십 번 오는데 AXe 호출은 느리다. 그래서 `scroll`은 합친다. 줄에서 아직 시작하지 않은
  `scroll`이 줄의 끝에 있으면 새 `scroll`은 거기에 더해지고(양은 합, 위치는 최신) 기다리는 `scroll`은
  많아야 하나다. 탭·스와이프·키·텍스트는 합치거나 버리지 않는다.
- `text`는 `axe type`을 쓰지 않고 `IosDevice.inputText`(`simctl pbcopy` + ⌘V)로 간다. `type`은 ASCII만 받고
  시뮬레이터 키보드가 한국어면 ASCII도 깨지기 때문이다(스파이크 3, M4-3 검증에서 다시 봤다).
  `createIosStreamSessionFactory`가 이 호출을 `registry.run` 기기 큐에 세운다. MCP `ui_text`와 같은 줄이라
  한쪽의 `pbcopy`와 ⌘V 사이에 다른 쪽이 끼어들지 못한다. 탭·스와이프·키는 공유 상태가 없어 기기 큐에
  세우지 않는다. 세우면 사람 입력이 `app_install` 같은 긴 MCP 작업 뒤에서 기다린다.
- 입력 뒤 시뮬레이터 클립보드를 되돌리지 않는다. 복원을 검토했으나 만들지 않았다. ⌘V는 `key-combo`가
  돌아온 뒤에 비동기로 처리되므로 곧바로 되돌리면 이전 내용이 붙을 수 있다.
- `key`는 `iosKeys.ts`의 `IOS_KEY_ARGS` 표 하나를 쓴다(HID keycode, `home`은 `button home`, `power`는
  `button lock`). 세션이 알리는 `keys`(`IOS_KEYS`)도 이 표에서 나온다. iOS `keys`에는 `back`, `app_switch`,
  `volume_up`, `volume_down`이 없고, 표에 없는 키가 와도 호출하지 않는다.

**스트림 실패.** 지금처럼 스크린샷 PNG로 강등한다.

## 실패 처리

| 상황 | 결과 |
|---|---|
| macOS가 아니거나 `xcrun simctl`이 없다 | iOS 스택을 조립하지 않는다. Android는 그대로다 |
| `axe`가 없다 | 입력·`dumpUi`·스트림 호출이 `ios_tool_not_found`. 설치 안내 포함 |
| iOS에 없는 동작(`back`, `activity`) | `unsupported`. 플랫폼과 이유 포함 |
| simctl 폴링 연속 실패 | `tracking_failed`. renderer가 추적 중단을 표시한다 |
| `.app`에서 bundle id를 못 읽는다 | `apk_path_invalid`를 `app_path_invalid`로 이름을 넓혀 쓴다 |
| 노드 재검증 실패 | Android와 같은 `stale_ref` |
| `stream-video` 종료 | 기존 재연결 정책, 실패하면 스크린샷으로 강등 |

## 테스트

- **단위.** `fakeSimctl()`, `fakeAxe()`를 `fakeAdb()`와 같은 모양으로 만든다. `IosDevice`, 추적
  폴링, `iosLogDeps`, `AxeStreamSession`, `axeControl`을 실기기 없이 검증한다.
- **fixture.** 파서 테스트는 실제 출력만 쓴다. `simctl list -j`, `log show`/`log stream` ndjson,
  `launchctl list`, `describe-ui` JSON, MJPEG stdout 조각을 M4-1 스파이크에서 채집해
  `__fixtures__/ios/`에 둔다. 손으로 지어낸 fixture는 쓰지 않는다.
- **계약.** 같은 `Device` 시나리오를 `AndroidDevice`(가짜 adb)와 `IosDevice`(가짜 simctl·axe)에
  돌린다. 두 구현의 의미가 같은지 본다.
- **층.** `layering.test.ts`: mcp 층은 `ios/`·`iosDevice`를 import하지 못한다. renderer와 mcp 층이
  `platform`으로 분기하지 않는 것은 코드 리뷰로 지킨다.
- **renderer.** `jpegRenderer`는 jsdom에서 `createImageBitmap`을 목으로 바꿔 최신 프레임만 남기는지
  본다.
- **통합.** `*.ios.integration.test.ts`는 부팅된 시뮬레이터와 `axe`가 있을 때만 돈다. 대상 앱은
  기본 설치된 Settings(`com.apple.Preferences`)다. 테스트용 앱을 저장소에 두지 않는다.
- **완료 검증.** 단계마다 앱을 띄우고 MCP 클라이언트로 완료 기준 시나리오를 돌려 이 스펙에 남긴다.

## 파일 구성

| 파일 | 역할 | 단계 |
|---|---|---|
| `src/shared/types/device.ts` | `Platform`, `DeviceInfo`, `UiNode.editable`, `VirtualDeviceEntry` | M4-1 |
| `src/shared/types/errors.ts` | `unsupported`, `ios_tool_not_found`, `app_path_invalid` | M4-1 |
| `src/main/ios/simctlClient.ts` | `xcrun simctl` 경계 | M4-1 |
| `src/main/ios/trackSimulators.ts` | `list devices booted -j` 폴링과 비교 | M4-1 |
| `src/main/ios/simulatorCatalog.ts` | 시뮬레이터 목록·부팅·종료 | M4-1 |
| `src/main/device/iosDevice.ts` | `Device`의 iOS 구현 | M4-1, M4-2 |
| `src/main/device/parsers/` | simctl·log·launchctl·describe-ui 파서 | M4-1, M4-2 |
| `src/main/logs/iosLogDeps.ts` | 로그 패널 iOS deps | M4-1 |
| `src/main/ios/axeClient.ts` | `axe` 경계 | M4-2 |
| `src/main/stream/streamSession.ts` | `StreamSession` 인터페이스 | M4-3 |
| `src/main/stream/axeStreamSession.ts` | MJPEG 스트림 세션 | M4-3 |
| `src/main/stream/mjpegSplitter.ts`, `jpegSize.ts` | MJPEG 파트 자르기, JPEG 크기 읽기 | M4-3 |
| `src/main/stream/axeControl.ts`, `iosKeys.ts` | `ControlIntent` → AXe, iOS 키 표 | M4-3 |
| `src/main/stream/rejectingSession.ts` | 플랫폼별 세션 라우터와 iOS 세션 조립 | M4-1, M4-3 |
| `src/renderer/src/stream/jpegRenderer.ts` | JPEG 프레임 그리기 | M4-3 |

`docs/architecture/main-layers.md`에 iOS 줄을 M4-1에서 더하고 `verified`를 갱신한다.

## 스파이크 (M4-1 첫 작업)

확인할 것:

1. `describe-ui` JSON의 실제 필드 이름과 트리 모양. SwiftUI 앱과 UIKit 앱의 차이.
2. `describe-ui` 한 번의 소요 시간. 재검증마다 부르므로 1초를 넘기면 설계를 고친다.
3. `type`이 한글·이모지를 넣는가. 막히면 `simctl pbcopy`와 붙여넣기 우회를 검토한다.
4. `stream-video --format mjpeg`의 stdout 형식(multipart 경계인지 JPEG 연결인지), 실제 fps, 지연.
5. `batch --stdin`이 EOF 전에 단계를 하나씩 실행하는가.
6. Xcode 26 시뮬레이터에서 위가 모두 도는가.
7. `simctl io <udid> screenshot -`이 PNG를 stdout으로 내는가. 안 되면 임시 파일을 쓴다.
8. `log show`/`log stream --style ndjson`의 `timestamp` 형식과 한 줄의 필드.

결과는 이 절 아래에 적고, 어긋난 설계는 본문을 고친다.

### 스파이크 결과

환경은 Xcode 26.6, iOS 26.5 시뮬레이터(iPhone 17), AXe 1.8.0이다. 수치는 관찰값이다.
SwiftUI와 UIKit의 차이를 가를 서드파티 앱은 이번에 쓰지 못했고 Settings 앱만 봤다.

1. **`describe-ui` 필드.** 최상위는 배열이고 노드마다 `type`, `role`(`AXButton` 등), `role_description`,
   `AXLabel`, `AXValue`, `AXUniqueId`, `AXFrame`(문자열), `frame`(숫자 객체), `enabled`, `traits`, `subrole`,
   `title`, `help`, `pid`, `custom_actions`, `content_required`, `children`이 있다. 값이 없으면 `null`이고
   키 순서는 호출마다 다르다. 스펙의 노드 매핑 표와 필드 이름은 맞다. `frame` 숫자 객체가 따로 있고
   Cell 타입이 없는 점은 본문에 반영했다. M4-2 계획의 AX 속성 이름은 실제와 같다.
2. **`describe-ui` 소요.** 부팅 뒤 첫 호출은 약 4초였고 이후 0.5초 안팎이었다(iOS 18.2도 0.5~0.7초).
   앱을 띄운 직후 첫 호출은 `No translation object returned for simulator` 오류로 실패한 적이 있다.
   재시도하면 된다. 재검증 호출은 첫 호출 이후의 값으로 설계한다.
3. **`type`.** `type --stdin`은 ASCII만 받는다. 한글·이모지는 `No keycode found for character`와
   종료 코드 1로 실패한다. 게다가 시뮬레이터에 한국어 키보드가 켜져 있으면 ASCII `hello`가 `ㅗ디ㅣㅐ`로
   들어간다(HID keycode가 활성 키보드 배열을 거친다). 우회는 통한다. `simctl pbcopy <udid>`로 클립보드를
   채우고 `key-combo --modifiers 227 --key 25`(Cmd+V)를 보내면 `한글 😀 abc`가 그대로 들어갔다.
   입력 전 `key-combo`(227, 4)와 `key 42`로 비웠다. 본문 입력 매핑을 고쳤다.
4. **`stream-video`.** stdout은 `HTTP/1.1 200 OK` 헤더, `multipart/x-mixed-replace; boundary=--mjpegstream`이고
   파트마다 `--mjpegstream`, `Content-Type: image/jpeg`, `Content-Length`가 붙는다. 그런데 `--scale 1.0`과
   `--quality 80`(둘 다 기본값)이면 `image/jpeg`라고 적힌 파트가 실제로는 PNG(약 158KB)다. 둘 중 하나라도
   기본값이 아니면 JPEG이다(scale 0.5 quality 70은 약 38KB). fps는 5 요청에 5.0~5.7, 15 요청에 14.3,
   20 요청에 18.9, 30 요청(scale 0.5)에 약 18이 나왔다. 프로세스 시작에서 첫 바이트까지 약 0.24초,
   첫 프레임 헤더까지 약 0.43초다. iOS 18.2에서도 JPEG이 나왔고 fps는 낮았다(5 요청에 약 4.7). 본문에
   파싱 방법과 명시 옵션을 적었다.
5. **`batch --stdin`.** 열린 채로는 실행하지 않는다. 2초 간격으로 세 단계를 보내는 동안 아무 단계도
   실행되지 않았고 stdin을 닫은 뒤에야 세 단계가 연달아 실행됐다(단계당 약 0.5초). 독립 `tap` 호출은
   프로세스당 약 0.8초다. 그래서 M4-3의 제스처는 `down`/`move`/`up`을 모아 `up`에 한 번 보내는 설계가 확정이다.
6. **Xcode 26.** 위 항목은 Xcode 26.6과 iOS 26.5에서 모두 돌았다. iOS 18.2에서는 `describe-ui`, `stream-video`,
   `log show`를 확인했다.
7. **`screenshot -`.** 안 된다. `-`를 파일 이름으로 취급해 작업 디렉토리에 `-`라는 파일을 만들고 stdout에는
   아무것도 내지 않는다(`/dev/stdout`도 빈 출력). 임시 파일로 쓰고 읽는다. `--type=png`로 약 0.17초,
   `axe screenshot --output <파일>`은 약 0.2초다. 이 계획의 Task 6 `screenshot`을 고쳤다.
8. **ndjson.** `log show`와 `log stream` 모두 한 줄이 JSON 하나이고 헤더 줄은 stdout에 없다. `timestamp`는
   `2026-09-30 14:40:14.608720+0900`(로컬 시각, 마이크로초, 오프셋)이다. 필드는 `timestamp`, `eventType`,
   `messageType`, `eventMessage`, `subsystem`, `category`, `processID`, `processImagePath`, `senderImagePath`,
   `threadID`, `formatString`, `machTimestamp`, `traceID`, `bootUUID` 등이다. `messageType`은 `Default`,
   `Error`, `Fault`를 봤고(`log stream` 기본은 Info·Debug를 내지 않는다) `eventType`이 `activityCreateEvent`인
   줄에는 `messageType`이 없다. `spawn`한 로그 명령은 stderr에 `getpwuid_r did not find a match for uid 501`을
   찍고, 파이프를 닫으면 `Child process terminated with signal 13`을 찍는다. 둘 다 무시한다. 본문 매핑 표와
   Task 7의 `parseIosLogLine`을 고쳤다.

추가로 확인한 것:

- 같은 이름이 여러 런타임에 있다(`iPhone 17 Pro`는 iOS 26.0과 26.5). `list devices -j`의 런타임 키로 구분한다.
  `Booting` 상태는 `boot` 직후 목록에서 잡혔다.
- `launchctl list`는 `pid`, 종료 코드, 라벨의 탭 구분이고 Settings는 `UIKitApplication:com.apple.Preferences[...]`
  줄에서 pid를 얻는다.
- M4-2 계획이 쓰는 AX 속성 이름(`AXLabel`, `AXUniqueId`, `AXValue`, `AXFrame`, `type`)은 실제와 같다.

## 열린 질문

- 화면 입력으로 영문을 한 글자씩 넣으면 붙여 넣기 사이에 공백이 낀다. 어떻게 넣을지 정해야 한다("M4-3 검증 결과").
- 시뮬레이터를 가로로 돌려도 스트림 프레임이 세로 그대로다. 화면과 입력 좌표를 어디서 돌릴지 정해야 한다("M4-3 검증 결과").

## M4-1 검증 결과

2026-09-30에 iPhone 17 Pro(iOS 26.0) 시뮬레이터 하나를 부팅해 확인했다. 확인한 뒤 그 시뮬레이터를 껐다.
`npm run dev` 앱 창은 사람이 볼 수 없어서, 앱을 통하지 않고 실제 모듈(`simctl` 클라이언트, `IosDevice`, 기기
관리 층, `startMcpHttpServer`)을 그대로 조립해 MCP 클라이언트로 HTTP 호출했다. 앱 조립 코드(`index.ts`,
`bootstrap.ts`) 자체는 이 경로에 없다. 앱은 `npm run dev`로 25초 동안 띄워 크래시 없이 뜨는 것만 봤다.

**통합 테스트** (`iosDevice.ios.integration.test.ts`, 부팅된 시뮬레이터에서): 일곱 개 모두 통과했다. `platform`이
`ios`, 설정 앱 실행 뒤 `readLogs` 한 줄 이상, 스크린샷 PNG 디코드와 긴 변 상한, `stop` 두 번 연속 성공,
`clearLogs` 이전 timestamp 없음, 미설치 번들 `launch`의 `package_not_found`, `%`·`"`·`\`가 든 `filter`가 거절되지 않음.

| 항목 | 결과 | 관찰 |
|---|---|---|
| 1. `device_list` | 확인 | 가상 기기가 `platform: 'ios'`, `id`=UDID, `osVersion`과 함께 나온다. |
| 2. `device_info` | 확인(`device_boot`는 미호출) | 부팅해 둔 기기에서 `platform`, `model`, `osVersion: '26.0'`, 화면 크기를 준다. 기기 패널의 iOS 라벨은 사람 확인 필요. |
| 3. `app_install` → `app_launch` → `screenshot` → `log_read` | 부분 확인 | 설치할 `.app`이 없어 `app_install`은 실패 경로만 봤다(없는 경로는 `app_path_invalid`). 설치 성공은 미검증 — 설치할 .app 없음. 시스템 앱 설정으로 `screenshot`(PNG 반환)과 `log_read`(줄 반환)는 확인했다. |
| 4. `app_reset_and_launch` | 미검증 — 설치할 .app 없음 | 미설치 번들은 `package_not_found`. 시스템 앱(설정)은 `get_app_container data`가 `(null)`을 준다. 처음엔 경로 가드의 `command_failed`로 나갔고, 최종 리뷰 뒤 `unsupported`("iOS에서는 시스템 앱 데이터 지우기를 할 수 없다")로 바꿨다. 시스템 앱은 데이터 컨테이너가 없으므로 기대된 동작이지만, `settleSkipped: 'unsupported'`가 붙는 성공 경로는 보지 못했다. |
| 5. 로그 패널의 iOS 로그 | 사람 확인 필요 | 패널은 못 봤다. 대신 `xcrun simctl spawn <udid> log stream --style ndjson`을 15초 받으니 374줄(초당 약 25줄, 거의 놀고 있는 시뮬레이터, 필터 없는 원본 줄)이었다. `readLogs`로 최근 5분을 필터 없이 읽으면 잘리기 전 줄 수가 256,288이었다. 링 버퍼 상한을 다시 볼 때 이 둘을 참고한다. 최종 리뷰 뒤 `readLogs`는 이 출력을 스트림으로 읽어 `limit`줄만 남긴다. |
| 6. 화면 영역의 스크린샷 강등과 `unsupported` 안내 | 사람 확인 필요 | 스트림 세션 라우터의 `unsupported`는 단위 테스트로만 확인했다. |
| 7. `ui_tap` | 확인 | `unsupported`로 끝난다. 다만 좌표 탭은 화면 크기를 먼저 읽다 실패해 메시지가 `디스플레이 크기 읽기을 할 수 없다`(작업 이름이 탭이 아니고 조사도 어색하다)로 나왔다. 최종 리뷰 뒤 `unsupported`가 받침으로 을/를을 고르고 플랫폼을 `iOS`로 표시해 `iOS에서는 디스플레이 크기 읽기를 할 수 없다`가 된다. 작업 이름이 탭이 아닌 것은 그대로다. |

**통합 테스트로 잡은 것.** 미설치 번들의 실제 `simctl launch` stderr는 `not installed`나 `found nothing`이
아니라 `FBSOpenApplicationServiceErrorDomain, code=4`와 `The request to open "..." failed`다.
`iosDevice.ts#launch`의 정규식이 이를 놓쳐 `command_failed`로 나가던 것을 고쳤다. `logFilterPredicate`의
`%`는 실제 `log show`에서 문제없이 통과해 고치지 않았다.

**최종 리뷰 뒤 실제 시뮬레이터로 확인한 것.** `device_boot`는 부팅 직후 `registry.resolve` 대신
`registry.waitFor`로 기기 등록을 기다린다. simctl 폴링이 아직 못 본 기기에서 `no_device`가 나던 경합을 막는다.
실제 부팅(`catalog.boot` + 실제 `trackSimulators`)에서는 `bootstatus -b`가 끝날 무렵 폴링이 이미 기기를 봐
대기가 사실상 없었다 — 경합은 재현되지 않았고 방어로 둔다. `log stream` tail을 `SIGTERM`으로 닫으면 호스트의
`simctl spawn`과 시뮬레이터 안 `log` 프로세스가 모두 사라진다(남는 프로세스 없음).

**열린 것.** 설치 성공 경로(`app_install`, `app_reset_and_launch`의 `settleSkipped`)는 시뮬레이터용으로 빌드한
`.app`이 있는 환경에서 한 번 더 확인해야 한다. 앱 창에서 보는 항목(5·6, 기기 패널 라벨)은 사람이 확인한다.

> 설치 성공 경로와 `app_reset_and_launch`의 결과는 아래 "M4-2 검증 결과"에서 확인했다.

## M4-2 검증 결과

2026-09-30에 iPhone 17(iOS 26.5) 시뮬레이터 하나를 부팅해 확인했다. Xcode 26.6, AXe 1.8.0(`/opt/homebrew/bin/axe`)이다.
확인한 뒤 그 시뮬레이터를 껐다. 시뮬레이터 키보드와 로케일은 한국어였다. M4-1과 같이 앱 창은 사람이 볼 수 없어,
실제 모듈(`simctl` 클라이언트, `axeClient.ts`의 `createAxeClient`, `locateAxe.ts`의 `locateAxe`, `IosDevice`, 기기
관리 층, `startMcpHttpServer`)을 그대로 조립해 MCP 클라이언트로 HTTP 호출했다. 앱 조립 코드(`index.ts`,
`bootstrap.ts`)와 앱 창은 이 경로에 없다.

**계약 테스트** (`deviceContract.test.ts`): 같은 시나리오를 `AndroidDevice`(가짜 adb, `window-dump-emulator.xml`)와
`IosDevice`(가짜 simctl·axe, `describe-ui-settings.json`)에 돌려 모두 통과했다. `dumpUi`의 bounds가 0..1,
`displayFrame`이 양수, `tap`과 `pressKey('home')` resolve, `stop` 두 번 연속 성공, 없는 경로 `install`의 `app_path_invalid`.

**통합 테스트** (`iosDevice.ui.ios.integration.test.ts`, 부팅된 시뮬레이터에서): 통과했다. 설정 앱 `dumpUi`에서 검색
필드가 아닌 clickable 셀을 골라 그 중심을 `displayFrame` 기준 point로 `tap`하면 1초 뒤 덤프 지문이 달라지고,
`pressKey('home')`이 성공한다. 부팅된 시뮬레이터가 없으면 skip된다. M4-1의 `iosDevice.ios.integration.test.ts`도
같은 기기에서 다시 통과했다.

| 항목 | 결과 | 관찰 |
|---|---|---|
| 1. `ui_find({ query: '검색' })` | 확인 | 설정 첫 화면에서 검색 필드가 `className: 'TextField'`, `text: '검색'`(placeholder)으로 나온다. 목록 위 검색 버튼(`com.apple.settings.search`)과 돋보기 이미지도 함께 걸린다. |
| 2. `ui_tap({ ref })` | 확인 | 검색 필드 ref로 탭해 검색 화면으로 들어갔다. 응답은 탭한 점을 0..1로 준다. |
| 3. `ui_text({ ref, text: 'Wi' })` | 확인 | 이어서 받은 ref로 입력하면 검색 필드의 `text`가 `Wi`가 된다. 같은 경로로 `일반`도 그대로 들어갔다(한국어 키보드에서 pbcopy + Cmd+V). |
| 4. `ui_find`로 검색 결과 확인 | 부분 확인 | 검색 화면이 뜨고 `‘Wi’에 대한 결과 없음`이 노드로 나온다. `일반`도 결과가 없었다. 새로 만든 시뮬레이터의 설정 검색 색인이 비어 있던 것으로 보인다. 결과 목록이 나오는 경우는 미검증 — 색인이 찬 시뮬레이터가 없음. |
| 5. 1분 지난 ref로 `ui_tap` | 확인 | 검색 결과 화면의 ref를 받아 두고 `ui_key home`으로 화면을 바꾼 뒤 60초 기다려 탭하면 `stale_ref`("지문이 같은 노드가 새 화면에 없다")다. |
| 6. `app_reset_and_launch` | 확인 | 시뮬레이터용으로 직접 빌드한 최소 SwiftUI `.app`(`dev.vdh.probe`)을 `app_install`로 설치하자 bundle id를 돌려줬고, `app_reset_and_launch`가 `{ settled: true, nodeCount: 2 }`를 줬다. `settleSkipped`는 없다. 확인 뒤 `app_uninstall`로 지웠다. 설정 앱(시스템 앱)은 여전히 `unsupported`("시스템 앱 데이터 지우기")다. |
| 7. `ui_key back` | 확인 | `unsupported`("iOS에서는 back 키를 할 수 없다: iOS에는 back 버튼이 없다")다. |
| 8. `describe-ui` 소요 | 측정 | 설정 앱에서 워밍업 한 번(약 1.7초) 뒤 다섯 번 재 평균 약 0.82초(0.57~1.24초)다. 같은 때 `ui_find` 한 번은 0.6~2.0초였다. |

**실제 기기로 잡은 것.** 설정 앱을 띄우고 약 3초 뒤 `ui_find`로 받은 검색 필드 ref를 바로 `ui_tap`하자 `stale_ref`가
났다. 버그가 아니라 화면이 실제로 바뀐 것이다. 실행 뒤 약 4초에 `Toolbar`(`도구 막대`) Group이 트리에 나타나
검색 필드의 조상이 되고, `nodeRefs.ts`의 `fingerprintOf`가 조상 경로를 지문에 넣으므로 ref가 안전하게 실패한다.
화면이 안정된 뒤(실행 뒤 6초) 받은 ref는 탭·입력 모두 통했다. 에이전트는 `app_reset_and_launch`의 안정 대기를
쓰거나 `stale_ref`를 받으면 `ui_find`를 다시 부르면 된다. 코드는 고치지 않았다.

**열린 것.** 검색 결과 목록이 나오는 경우(항목 4), 앱 창에서 보는 항목(기기 화면의 탭 표시, 활동 탭의 입력 가림)은
사람이 확인한다. 서드파티 UIKit 앱의 `describe-ui` 모양은 이번에도 보지 못했고 SwiftUI 최소 앱과 설정 앱만 봤다.

## M4-3 검증 결과

2026-10-06에 iPhone 17(iOS 26.5) 시뮬레이터 하나를 부팅해 확인했다. Xcode 26.6, AXe 1.8.0(`/opt/homebrew/bin/axe`)이다.
확인한 뒤 그 시뮬레이터를 껐다. 시뮬레이터 키보드와 로케일은 한국어였다. 앱 창은 사람이 볼 수 없어 실제
모듈을 스크립트로 조립해 돌렸다. `createStreamManager`에 가짜 포트를 물리고, `createSession`에는 앱과 같은
`createPlatformStreamSession` + `createIosStreamSessionFactory`를, 기기 쪽에는 `createDeviceRegistry` +
`trackSimulators` + `createIosDevice`를 썼다. 입력은 renderer가 보내는 모양 그대로 포트의 `message`로 넣어
`streamManager.ts`의 `toControlIntent` 검증을 거치게 했다. 앱 조립 코드(`index.ts`, `bootstrap.ts`)와 renderer·앱
창은 이 경로에 없다. "화면이 바뀐 때"는 포트로 온 `frame`의 바이트가 직전과 달라진 첫 프레임으로 쟀다.

**이번 확인으로 M4-3의 완료 기준 둘이 충족되지 않았다(영문 한 글자씩 입력, 가로 회전).** 고치려면 설계 결정이
필요해 코드는 그대로 두었고 스펙 상태를 `implemented`로 올리지 않았다.

**통합 테스트** (`axeStreamSession.ios.integration.test.ts`, 부팅된 시뮬레이터에서): 통과했다. 세션이 `codec: 'jpeg'`로
열리고 프레임이 오며, 화면 가운데 탭이 `axe tap`까지 가고 실패가 없다. 첫 프레임까지 0.27~0.35초였고, 그 뒤 2초
동안 받은 프레임은 실행마다 크게 달랐다(적을 때는 초당 6~7장, 많을 때는 초당 16장). M4-1·M4-2의 iOS 통합
테스트도 같은 기기에서 다시 통과했다. 스트림 테스트의 탭이 같은 시뮬레이터를 쓰는 다른 파일의 화면을 바꿔
함께 돌리면 실패했으므로 `vitest.integration.config.ts`에서 파일을 한 번에 하나씩 돌리게 했다.

| 항목 | 결과 | 관찰 |
|---|---|---|
| 1. 실시간 화면 | 부분 확인 | `open`에서 첫 `frame`까지 0.26~0.32초. `session`은 603×1311, `codec: 'jpeg'`, `keys`는 `IOS_KEYS`. `--fps 30` 요청에 정지 화면에서 초당 15.4~16.6장, 스크롤 중 14.3~15.9장이 왔다. 프레임 하나는 약 70KB다. canvas에 그려지는 것은 사람 확인 필요 — 그리기는 `jpegRenderer.test.ts`와 `useScrcpyStream.test.tsx`가 덮는다. |
| 2. Settings 셀 클릭 | 확인 | 설정 첫 화면의 `일반` 셀 중심을 `touch` down·up으로 보내자 `tap -x 201 -y 319`가 나가고 일반 화면으로 들어갔다(세 번). |
| 3. 드래그로 스크롤 | 확인 | 약 0.3초 동안 `down`→`move`→`up`을 보내면 `swipe` 한 번이 나가고 목록이 움직였다. 목록 끝에서는 더 움직이지 않았다. |
| 4. 휠로 스크롤 | 확인 | 16ms 간격 `scroll`(`vScroll: -1`) 서른 번이 `swipe` 두 번으로 합쳐졌고 목록이 아래로 내려갔다. 손가락은 `vScroll > 0`에서 아래로, `hScroll > 0`에서 왼쪽으로 갔고 거리는 `displayFrame`의 0.15배였다. |
| 5. 한글 입력 | 확인 | 검색 필드에 `text` `한글`, 한 글자씩 `한`·`글`을 보내면 `한글`로 들어갔다. renderer의 조합 입력(IME)이 이 모양으로 보내는지는 사람 확인 필요. |
| 6. 영문 입력 | **실패** | 문자열 한 번(`Wi`)은 그대로 들어간다. 그러나 한 글자씩 `a`·`b`·`c`를 보내면 `a b c`가 된다(`1`·`2` → `1 2`, `ab`·`cd` → `ab cd`). 아래 "실제 기기로 잡은 것" 참고. |
| 7. 홈 버튼, 지원하지 않는 키 | 확인 | `key: 'home'`이 `button home`으로 나가 홈 화면이 됐다. `backspace`는 `key 42`로 한 글자를 지웠다. `back`·`app_switch`·`volume_up`·`volume_down`은 AXe 호출이 없었고 스트림은 이어졌다. 뒤로 버튼이 그려지지 않는 것은 `DeviceScreen.test.tsx`가 덮고, 앱 창에서는 사람 확인 필요. |
| 8. 가로 회전 | **실패** | Simulator.app의 Device 메뉴로 왼쪽 회전했다(Safari). `displayFrame`은 874×402로 바뀌지만 스트림 프레임은 603×1311 그대로이고 내용만 옆으로 누워 온다. 새 `session`도 오지 않는다. 아래 참고. |
| 9. 시뮬레이터 종료 | 확인 | 스트림 중 `simctl shutdown`을 부르자 약 0.6초 뒤 세션이 `onEnded`(`device_unresponsive`, "axe stream-video가 끝났다")를 올렸다. 매니저가 `reconnecting`을 두 번 알린 뒤, 약 1.9초에 `trackSimulators` 폴링이 기기 해제를 알려 `handleDisconnect`로 포트가 닫혔다. `axe` 프로세스는 남지 않았다. |
| 10. 사람 입력과 MCP 입력의 겹침 | 확인 | `registry.run` 안의 `inputText('M')`과 화면 `text` `H`를 동시에 보내면 두 ⌘V가 겹치지 않고 차례로 돌아 `M`, `H` 순으로 들어갔다. |

**입력 지연** (보낸 때 → 화면이 바뀐 첫 프레임, 세 번씩)

| 입력 | 지연 | 내역 |
|---|---|---|
| 탭 | 1.25~1.6초 | `displayFrame`(`describe-ui`) 약 0.53초 + `axe tap` 약 0.58초. 호출은 보낸 뒤 약 1.1초에 끝난다. |
| 드래그 | 손을 뗀 뒤 1.2~1.3초 | `displayFrame` 약 0.5초 + `axe swipe` 0.86~0.98초(그중 0.31초가 `duration`). |
| 휠 | 약 1.3초 | 첫 `swipe`가 약 0.54초에 시작해 약 0.71초 걸린다. |
| 텍스트 | 호출이 0.33~0.39초에 끝남 | 커서가 깜빡여 프레임 변화로는 잴 수 없었다. `pbcopy` 약 0.14초 + `key-combo` 약 0.2초. |
| 홈 | 호출이 약 0.18초에 끝남 | `displayFrame`을 재지 않는다. |

탭과 드래그가 1초를 넘는다. 쓸 수는 있지만 느리다. 절반은 제스처마다 다시 재는 `displayFrame`(`describe-ui`)이다.
후속 과제로 남긴다. `displayFrame`을 캐시하면 탭·드래그가 약 0.5초 줄지만 회전을 어떻게 알아챌지와 묶인
결정이다. 드래그가 손을 뗀 뒤에야 반영되는 것은 스파이크 5(`batch --stdin`은 stdin을 닫아야 실행한다) 때문에
그대로다.

**호스트 클립보드.** 텍스트 입력은 시뮬레이터 pasteboard를 덮는다(`simctl pbpaste`로 확인). 호스트 Mac의
클립보드가 따라 바뀌는지 세 경우로 쟀다. 호스트 클립보드에 표식을 넣고 텍스트를 입력한 뒤 `pbpaste`로 읽었다.

- Simulator.app이 떠 있지 않을 때: 바뀌지 않았다.
- Simulator.app이 뒤에 떠 있을 때: 바뀌지 않았다. 반대 방향(호스트 → 시뮬레이터)은 동기화돼 입력 전 시뮬레이터
  pasteboard에 호스트의 표식이 들어 있었다.
- Simulator.app을 앞에 둔 채 `simctl pbcopy`를 하고 다른 앱으로 돌아왔을 때: 바뀌지 않았다.

관찰한 범위에서는 호스트 클립보드가 덮이지 않는다. 사람이 시뮬레이터 안에서 직접 복사하는 경우는 보지 않았다.
시뮬레이터 클립보드 복원은 만들지 않았다(이유는 "스트리밍과 화면 입력 (M4-3)").

**실제 기기로 잡은 것.**

- *스와이프 길이가 늘어났다(고침).* `axeControl.ts`의 `createAxeControl`이 `swipe`의 `duration`을 줄에서 실행될 때
  쟀다. 그래서 `displayFrame`을 재는 약 0.5초와 앞 호출을 기다린 시간이 더해져 0.3초 드래그가 0.8~1.2초
  스와이프로 나갔다. `up`을 받은 때에 재도록 고치고 단위 테스트를 더했다. 고친 뒤 0.31초로 나간다.
- *영문을 한 글자씩 넣으면 공백이 낀다(안 고침).* renderer의 `inputMapper.ts`는 키 하나마다 `text` 하나를
  보내고, iOS는 붙여 넣은 낱말과 앞 낱말 사이에 공백을 넣는다(smart insert). 그래서 사람이 `abc`를 치면
  `a b c`가 된다. 한글은 공백이 끼지 않는다. MCP `ui_text`도 같은 필드에 두 번 부르면 같은 일이 생긴다
  (`Wi` 다음 `한글` → `Wi 한글`). `axe type`은 대안이 아니다. 한국어 키보드에서 `a`·`b`·`c`가 `뮻`이 됐다.
  줄에서 기다리는 `text`를 합치면 빠르게 친 글자는 붙지만 천천히 치면 여전히 낀다. 넣는 방법을 정해야 한다.
- *가로 회전을 따라가지 않는다(안 고침).* `stream-video`와 `simctl io screenshot`은 기기를 돌려도 세로 프레임을
  주고 내용만 눕는다. `describe-ui`와 `axe tap`의 좌표는 돌아간 화면 기준이다(가로 874×402에서 `describe-ui`로
  찾은 주소 필드 중심을 `IosDevice.tap`하자 주소 필드가 눌렸다. MCP 경로는 가로에서도 맞는다). 화면 입력은
  세로 프레임의 좌표를 가로 `displayFrame`에 비율로만 옮기므로 엉뚱한 곳을 누른다(프레임의 (0.75, 0.75)가
  `tap -x 655 -y 301`). 프레임과 `displayFrame`의 가로세로가 뒤바뀐 것으로 회전은 알 수 있으나 왼쪽·오른쪽은
  가르지 못한다. 프레임과 좌표를 어디서 돌릴지 정해야 한다. iPhone의 설정 앱과 홈 화면은 돌지 않아 영향이 없다.

**열린 것.** 위 두 실패. 앱 창에서 보는 항목(canvas에 그려지는 화면과 비율, 툴바 키 버튼과 뒤로 버튼 없음,
한글 조합 입력, AXe 없는 Mac에서의 강등 안내)은 사람이 확인한다. iOS 18.2 등 다른 런타임과 iPad는 보지 않았다.

