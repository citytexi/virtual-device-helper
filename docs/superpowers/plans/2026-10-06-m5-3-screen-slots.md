---
id: m5-3-screen-slots
title: M5-3 — 화면 칸과 여러 화면
status: draft
type: work-order
created: 2026-10-06
updated: 2026-10-06
owner: virtual-device-helper 팀
scope: [main, renderer, preload, shared, streaming, android, ios]
hosts: [windows, macos]
archived_reason:
related_adr: [ADR-0017, ADR-0018, ADR-0015, ADR-0010]
related_spec: m5-multi-screen
related_architecture: main-layers
related_plan: [m5-1-device-card-badges, m5-2-jpeg-frame-ack]
related_code: [streamManager.ts#createStreamManager, bootstrap.ts#bootstrapApp, appState.ts#createAppState, ipcBridge.ts#BridgeActions, registry.ts#createDeviceRegistry, ipc.ts#AppSnapshot, stream.ts#StreamPortMeta, streamPort.ts#onStreamPort, App.tsx#App, DeviceScreen.tsx#DeviceScreen, useScrcpyStream.ts#useScrcpyStream, useAppState.ts#targetSerial]
tags: [plan, streaming, multi-screen]
---

# M5-3 — 화면 칸과 여러 화면 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: `superpowers:subagent-driven-development`(권장) 또는
> `superpowers:executing-plans`로 task 단위 구현. 각 단계는 체크박스(`- [ ]`)로 추적한다.

**Goal:** Android 기기 한 대와 iOS 기기 한 대의 화면이 앱 창에 나란히 실시간으로 보이고 둘 다 조작된다.

**Architecture:** main의 `screenSlots`가 칸 목록을 들고 칸마다 `createStreamManager` 인스턴스 하나를 둔다. 어느
기기를 어느 칸에 놓을지는 조립 지점이 주는 배정 함수가 정한다. 칸은 `AppSnapshot.screens`로 내려가고 renderer는
목록을 그린다. renderer는 칸과 세대(`SlotRef`)로 스트림을 요청하고, 포트는 라우터 하나가 받아 맞는 화면에만 넘긴다.
MCP 대상은 `registry`에 그대로 있고, 대상이 정해지면 조정자가 그 기기를 칸에 놓는다.

**Tech Stack:** TypeScript, Electron IPC·MessagePort, React, Vitest + Testing Library

**Spec:** [`../specs/2026-10-06-m5-multi-screen.md`](../specs/2026-10-06-m5-multi-screen.md) — "인터페이스", "동작 / 상태", "실패 처리".
결정 근거는 [ADR-0017](../../adr/0017-screen-slots-separate-from-target.md).

**선행 조건:** [M5-2](2026-10-06-m5-2-jpeg-frame-ack.md) 완료(`frame_ack`가 프레임이 온 포트로 간다).
[M5-1](2026-10-06-m5-1-device-card-badges.md)은 독립이다.

## Global Constraints

- 답변·주석·문서는 한국어로 쓴다. 기술 용어·API 이름·명령어·에러 문자열은 원문 그대로 둔다.
- ADR-0015: mcp·renderer는 `platform`으로 분기하지 않는다. 칸 id나 라벨로 돌려서 분기하지도 않는다.
- 새 npm 의존성을 들이지 않는다.
- 각 task 끝에서 `npm test`와 `npm run typecheck`가 통과해야 한다. 테스트 출력에 경고가 없어야 한다.
- 문서에는 라인번호, 파일·툴 개수, 진행률을 적지 않는다. 문서를 고치면 `docs.py lint`와 `docs.py links`를 돌린다.
- 커밋 메시지는 한국어 Conventional Commits이고, 끝에 다음 줄을 붙인다:
  `Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>`
- `createStreamManager`의 재연결·포트·세션 수명 로직은 바꾸지 않는다. 관리자는 칸을 모른다 — 포트 꼬리표의
  `slotId`·`epoch`는 조정자가 `postPort`를 감싸서 붙인다.
- 칸 id는 `'a'`, `'b'`다. `screenSlots.ts`는 `Platform`을 import하지 않는다. 플랫폼을 보는 곳은 `bootstrap.ts`의
  배정 클로저뿐이다.
- `MAX_SCREEN_SLOTS = 2`는 `src/shared/limits.ts`에 둔다.
- `AppSnapshot.activeSerial`의 이름과 뜻을 바꾸지 않는다. 새 IPC를 만들지 않는다.
- 불변식(스펙 "불변식" 절 그대로): 칸의 진실은 main에 하나 / 대상은 늘 화면에 보이는 기기 / 화면 조작은 대상을
  바꾸지 않는다 / 조정자는 상태 변경과 `onChange`를 await 전에 한다 / 조정자는 `registry.start()` 전에 구독한다.
- 포트를 닫는 곳은 renderer에서 라우터뿐이다. 훅은 남의 포트를 닫지 않는다.
- 문구(스펙 그대로): 빈 상태 `연결된 기기가 없다. 왼쪽 목록에서 기기를 부팅해라` / 대상 없음 안내
  `대상 기기가 없다. 화면 머리의 "대상으로"를 누르거나 툴 호출에 serial을 넘겨라` / boundary `이 화면을 그리지 못했다`.
- 실제 기기 확인에서는 Simulator.app을 띄우지 않고 호스트 클립보드를 건드리지 않는다. 부팅한 시뮬레이터는 끈다.
  사람이 띄워 둔 기기는 끄지 않는다.

## Review Focus

- **같은 기기가 빠르게 내려갔다 올라온다**: 끊겼다 바로 다시 붙거나 A→B→A로 고르면 화면이 얼어붙지 않고 새
  스트림이 열린다. → Task 1(세대), Task 4(React key) 테스트.
- **죽은 기기의 느린 닫기**: 세션 닫기가 끝나지 않아도 칸이 곧바로 승계되고 화면이 바뀐다. → Task 1 테스트.
- **화면 둘이 동시에 마운트**: 두 훅이 같은 순간 스트림을 요청해도 서로의 포트를 닫지 않고 둘 다 `streaming`에
  이른다. → Task 2·3 테스트, Task 5 실제 앱.
- **Windows 호스트와 기기 한 대**: 화면이 하나일 때 모습과 동작이 지금과 같다. → Task 3·4 테스트, Task 5 사람 확인.
- **엉뚱한 기기에 타이핑**: 어느 화면이 키보드를 받는지 보이고, 툴바 버튼을 누른 뒤에도 입력이 그 화면으로 간다.
  → Task 4 테스트.

---

### Task 1: 화면 칸 조정자

**Files:**
- Create: `src/main/stream/screenSlots.ts`, `src/main/stream/screenSlots.test.ts`
- Modify: `src/shared/limits.ts`, `src/shared/types/ipc.ts`, `src/shared/types/stream.ts`, `src/main/stream/streamManager.ts`(타입 이름만)

**Interfaces:**
- Produces (`limits.ts`): `export const MAX_SCREEN_SLOTS = 2`.
- Produces (`ipc.ts`): `ScreenSlot { id: string; epoch: number; serial: string | null; label: string }`,
  `SlotRef { slotId: string; epoch: number }`. (`AppSnapshot`·`MainEvent`는 Task 3에서 고친다.)
- Produces (`stream.ts`): `SessionPortMeta { serial: string; sessionId: string }`(지금의 `StreamPortMeta` 모양)과
  `StreamPortMeta extends SessionPortMeta { slotId: string; epoch: number }`. `StreamManagerDeps.postPort`의 인자 타입은
  `SessionPortMeta`로 바꾼다(모양은 그대로라 관리자 코드는 바뀌지 않는다). 지금 `StreamPortMeta`를 쓰는 다른 곳은
  Task 3까지 컴파일되도록 `SessionPortMeta`로 돌려 둔다.
- Produces (`screenSlots.ts`): 스펙 "화면 칸 조정자" 절의 `PlaceReason`, `Occupancy`, `PlaceFn`, `ScreenSlotsDeps`,
  `ScreenSlots`, 그리고 `createScreenSlots(deps: ScreenSlotsDeps): ScreenSlots`. 시그니처는 스펙 코드 블록 그대로다.
  - `createManager(slotId)`는 생성 때 칸마다 한 번 부른다.
  - `handleConnect(serial)`: 연결 순서 목록에 더하고 `place(serial, occupancy, 'connected')`가 칸을 주면 놓는다.
  - `select(serial)`: 붙어 있지 않은 serial이면 아무것도 하지 않는다. 이미 어느 칸에 보이는 기기면 아무것도 하지
    않는다. 아니면 `place(…, 'selected')`가 준 칸에 놓는다.
  - `handleDisconnect(serial)`: 목록에서 빼고, 보이던 칸이면 비운 뒤 붙어 있지만 어느 칸에도 없는 기기를 연결
    순서대로 돌며 `place(…, 'vacated')`가 **그 칸**을 주는 첫 기기를 놓는다.
  - "놓는다" = 그 칸의 `serial`·`label`(`labelOf`)을 바꾸고 `epoch`를 1 올리고 `onChange`를 부른 **뒤** 그 칸
    관리자의 `stop()`을 부른다(기다리지 않고, reject는 삼켜 `console.error`로 남긴다). "비운다"도 같다(`label`은 빈 문자열).
  - `open(ref)`/`stop(ref)`: 칸이 없거나 `ref.epoch`가 지금 세대와 다르거나 칸이 비었으면 resolve하고 아무것도 하지
    않는다. 맞으면 그 칸 관리자의 `open(serial)`/`stop()`.
  - `closeAll()`: 모든 관리자의 `stop()`을 `Promise.allSettled`로 기다린다.
  - `slotIds.length > MAX_SCREEN_SLOTS`거나 id가 겹치면 생성에서 던진다.

- [ ] **Step 1: 실패하는 테스트를 쓴다** — 가짜 관리자(`open`·`stop`·`handleDisconnect`가 `vi.fn`)와 배정 함수
  `place = (serial, occ, reason) => serial이 'A'로 시작하면 'a', 'I'로 시작하면 'b'`(단 `connected`일 때 그 칸이 차
  있으면 null)로: `handleConnect('A1')` → `screens()`의 `a` 칸이 `{ serial: 'A1', epoch: 1 }`, `b`는 `{ serial: null, epoch: 0 }` /
  `handleConnect('A2')` → 칸 그대로, `onChange` 추가 호출 없음 / `select('A2')` → `a` 칸이 `A2`, 세대 2, `a` 관리자의 `stop`
  한 번 / `select('A2')` 다시 → 세대 그대로, `onChange` 없음 / `handleDisconnect('A2')` → `a` 칸이 `A1`, 세대 3 /
  `handleDisconnect('A1')` → `a` 칸이 비고 `label === ''` / 같은 serial을 다시 `handleConnect` → 새 세대 /
  `stop`이 끝나지 않는 관리자여도 `handleDisconnect` 직후 `onChange`가 이미 불려 있다 / `open({ slotId: 'a', epoch: 낡은 값 })` →
  관리자 `open` 호출 없음, resolve / `open`이 맞는 세대면 그 칸 관리자의 `open(serial)` / `a` 관리자의 `open`이 reject해도
  `b` 관리자는 호출되지 않는다 / 한 관리자의 `stop`이 reject해도 `closeAll`이 resolve하고 나머지 `stop`이 불린다 /
  `place`가 null을 주는 serial은 어느 칸에도 없다 / `slotIds`가 셋이면 던진다 / 붙어 있지 않은 serial의 `select`는 무시.
- [ ] **Step 2: 실패를 확인한다** — Run: `npx vitest run src/main/stream/screenSlots.test.ts` / Expected: FAIL.
- [ ] **Step 3: 구현한다.**
- [ ] **Step 4: 통과를 확인한다** — Run: `npm test && npm run typecheck` / Expected: PASS.
- [ ] **Step 5: 커밋** — `git commit -m "feat(stream): 화면 칸 조정자를 더한다"`

---

### Task 2: renderer 스트림 포트 라우터

**Files:**
- Modify: `src/renderer/src/stream/streamPort.ts`
- Test: `src/renderer/src/stream/streamPort.test.ts`

**Interfaces:**
- Consumes: `SlotRef`, `StreamPortMeta` (Task 1).
- Produces: `createStreamPortRouter(target?: MessageTarget): StreamPortRouter` — 스펙 "renderer 포트 라우터" 절의
  시그니처. `streamPortRouter`(모듈 수준의 기본 인스턴스)도 내보낸다. 기본 인스턴스는 첫 `subscribe` 때 리스너를 건다.
  - 받는 메시지는 지금의 `onStreamPort`와 같은 검사(같은 창, 채널, 포트 하나)에 더해 `slotId`가 문자열이고 `epoch`가
    수여야 한다. 꼬리표 네 필드를 그대로 넘긴다.
  - `slotId`와 `epoch`가 모두 같은 구독자에게만 `onPort(meta, port)`를 부른다. 그런 구독자가 없으면 `port.close()`.
  - 같은 `SlotRef`로 다시 `subscribe`하면 앞 구독을 갈아 끼운다.
  - 기존 `onStreamPort`는 이 task에서 지우지 않는다(Task 3에서 지운다).

- [ ] **Step 1: 실패하는 테스트를 쓴다** — 구독자 둘(`{a,1}`, `{b,1}`)이 있을 때 `slotId: 'a', epoch: 1` 포트는 첫
  구독자에게만 가고 `close`되지 않는다 / `slotId: 'b'` 포트는 둘째에게만 / `epoch: 2` 포트는 아무에게도 가지 않고
  `close`가 한 번 불린다 / 구독을 해제한 뒤 온 포트는 닫힌다 / `slotId`가 없거나 `epoch`가 문자열인 메시지는 무시(포트를
  닫지도 않는다 — 우리 것이 아니다) / 다른 창에서 온 메시지는 무시 / 넘어간 `meta`에 `serial`·`sessionId`·`slotId`·`epoch`가 모두 있다.
- [ ] **Step 2: 실패를 확인한다** — Run: `npx vitest run src/renderer/src/stream/streamPort.test.ts` / Expected: FAIL.
- [ ] **Step 3: 구현한다.**
- [ ] **Step 4: 통과를 확인한다** — Run: `npm test && npm run typecheck` / Expected: PASS.
- [ ] **Step 5: 커밋** — `git commit -m "feat(renderer): 스트림 포트를 칸과 세대로 가려 넘기는 라우터를 더한다"`

---

### Task 3: 조립 — 칸을 스냅샷·IPC·포트에 잇는다

main, preload, renderer의 IPC 모양이 함께 바뀌므로 한 task다. 이 task가 끝나면 앱은 여전히 화면을 **하나**만 그리지만
(첫 번째 찬 칸), 그 화면은 칸과 세대로 열린다.

**Files:**
- Modify: `src/shared/types/ipc.ts`, `src/shared/types/stream.ts`, `src/preload/index.ts`,
  `src/main/app/appState.ts`, `src/main/app/ipcBridge.ts`, `src/main/app/bootstrap.ts`, `src/main/index.ts`,
  `src/renderer/src/state/useAppState.ts`, `src/renderer/src/hooks/useScrcpyStream.ts`,
  `src/renderer/src/components/DeviceScreen.tsx`, `src/renderer/src/App.tsx`, `src/renderer/src/stream/streamPort.ts`
- Test: 위 파일들의 기존 테스트 파일

**Interfaces:**
- Consumes: `createScreenSlots` (Task 1), `streamPortRouter` (Task 2).
- `ipc.ts`: `AppSnapshot.screens: ScreenSlot[]` / `MainEvent`에 `{ type: 'screens_changed'; screens: ScreenSlot[] }` /
  `RendererApi.startStream(ref: SlotRef)`, `stopStream(ref: SlotRef)`.
- `appState.ts`: `AppState.setScreens(screens: ScreenSlot[]): void` — 들고 있다가 `snapshot()`에 싣고 `screens_changed`를
  낸다(`setServer`와 같은 늦은 연결). 처음 값은 `[]`.
- `ipcBridge.ts`: `BridgeActions.startStream(ref: SlotRef)`, `stopStream(ref: SlotRef)`. 인자는 `slotId`가 빈 문자열이
  아니고 `epoch`가 0 이상의 정수인 객체여야 한다. 아니면 지금의 `withText`가 내는 것과 같은 모양의 실패 `Outcome`.
- `bootstrap.ts`:
  - `BootstrapDeps.createStreamManager`의 hooks에 `postPort?`를 더할 필요가 없도록, 시그니처를
    `createStreamManager(registry, paths, hooks, slot: { id: string; epochOf(): number })`로 바꾼다. `index.ts`의 구현이
    `postPort`에서 `{ ...meta, slotId: slot.id, epoch: slot.epochOf() }`를 붙여 창으로 보낸다. `epochOf`는 조정자의
    `screens()`에서 그 칸의 세대를 읽는 클로저다. 관리자는 조정자보다 먼저 만들어지므로 호출 시점에 읽는다.
  - 배정 클로저 `placeByPlatform`: `registry`로 기기의 플랫폼을 보고 Android면 `'a'`, iOS면 `'b'`. `connected`일 때 그
    칸이 차 있으면 null, `selected`면 늘 그 칸, `vacated`면 그 칸. 플랫폼을 알 수 없으면 null.
  - `labelOf(serial)`: 기기 플랫폼의 사람이 읽는 이름(이미 있는 `PLATFORM_LABELS`).
  - `createScreenSlots({ slotIds: ['a', 'b'], place, labelOf, createManager, onChange: state.setScreens })`.
  - `registry.on` 구독(반드시 `registry.start()` 전): `device_connected` → `slots.handleConnect` /
    `device_disconnected` → `slots.handleDisconnect` / `active_changed`이고 serial이 null이 아니면 → `slots.select(serial)`.
    지금의 `stream.handleDisconnect(event.serial)` 호출은 조정자가 대신한다.
  - 액션: `startStream: (ref) => slots.open(ref)`, `stopStream: (ref) => slots.stop(ref)`. 앱 종료의 `stream.stop()`은
    `slots.closeAll()`.
  - `assembleWithoutPlatforms`: 스냅샷에 `screens: []`, 두 액션은 no-op.
- `preload/index.ts`: 두 IPC가 `SlotRef`를 넘긴다. `streamPort` 이벤트는 꼬리표 네 필드를 모두 `window.postMessage`로 넘긴다.
- renderer:
  - `useAppState`의 reduce가 `screens_changed`를 `snapshot.screens`에 반영한다. 버퍼에 쌓였다 재생되는 경로도 같다.
  - `useScrcpyStream(screen: { ref: SlotRef; serial: string }, canvasRef, deps?)`. `deps.onStreamPort`를
    `deps.subscribePort(ref, onPort)`로 바꾸고 기본은 `streamPortRouter.subscribe`. **훅에서 `next.close()`로 남의 포트를
    닫는 분기를 지운다.** `startStream(ref)`, 정리에서 `stopStream(ref)`.
  - `DeviceScreen`의 props를 `{ screen: ScreenSlot }`로 바꾼다(`serial`이 null인 칸은 그리지 않으므로 호출부가 거른다).
    `LiveScreen`의 key는 호출부가 준다.
  - `App`: `snapshot.screens` 중 `serial`이 있는 **첫** 칸 하나를 `key={`${id}:${epoch}`}`로 그린다. 없으면 빈 상태 문구.
    (여러 화면은 Task 4.)
  - `streamPort.ts`의 옛 `onStreamPort`와 그 테스트를 지운다.

- [ ] **Step 1: 실패하는 테스트를 쓴다**
  - `appState.test.ts`: `setScreens` 뒤 `snapshot().screens`가 그 값이고 `screens_changed`가 한 번 나간다.
  - `ipcBridge.test.ts`: `startStream`에 `{ slotId: 'a', epoch: 1 }` → 액션이 그 값으로 불린다 / `'A1'`(문자열),
    `{ slotId: '', epoch: 1 }`, `{ slotId: 'a', epoch: -1 }`, `{ slotId: 'a', epoch: 1.5 }` → 실패 `Outcome`이고 액션은 불리지 않는다. `stopStream`도 같다.
  - `bootstrap.test.ts`: `registry.start()` 때 이미 붙어 있던 Android 기기가 `snapshot.screens`의 `a` 칸에 있다 / Android와
    iOS가 붙으면 `a`·`b` 칸이 모두 찬다(아무도 고르지 않아도) / `selectDevice`(같은 플랫폼의 둘째 기기) → `activeSerial`과
    그 칸의 `serial`이 함께 바뀐다 / MCP `device_select` 경로(`registry.setActive`)도 같다 / 대상 기기가 끊기면
    `activeSerial`이 null이고 칸은 같은 플랫폼의 다른 기기로 승계된다 / `startStream({ slotId: 'a', epoch })`이 `a` 칸의
    관리자만 연다 / 낡은 세대면 어느 관리자도 열리지 않고 성공 / 플랫폼이 없는 조립의 `screens`가 `[]` / 종료 때 모든 관리자의 `stop`이 불린다.
  - `streamManager.test.ts`: `postPort`가 받는 값이 `{ serial, sessionId }`다(관리자는 칸을 모른다).
  - `useAppState.test.tsx`: `screens_changed`가 반영된다.
  - `useScrcpyStream.test.tsx`: 훅이 `subscribePort`를 제 `ref`로 부른다 / `startStream`·`stopStream`이 `ref`로 불린다 /
    **기존 'closes a port that belongs to another serial' 테스트를 지우고** 대신 "훅은 받은 포트 말고는 어떤 포트도 닫지 않는다"를 둔다.
  - `App.test.tsx`: `screens`의 첫 찬 칸이 그려진다 / 세대가 오르면 화면이 다시 마운트된다(훅의 `startStream`이 새 `ref`로 한 번 더) / 찬 칸이 없으면 빈 상태 문구.
- [ ] **Step 2: 실패를 확인한다** — Run: `npx vitest run src/main/app src/main/stream/streamManager.test.ts src/renderer/src` / Expected: FAIL.
- [ ] **Step 3: 구현한다.**
- [ ] **Step 4: 통과를 확인한다** — Run: `npm test && npm run typecheck` / Expected: PASS.
- [ ] **Step 5: 커밋** — `git commit -m "feat(main): 화면 칸을 스냅샷과 스트림 IPC에 잇는다"`

---

### Task 4: renderer — 여러 화면

**Files:**
- Create: `src/renderer/src/components/ScreenHeader.tsx`, `ScreenHeader.test.tsx`, `ScreenBoundary.tsx`, `ScreenBoundary.test.tsx`
- Modify: `src/renderer/src/App.tsx`, `src/renderer/src/components/DeviceScreen.tsx`, `src/renderer/src/app.css`
- Test: `src/renderer/src/App.test.tsx`, `src/renderer/src/components/DeviceScreen.test.tsx`

**Interfaces:**
- Consumes: `ScreenSlot`, `targetSerial` (기존), Task 3의 `DeviceScreen` props.
- Produces:
  - `ScreenHeader({ screen: ScreenSlot; isTarget: boolean; onMakeTarget(): void })` — `label`, `serial`(mono, `title`에 전체 값),
    대상이면 `(대상)` 배지, `대상으로` 버튼(`aria-label={`${label} ${serial} 대상으로`}`, 대상이면 `disabled`).
  - `ScreenBoundary({ children })` — 클래스 컴포넌트 error boundary. 던지면 `이 화면을 그리지 못했다`와 `다시 시도` 버튼을
    보인다. 다시 시도는 내부 카운터를 올려 `children`을 새 key로 다시 마운트한다. 잡은 에러는 `console.error`로 남긴다.
  - `App`: `serial`이 있는 칸을 모두 그린다. 화면 묶음은 `<div className="screens" style={{ '--screen-count': n }}>`.
    칸마다 `<ScreenBoundary key={`${id}:${epoch}`}>` 안에 `DeviceScreen`. 화면이 둘 이상이고 `targetSerial(snapshot)`이
    null이면 묶음 위에 `notice notice-info`로 대상 없음 안내. `onMakeTarget`은 `window.api.selectDevice(serial)`.
  - `DeviceScreen`: 머리에 `ScreenHeader`. `section`의 `aria-label`은 `` `기기 화면 ${label} ${serial}` ``, 툴바는
    `` `기기 버튼 ${label} ${serial}` ``. 툴바 버튼의 클릭 처리 끝에 그 화면의 캔버스에 `focus()`. 캔버스 `keydown`에서
    `F6`이면 기기로 보내지 않고 `onFocusNext()` prop을 부른다. `App`이 화면 순서대로 캔버스 ref를 모아 다음 화면의
    캔버스에 `focus()`한다(끝에서 처음으로, 화면이 하나면 아무것도 하지 않는다).
  - `app.css`: `.screens`는 `display: grid; grid-template-columns: repeat(var(--screen-count), minmax(0, 1fr))`. 각 화면의
    캔버스는 제 칸 안에서 종횡비를 지키며 줄어든다. `.device-screen:focus-within`이면 머리와 테두리를 강조한다(기존 색 토큰).
    화면이 하나일 때의 모습은 지금과 같아야 한다.

- [ ] **Step 1: 실패하는 테스트를 쓴다**
  - `ScreenHeader.test.tsx`: `label`과 `serial`이 보인다 / 대상이 아니면 `대상으로` 버튼이 켜져 있고 누르면 `onMakeTarget` /
    대상이면 `(대상)` 배지가 있고 버튼이 꺼져 있다.
  - `ScreenBoundary.test.tsx`: 자식이 던지면 `이 화면을 그리지 못했다`가 보이고 형제 요소는 그대로 있다 / `다시 시도`를
    누르면 자식이 다시 마운트된다(이번에는 던지지 않는 자식이 보인다). `console.error`는 spy로 받아 출력이 깨끗하다.
  - `App.test.tsx`: `screens`가 임의 id(`'x'`, `'y'`)의 찬 칸 둘이면 `기기 화면`으로 시작하는 region이 둘이고 이름이
    서로 다르다 / 찬 칸 하나면 region 하나 / 화면 둘·대상 없음이면 안내 문구가 보이고, 대상이 있으면 없다 / 화면 하나면
    안내가 없다 / 한 화면의 `DeviceScreen`이 던져도 다른 화면의 region이 남는다 / 한 칸의 세대만 오르면 그 화면만
    다시 마운트된다 / `대상으로`를 누르면 `window.api.selectDevice`가 그 칸의 serial로 불린다.
  - `DeviceScreen.test.tsx`: 툴바 버튼을 누른 뒤 `document.activeElement`가 그 화면의 캔버스다 / 캔버스에서 `F6`을 누르면
    `onFocusNext`가 불리고 포트로 `key` intent가 가지 않는다 / `App` 수준: 화면 둘에서 첫 캔버스의 `F6`이 둘째 캔버스로,
    둘째의 `F6`이 첫째로 포커스를 옮긴다.
- [ ] **Step 2: 실패를 확인한다** — Run: `npx vitest run src/renderer/src` / Expected: FAIL.
- [ ] **Step 3: 구현한다.**
- [ ] **Step 4: 통과를 확인한다** — Run: `npm test && npm run typecheck` / Expected: PASS.
- [ ] **Step 5: 커밋** — `git commit -m "feat(renderer): 칸마다 화면을 그리고 머리·경계·포커스 표시를 더한다"`

---

### Task 5: 실제 앱 확인과 문서

**Files:**
- Modify: `docs/superpowers/specs/2026-10-06-m5-multi-screen.md`, `docs/architecture/main-layers.md`,
  `docs/adr/0017-screen-slots-separate-from-target.md`·`0018-jpeg-frame-ack-flow-control.md`(`related_plan`), 이 계획 문서
- Create: `src/main/stream/screenSlots.integration.test.ts`

- [ ] **Step 1: 통합 테스트를 쓴다**

실제 `createStreamManager` 둘과 `createScreenSlots`를 가짜 포트로 조립한다. Android 기기(adb에 붙은 것)와 부팅된 iOS
시뮬레이터가 **둘 다** 있을 때만 돌고 아니면 skip한다. 두 칸을 함께 열어 각 포트가 `session`과 프레임(또는 `packet`)을
받는지, 한 칸을 `stop`해도 다른 칸의 프레임이 계속 오는지 본다. 기다림은 `sleep`이 아니라 받은 메시지의 promise로 한다.

Run: `npm run test:integration -- src/main/stream/screenSlots.integration.test.ts` / Expected: PASS(또는 skip).

- [ ] **Step 2: 실제 앱에서 본다**

`npm run dev`로 띄운다. Android 기기와 iOS 시뮬레이터가 함께 붙어 있어야 한다(없으면 iOS는 `simctl`로 하나 부팅하고,
Android가 없으면 그 항목은 "미검증 — Android 기기 없음"으로 적는다). 앱 창만 캡처해서(`screencapture -l <창 id>`) 본다:
두 화면이 나란히 뜨고 둘 다 `streaming`이다 / 고르지 않았을 때 대상 없음 안내가 보인다 / `대상으로`를 누르면 표시가
옮겨 가고 오른쪽 탭이 그 기기를 따른다 / 한쪽 기기를 끄면 그 화면만 사라지고 다른 쪽은 계속 돈다 / 기기가 하나일 때
모습이 M5 이전과 같다. 두 스트림이 함께 돌 때 각 fps와 앱 프로세스의 CPU를 잰다(`ps`로 충분하다). 화면을 클릭·타이핑해
보는 것, 포커스 강조, `F6`, 창을 좁혔을 때의 배치, Windows 호스트의 회귀는 "사람 확인 필요"로 남긴다.

- [ ] **Step 3: 문서를 고치고 커밋한다**

스펙 끝에 "M5-3 검증 결과" 절(본 것 / 부분적으로 본 것 / 못 본 것, 잰 fps·CPU)을 쓴다. 잰 부하에 비추어 "열린 질문"의
`MAX_SCREEN_SLOTS` 항목을 갱신한다. `main-layers.md`에 화면 칸 층(조정자, 칸마다 관리자, renderer 라우터)을 더하고
`verified`를 갱신한다. 두 ADR의 `related_plan`을 채운다. 스펙 `status`는 앱 창 확인이 사람에게 남아 있으면 `in-progress`로 둔다.

Run: `python3 docs/script/docs.py lint && python3 docs/script/docs.py links` / Expected: 문제 0건.

`git commit -m "docs(stream): M5-3 화면 칸의 확인 결과를 남긴다"`
