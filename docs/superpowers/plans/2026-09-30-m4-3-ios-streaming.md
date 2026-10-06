---
id: m4-3-ios-streaming
title: M4-3 — iOS 스트리밍과 화면 입력
status: in-progress
type: work-order
created: 2026-09-30
updated: 2026-10-06
owner: virtual-device-helper 팀
scope: [main, renderer, shared, streaming, ios]
hosts: [macos]
archived_reason:
related_adr: [ADR-0016, ADR-0014, ADR-0015, ADR-0010, ADR-0002]
related_spec: m4-ios-simulator
related_architecture: main-layers
related_plan: [m4-1-ios-foundation, m4-2-ios-input-nodes]
related_code: [streamManager.ts#createStreamManager, streamManager.ts#toControlIntent, scrcpySession.ts#ScrcpySession, rejectingSession.ts#rejectingSession, stream.ts#StreamDown, stream.ts#DeviceKey, useScrcpyStream.ts#useScrcpyStream, streamDecoder.ts#createStreamDecoder, DeviceScreen.tsx#DeviceScreen, axeClient.ts#createAxeClient]
tags: [plan, ios, streaming, axe]
---

# M4-3 — iOS 스트리밍과 화면 입력 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: `superpowers:subagent-driven-development`(권장) 또는
> `superpowers:executing-plans`로 task 단위 구현. 각 단계는 체크박스(`- [x]`)로 추적한다.

**Goal:** 앱 창에 iOS 시뮬레이터 화면이 실시간으로 보이고 마우스·키보드로 조작된다.

**Architecture:** 스트림 세션을 `StreamSession` 인터페이스로 올리고 `ScrcpySession`과 새
`AxeStreamSession`이 구현한다. `AxeStreamSession`은 `axe stream-video` MJPEG를 JPEG 한 장씩 잘라
`frame` 메시지로 보낸다. `session` 메시지가 `codec`과 `keys`를 알리고, renderer는 `codec`으로
WebCodecs 경로와 새 `jpegRenderer`를 고른다. 화면 입력은 `axeControl`이 제스처를 모아 AXe 호출로 바꾼다.

**Tech Stack:** TypeScript, Electron MessagePort, AXe CLI, WebCodecs, `createImageBitmap`, React, Vitest

**Spec:** [`../specs/2026-09-29-m4-ios-simulator.md`](../specs/2026-09-29-m4-ios-simulator.md) —
"스트리밍과 화면 입력 (M4-3)" 절, "스파이크 결과" 4·5번. 결정 근거는
[ADR-0016](../../adr/0016-stream-codec-per-session.md).

**선행 조건:** [M4-2](2026-09-30-m4-2-ios-input-nodes.md) 완료(`axeClient`, `locateAxe`, `IosDevice.displayFrame`).
M4-1 Task 1의 fixture `stream-video-jpeg.bin`(JPEG 파트). `stream-video.bin`은 기본 인자(scale 1.0, quality 80)로 받은 것이라 파트가 PNG다 — 분할기 입력으로 쓰지 않는다.

## Global Constraints

- 답변·주석·문서는 한국어로 쓴다. 기술 용어·API 이름·명령어·에러 문자열은 원문 그대로 둔다.
- 포트 메시지 모양은 스펙 "포트 메시지" 절 그대로다. `session`에 `codec: 'h264' | 'jpeg'`와
  `keys: DeviceKey[]`, 새 `{ type: 'frame'; data: Uint8Array }`.
- `stream-video` 시작 인자는 `['stream-video', '--format', 'mjpeg', '--fps', '30', '--scale', '0.5', '--quality', '70']`다.
  상수로 두고 스파이크 결과로 바꿀 수 있게 한 곳에 모은다.
- iOS 세션의 `keys`는 `['home', 'power', 'enter', 'backspace', 'forward_delete', 'tab', 'escape', 'up', 'down', 'left', 'right']`.
  Android(scrcpy) 세션은 `DEVICE_KEYS` 전부.
- HID keycode: enter 40, escape 41, backspace 42, tab 43, forward_delete 76, right 79, left 80, down 81, up 82.
  `home` → `button home`, `power` → `button lock`.
- renderer는 `platform`을 읽지 않는다. 디코더 선택은 `session.codec`, 버튼은 `session.keys`로만 한다.
- `streamManager`의 재연결·포트·세션 수명 로직은 바꾸지 않는다. 바뀌는 것은 세션 타입과 메시지 전달뿐이다.
- 화면 입력 AXe 호출은 기기당 순서대로 한 번에 하나만 돈다. 앞 호출이 끝나기 전에 다음 제스처가
  오면 뒤에 줄 세운다.
- 새 npm 의존성을 들이지 않는다.
- 각 task 끝에서 `npm test`와 `npm run typecheck`가 통과해야 한다.
- 문서에는 라인번호, 파일·툴 개수, 진행률을 적지 않는다. 문서를 고치면 `docs.py lint`와 `docs.py links`를 돌린다.
- 커밋 메시지는 한국어 Conventional Commits이고, 끝에 다음 줄을 붙인다:
  `Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>`

## M4-2에서 넘어온 과제

M4-2 작업 중 미룬 것 중 이 계획이 맡는 것이다. 해당 task에 붙여 처리한다.

- 기기 추적 실패 안내(`trackingFailure`)가 한 칸이라 iOS 폴링만 죽어도 어느 쪽인지 말하지 않는다. 플랫폼별로 나눠 어느 플랫폼의 추적이 죽었는지 말하게 한다. renderer의 안내 표시를 만지는 Task 5에 붙이는 것이 자연스럽다. → Task 5.
  - **했다(Task 5).** `registry.ts`의 `tracking_failed` 이벤트가 `platform`을 싣고 안내가 어느 플랫폼인지 말한다.
- `inputText`가 시뮬레이터 클립보드를 덮어쓴다(M4-2 스펙 "입력 매핑"). 입력 전 `simctl pbpaste`로 읽어 두었다가 붙여 넣은 뒤 `pbcopy`로 되돌리는 복원을 검토한다. Simulator.app pasteboard 동기화로 호스트 클립보드까지 덮이는지도 그때 측정한다.
  - **만들지 않기로 했다.** ⌘V는 `key-combo`가 돌아온 뒤에 비동기로 처리되므로 곧바로 되돌리면 이전 내용이 붙을 수 있다. 측정 결과 호스트 클립보드는 Simulator.app이 없을 때, 뒤에 떠 있을 때, 앞에 있다가 물러날 때 모두 바뀌지 않았다(스펙 "M4-3 검증 결과").
- SDK/AXe 없음 안내를 Android도 iOS처럼 main이 hint로 정해 내려 주게 대칭화한다. 지금은 `SdkMissing`·`DevicePanel`의 Android 안내 문구가 renderer에 고정돼 있다.
  - **했다.** `bootstrap.ts`의 `platformStatuses`가 Android 안내도 `hint`로 내려 준다.

## Review Focus

- **청크 경계에 걸린 JPEG**: `FFD8`/`FFD9`가 두 stdout 청크에 걸쳐 쪼개져 와도 프레임 하나로
  이어 붙는다. → Task 2 테스트.
- **회전**: 계획할 때는 시뮬레이터를 가로로 돌리면 JPEG 크기가 바뀌어 새 `session`이 가고 캔버스와 입력
  좌표가 따라간다고 봤다. 실제 기기에서는 그렇지 않았다. `stream-video` 프레임은 세로 그대로이고 내용만
  누워서 오며 새 `session`은 오지 않는다. `displayFrame`만 가로가 된다(스펙 "M4-3 검증 결과"). 그래서
  `axeControl.ts`의 `createAxeControl`은 `displayFrame`과 프레임의 방향이 어긋나면 탭·스와이프·scroll을
  보내지 않고 `unsupported`를 한 번 알린다(R12). 크기가 바뀐 프레임에 `session`을 다시 보내는 경로는
  그대로 있고 Task 3·5 테스트가 덮지만, 시뮬레이터 회전으로는 그 경로를 타지 않는다.
- **느린 디코드**: renderer 디코드가 프레임 속도를 못 따라가면 최신 한 장만 그리고 쌓지 않는다.
  → Task 5 테스트.
- **빠른 연타**: 탭을 빠르게 여러 번 하면 순서가 뒤바뀌지 않고 모두 간다. → Task 4 테스트.
- **iOS에 없는 키**: 캔버스 키보드에서 누른 키가 `keys`에 없으면 main이 조용히 버리고 세션은
  죽지 않는다. → Task 4 테스트.

---

### Task 1: `StreamSession` 인터페이스와 `session`의 `codec`·`keys`

**Files:**
- Create: `src/main/stream/streamSession.ts`
- Modify: `src/main/stream/streamManager.ts`, `src/main/stream/scrcpySession.ts`, `src/main/stream/rejectingSession.ts`,
  `src/shared/types/stream.ts`, `src/renderer/src/hooks/useScrcpyStream.ts`
- Test: `src/main/stream/streamManager.test.ts`, `src/main/stream/scrcpySession.test.ts`, `src/renderer/src/hooks/useScrcpyStream.test.tsx`

**Interfaces:**
- Produces (`streamSession.ts`):
  ```ts
  export interface SessionInfo { width: number; height: number; codec: 'h264' | 'jpeg'; keys: DeviceKey[] }
  export interface StreamSessionHandlers {
    onSession(info: SessionInfo): void
    onPacket(packet: VideoPacket): void
    onFrame(jpeg: Uint8Array): void
    onEnded(error: DeviceError): void
  }
  export interface StreamSession {
    readonly serial: string
    start(): Promise<void>
    sendControl(intent: ControlIntent): void
    close(): Promise<void>
  }
  ```
- `StreamManagerDeps.createSession(serial, handlers: StreamSessionHandlers): StreamSession`. `handlersFor`가 `onFrame`을 `{ type: 'frame', data }`로 보낸다.
- `ScrcpySession`은 `StreamSession`을 구현하고 `onSession({ width, height, codec: 'h264', keys: [...DEVICE_KEYS] })`를 부른다.
- `stream.ts`: 스펙 "포트 메시지" 절대로 `StreamDown`을 고친다.
- renderer `useScrcpyStream`: `session` 메시지의 `codec`·`keys`를 상태로 들고 반환값에 `keys: DeviceKey[]`를 더한다. `frame` 메시지는 이 task에서는 무시한다(Task 5).

- [x] **Step 1: 실패하는 테스트를 쓴다** — `streamManager.test.ts`: 가짜 세션이 `onFrame(bytes)`를 부르면 포트에 `{ type: 'frame', data: bytes }` / `onSession(info)`가 `codec`·`keys`를 그대로 싣는다. `scrcpySession.test.ts`: 첫 meta에 `codec: 'h264'`와 `DEVICE_KEYS`. `useScrcpyStream.test.tsx`: `session` 메시지 뒤 `keys`가 반환된다.
- [x] **Step 2: 실패를 확인한다** — Run: `npx vitest run src/main/stream src/renderer/src/hooks/useScrcpyStream.test.tsx` / Expected: FAIL.
- [x] **Step 3: 구현한다.**
- [x] **Step 4: 통과를 확인한다** — Run: `npm test && npm run typecheck` / Expected: PASS.
- [x] **Step 5: 커밋** — `git commit -m "refactor(stream): 세션을 StreamSession으로 올리고 session에 codec과 keys를 싣는다"`

---

### Task 2: MJPEG 분할기와 JPEG 크기 읽기

**Files:**
- Create: `src/main/stream/mjpegSplitter.ts`, `src/main/stream/mjpegSplitter.test.ts`, `src/main/stream/jpegSize.ts`, `src/main/stream/jpegSize.test.ts`

**Interfaces:**
- Produces:
  - `createMjpegSplitter(onFrame: (jpeg: Uint8Array) => void, opts?: { maxFrameBytes?: number }): { push(chunk: Buffer): void }` — SOI(`FF D8`)부터 EOI(`FF D9`)까지를 한 장으로 낸다. SOI 앞 바이트(multipart 경계·헤더)는 버린다. `maxFrameBytes`(기본 8MiB)를 넘도록 EOI가 안 오면 그 장을 버리고 다음 SOI를 찾는다.
  - `jpegSize(jpeg: Uint8Array): { width: number; height: number } | null` — SOF0/SOF1/SOF2 마커의 크기. 없으면 null.

- [x] **Step 1: 실패하는 테스트를 쓴다** (`stream-video-jpeg.bin`) — 스트림은 HTTP 응답 헤더와 `multipart/x-mixed-replace; boundary=--mjpegstream` 파트 헤더가 섞여 온다. 분할기는 헤더 바이트를 건너뛰고 SOI~EOI만 낸다. fixture 전체를 한 번에 push하면 프레임이 하나 이상, 각 프레임이 `FFD8`로 시작해 `FFD9`로 끝난다 / 같은 fixture를 1바이트씩 push해도 같은 프레임들 / 첫 프레임의 `jpegSize`가 양수 / 잘린 JPEG에서 `jpegSize`가 null / `maxFrameBytes: 16`이면 큰 프레임은 버려지고 다음 프레임은 나온다.
- [x] **Step 2: 실패를 확인한다** — Run: `npx vitest run src/main/stream/mjpegSplitter.test.ts src/main/stream/jpegSize.test.ts` / Expected: FAIL.
- [x] **Step 3: 구현한다.**
- [x] **Step 4: 통과를 확인한다** — Run: `npm test && npm run typecheck` / Expected: PASS.
- [x] **Step 5: 커밋** — `git commit -m "feat(stream): MJPEG 스트림을 JPEG 한 장씩 자른다"`

---

### Task 3: `AxeStreamSession`

**Files:**
- Create: `src/main/stream/axeStreamSession.ts`, `src/main/stream/axeStreamSession.test.ts`

**Interfaces:**
- Consumes: `AxeClient`·`fakeAxe`(M4-2 Task 1), `StreamSession`·`StreamSessionHandlers`(Task 1), `createMjpegSplitter`·`jpegSize`(Task 2), `AxeControl`(Task 4 — 이 task에서는 `sendControl`을 주입된 `control.send`로 넘기기만 한다)
- Produces:
  ```ts
  export interface AxeStreamSessionDeps {
    udid: string
    axe: AxeClient
    control: { send(intent: ControlIntent, video: { width: number; height: number }): void; close(): void }
    firstFrameTimeoutMs?: number   // 기본 10000
    setTimer?: typeof setTimeout
    clearTimer?: typeof clearTimeout
  }
  export function createAxeStreamSession(deps: AxeStreamSessionDeps, handlers: StreamSessionHandlers): StreamSession
  ```
  - `start()`: `axe.stream(udid, STREAM_ARGS)`. 첫 프레임에서 `jpegSize`로 `onSession({ …, codec: 'jpeg', keys: IOS_KEYS })`을 부르고 resolve. 시간 안에 첫 프레임이 없으면 스트림을 닫고 `device_unresponsive`로 reject. 첫 프레임 전에 스트림이 끝나면 그 에러로 reject.
  - 이후 프레임마다 `onFrame`. 크기가 바뀌면 먼저 `onSession`을 다시 부른다.
  - 시작 뒤 스트림이 예기치 않게 끝나면 `onEnded`를 한 번. `close()`로 닫으면 부르지 않는다.
  - `sendControl(intent)`: 마지막 `SessionInfo`의 `width`·`height`와 함께 `control.send`로 넘긴다.

- [x] **Step 1: 실패하는 테스트를 쓴다** — 가짜 stream에 fixture를 흘리면 `start()`가 resolve하고 `onSession`의 `codec === 'jpeg'` / 첫 프레임 없이 타이머가 다 되면 `device_unresponsive` / 크기가 다른 JPEG가 오면 `onSession`이 다시 불린다(fixture 프레임 둘의 SOF 크기 바이트를 바꾼 복사본) / 시작 뒤 close 이벤트에 `onEnded` 한 번, `close()` 뒤에는 없음 / `sendControl`이 현재 크기를 싣는다.
- [x] **Step 2: 실패를 확인한다** — Run: `npx vitest run src/main/stream/axeStreamSession.test.ts` / Expected: FAIL.
- [x] **Step 3: 구현한다.**
- [x] **Step 4: 통과를 확인한다** — Run: `npm test && npm run typecheck` / Expected: PASS.
- [x] **Step 5: 커밋** — `git commit -m "feat(stream): axe stream-video로 iOS 스트림 세션을 연다"`

---

### Task 4: `axeControl` — 화면 입력을 AXe 호출로

**Files:**
- Create: `src/main/stream/axeControl.ts`, `src/main/stream/axeControl.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export interface AxeControlDeps {
    udid: string
    axe: AxeClient
    /** point 단위. IosDevice.displayFrame()을 넘긴다. 제스처마다 한 번 부른다. */
    displayFrame(): Promise<DisplayFrame>
    now?: () => number
    onError?: (error: DeviceError) => void   // 기본은 console.error
  }
  export function createAxeControl(deps: AxeControlDeps): { send(intent: ControlIntent, video: { width: number; height: number }): void; close(): void }
  ```
- 동작은 스펙 "화면 입력" 절:
  - 좌표 변환: `VideoPoint`(JPEG 픽셀) × (`displayFrame` / `video`).
  - `touch` down → 시작점·시각 기록, move → 끝점 갱신, up → 이동이 10 point 미만이면 `tap`, 이상이면 `swipe`(`--duration` = 경과 초, 최소 0.05).
  - `scroll`: 그 점에서 `swipe`. 거리 = `displayFrame.height × 0.15 × clamp(vScroll, -1, 1)` 세로(가로는 `hScroll`로 같게). `vScroll > 0`이면 손가락이 아래로 간다. duration 0.1.
  - `text`: `['type', '--stdin']`, `input: text`.
  - `key`: Global Constraints의 표. 표에 없는 키는 AXe를 부르지 않고 버린다.
  - 호출은 한 줄로 세운다(Global Constraints). 실패는 `onError`로 보내고 다음 호출은 계속한다.
  - `close()` 뒤에 온 `send`는 버린다. 진행 중 제스처도 버린다.

- [x] **Step 1: 실패하는 테스트를 쓴다** — down·up 같은 점 → `tap` 한 번, 좌표가 `displayFrame`/`video` 비율로 환산 / down·move·up 긴 이동 → `swipe` 한 번, 시작·끝·duration / 탭 셋을 연달아 보내고 첫 호출을 늦게 resolve시키면 `calls` 순서가 보낸 순서 / `key: 'back'` → 호출 없음 / `key: 'power'` → `['button', 'lock']` / 첫 호출이 reject해도 둘째 호출이 간다 / `scroll` vScroll 1 → 끝점 y가 시작보다 크다.
- [x] **Step 2: 실패를 확인한다** — Run: `npx vitest run src/main/stream/axeControl.test.ts` / Expected: FAIL.
- [x] **Step 3: 구현한다.**
- [x] **Step 4: 통과를 확인한다** — Run: `npm test && npm run typecheck` / Expected: PASS.
- [x] **Step 5: 커밋** — `git commit -m "feat(stream): 화면 입력을 제스처 단위 AXe 호출로 바꾼다"`

---

### Task 5: renderer JPEG 경로와 키 버튼

**Files:**
- Create: `src/renderer/src/stream/jpegRenderer.ts`, `src/renderer/src/stream/jpegRenderer.test.ts`
- Modify: `src/renderer/src/hooks/useScrcpyStream.ts`, `src/renderer/src/components/DeviceScreen.tsx`
- Test: `src/renderer/src/hooks/useScrcpyStream.test.tsx`, `src/renderer/src/components/DeviceScreen.test.tsx`

**Interfaces:**
- Produces:
  ```ts
  export interface JpegRendererDeps {
    decode(jpeg: Uint8Array): Promise<ImageBitmap>   // 기본 createImageBitmap(new Blob([jpeg], { type: 'image/jpeg' }))
    draw(bitmap: ImageBitmap): void                  // 캔버스에 그리고 bitmap.close()
  }
  export function createJpegRenderer(deps: JpegRendererDeps): { push(jpeg: Uint8Array): void; close(): void }
  ```
  - 디코드 중에 온 프레임은 최신 한 장만 남기고 앞의 것은 버린다. 디코드가 끝나면 남은 한 장을 이어서 디코드한다. `close()` 뒤에 끝난 디코드는 그리지 않고 bitmap을 닫는다.
- `useScrcpyStream`: `session.codec`이 `jpeg`면 `createStreamDecoder` 대신 `createJpegRenderer`를 만들고 `frame` 메시지를 넣는다. 캔버스 크기는 두 경로 모두 `session`의 `width`·`height`만 따른다. codec이 바뀌는 `session`이 오면 이전 경로를 닫는다.
- `DeviceScreen`: `DEVICE_BUTTONS` 중 `keys`에 있는 것만 그린다.

- [x] **Step 1: 실패하는 테스트를 쓴다** — `jpegRenderer`: 느린 `decode` 중 프레임 셋을 push하면 `draw`는 첫 장과 마지막 장 두 번 / `close()` 뒤 끝난 디코드는 `draw`하지 않는다. `useScrcpyStream`: `codec: 'jpeg'` 세션에서 `frame`이 jpeg 경로로 가고 `VideoDecoder`는 만들지 않는다 / `codec`이 h264→jpeg로 바뀌면 이전 디코더의 `close`가 불린다. `DeviceScreen`: `keys`에 `back`이 없으면 뒤로 버튼이 없다.
- [x] **Step 2: 실패를 확인한다** — Run: `npx vitest run src/renderer/src/stream/jpegRenderer.test.ts src/renderer/src/hooks src/renderer/src/components/DeviceScreen.test.tsx` / Expected: FAIL.
- [x] **Step 3: 구현한다.**
- [x] **Step 4: 통과를 확인한다** — Run: `npm test && npm run typecheck` / Expected: PASS.
- [x] **Step 5: 커밋** — `git commit -m "feat(renderer): JPEG 스트림 경로를 더하고 키 버튼을 세션이 준 목록으로 그린다"`

---

### Task 6: 조립, 통합 테스트, 완료 검증

**Files:**
- Modify: `src/main/index.ts`, `docs/superpowers/specs/2026-09-29-m4-ios-simulator.md`, `docs/architecture/main-layers.md`,
  `docs/adr/0016-stream-codec-per-session.md`(`related_plan`), 이 계획 문서
- Create: `src/main/stream/axeStreamSession.ios.integration.test.ts`

- [x] **Step 1: 조립을 바꾼다**

`index.ts`의 `createSession`: 기기 `platform`이 `ios`이고 axe가 있으면
`createAxeStreamSession({ udid, axe, control: createAxeControl({ udid, axe, displayFrame: () => device.displayFrame(), inputText: (text) => device.inputText(text) }) }, handlers)`
(R2. 실제 조립은 `rejectingSession.ts`의 `createIosStreamSessionFactory`가 하고 `inputText`를 `registry.run`에 세운다),
axe가 없으면 `rejectingSession(ios_tool_not_found 에러)`. M4-1의 `unsupported` 거절은 지운다.

Run: `npm test && npm run typecheck` / Expected: PASS.

- [x] **Step 2: 통합 테스트를 쓴다**

부팅된 시뮬레이터와 axe가 없으면 skip. 세션을 열어 2초 동안 받은 프레임 수와 첫 프레임까지 걸린 시간을
`console.info`로 남기고, 프레임이 하나 이상이며 `onSession.codec === 'jpeg'`인지 본다. 탭 한 번을
`sendControl`로 보내 reject가 없는지 본다.

Run: `npm run test:integration -- src/main/stream/axeStreamSession.ios.integration.test.ts` / Expected: PASS.

- [ ] **Step 3: 앱으로 완료 기준을 확인한다** — 실제 모듈로 확인했다. 영문 한 글자씩 입력은 글자를 모아 붙이게 고쳐 다시 확인했고(R11), 가로 화면은 따라가지 않고 터치를 막는 것으로 정했다(R12). 앱 창에서 보는 항목은 사람 확인이 남았다. 화면 키보드 입력은 ASCII만 간다(`inputMapper.ts`의 `keyToIntent`). main의 `text` 경로는 한글을 받지만 renderer 조합 입력(IME)은 후속 과제다. 스펙 "M4-3 검증 결과".

앱에서 iOS 기기를 골라: 실시간 화면이 뜬다 / Settings 셀을 클릭하면 들어간다 / 목록을 드래그·휠로
스크롤한다 / 검색 필드에 키보드로 영문·한글을 친다 / 홈 버튼이 동작하고 뒤로 버튼은 없다 /
시뮬레이터를 가로로 돌리면 화면과 클릭 좌표가 따라간다 / 시뮬레이터를 끄면 스트림이 닫힌다.
관찰한 fps·입력 지연을 스펙 끝 "M4-3 검증 결과" 절에 적는다. 드래그 반영 지연이 쓰기 어려운 수준이면
스파이크 5번(`batch --stdin`) 결과와 함께 후속 과제로 적는다.

- [ ] **Step 4: 문서를 마무리하고 커밋한다** — 문서는 맞췄다. 스펙 `implemented`와 이 계획 `done`으로 닫는 것은 사람이 앱 창을 확인한 뒤 정한다(R13).

`main-layers.md`에 스트림 세션 두 갈래를 더하고 `verified`를 갱신한다. 스펙 `status`를 `implemented`로,
세 계획의 `status`를 `done`으로 바꾼다(아카이브 이동은 머지 뒤 따로 한다).

Run: `python3 docs/script/docs.py lint && python3 docs/script/docs.py links` / Expected: 문제 0건.

`git commit -m "docs(ios): M4-3 앱 확인 결과를 남기고 M4 스펙을 닫는다"`
