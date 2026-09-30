---
id: m4-1-ios-foundation
title: M4-1 — iOS 기반: simctl, 기기 목록, 앱, 스크린샷, 로그
status: draft
type: work-order
created: 2026-09-29
updated: 2026-09-29
owner: virtual-device-helper 팀
scope: [main, renderer, preload, mcp, shared, ios, android]
hosts: [macos]
archived_reason:
related_adr: [ADR-0015, ADR-0014, ADR-0005, ADR-0003, ADR-0008, ADR-0011, ADR-0013]
related_spec: m4-ios-simulator
related_architecture: main-layers
related_plan: [m4-2-ios-input-nodes, m4-3-ios-streaming]
related_code: [device.ts#Device, errors.ts#ToolErrorKind, adbClient.ts#createAdbClient, avdController.ts#createAvdController, registry.ts#createDeviceRegistry, bootstrap.ts#bootstrapApp, index.ts, appState.ts#createAppState, ipc.ts#AppSnapshot, DevicePanel.tsx#DevicePanel, SdkMissing.tsx#SdkMissing, nodeRefs.ts, logManager.ts#LogManagerDeps, logTail.ts#createLogTail, pidTracker.ts#createPidTracker, device.ts#registerDeviceTools, app.ts, agentGuide.ts, layering.test.ts]
tags: [plan, ios, simctl]
---

# M4-1 — iOS 기반 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: `superpowers:subagent-driven-development`(권장) 또는
> `superpowers:executing-plans`로 task 단위 구현. 각 단계는 체크박스(`- [ ]`)로 추적한다.

**Goal:** iOS 시뮬레이터가 기기 목록에 뜨고, 에이전트가 MCP로 시뮬레이터를 부팅해 `.app`을
설치·실행하고 스크린샷과 로그를 읽는다. 앱 로그 패널에 iOS 로그가 흐른다.

**Architecture:** 프로세스 실행 공통부를 `processClient`로 뽑아 `adbClient`와 새 `simctlClient`가
나눠 쓴다. `IosDevice`가 `Device`를 구현하고, simctl 폴링 추적과 adb 추적을 합쳐 registry 하나에
넣는다. AVD와 시뮬레이터 목록은 `VirtualDeviceCatalog`가 합친다. 조립은 플랫폼마다 따로 하고,
하나라도 준비되면 MCP 서버를 연다.

**Tech Stack:** TypeScript, Electron, `xcrun simctl`, `plutil`, zod 4, `@modelcontextprotocol/sdk`, React, Vitest

**Spec:** [`../specs/2026-09-29-m4-ios-simulator.md`](../specs/2026-09-29-m4-ios-simulator.md) —
"범위"의 M4-1, "인터페이스", "동작"의 층 구조·기기 추적·조립·로그 절, "실패 처리", "테스트", "스파이크".
결정 근거는 [ADR-0015](../../adr/0015-platform-difference-surface.md),
[ADR-0014](../../adr/0014-ios-control-via-axe.md).

**선행 조건:** macOS 호스트, Xcode(`xcrun simctl`), 부팅 가능한 iOS 런타임이 하나 이상. AXe는 Task 1
스파이크에만 쓴다(`brew install cameroncooke/axe/axe`).

## Global Constraints

- 답변·주석·문서는 한국어로 쓴다. 기술 용어·API 이름·명령어·에러 문자열은 원문 그대로 둔다.
- ADR-0005: 위층은 바로 아래층만 부른다. `src/main/mcp/`는 `src/main/ios/`, `device/iosDevice`,
  `device/androidDevice`, `adb/`, `logs/`를 import하지 않는다. `layering.test.ts`가 막는다.
- ADR-0015: 위층(mcp·renderer·appState)은 `platform`으로 분기하지 않는다. `platform`은 표시·기록용이다.
  플랫폼 분기는 조립 지점(`src/main/index.ts`, `bootstrap.ts`)과 카탈로그 라우팅에만 둔다.
- 할 수 없는 동작은 `unsupported`로 던진다. 조용히 무시하지 않는다. M4-1의 `IosDevice`에서
  `tap`/`swipe`/`inputText`/`pressKey`/`dumpUi`/`displayFrame`은 모두 `unsupported`다.
- `simctl`과 `plutil`은 셸 없이 `spawn`/`execFile`로 부른다. 사용자 입력(경로·bundle id·filter)을
  셸 문자열로 이어 붙이지 않는다.
- `xcrun`이 없거나 실행되지 않으면 `ios_tool_not_found`다. hint는 `Xcode를 설치하고 xcode-select -s로 개발자 디렉토리를 정해라`.
- 시뮬레이터 추적 폴링 간격은 2000ms, 연속 실패 3회에서 `tracking_failed`. 상수로 두고 테스트가 주입한다.
- `readLogs`의 기본 시작점은 최근 5분(300000ms)이다. 상수로 둔다.
- 파서 테스트의 fixture는 Task 1에서 실제 출력으로 채집한 파일만 쓴다. 손으로 지어낸 fixture는 금지한다.
  테스트 안에서 fixture 일부를 잘라 쓰는 것은 된다.
- 새 npm 의존성을 들이지 않는다.
- 각 task 끝에서 `npm test`와 `npm run typecheck`가 통과해야 한다. 바뀐 모양 때문에 깨지는 기존
  테스트는 같은 task에서 고친다.
- 문서에는 라인번호, 파일·툴 개수, 진행률을 적지 않는다. 파일명과 심볼명으로 가리킨다.
- 문서를 고치면 `python3 docs/script/docs.py lint`와 `python3 docs/script/docs.py links`를 돌린다.
- 커밋 메시지는 한국어 Conventional Commits(`feat(ios): ...한다`)이고, 끝에 다음 줄을 붙인다:
  `Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>`

## Review Focus

- **같은 이름의 시뮬레이터가 런타임마다 있다**: "iPhone 16"이 iOS 18.2와 26.0에 모두 있어도
  목록에 둘 다 뜨고, `device_boot({ id })`는 그 UDID만 부팅한다. → Task 5 테스트.
- **filter에 따옴표·역슬래시**: `log_read({ filter: 'a" OR 1==1 OR "' })`가 predicate를 깨거나
  다른 줄을 끌어오지 않는다. → Task 7 테스트.
- **Booting·Shutting Down 상태**: 부팅 중인 시뮬레이터를 연결로 치지 않는다. `Booted`가 된 뒤에만
  `device_connected`가 나간다. → Task 5 테스트.
- **Android SDK는 없고 Xcode만 있는 호스트**: 안내 화면에 막히지 않고 iOS 기기로 앱과 MCP 서버가
  돈다. → Task 9 테스트.
- **떠 있지 않은 앱의 `stop`**: `simctl terminate`가 실패 종료해도 `stop`은 성공한다. Android
  `force-stop`과 같은 의미다. → Task 6 테스트.

---

### Task 1: 스파이크와 fixture 채집

코드를 쓰지 않는다. 실제 출력을 fixture로 남기고, 스펙의 스파이크 질문에 답한다.

**Files:**
- Create: `src/main/device/parsers/__fixtures__/ios/` 아래 파일들
- Modify: `docs/superpowers/specs/2026-09-29-m4-ios-simulator.md` ("스파이크" 절 아래 "스파이크 결과")

- [ ] **Step 1: 시뮬레이터 하나를 부팅한다**

Run: `xcrun simctl list devices available -j`에서 iPhone 하나의 UDID를 고르고 `xcrun simctl boot <udid> && xcrun simctl bootstatus <udid> -b`
Expected: `bootstatus`가 끝나고 `xcrun simctl list devices booted`에 그 기기가 보인다.

- [ ] **Step 2: simctl 출력을 채집한다**

아래를 그대로 저장한다. 파일명은 이대로 쓴다. 이후 task가 이 이름을 가리킨다.

| 파일 | 명령 |
|---|---|
| `simctl-list-devices.json` | `xcrun simctl list devices -j` (같은 이름이 여러 런타임에 있는지 확인. 없으면 `xcrun simctl create`로 하나 더 만들고 다시 채집한 뒤 지운다) |
| `simctl-list-devices-booting.json` | 다른 시뮬레이터를 `boot`한 직후, `bootstatus`가 끝나기 전에 `xcrun simctl list devices -j` (`state`가 `Booted`가 아닌 항목이 있어야 한다) |
| `log-show.ndjson` | `xcrun simctl spawn <udid> log show --style ndjson --last 1m` 앞 200줄 |
| `log-stream.ndjson` | `xcrun simctl spawn <udid> log stream --style ndjson` 10초 분량 앞 200줄 |
| `launchctl-list.txt` | Settings를 띄운 뒤(`xcrun simctl launch <udid> com.apple.Preferences`) `xcrun simctl spawn <udid> launchctl list` |
| `settings-info.plist.txt` | 런타임 안 `Preferences.app/Info.plist`를 `plutil -p`로 출력 (bundle id 확인용) |
| `describe-ui-settings.json` | `axe describe-ui --udid <udid>` (Settings 화면) |
| `stream-video.bin` | `axe stream-video --udid <udid> --format mjpeg --fps 5` stdout 앞 2초 (`head -c`로 1MB 이내) |

- [ ] **Step 3: 스파이크 질문에 답한다**

스펙 "스파이크" 절의 질문마다 한 줄씩 결과를 "스파이크 결과" 소절에 적는다. 수치(소요 시간, fps)는
관찰값 그대로 적되 스펙 본문 설계에 박지 않는다. 특히 7번(`screenshot -`의 stdout 출력)과 8번
(ndjson `timestamp` 형식)은 Task 6·7이 기대므로 반드시 답한다. 설계와 어긋나는 결과가 나오면
스펙 본문을 고치고, M4-1 범위(Task 6·7)에 영향이 있으면 이 계획의 해당 task도 고친다.

- [ ] **Step 4: 부팅한 시뮬레이터를 끄고 커밋한다**

```bash
xcrun simctl shutdown all
git add src/main/device/parsers/__fixtures__/ios docs/superpowers/specs/2026-09-29-m4-ios-simulator.md
git commit -m "docs(ios): M4 스파이크 결과와 simctl·AXe 출력 fixture를 남긴다"
```

---

### Task 2: 프로세스 실행 공통부를 `processClient`로 뽑는다

동작을 바꾸지 않는 추출이다. `adbClient`의 기존 테스트가 한 줄도 바뀌지 않고 통과해야 한다.

**Files:**
- Create: `src/main/process/processClient.ts`, `src/main/process/processClient.test.ts`
- Modify: `src/main/adb/adbClient.ts`

**Interfaces:**
- Produces (`processClient.ts`):
  - `ExecOpts`, `ExecResult`, `SpawnFn`, `STDERR_TAIL_LIMIT_BYTES`를 여기로 옮긴다. `adbClient.ts`는 같은 이름으로 다시 내보낸다.
  - `ProcessStream`: 지금의 `AdbStream`과 같은 모양. `adbClient.ts`는 `export type AdbStream = ProcessStream`.
  - `interface ProcessFailures { notFound(): DeviceError; classify(stderr: string, args: string[]): DeviceError; timedOut(args: string[], timeoutMs: number): DeviceError; killed(args: string[], signal: NodeJS.Signals | null, stderr: string): DeviceError; streamReadFailed(stream: 'stdout' | 'stderr', error: Error, args: string[]): DeviceError }`
  - `createProcessClient(command: string, failures: ProcessFailures, spawnFn?: SpawnFn): { exec(args: string[], opts?: ExecOpts): Promise<ExecResult>; stream(args: string[]): ProcessStream }`
- `adbClient.ts`의 `createAdbClient(adbPath, spawnFn)`는 `createProcessClient`에 adb용 `ProcessFailures`(지금의 메시지·kind 그대로)를 넘기고 `withSerial`만 붙인다.

- [ ] **Step 1: `processClient.test.ts`에 실패 분류 주입 테스트를 쓴다**

가짜 spawn으로 세 경우를 본다: 종료 코드 1이면 `failures.classify(stderr, args)`가 돌려준 에러로 reject,
spawn의 `error` 이벤트가 `ENOENT`면 `failures.notFound()`로 reject, 타임아웃이면 `failures.timedOut(args, timeoutMs)`로 reject.

- [ ] **Step 2: 실패를 확인한다**

Run: `npx vitest run src/main/process/processClient.test.ts`
Expected: FAIL — 모듈이 없다.

- [ ] **Step 3: `adbClient.ts`의 exec·stream 본문을 `processClient.ts`로 옮기고 메시지만 `ProcessFailures`로 뺀다**

- [ ] **Step 4: 통과를 확인한다**

Run: `npx vitest run src/main/process src/main/adb && npm run typecheck`
Expected: PASS. `src/main/adb/*.test.ts`는 수정 없이 통과한다(`git diff --stat src/main/adb/*.test.ts`가 비어 있다).

- [ ] **Step 5: 커밋**

```bash
git add src/main/process src/main/adb/adbClient.ts
git commit -m "refactor(main): adbClient의 프로세스 실행부를 processClient로 뽑는다"
```

---

### Task 3: `Device` 인터페이스와 에러를 넓히고 Android를 맞춘다

**Files:**
- Modify: `src/shared/types/device.ts`, `src/shared/types/errors.ts`, `src/main/device/androidDevice.ts`,
  `src/main/device/parsers/uiDump.ts`, `src/main/mcp/nodeRefs.ts`, `src/main/mcp/tools/app.ts`,
  `src/main/mcp/tools/device.ts`(`device_info` 설명), `src/shared/agentGuide.ts`,
  `docs/adr/0011-node-ref-revalidation.md`, `docs/adr/0005-device-interface-abstraction.md`
- Test: `src/main/mcp/nodeRefs.test.ts`, `src/main/device/androidDevice.observe.test.ts`,
  `src/main/device/androidDevice.app.test.ts`, `src/main/device/parsers/uiDump.test.ts`, `src/shared/agentGuide.test.ts`

**Interfaces:**
- Produces (`device.ts`): 스펙 "`Device` 변경" 절 그대로. `Platform`, `DeviceInfo{serial, platform, model, osVersion, width, height}`,
  `UiNode.editable`, `Device.platform`, `install(appPath, opts)`. (`VirtualDeviceEntry`는 Task 4)
- Produces (`errors.ts`): `ToolErrorKind`에 `'unsupported' | 'ios_tool_not_found'`를 더하고 `'apk_path_invalid'`를 `'app_path_invalid'`로 바꾼다.
- Produces: `unsupported(platform: Platform, action: string, reason: string): DeviceError` (`errors.ts`). message는 `` `${platform}에서는 ${action}을 할 수 없다: ${reason}` ``, hint는 `에이전트 가이드의 플랫폼 차이 절을 확인해라`, details는 `{ platform, action }`.

- [ ] **Step 1: 실패하는 테스트를 쓴다**
  - `nodeRefs.test.ts`: `className: 'TextField', editable: true`인 노드는 text가 달라도 같은 지문이고, `className: 'EditText', editable: false`인 노드는 text가 다르면 다른 지문이다(이제 className이 아니라 `editable`로 정한다).
  - `uiDump.test.ts`: 기존 fixture에서 `EditText` 노드는 `editable: true`, 나머지는 `false`.
  - `androidDevice.observe.test.ts`: `info()`가 `ro.build.version.release`=`14`, `ro.build.version.sdk`=`34`일 때 `{ platform: 'android', osVersion: '14 (API 34)' }`를 포함한다. `device.platform === 'android'`.
  - `androidDevice.app.test.ts`: `.apk`가 아닌 경로와 없는 파일은 `app_path_invalid`.

- [ ] **Step 2: 실패를 확인한다**

Run: `npx vitest run src/main/mcp/nodeRefs.test.ts src/main/device`
Expected: FAIL — `editable`·`platform`·`osVersion`·`app_path_invalid`가 없다.

- [ ] **Step 3: 타입과 Android 구현을 고친다**
  - `androidDevice.ts`의 `info`는 `getprop ro.build.version.release`를 더 읽는다. `apiLevel`을 없앤다.
  - `nodeRefs.ts`는 `node.className.endsWith('EditText')` 대신 `node.editable`을 본다.
  - `app.ts`의 `app_install`·`app_launch`·`app_grant_permission` 설명과 `pkg` 설명을 스펙 "iOS에서 달라지는 `Device` 동작" 아래 문단대로 넓힌다. `app_install`의 인자 이름 `apkPath`가 있으면 `appPath`로 바꾼다.
  - `agentGuide.ts`에 "플랫폼 차이" 절을 더한다: iOS에는 `back` 키와 `activity`가 없고 `unsupported`가 온다, 권한 이름은 `photos`/`camera`/`location` 같은 `simctl privacy` 서비스 이름이다, `pkg`는 bundle id다.
  - ADR-0011 결정 절의 "`EditText` 계열은" 문장을 "`UiNode.editable`이 참인 노드는"으로 고친다. ADR-0005 `related_adr`에 ADR-0015를 더하고, 결정 절 끝에 "M4에서 넓힌 내용은 ADR-0015에 있다." 한 줄을 더한다.

- [ ] **Step 4: 통과를 확인한다**

Run: `npm test && npm run typecheck && python3 docs/script/docs.py lint && python3 docs/script/docs.py links`
Expected: 전부 PASS / 문제 0건.

- [ ] **Step 5: 커밋**

```bash
git add -A src docs/adr
git commit -m "feat(shared): Device에 platform·osVersion·editable을 더하고 unsupported 에러를 둔다"
```

---

### Task 4: `VirtualDeviceCatalog`와 IPC·기기 패널을 플랫폼 중립으로 바꾼다

이 task가 끝나도 목록에는 AVD만 있다. 모양만 바꾼다.

**Files:**
- Create: `src/main/device/virtualDeviceCatalog.ts`, `src/main/device/virtualDeviceCatalog.test.ts`
- Modify: `src/shared/types/device.ts`, `src/main/device/avdController.ts`, `src/main/mcp/toolContext.ts`,
  `src/main/mcp/tools/device.ts`, `src/main/app/appState.ts`, `src/main/app/bootstrap.ts`, `src/main/app/ipcBridge.ts`,
  `src/shared/types/ipc.ts`, `src/preload/index.ts`, `src/renderer/src/components/DevicePanel.tsx`,
  `src/renderer/src/state/useAppState.ts`, `src/main/index.ts`
- Test: 위 파일들의 기존 테스트, `src/main/mcp/tools/device.test.ts`, `src/renderer/src/components/DevicePanel.test.tsx`

**Interfaces:**
- Produces (`device.ts`): `VirtualDeviceEntry` (스펙 그대로, `id` 포함). `AvdEntry`는 없앤다.
- Produces (`virtualDeviceCatalog.ts`):
  ```ts
  export interface VirtualDeviceSource {
    readonly platform: Platform
    list(): Promise<VirtualDeviceEntry[]>
    /** 부팅 완료까지 기다리고 serial을 돌려준다. */
    boot(id: string): Promise<string>
    shutdown(serial: string): Promise<void>
  }
  export interface VirtualDeviceCatalog {
    list(): Promise<VirtualDeviceEntry[]>
    boot(id: string): Promise<string>
    shutdown(serial: string, platform: Platform): Promise<void>
  }
  export function createVirtualDeviceCatalog(sources: VirtualDeviceSource[]): VirtualDeviceCatalog
  ```
  - `list`는 소스 순서대로 이어 붙인다. 한 소스가 reject하면 그 소스만 빼고 `console.error`로 남긴다.
  - `boot(id)`는 `list()`에서 그 `id`를 가진 항목의 소스로 보낸다. 없으면 `command_failed`, message `` `그런 가상 기기가 없다: ${id}` ``, hint `device_list로 id를 확인해라`, details `{ available: ids }`.
  - `shutdown(serial, platform)`은 같은 `platform` 소스로 보낸다.
- `avdController.ts`: `AvdController`가 `VirtualDeviceSource`를 구현한다. `platform: 'android'`, 항목은 `{ platform: 'android', id: name, name, running, serial, osVersion: null }`. `boot(name, timeoutMs?)` 시그니처는 그대로 호환된다.
- `ToolContext.avd` → `ToolContext.catalog: VirtualDeviceCatalog`.
- MCP: `device_list` → `{ virtualDevices, connected, active }`, `device_boot` 입력 `{ id: z.string().describe('부팅할 가상 기기의 id. device_list의 virtualDevices[].id') }`, `device_shutdown`은 `catalog.shutdown(device.serial, device.platform)`. 이 한 줄의 `platform` 전달은 분기가 아니라 라우팅 키 전달이다.
- IPC: `AppSnapshot.avds` → `virtualDevices`, `MainEvent` `avds_changed` → `virtual_devices_changed`, `RendererApi.bootAvd(name)` → `bootVirtualDevice(id)`, `IPC_CHANNELS.bootAvd` → `bootVirtualDevice: 'app:boot-virtual-device'`.
- `DevicePanel`: 항목 key는 `id`. 이름 옆에 플랫폼 라벨(`Android`/`iOS`)을 `<span className="badge">`로 붙인다. 빈 목록 문구는 `가상 기기가 없다. Android Studio에서 AVD를 만들거나 Xcode에서 시뮬레이터를 추가하고 앱을 다시 켜라.`

- [ ] **Step 1: 실패하는 테스트를 쓴다**
  - `virtualDeviceCatalog.test.ts`: 두 가짜 소스의 목록이 순서대로 합쳐진다 / 한 소스가 reject해도 나머지가 나온다 / `boot('udid-2')`는 그 id를 가진 소스의 `boot`만 부른다 / 모르는 id는 `command_failed`와 `details.available` / `shutdown(serial, 'ios')`는 ios 소스로 간다.
  - `device.test.ts`: `device_boot({ id })`가 `catalog.boot(id)`를 부르고 `device_list`가 `virtualDevices`를 준다.
  - `DevicePanel.test.tsx`: 같은 `name`, 다른 `id`인 두 항목이 둘 다 그려지고 각자의 부팅 버튼이 `bootVirtualDevice(id)`를 부른다. 플랫폼 라벨이 보인다.

- [ ] **Step 2: 실패를 확인한다**

Run: `npx vitest run src/main/device/virtualDeviceCatalog.test.ts src/main/mcp/tools/device.test.ts src/renderer/src/components/DevicePanel.test.tsx`
Expected: FAIL.

- [ ] **Step 3: 카탈로그를 만들고 이름을 바꾼다**

`bootstrap.ts`의 `DeviceStack.avd`는 `catalog`로 바꾸고 `createDeviceStack`이 `createVirtualDeviceCatalog([avd])`를 돌려준다. `assembleWithoutSdk`의 가짜 `avd`도 카탈로그 모양으로 바꾼다.

- [ ] **Step 4: 통과를 확인한다**

Run: `npm test && npm run typecheck`
Expected: PASS.

- [ ] **Step 5: 커밋**

```bash
git add -A src
git commit -m "refactor: AVD 목록을 플랫폼 중립 VirtualDeviceCatalog로 바꾼다"
```

---

### Task 5: `simctlClient`, 시뮬레이터 목록·부팅·종료, 추적 폴링

**Files:**
- Create: `src/main/ios/simctlClient.ts`, `src/main/ios/simctlClient.test.ts`,
  `src/main/device/parsers/simctlDevices.ts`, `src/main/device/parsers/simctlDevices.test.ts`,
  `src/main/ios/simulatorCatalog.ts`, `src/main/ios/simulatorCatalog.test.ts`,
  `src/main/ios/trackSimulators.ts`, `src/main/ios/trackSimulators.test.ts`, `src/main/ios/testing.ts`
- Modify: `src/main/device/registry.ts`, `src/main/device/registry.test.ts`, `src/main/index.ts`, `src/main/mcp/layering.test.ts`

**Interfaces:**
- Produces (`simctlClient.ts`):
  - `interface SimctlClient { exec(args: string[], opts?: ExecOpts): Promise<ExecResult>; stream(args: string[]): ProcessStream }`. `args`는 `simctl` 다음부터다(`['list', 'devices', '-j']`).
  - `createSimctlClient(spawnFn?: SpawnFn): SimctlClient`. `createProcessClient('xcrun', failures)`에 `['simctl', ...args]`를 넘긴다. `notFound`는 `ios_tool_not_found`, `classify`는 stderr에 `Invalid device`가 있으면 `no_device`, 그 밖은 `command_failed`(details `{ stderr, args }`).
- Produces (`testing.ts`): `fakeSimctl(handlers: Record<string, ExecResult | Error>): SimctlClient & { calls: string[][] }` — 키는 `args.join(' ')`. 이후 task의 테스트가 이것을 쓴다. `fakeAdb()`처럼 `vi.fn`을 쓴다.
- Produces (`simctlDevices.ts`):
  - `interface SimulatorEntry { udid: string; name: string; state: string; runtime: string; osVersion: string }`
  - `parseSimctlDevices(json: string): SimulatorEntry[]`. 런타임 키 `com.apple.CoreSimulator.SimRuntime.iOS-26-0`에서 `osVersion` `'26.0'`을 뽑는다. iOS 런타임만 남긴다(watchOS·tvOS·visionOS 제외). `isAvailable === false`는 버린다.
- Produces (`simulatorCatalog.ts`): `createSimulatorCatalog({ simctl, sleep?, now? }): VirtualDeviceSource`
  - `list()`: 항목 `{ platform: 'ios', id: udid, name, running: state === 'Booted', serial: state === 'Booted' ? udid : null, osVersion }`.
  - `boot(udid)`: 이미 `Booted`면 `command_failed`(Android와 같은 문구 결). 아니면 `['boot', udid]` 다음 `['bootstatus', udid, '-b']`(timeoutMs 180000). 돌려주는 serial은 udid.
  - `shutdown(serial)`: `['shutdown', serial]`.
- Produces (`trackSimulators.ts`):
  - `trackSimulators(simctl: SimctlClient, onChange: (serial: string, connected: boolean) => void, onFailure: (failure: TrackFailure) => void, opts?: { intervalMs?: number; maxFailures?: number; setTimer?: ...; clearTimer?: ... }): () => void`
  - `['list', 'devices', 'booted', '-j']`를 `intervalMs`(2000)마다 부르고 `state === 'Booted'`만 연결로 친다. 연속 `maxFailures`(3)회 실패하면 `onFailure({ error, exitCode: null })`를 한 번 부르고 폴링을 멈춘다. 반환 함수는 폴링을 멈춘다.
- Modify (`registry.ts`): `DeviceRegistryDeps.track`의 `onChange`를 `(serial, connected, platform: Platform) => void`로, `createDevice`를 `(serial: string, platform: Platform) => Device`로 바꾼다.
- Modify (`index.ts`): `track`은 `trackDevices`(adb, platform `'android'`)와 `trackSimulators`(platform `'ios'`)를 합친 함수. 이 task에서 `createDevice`의 `'ios'` 갈래는 `unsupported`를 던지는 자리표시다(Task 6에서 채운다). iOS 조립 조건은 Task 9에서 붙인다 — 이 task에서는 `process.platform === 'darwin'`일 때만 `trackSimulators`를 합친다.
- `layering.test.ts`: `FORBIDDEN`에 `join(MAIN_DIR, 'ios')`, `join(MAIN_DIR, 'device', 'iosDevice')`를 더하고 guard 테스트에 두 경로를 더한다.

- [ ] **Step 1: 실패하는 테스트를 쓴다**
  - `simctlDevices.test.ts` (`simctl-list-devices.json`): 같은 `name`을 가진 서로 다른 `udid` 항목이 둘 다 나온다 / `osVersion`이 런타임 키에서 나온다 / iOS 아닌 런타임은 없다.
  - `trackSimulators.test.ts` (`simctl-list-devices-booting.json`와 가짜 타이머): `Booting` 상태 기기는 `onChange`를 부르지 않다가 다음 폴링에서 `Booted`가 되면 `(udid, true)` / 사라지면 `(udid, false)` / 3회 연속 reject에 `onFailure` 한 번, 그 뒤 호출 없음 / 중간 성공이 실패 횟수를 되돌린다.
  - `simulatorCatalog.test.ts`: `boot(udid)`가 `boot`과 `bootstatus -b`를 순서대로 부르고 udid를 돌려준다 / 이미 Booted면 `command_failed`.
  - `simctlClient.test.ts`: spawn `ENOENT`에 `ios_tool_not_found` / stderr `Invalid device: x`에 `no_device` / 인자 앞에 `simctl`이 붙는다.
  - `registry.test.ts`: `createDevice`가 `track`이 넘긴 platform을 받는다.

- [ ] **Step 2: 실패를 확인한다**

Run: `npx vitest run src/main/ios src/main/device/parsers/simctlDevices.test.ts src/main/device/registry.test.ts`
Expected: FAIL.

- [ ] **Step 3: 구현한다**

- [ ] **Step 4: 통과를 확인한다**

Run: `npm test && npm run typecheck`
Expected: PASS.

- [ ] **Step 5: 커밋**

```bash
git add -A src
git commit -m "feat(ios): simctl 클라이언트와 시뮬레이터 목록·부팅·추적을 더한다"
```

---

### Task 6: `IosDevice` — 정보, 앱, 스크린샷

**Files:**
- Create: `src/main/device/iosDevice.ts`, `src/main/device/iosDevice.app.test.ts`, `src/main/device/iosDevice.observe.test.ts`,
  `src/main/device/parsers/launchctl.ts`, `src/main/device/parsers/launchctl.test.ts`
- Modify: `src/main/index.ts` (`createDevice`의 `'ios'` 갈래), `src/main/mcp/tools/app.ts` (`app_reset_and_launch`)
- Test: `src/main/mcp/tools/app.test.ts`

**Interfaces:**
- Consumes: `SimctlClient`, `fakeSimctl` (Task 5), `unsupported` (Task 3), `ResizeImage`·`DEFAULT_MAX_LONG_EDGE`(`androidDevice.ts`의 것을 import한다)
- Produces:
  ```ts
  export interface IosDeviceDeps {
    udid: string
    simctl: SimctlClient
    resizeImage: ResizeImage
    /** `plutil -extract CFBundleIdentifier raw -o - <plist>`. 기본값은 execFile. */
    readBundleId?: (infoPlistPath: string) => Promise<string>
    fileExists?: (path: string) => boolean
    isDirectory?: (path: string) => boolean
    /** 데이터 컨테이너 안쪽을 비운다. 기본값은 node:fs/promises의 readdir + rm({ recursive: true, force: true }). */
    emptyDirectory?: (path: string) => Promise<void>
    now?: () => number
  }
  export function createIosDevice(deps: IosDeviceDeps): Device & { readonly platform: 'ios' }
  ```
  - `parseLaunchctlList(stdout: string): Array<{ pid: number; bundleId: string }>` — `UIKitApplication:<bundle id>[...]` 라벨이고 pid가 `-`가 아닌 줄만. Task 8이 쓴다.
- 동작은 스펙 "iOS에서 달라지는 `Device` 동작" 표대로. 이 task에서 정하는 세부:
  - `info()`: `list devices -j`에서 자기 udid 항목의 `name`→`model`, `osVersion`. `width`·`height`는 스크린샷 PNG 원본 크기(한 번 재고 캐시, 실패하면 캐시하지 않는다).
  - `install(appPath)`: 끝의 `/`를 떼고, `.app`으로 끝나는 디렉토리가 아니거나 `Info.plist`가 없으면 `app_path_invalid`. `readBundleId`로 id를 읽은 뒤 `['install', udid, appPath]`. 반환값은 bundle id. `opts.reinstall`은 무시한다(`simctl install`은 늘 덮어쓴다).
  - `stop(pkg)`: `['terminate', udid, pkg]`. reject해도 성공으로 끝낸다.
  - `launch(pkg, activity)`: `activity`가 있으면 `unsupported('ios', 'activity 지정 실행', 'iOS 앱에는 activity가 없다')`. 없으면 `['launch', udid, pkg]`. 설치 안 된 bundle이면(stderr에 `not installed` 또는 `found nothing`) `package_not_found`.
  - `clearData(pkg)`: `stop` → `['get_app_container', udid, pkg, 'data']` → `emptyDirectory(stdout.trim())`. `get_app_container`가 실패하면 `package_not_found`.
  - `grantPermission(pkg, permission)`: `['privacy', udid, 'grant', permission, pkg]`.
  - `screenshot(opts)`: Task 1 결과대로 stdout(`-`)은 안 되므로 임시 파일 경로를 두고 `['io', udid, 'screenshot', '--type=png', <임시 파일>]`을 실행한 뒤 읽고 지운다(`-`를 넘기면 작업 디렉토리에 `-` 파일이 생긴다). scale 검증과 축소는 `androidDevice.ts`와 같은 규칙.
  - `tap`/`swipe`/`inputText`/`pressKey`/`dumpUi`/`displayFrame`: `unsupported('ios', <동작>, 'M4-2에서 지원한다')`.
- `app_reset_and_launch`: `waitForSettle`이 `unsupported` 에러로 실패하면 툴을 실패시키지 않고
  `{ pkg, settled: false, nodeCount: 0, settleSkipped: 'unsupported' }`를 돌려준다. 다른 에러는 그대로 던진다.
  에러 kind로 판단한다. `platform`을 보지 않는다.

- [ ] **Step 1: 실패하는 테스트를 쓴다**
  - `iosDevice.app.test.ts`: `install('/x/My.app/')`가 `Info.plist` 경로로 `readBundleId`를 부르고 `simctl install`에 끝 `/` 없는 경로를 넘겨 bundle id를 돌려준다 / `.apk` 경로·없는 디렉토리는 `app_path_invalid` / `stop`이 `terminate` reject에도 resolve / `launch(pkg, '.Main')`은 `unsupported`이고 `details.platform === 'ios'` / `clearData`가 `terminate` → `get_app_container ... data` → `emptyDirectory('<그 경로>')` 순서 / `get_app_container` 실패는 `package_not_found`.
  - `iosDevice.observe.test.ts`: `info()`가 `simctl-list-devices.json`의 그 udid에 대해 `{ platform: 'ios', model: <name>, osVersion: <버전> }` / `screenshot({ scale: 0 })`은 `command_failed` / `tap(0, 0)`은 `unsupported`.
  - `launchctl.test.ts` (`launchctl-list.txt`): `com.apple.Preferences`의 pid가 나온다 / pid가 `-`인 줄은 없다.
  - `app.test.ts`: `dumpUi`가 `unsupported`로 reject하는 기기에서 `app_reset_and_launch`가 성공하고 `settleSkipped: 'unsupported'` / `command_failed`로 reject하면 툴이 실패한다.

- [ ] **Step 2: 실패를 확인한다**

Run: `npx vitest run src/main/device/iosDevice src/main/device/parsers/launchctl.test.ts`
Expected: FAIL.

- [ ] **Step 3: 구현하고 `index.ts`의 `'ios'` 갈래를 `createIosDevice({ udid: serial, simctl, resizeImage: electronResizeImage })`로 채운다**

- [ ] **Step 4: 통과를 확인한다**

Run: `npm test && npm run typecheck`
Expected: PASS.

- [ ] **Step 5: 커밋**

```bash
git add -A src
git commit -m "feat(ios): IosDevice의 정보·앱·스크린샷을 simctl로 구현한다"
```

---

### Task 7: iOS 로그 파서와 `readLogs`·`clearLogs`

**Files:**
- Create: `src/main/device/parsers/iosLog.ts`, `src/main/device/parsers/iosLog.test.ts`, `src/main/device/iosDevice.logs.test.ts`
- Modify: `src/main/device/iosDevice.ts`

**Interfaces:**
- Produces (`iosLog.ts`):
  - `parseIosLogLine(line: string): (LogLine & { epochMs: number }) | null` — ndjson 한 줄. 매핑은 스펙 "`LogLine` 매핑" 표. `timestamp`는 기기 로컬 `MM-DD HH:mm:ss.SSS`, `epochMs`는 원문 timestamp의 오프셋까지 반영한 epoch. JSON이 아니거나 `eventType`이 `logEvent`가 아니거나(`activityCreateEvent`는 `messageType`이 없다) `eventMessage`가 없으면 null. `timestamp`는 `2026-09-30 14:40:14.608720+0900` 형식이다.
  - `toLogShowStart(since: string, nowMs: number): string` — `MM-DD HH:mm:ss.SSS`를 `log show --start`가 받는 `YYYY-MM-DD HH:mm:ss`로. 연도는 `logClock.ts`의 연말 규칙과 같게 정한다(미래 날짜면 작년).
  - `logFilterPredicate(filter: string): string` — `eventMessage CONTAINS[c] "<f>" OR subsystem CONTAINS[c] "<f>" OR process CONTAINS[c] "<f>"`. `<f>`에서 `\`와 `"`를 역슬래시로 이스케이프한다.
- `IosDevice.readLogs(opts)`: `['spawn', udid, 'log', 'show', '--style', 'ndjson', '--start', <시작>, ...(filter ? ['--predicate', logFilterPredicate(filter)] : [])]`. 시작은 `since` → 마지막 `clearLogs` 시각 → `now - 300000` 순. `pids`로 거른 뒤 `limit`을 뒤에서부터 적용하고 `truncated`·`droppedCount`를 채운다(Android `readLogs`와 같은 의미).
- `IosDevice.clearLogs()`: `now()`를 워터마크로 적는다. simctl을 부르지 않는다.

- [ ] **Step 1: 실패하는 테스트를 쓴다**
  - `iosLog.test.ts` (`log-show.ndjson`, `log-stream.ndjson`): 모든 줄이 null이 아니거나 이유 있게 null / `messageType` `Default`→`I`, `Error`→`E`, `Fault`→`F`, `Debug`→`D` / `subsystem`이 빈 줄의 `tag`는 프로세스 이름 / `logFilterPredicate('a" OR 1==1 OR "')`의 결과에 이스케이프 안 된 `"`가 따옴표 쌍 밖으로 나오지 않는다 / `toLogShowStart('12-31 23:59:59.000', <1월 1일 시각>)`은 작년 연도.
  - `iosDevice.logs.test.ts`: `clearLogs()` 뒤 `readLogs()`의 `--start`가 워터마크 시각 / `since`가 워터마크보다 우선 / `limit: 2`면 마지막 두 줄과 `truncated: true` / `filter`가 `--predicate`로 한 인자로 간다.

- [ ] **Step 2: 실패를 확인한다**

Run: `npx vitest run src/main/device/parsers/iosLog.test.ts src/main/device/iosDevice.logs.test.ts`
Expected: FAIL.

- [ ] **Step 3: 구현한다**

- [ ] **Step 4: 통과를 확인한다**

Run: `npm test && npm run typecheck`
Expected: PASS.

- [ ] **Step 5: 커밋**

```bash
git add -A src
git commit -m "feat(ios): iOS 통합 로그를 LogLine으로 읽고 clearLogs를 워터마크로 한다"
```

---

### Task 8: 앱 로그 패널의 iOS tail과 deps 라우팅

**Files:**
- Create: `src/main/logs/iosLogTail.ts`, `src/main/logs/iosLogTail.test.ts`, `src/main/logs/iosLogDeps.ts`, `src/main/logs/iosLogDeps.test.ts`
- Modify: `src/main/index.ts` (`createLogManager` deps)

**Interfaces:**
- Consumes: `LogTailHandlers`, `LogTail`(`logTail.ts`), `RECONNECT_DELAYS_MS`, `parseIosLogLine`(Task 7), `parseLaunchctlList`(Task 6)
- Produces:
  - `createIosLogTail(deps: { udid: string; simctl: SimctlClient; isConnected(): boolean; sleep?: (ms: number) => Promise<void> }, handlers: LogTailHandlers): LogTail`
    - `['spawn', udid, 'log', 'stream', '--style', 'ndjson']`(기본 레벨=info 이상). 줄마다 `parseIosLogLine`, `handlers.onLine(line, epochMs)`.
    - 끊기면 `RECONNECT_DELAYS_MS`로 다시 붙고 붙으면 `onResume()`. `log stream`은 과거를 다시 주지 않으므로 재생 중복 처리는 없다. 기기가 끊겼으면 포기하고 `onState('stopped')`. 상태 전이는 `logTail.ts`와 같다.
  - `createIosSeedPids(simctl): LogManagerDeps['seedPids']` — `launchctl list`를 `parseLaunchctlList`로 읽어 `PID NAME` 헤더와 `<pid> <bundleId>` 줄로 된 문자열을 돌려준다. `pidTracker.seed`가 그대로 읽는 모양이다.
  - `createIosPidof(simctl): LogManagerDeps['pidof']` — 같은 목록에서 그 bundle id의 pid. 실패는 빈 배열.
- `index.ts`: `createLogManager`의 `createTail`·`seedPids`·`pidof`는 `registry.resolve(serial).platform`으로 Android·iOS 구현을 고르는 작은 라우터 함수로 감싼다. `resolve`가 던지면(끊긴 기기) seed·pidof는 빈 결과다.

- [ ] **Step 1: 실패하는 테스트를 쓴다**
  - `iosLogTail.test.ts` (가짜 stream에 `log-stream.ndjson` 줄을 흘림): 줄마다 `onLine`에 `epochMs`가 온다 / stream close 후 재연결에 `onResume` / `isConnected()`가 false면 `onState('stopped')` 한 번 / `stop()` 뒤에는 아무 핸들러도 안 불린다.
  - `iosLogDeps.test.ts` (`launchctl-list.txt`): `seedPids` 결과를 `createPidTracker().seed`에 넣으면 `packageOf(<Settings pid>) === 'com.apple.Preferences'` / `pidof(udid, 'com.apple.Preferences')`가 그 pid / simctl reject에 `[]`.

- [ ] **Step 2: 실패를 확인한다**

Run: `npx vitest run src/main/logs/iosLogTail.test.ts src/main/logs/iosLogDeps.test.ts`
Expected: FAIL.

- [ ] **Step 3: 구현하고 `index.ts`의 라우터를 붙인다**

- [ ] **Step 4: 통과를 확인한다**

Run: `npm test && npm run typecheck`
Expected: PASS.

- [ ] **Step 5: 커밋**

```bash
git add -A src
git commit -m "feat(logs): 로그 패널에 iOS log stream tail을 붙인다"
```

---

### Task 9: 플랫폼별 조립, 플랫폼 상태 스냅샷, iOS 스트림 거절

**Files:**
- Create: `src/main/ios/locateIosTools.ts`, `src/main/ios/locateIosTools.test.ts`,
  `src/main/stream/rejectingSession.ts`, `src/main/stream/rejectingSession.test.ts`
- Modify: `src/main/app/bootstrap.ts`, `src/main/app/bootstrap.test.ts`, `src/main/app/appState.ts`, `src/shared/types/ipc.ts`,
  `src/main/index.ts`, `src/renderer/src/App.tsx`, `src/renderer/src/components/SdkMissing.tsx`, `src/renderer/src/components/DevicePanel.tsx`
- Test: `src/renderer/src/App.test.tsx`, `src/renderer/src/components/SdkMissing.test.tsx`, `src/renderer/src/components/DevicePanel.test.tsx`

**Interfaces:**
- Produces (`locateIosTools.ts`):
  - `type IosToolsResult = { ok: true; developerDir: string } | { ok: false; reason: string }`
  - `locateIosTools(deps: { platform: NodeJS.Platform; execFile: ExecFileFn }): Promise<IosToolsResult>` — darwin이 아니면 `{ ok: false, reason: 'macOS에서만 iOS 시뮬레이터를 쓸 수 있다' }`. `xcode-select -p`와 `xcrun simctl help`가 모두 성공해야 ok.
- Produces (`ipc.ts`):
  - `type PlatformStatus = { ok: true; location: string } | { ok: false; reason: string; searched: string[] }`
  - `AppSnapshot.sdk` → `platforms: { android: PlatformStatus; ios: PlatformStatus }`. Android는 `location: sdkRoot` / `searched: located.searched`, iOS는 `location: developerDir` / `reason`, `searched: []`.
- `BootstrapDeps`: `located`는 그대로(Android), `iosTools: IosToolsResult`를 더한다. `createDeviceStack(android: SdkPaths | null, ios: boolean)`, `createStreamManager`·`createLogManager`의 `paths`는 `SdkPaths | null`.
- `bootstrapApp`: 두 플랫폼 모두 준비되지 않았을 때만 `assembleWithoutSdk`(이름은 `assembleWithoutPlatforms`로 바꾼다). 하나라도 준비되면 지금의 전체 조립과 MCP 서버를 연다.
- `index.ts`:
  - `createDeviceStack`: Android paths가 있으면 adb 추적과 `createAvdController` 소스를, iOS가 ok면 `trackSimulators`와 `createSimulatorCatalog` 소스를 넣는다. Task 5의 `process.platform` 조건은 여기서 `ios` 인자로 대체한다.
  - `createStreamManager`의 `createSession`: `registry.resolve(serial).platform === 'ios'`면 `start()`가 `unsupported('ios', '실시간 화면', 'M4-3에서 지원한다')`로 reject하는 세션을 돌려준다. 첫 `start()` 실패는 재시도 없이 `failed`로 간다(`streamManager.ts`의 `open` 흐름). renderer는 `DeviceScreen`에서 스크린샷으로 강등한다.
- renderer:
  - `App.tsx`: `!platforms.android.ok && !platforms.ios.ok`일 때만 `SdkMissing`.
  - `SdkMissing`: props `platforms`. Android 안내(지금 문구와 `searched`)와 iOS 안내(`reason`, `Xcode를 설치하고 xcode-select -s로 개발자 디렉토리를 정해라`)를 함께 그린다.
  - `DevicePanel`: 한쪽만 ok면 목록 위에 `<p className="notice notice-info">`로 빠진 쪽의 한 줄 안내를 띄운다. 문구는 Android `Android SDK를 찾지 못해 AVD는 쓸 수 없다.`, iOS `<reason> — iOS 시뮬레이터는 쓸 수 없다.`

- [ ] **Step 1: 실패하는 테스트를 쓴다**
  - `locateIosTools.test.ts`: `linux`면 ok false / `xcrun` ENOENT면 ok false / 둘 다 성공하면 `developerDir`.
  - `bootstrap.test.ts`: `located.ok === false`, `iosTools.ok === true`면 `startServer`가 불리고 스냅샷 `platforms.android.ok === false`, `platforms.ios.ok === true` / 둘 다 false면 서버 없음(기존 테스트를 옮긴다).
  - `App.test.tsx`: Android만 없으면 `SdkMissing`이 아니라 기기 패널과 Android 안내 한 줄이 보인다.
  - `SdkMissing.test.tsx`: 둘 다 없을 때 두 안내가 모두 보인다.
  - `index.ts`의 스트림 거절은 `streamManager.test.ts` 모양의 가짜로 `start()` reject → 첫 상태가 `failed`이고 `error.kind === 'unsupported'`인지 본다(`src/main/stream/rejectingSession.ts`의 `rejectingSession(error: DeviceError): ReturnType<StreamManagerDeps['createSession']>`로 뽑는다. `start()`는 그 에러로 reject하고, 나머지 멤버는 아무것도 하지 않는다. 테스트는 이 세션을 `createStreamManager`에 넣고 `open` 뒤 포트의 첫 `status`가 `failed`이며 `reconnecting`이 없음을 본다. `index.ts`는 테스트가 없으므로 판단 로직을 거기 두지 않는다). `StreamSession` 인터페이스로 올리는 일은 M4-3이다.

- [ ] **Step 2: 실패를 확인한다**

Run: `npx vitest run src/main/ios/locateIosTools.test.ts src/main/app src/renderer/src/App.test.tsx src/renderer/src/components`
Expected: FAIL.

- [ ] **Step 3: 구현한다**

- [ ] **Step 4: 통과를 확인한다**

Run: `npm test && npm run typecheck`
Expected: PASS.

- [ ] **Step 5: 커밋**

```bash
git add -A src
git commit -m "feat(app): 플랫폼마다 따로 조립하고 하나라도 준비되면 MCP 서버를 연다"
```

---

### Task 10: 통합 테스트, 문서, 완료 검증

**Files:**
- Create: `src/main/device/iosDevice.ios.integration.test.ts`
- Modify: `docs/architecture/main-layers.md`, `docs/superpowers/specs/2026-09-29-m4-ios-simulator.md`, 이 계획 문서

- [ ] **Step 1: 통합 테스트를 쓴다**

부팅된 시뮬레이터가 없거나 `xcrun`이 없으면 `describe.skip`. 있으면 첫 Booted 기기로:
`info().platform === 'ios'` / `launch('com.apple.Preferences')` 후 `readLogs({ limit: 50 })`가 한 줄 이상 /
`screenshot()`의 PNG가 디코드되고 긴 변이 `DEFAULT_MAX_LONG_EDGE` 이하 / `stop('com.apple.Preferences')` 두 번 연속 성공 /
`clearLogs()` 직후 `readLogs()`에 그 이전 timestamp가 없다.

Run: `npm run test:integration -- src/main/device/iosDevice.ios.integration.test.ts`
Expected: PASS (시뮬레이터 부팅 상태에서).

- [ ] **Step 2: `main-layers.md`를 고친다**

층 그림에 `simctlClient → IosDevice`와 `processClient`를, 기기 추적에 simctl 폴링을, 로그에 iOS tail과
deps 라우터를 더한다. 코드와 대조한 뒤 `verified`를 오늘 날짜로 바꾼다.

- [ ] **Step 3: 앱으로 완료 기준을 확인한다**

`npm run dev`로 앱을 띄우고, MCP 클라이언트로 다음을 순서대로 한다. 결과를 스펙 끝에 "M4-1 검증 결과" 절로 적는다.

1. `device_list`에 시뮬레이터가 `platform: 'ios'`, `id`=UDID로 뜬다.
2. `device_boot({ id })` → `device_info`가 `osVersion`을 준다. 기기 패널에 iOS 라벨로 뜬다.
3. 로컬에 빌드된 `.app` 하나(없으면 Xcode 템플릿 앱을 시뮬레이터용으로 빌드)를 `app_install` → `app_launch` → `screenshot` → `log_read({ package })`.
4. `app_reset_and_launch`가 데이터를 비우고 다시 띄우고 `settleSkipped: 'unsupported'`를 준다.
5. 앱 로그 패널에 iOS 로그가 흐르고, 초당 줄 수를 적는다(스펙 "로그" 절의 링 버퍼 재검토용).
6. iOS 기기를 고르면 화면 영역이 스크린샷으로 강등되고 `unsupported` 안내가 보인다.
7. `ui_tap`이 `unsupported`를 준다.

- [ ] **Step 4: 문서 검사와 커밋**

Run: `python3 docs/script/docs.py lint && python3 docs/script/docs.py links`
Expected: 문제 0건.

```bash
git add -A src docs
git commit -m "docs(ios): M4-1 통합 테스트와 앱 확인 결과를 남긴다"
```
