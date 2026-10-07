---
id: m5-3-screen-slots
title: M5-3 — 화면 칸과 여러 화면
status: done
type: work-order
created: 2026-10-06
updated: 2026-10-07
owner: virtual-device-helper 팀
scope: [main, renderer, preload, shared, streaming, android, ios]
hosts: [windows, macos]
archived_reason: done — M5-3 구현 완료. 화면 칸 조정자, 칸·세대 IPC, renderer 포트 라우터, 여러 화면. PR #29로 develop에 머지. 사람 확인 일부 미검증(스펙 "M5-3 검증 결과")
related_adr: [ADR-0017, ADR-0018, ADR-0015, ADR-0010]
related_spec: m5-multi-screen
related_architecture: main-layers
related_plan: [m5-1-device-card-badges, m5-2-jpeg-frame-ack]
related_code: [streamManager.ts#createStreamManager, bootstrap.ts#bootstrapApp, appState.ts#createAppState, ipcBridge.ts#BridgeActions, registry.ts#createDeviceRegistry, ipc.ts#AppSnapshot, stream.ts#StreamPortMeta, streamPort.ts#createStreamPortRouter, App.tsx#App, DeviceScreen.tsx#DeviceScreen, useScrcpyStream.ts#useScrcpyStream, useAppState.ts#targetSerial]
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

task는 여덟이다. Task 4까지는 IPC 모양을 그대로 둔 채 main만 칸으로 바꾼다 — 그 시점에 화면 하나의 회귀를 실제 앱에서
볼 수 있다. Task 5에서 IPC와 포트 계약을 한 번에 바꾼다.

**Tech Stack:** TypeScript, Electron IPC·MessagePort, React, Vitest + Testing Library

**Spec:** [`../specs/2026-10-06-m5-multi-screen.md`](../../specs/archive/2026-10-06-m5-multi-screen.md) — "인터페이스", "동작 / 상태", "실패 처리".
결정 근거는 [ADR-0017](../../../adr/0017-screen-slots-separate-from-target.md).

**선행 조건:** [M5-2](2026-10-06-m5-2-jpeg-frame-ack.md) 완료(`frame_ack`가 프레임이 온 포트로 간다).
[M5-1](2026-10-06-m5-1-device-card-badges.md)은 독립이다.

## Global Constraints

- 답변·주석·문서는 한국어로 쓴다. 기술 용어·API 이름·명령어·에러 문자열은 원문 그대로 둔다.
- 새 npm 의존성을 들이지 않는다.
- 각 task 끝에서 `npm test`와 `npm run typecheck`가 통과해야 한다. **테스트 파일도 typecheck 대상이다** — 타입을 바꾸면 그 타입의
  fixture를 든 테스트 파일까지 같은 task에서 고친다. 테스트 출력에 경고가 없어야 한다.
- ADR-0015: mcp·renderer는 `platform`으로 분기하지 않는다. 칸 id나 라벨로 돌려서 분기하지도 않는다. renderer 테스트는 임의의
  칸 id(`'x'`, `'y'`)로 돈다.
- `createStreamManager`의 재연결·포트·세션 수명 로직은 바꾸지 않는다. **관리자는 칸을 모른다** — 관리자가 내놓는 꼬리표는
  `{ serial, sessionId }`이고, 칸과 세대는 조정자의 `tagPort`가 붙인다.
- 칸 id는 `'a'`, `'b'`다. `screenSlots.ts`는 `Platform`을 import하지 않는다. 플랫폼을 보는 곳은 `bootstrap.ts`의 배정 함수와
  `labelOf`뿐이다.
- `MAX_SCREEN_SLOTS = 2`는 `src/shared/limits.ts`에 둔다.
- `AppSnapshot.activeSerial`의 이름과 뜻을 바꾸지 않는다. 새 IPC 채널을 만들지 않는다.
- 불변식(스펙 "불변식" 절): 칸의 진실은 main에 하나 / 대상은 늘 화면에 보이는 기기 / 화면 조작은 대상을 바꾸지 않는다 /
  조정자는 상태 변경과 `onChange`를 await 전에 한다 / 조정자는 `registry.start()` 전에 구독한다 / 기기는 많아야 한 칸에 있다.
- 칸에 놓인 기기가 바뀌는 것은 **한 번의 변화**다: 세대 +1, `onChange` 한 번, 그 칸 관리자의 `stop()` 한 번. 끊김 뒤의 승계도
  빈 칸을 거치지 않는다.
- renderer에서 포트를 닫는 곳은 라우터뿐이다. 훅은 남의 포트를 닫지 않는다. 화면은 구독을 먼저 하고 스트림을 요청한다.
- 문구(스펙 그대로): 빈 상태 `연결된 기기가 없다. 왼쪽 목록에서 기기를 부팅해라` / 대상 없음 안내
  `대상 기기가 없다. 화면 머리의 "대상으로"를 누르거나 툴 호출에 serial을 넘겨라` / boundary `이 화면을 그리지 못했다`.
- 실제 기기 확인에서는 Simulator.app을 띄우지 않고 호스트 클립보드를 건드리지 않는다. 자신이 부팅한 시뮬레이터만 끈다.
- 문서에는 라인번호, 파일·툴 개수, 진행률을 적지 않는다. 문서를 고치면 `docs.py lint`와 `docs.py links`를 돌린다.
- 커밋 메시지는 한국어 Conventional Commits이고, 끝에 다음 줄을 붙인다:
  `Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>`

## Review Focus

- **옛 화면의 정리가 새 세션을 죽인다**: 칸의 기기가 바뀐 뒤 옛 화면이 언마운트되며 보내는 `stopStream`(낡은 세대)이 새
  세션을 닫지 않는다. → Task 1·5 테스트.
- **같은 기기가 빠르게 내려갔다 올라온다**: 끊겼다 바로 다시 붙거나 A→B→A로 고르면 화면이 얼어붙지 않고 새 스트림이
  열린다. → Task 1(세대), Task 7(React key) 테스트.
- **죽은 기기의 느린 닫기**: 세션 닫기가 끝나지 않아도 칸이 곧바로 승계되고, 새 세대의 스트림이 바로 열린다. → Task 1 테스트.
- **화면 둘이 동시에 마운트**: 두 훅이 같은 순간 스트림을 요청해도 서로의 포트를 닫지 않고 둘 다 `streaming`에 이르며, 한 화면의
  입력이 제 포트로만 간다. → Task 2·5 테스트, Task 8 실제 앱.
- **화면이 다시 그려질 때마다 스트림이 끊긴다**: 타임라인 이벤트로 앱이 다시 그려져도 스트림이 내려갔다 올라오지 않는다. → Task 5 테스트.

---

### Task 1: 화면 칸 조정자

**Files:**
- Create: `src/main/stream/screenSlots.ts`, `src/main/stream/screenSlots.test.ts`
- Modify: `src/shared/limits.ts`, `src/shared/types/ipc.ts`, `src/shared/types/stream.ts`, `src/main/stream/streamManager.ts`,
  `src/preload/index.ts`, `src/renderer/src/stream/streamPort.ts`, `src/renderer/src/hooks/useScrcpyStream.ts`
- Test: `src/renderer/src/hooks/useScrcpyStream.test.tsx`, `src/renderer/src/stream/streamPort.test.ts`(타입 이름만)

**Interfaces:**
- Produces (`limits.ts`): `export const MAX_SCREEN_SLOTS = 2`.
- Produces (`ipc.ts`): `ScreenSlot { id: string; epoch: number; serial: string | null; label: string }`,
  `SlotRef { slotId: string; epoch: number }`. (`AppSnapshot`·`MainEvent`는 Task 3에서 고친다.)
- Produces (`stream.ts`): `SessionPortMeta { serial: string; sessionId: string }`(지금의 `StreamPortMeta` 모양)과
  `StreamPortMeta extends SessionPortMeta { slotId: string; epoch: number }`. 지금 `StreamPortMeta`를 쓰는 넷 —
  `streamManager.ts`의 `StreamManagerDeps.postPort`, `preload/index.ts`, `streamPort.ts`의 `onStreamPort`, `useScrcpyStream.ts`의
  `ScrcpyStreamDeps.onStreamPort`(과 그 테스트 harness) — 을 `SessionPortMeta`로 바꾼다. 동작은 바뀌지 않는다.
- Produces (`screenSlots.ts`): 스펙 "화면 칸 조정자" 절의 `PlaceReason`, `Occupancy`, `PlaceFn`, `ScreenSlotsDeps`, `ScreenSlots`와
  `createScreenSlots(deps: ScreenSlotsDeps): ScreenSlots`. 시그니처는 스펙 코드 블록 그대로다(`tagPort` 포함).
  - `createManager(slotId)`는 생성 때 칸마다 한 번 부른다.
  - `handleConnect(serial)`: 이미 붙어 있다고 아는 serial이면 무시. 연결 순서 목록에 더하고 `place(serial, occupancy, 'connected')`가
    칸을 주면 놓는다.
  - `select(serial)`: 붙어 있지 않은 serial이면 무시. `place(serial, occupancy, 'selected')`가 준 칸에 이미 그 기기가 보이면 무시.
    다른 칸에 보이던 기기면 그 칸을 먼저 승계 규칙으로 채우고(없으면 비우고) 새 칸에 놓는다.
  - `handleDisconnect(serial)`: 모르는 serial이면 무시. 목록에서 빼고, 보이던 칸이면 붙어 있지만 어느 칸에도 없는 기기를 연결
    순서대로 돌며 `place(…, 'vacated')`가 **그 칸**을 주는 첫 기기로 바꾼다. 없으면 비운다(`serial: null`, `label: ''`).
  - 칸의 기기를 바꾸는 일은 모두 한 길로 간다: `serial`·`label`(`labelOf`)을 바꾸고 `epoch`를 1 올리고 `onChange`를 부른 **뒤** 그
    칸 관리자의 `stop()`을 부른다(기다리지 않는다. reject는 `console.error`로 남긴다).
  - `place`가 모르는 칸 id를 주면 놓지 않는다.
  - `open(ref)`/`stop(ref)`: 칸이 없거나 `ref.epoch`가 지금 세대와 다르거나 칸이 비었으면 resolve하고 아무것도 하지 않는다.
    맞으면 그 칸 관리자의 `open(serial)`/`stop()`.
  - `tagPort(slotId, meta)`: 그 칸에 지금 놓인 serial이 `meta.serial`이면 `{ ...meta, slotId, epoch: 지금 세대 }`, 아니면 null.
  - `closeAll()`: 모든 관리자의 `stop()`을 `Promise.allSettled`로 기다리고 실패는 `console.error`로 남긴다. reject하지 않는다.
  - `slotIds.length > MAX_SCREEN_SLOTS`거나 id가 겹치면 생성에서 던진다.
  - 변화가 없으면 `onChange`를 부르지 않는다.

- [x] **Step 1: 실패하는 테스트를 쓴다** — 가짜 관리자(`open`·`stop`이 `vi.fn`)와 배정 함수(serial이 `'A'`로 시작하면 `'a'`, `'I'`로
  시작하면 `'b'`, 그 밖은 null. 단 `connected`일 때 그 칸이 차 있으면 null)로:
  - `handleConnect('A1')` → `a` 칸 `{ serial: 'A1', epoch: 1 }`, `b` 칸 `{ serial: null, epoch: 0, label: '' }`.
  - `handleConnect('A2')` → 칸 그대로, `onChange` 추가 호출 없음.
  - `select('A2')` → `a` 칸 `A2`, 세대 2, `a` 관리자 `stop` 한 번. 다시 `select('A2')` → 세대 그대로, `onChange` 없음.
  - `handleDisconnect('A2')` → `a` 칸 `A1`, 세대 **3**, `onChange` **한 번**, `stop` 한 번(빈 칸을 거치지 않는다).
  - `handleDisconnect('A1')` → `a` 칸이 비고 세대 4.
  - 같은 serial을 다시 `handleConnect` → 세대가 또 오른다. `select('A1')`·`select('A2')`·`select('A1')` → 세대가 매번 다르다.
  - `stop`이 끝나지 않는 관리자여도: `handleDisconnect` 직후 `onChange`가 이미 불려 있고, 새 세대의 `open(ref)`이 곧바로 관리자
    `open`을 부른다. `select`에서도 `onChange`가 `stop`보다 먼저 불린다.
  - 낡은 세대의 `open(ref)`과 `stop(ref)` → 관리자 호출 없음, resolve. 빈 칸과 모르는 칸 id도 같다.
  - 맞는 세대의 `open` → 그 칸 관리자의 `open(serial)`. `a` 관리자의 `open`이 reject해도 `b` 관리자는 호출되지 않는다.
  - 진행 중인(resolve되지 않은) `open` 도중의 `select` → 칸과 세대가 바뀌고 `stop`이 불린다.
  - `tagPort('a', { serial: 'A1', sessionId: 's' })` → 지금 세대가 붙는다. 칸의 기기가 다른 serial이면 null. 모르는 칸이면 null.
  - 한 관리자의 `stop`이 reject해도 `closeAll`이 resolve하고 나머지 `stop`이 불린다(`console.error`는 spy로 받는다).
  - `place`가 null을 주는 serial과 모르는 칸 id를 주는 경우 → 어느 칸에도 없다. 붙어 있지 않은 serial의 `select`는 무시.
    모르는 serial의 `handleDisconnect`는 무시. 중복 `handleConnect`는 무시.
  - `slotIds`가 셋이거나 겹치면 던진다.
- [x] **Step 2: 실패를 확인한다** — Run: `npx vitest run src/main/stream/screenSlots.test.ts` / Expected: FAIL.
- [x] **Step 3: 구현한다.**
- [x] **Step 4: 통과를 확인한다** — Run: `npm test && npm run typecheck` / Expected: PASS.
- [x] **Step 5: 커밋** — `git commit -m "feat(stream): 화면 칸 조정자를 더한다"`

---

### Task 2: renderer 스트림 포트 라우터

**Files:**
- Modify: `src/renderer/src/stream/streamPort.ts`
- Test: `src/renderer/src/stream/streamPort.test.ts`

**Interfaces:**
- Consumes: `SlotRef`, `StreamPortMeta` (Task 1).
- Produces: `createStreamPortRouter(target?: MessageTarget): StreamPortRouter`(스펙 "renderer 포트 라우터" 절의 시그니처)와
  모듈 수준의 기본 인스턴스 `streamPortRouter`.
  - `target`을 주지 않으면 `window`를 쓰되, **첫 `subscribe` 때** 읽고 리스너를 건다. 모듈을 import하는 것만으로 `window`를
    읽지 않는다(이 테스트 파일의 환경은 `node`다).
  - 받는 메시지는 지금의 `onStreamPort`와 같은 검사(같은 창, 채널, 포트 하나)에 더해 `slotId`가 문자열이고 `epoch`가 수여야 한다.
    우리 채널이 아니거나 모양이 틀린 메시지는 무시하고 포트도 건드리지 않는다. 꼬리표 네 필드를 그대로 넘긴다.
  - `slotId`와 `epoch`가 모두 같은 구독자에게만 `onPort(meta, port)`를 부른다. 그런 구독자가 없으면 `port.close()`.
  - 같은 `SlotRef`로 다시 `subscribe`하면 앞 구독을 갈아 끼운다. 해제 함수는 **자기 구독이 아직 그 자리에 있을 때만** 지운다
    (갈아 끼워진 앞 구독의 해제는 아무것도 하지 않는다).
  - 창 하나에 라우터 하나다. 주석으로 못 박는다.
  - 기존 `onStreamPort`는 이 task에서 지우지 않는다(Task 5에서 지운다).

- [x] **Step 1: 실패하는 테스트를 쓴다** — 구독자 둘(`{x,1}`, `{y,1}`)이 있을 때 `slotId: 'x', epoch: 1` 포트는 첫 구독자에게만
  가고 `close`되지 않는다 / `slotId: 'y'` 포트는 둘째에게만 / `epoch: 2` 포트는 아무에게도 가지 않고 `close`가 한 번 불린다 /
  구독을 해제한 뒤 온 포트는 닫힌다 / 같은 `SlotRef`로 다시 구독한 뒤 앞 구독의 해제 함수를 불러도 뒤 구독이 포트를 받는다 /
  `slotId`가 없거나 `epoch`가 문자열인 메시지는 무시하고 포트를 닫지도 않는다 / 다른 창에서 온 메시지는 무시 / 넘어간 `meta`에
  `serial`·`sessionId`·`slotId`·`epoch`가 모두 있다 / `target` 없이 `createStreamPortRouter()`를 만들기만 하면(구독 없이) 던지지 않는다.
- [x] **Step 2: 실패를 확인한다** — Run: `npx vitest run src/renderer/src/stream/streamPort.test.ts` / Expected: FAIL.
- [x] **Step 3: 구현한다.**
- [x] **Step 4: 통과를 확인한다** — Run: `npm test && npm run typecheck` / Expected: PASS.
- [x] **Step 5: 커밋** — `git commit -m "feat(renderer): 스트림 포트를 칸과 세대로 가려 넘기는 라우터를 더한다"`

---

### Task 3: 스냅샷에 칸을 싣는다

값은 아직 늘 `[]`다. 타입과 통로만 만든다.

**Files:**
- Modify: `src/shared/types/ipc.ts`, `src/main/app/appState.ts`, `src/main/app/bootstrap.ts`(`assembleWithoutPlatforms`),
  `src/renderer/src/state/useAppState.ts`
- Test: `src/main/app/appState.test.ts`, `src/renderer/src/state/useAppState.test.tsx`, 그리고 `AppSnapshot` fixture를 든 모든 테스트
  파일(`rg -l "activeSerial" src --glob '*.test.*'`로 찾는다 — `DevicePanel.test.tsx`, `WorkArea.test.tsx`, `App.test.tsx` 등)

**Interfaces:**
- Consumes: `ScreenSlot` (Task 1).
- `ipc.ts`: `AppSnapshot.screens: ScreenSlot[]` / `MainEvent`에 `{ type: 'screens_changed'; screens: ScreenSlot[] }`.
- `appState.ts`: `AppState.setScreens(screens: ScreenSlot[]): void` — 들고 있다가 `snapshot()`에 싣고 `screens_changed`를 낸다
  (`setServer`와 같은 늦은 연결). 처음 값은 `[]`.
- `bootstrap.ts`: `assembleWithoutPlatforms`의 스냅샷에 `screens: []`.
- `useAppState.ts`: `reduce`가 `screens_changed`를 `snapshot.screens`에 반영한다. 스냅샷이 오기 전에 쌓였다 재생되는 경로도 같다.

- [x] **Step 1: 실패하는 테스트를 쓴다** — `appState.test.ts`: 처음 `snapshot().screens`가 `[]` / `setScreens` 뒤 그 값이고
  `screens_changed`가 한 번 나간다. `useAppState.test.tsx`: `screens_changed`가 반영된다 / 스냅샷보다 먼저 온 `screens_changed`가
  재생 뒤에 반영된다. `bootstrap.test.ts`: 플랫폼이 없는 조립의 `screens`가 `[]`.
- [x] **Step 2: 실패를 확인한다** — Run: `npx vitest run src/main/app src/renderer/src/state` / Expected: FAIL.
- [x] **Step 3: 구현한다.** fixture를 든 테스트 파일에 `screens: []`를 더한다.
- [x] **Step 4: 통과를 확인한다** — Run: `npm test && npm run typecheck` / Expected: PASS.
- [x] **Step 5: 커밋** — `git commit -m "feat(shared): 스냅샷과 이벤트에 화면 칸을 싣는다"`

---

### Task 4: main 조립 — 조정자를 잇는다

IPC 모양은 바꾸지 않는다. 이 task가 끝나면 main은 칸으로 돌고, renderer는 지금처럼 serial로 요청한다.

**Files:**
- Modify: `src/main/app/bootstrap.ts`, `src/main/index.ts`, `src/main/app/appState.ts`(`PLATFORM_LABELS` export),
  `src/main/stream/streamManager.ts`(`handleDisconnect` 삭제)
- Test: `src/main/app/bootstrap.test.ts`, `src/main/stream/streamManager.test.ts`, `src/main/index.test.ts`

**Interfaces:**
- Consumes: `createScreenSlots` (Task 1), `AppState.setScreens` (Task 3).
- `streamManager.ts`: `StreamManager.handleDisconnect`와 그 테스트를 지운다. 조정자가 `stop()`을 쓰므로 부르는 곳이 없어진다.
- `appState.ts`: `PLATFORM_LABELS`를 export한다.
- `bootstrap.ts`:
  - `BootstrapDeps.createStreamManager(registry, paths, hooks)`의 `hooks`에 `postPort(meta: SessionPortMeta, remote: unknown): void`를
    더한다. 관리자는 포트를 이 hook으로 내놓는다.
  - `BootstrapDeps.postStreamPort(meta: StreamPortMeta | null, remote: unknown): void`를 더한다. null이면 그 포트를 닫으라는 뜻이다.
  - `export function createPlaceByPlatform(platformOf: (serial: string) => Platform | null): PlaceFn` — Android는 `'a'`, iOS는 `'b'`.
    `connected`일 때 그 칸이 차 있으면 null, `selected`와 `vacated`면 그 칸, 플랫폼을 모르면 null.
  - `platformOf(serial)`는 `registry.resolve(serial).platform`을 `try/catch`로 감싼다(`resolve`는 모르는 serial에 던진다).
    `labelOf(serial)`는 `PLATFORM_LABELS[platform]`, 모르면 빈 문자열.
  - `createScreenSlots({ slotIds: ['a', 'b'], place, labelOf, createManager, onChange: state.setScreens })`. `createManager(slotId)`는
    `deps.createStreamManager(registry, androidPaths, { onState: 지금과 같다, postPort: (meta, remote) => deps.postStreamPort(slots.tagPort(slotId, meta), remote) })`.
  - `registry.on` 구독(반드시 `registry.start()` 전): `device_connected` → `slots.handleConnect(serial)` 뒤
    `registry.getActive() === serial`이면 `slots.select(serial)` / `device_disconnected` → `slots.handleDisconnect(serial)` /
    `active_changed`이고 serial이 null이 아니면 → `slots.select(serial)`. 지금의 `stream.handleDisconnect` 호출을 대신한다.
  - 임시 IPC 연결(Task 5에서 지운다): `startStream(serial)`은 `registry.resolve(serial)`로 모르는 serial을 거른 뒤, `slots.screens()`에서
    그 serial이 놓인 칸을 찾아 `slots.open({ slotId, epoch })`. 칸에 없으면 아무것도 하지 않는다. `stopStream()`은 `slots.closeAll()`.
  - 앱 종료의 `stream.stop()`은 `slots.closeAll()`. 스트림 닫기 실패는 더 이상 `app.stop()`을 reject시키지 않는다.
- `index.ts`: `createStreamManager` 구현이 `hooks.postPort`를 관리자의 `postPort`로 넘긴다. `postStreamPort` 구현은 meta가 있으면
  지금의 창 전송 경로로, null이면 그 포트를 닫는다.

- [x] **Step 1: 실패하는 테스트를 쓴다**
  - 새 harness: 실제 `createDeviceRegistry`를 쓴다(`track`은 테스트가 손으로 쏘고, `createDevice`는 `{ serial, platform }`만 가진
    가짜를 준다). `createStreamManager`는 호출마다 **다른** 가짜 관리자를 돌려주고 받은 `hooks`를 잡아 둔다.
  - `registry.start()` 때 이미 붙어 있던 Android 기기가 `snapshot.screens`의 `a` 칸에 있다 / Android와 iOS가 붙으면 `a`·`b` 칸이 모두
    찬다(아무도 고르지 않아도) / `selectDevice`(같은 플랫폼의 둘째 기기) → `activeSerial`과 그 칸의 `serial`이 함께 바뀐다 /
    `registry.setActive`(MCP `device_select`의 길)도 같다 / 대상 기기가 끊기면 `activeSerial`이 null이고 칸은 같은 플랫폼의 다른
    기기로 승계된다 / `startStream(serial)`이 그 기기가 놓인 칸의 관리자만 연다 / 모르는 serial의 `startStream`은 지금처럼 실패 /
    관리자의 `postPort` hook을 부르면 `postStreamPort`가 `slotId`·`epoch`가 붙은 꼬리표로 불리고, 그 칸의 기기가 바뀐 뒤에 부르면
    null로 불린다 / 종료 때 모든 관리자의 `stop`이 불리고, 하나가 던져도 `app.stop()`이 resolve한다.
  - `createPlaceByPlatform`: 플랫폼별 칸, `connected`에서 찬 칸은 null, 모르는 플랫폼은 null.
  - 뜻이 바뀌는 기존 테스트를 고친다: 기기 끊김에 `stream.handleDisconnect`를 기대하던 것(→ 그 칸 관리자의 `stop`), 스트림
    닫기가 던지면 `app.stop()`이 reject하기를 기대하던 둘(→ resolve하고 나머지 정리가 계속된다).
  - `index.test.ts`: `postStreamPort(null, port)`가 포트를 닫는다.
- [x] **Step 2: 실패를 확인한다** — Run: `npx vitest run src/main` / Expected: FAIL.
- [x] **Step 3: 구현한다.**
- [x] **Step 4: 통과를 확인한다** — Run: `npm test && npm run typecheck` / Expected: PASS.
- [ ] **Step 5: 앱에서 화면 하나의 회귀를 본다** — `npm run dev`로 띄워 기기 하나의 화면이 지금처럼 뜨고, 다른 기기를 고르면
  바뀌는지 앱 창 캡처로 본다. 볼 수 없으면 "사람 확인 필요"로 보고한다. dev 프로세스를 끝낸다.
  (Task 4 때는 보지 못했고 Task 8에서도 칸의 기기가 바뀌는 경우는 보지 못했다 — 스펙 "M5-3 검증 결과"에 있다.)
- [x] **Step 6: 커밋** — `git commit -m "feat(main): 스트림 세션을 화면 칸 조정자로 연다"`

---

### Task 5: IPC와 포트 계약을 칸·세대로 바꾼다

main, preload, renderer의 계약이 함께 바뀌므로 한 task다. 끝나면 앱은 여전히 화면을 **하나**만 그리지만(첫 번째 찬 칸),
그 화면은 칸과 세대로 열리고 포트는 라우터로 받는다.

**Files:**
- Modify: `src/shared/types/ipc.ts`(`RendererApi`), `src/preload/index.ts`, `src/main/app/ipcBridge.ts`, `src/main/app/bootstrap.ts`,
  `src/renderer/src/hooks/useScrcpyStream.ts`, `src/renderer/src/components/DeviceScreen.tsx`, `src/renderer/src/App.tsx`,
  `src/renderer/src/stream/streamPort.ts`
- Test: `src/preload/index.test.ts`, `src/main/app/ipcBridge.test.ts`, `src/main/app/bootstrap.test.ts`,
  `src/renderer/src/hooks/useScrcpyStream.test.tsx`, `src/renderer/src/components/DeviceScreen.test.tsx`,
  `src/renderer/src/App.test.tsx`, `src/renderer/src/stream/streamPort.test.ts`

**Interfaces:**
- Consumes: `SlotRef`, `streamPortRouter` (Task 1·2), `slots.open`/`stop` (Task 4).
- `ipc.ts`: `RendererApi.startStream(ref: SlotRef)`, `stopStream(ref: SlotRef)`.
- `ipcBridge.ts`: `BridgeActions.startStream(ref: SlotRef)`, `stopStream(ref: SlotRef)`. 인자를 검사해 **새 객체**
  `{ slotId, epoch }`로 넘긴다. `slotId`가 빈 문자열이 아닌 문자열이고 `epoch`가 0 이상의 정수여야 한다. 아니면 `withText`의 실패와
  같은 모양의 `Outcome`이고 문구는 `칸 지정이 올바르지 않다`.
- `bootstrap.ts`: 액션을 `startStream: (ref) => slots.open(ref)`, `stopStream: (ref) => slots.stop(ref)`로 바꾸고 Task 4의 임시 연결을
  지운다. `assembleWithoutPlatforms`의 두 액션은 아무것도 하지 않고 resolve한다.
- `preload/index.ts`: 두 IPC가 `SlotRef`를 넘긴다. `streamPort` 이벤트는 꼬리표 네 필드를 모두 `window.postMessage`로 넘긴다.
- `useScrcpyStream(ref: SlotRef, canvasRef, deps?)`:
  - `deps.onStreamPort`를 `deps.subscribePort(ref, onPort)`로 바꾼다. 기본은 `streamPortRouter.subscribe`.
  - **`subscribePort`를 `startStream(ref)`보다 먼저 부른다.**
  - 다른 serial의 포트를 `close()`하던 분기를 지운다. 훅은 받은 포트만 다룬다.
  - effect의 의존성은 원시값이다: `ref.slotId`, `ref.epoch`, `attempt`, `canvasRef`. `ref` 객체를 넣지 않는다.
  - 정리에서 `stopStream(ref)`.
- `DeviceScreen`의 props를 `{ screen: ScreenSlot }`으로 바꾼다. 호출부가 `serial`이 null인 칸을 거른다. 안의 serial 사용처
  (`GestureOverlay`, `ScreenshotView` 등)는 `screen.serial`을 쓴다. `LiveScreen`의 `key={serial}`은 지운다(세대가 key를 대신한다).
- `App`: `snapshot.screens` 중 `serial`이 있는 **첫** 칸 하나를 `` key={`${id}:${epoch}`} ``로 그린다. 없으면 `section aria-label="기기 화면"`
  안에 빈 상태 문구. (여러 화면은 Task 7.)
- `streamPort.ts`의 옛 `onStreamPort`와 그 테스트를 지운다. 그것을 가리키는 주석(`logPort.ts`, `useLogStream.ts`)을 고친다.

- [x] **Step 1: 실패하는 테스트를 쓴다**
  - `ipcBridge.test.ts`: `startStream`에 `{ slotId: 'a', epoch: 1 }` → 액션이 같은 값의 **새 객체**로 불린다 / `'A1'`,
    `{ slotId: '', epoch: 1 }`, `{ slotId: 'a', epoch: -1 }`, `{ slotId: 'a', epoch: 1.5 }`, `null` → 실패 `Outcome`이고 액션은 불리지
    않는다. `stopStream`도 같다. 인자 없이 `stopStream`을 부르던 기존 테스트를 고친다.
  - `preload/index.test.ts`: `startStream`·`stopStream`이 `SlotRef`를 그대로 `invoke`한다 / 포트 전달이 꼬리표 네 필드를 **정확히**
    싣는다(`toEqual`로, 빠진 필드를 `undefined`로 넘기는 구현이 통과하지 않게).
  - `bootstrap.test.ts`: `startStream({ slotId: 'a', epoch })`이 `a` 칸의 관리자만 연다 / 낡은 세대면 어느 관리자도 열리지 않고
    성공 / 칸의 기기가 바뀐 뒤 옛 세대의 `stopStream`은 새 세션을 가진 관리자의 `stop`을 부르지 않는다 / 플랫폼이 없는 조립의
    두 액션은 성공하고 아무것도 하지 않는다.
  - `useScrcpyStream.test.tsx`: 훅이 `subscribePort`를 제 `ref`로 부르고 그 호출이 `startStream`보다 먼저다(`invocationCallOrder`) /
    `startStream`·`stopStream`이 `ref`로 불린다 / 내용이 같은 새 `ref` 객체로 rerender해도 `startStream`이 다시 불리지 않는다 /
    세대가 바뀐 `ref`로 rerender하면 이전 것을 `stopStream(옛 ref)`으로 정리하고 새 `ref`로 연다 / **'closes a port that belongs to
    another serial'과 'closes a stale port for the previous serial after switching devices…'를 지우고** "훅은 받은 포트 말고는 어떤
    포트도 닫지 않는다"를 둔다.
  - 같은 파일: 실제 `createStreamPortRouter(fakeTarget)` 하나에 훅 둘(`{x,1}`, `{y,1}`)을 붙인다 → 각자의 포트로 `streaming`에
    이르고, 어느 포트도 `close`되지 않고, 한 훅의 `send`가 제 포트로만 간다.
  - `App.test.tsx`: `screens`의 첫 찬 칸이 그려진다 / 그 칸의 세대가 오르면 화면이 다시 마운트된다(`startStream`이 새 `ref`로 한 번
    더) / 찬 칸이 없으면 빈 상태 문구 / 타임라인 이벤트로 다시 그려져도 `startStream`이 다시 불리지 않는다. `mockApi`의 `onEvent`가
    리스너를 잡아 두게 harness를 고친다.
- [x] **Step 2: 실패를 확인한다** — Run: `npx vitest run src/main/app src/preload src/renderer/src` / Expected: FAIL.
- [x] **Step 3: 구현한다.**
- [x] **Step 4: 통과를 확인한다** — Run: `npm test && npm run typecheck` / Expected: PASS.
- [x] **Step 5: 커밋** — `git commit -m "feat(main): 스트림 요청과 포트를 칸과 세대로 주고받는다"`

---

### Task 6: 화면 머리와 화면별 boundary

독립된 컴포넌트 둘이다. 아직 어디에도 끼우지 않는다.

**Files:**
- Create: `src/renderer/src/components/ScreenHeader.tsx`, `ScreenHeader.test.tsx`, `ScreenBoundary.tsx`, `ScreenBoundary.test.tsx`

**Interfaces:**
- Produces:
  - `ScreenHeader({ screen, isTarget, onMakeTarget, onReconnect, canReconnect }: { screen: ScreenSlot; isTarget: boolean; onMakeTarget(): void; onReconnect(): void; canReconnect: boolean })`
    — `label`, `serial`(mono, `title`에 전체 값), 대상이면 `(대상)` 배지, `대상으로` 버튼
    (`` aria-label={`${label} ${serial} 대상으로`} ``, 대상이면 `disabled`), `다시 연결` 버튼(`canReconnect`일 때만 그린다).
  - `ScreenBoundary({ children }: { children: ReactNode })` — 클래스 컴포넌트 error boundary. 던지면 `이 화면을 그리지 못했다`와
    `다시 시도` 버튼을 보인다. 다시 시도는 내부 카운터를 올려 `children`을 새 key로 다시 마운트한다. 잡은 에러는 `console.error`로 남긴다.

- [x] **Step 1: 실패하는 테스트를 쓴다** — `ScreenHeader`: `label`과 `serial`이 보이고 serial의 `title`이 전체 값이다 / 대상이 아니면
  `대상으로`가 켜져 있고 누르면 `onMakeTarget` / 대상이면 `(대상)` 배지가 있고 버튼이 꺼져 있다 / `canReconnect`가 true일 때만
  `다시 연결`이 있고 누르면 `onReconnect`. `ScreenBoundary`: 자식이 던지면 `이 화면을 그리지 못했다`가 보이고 형제 요소는 그대로
  있다 / `다시 시도`를 누르면 자식이 다시 마운트된다(이번에는 던지지 않는 자식이 보인다). `console.error`는 spy로 받는다.
- [x] **Step 2: 실패를 확인한다** — Run: `npx vitest run src/renderer/src/components/ScreenHeader.test.tsx src/renderer/src/components/ScreenBoundary.test.tsx` / Expected: FAIL.
- [x] **Step 3: 구현한다.**
- [x] **Step 4: 통과를 확인한다** — Run: `npm test && npm run typecheck` / Expected: PASS.
- [x] **Step 5: 커밋** — `git commit -m "feat(renderer): 화면 머리와 화면별 error boundary를 더한다"`

---

### Task 7: 여러 화면을 그린다

**Files:**
- Modify: `src/renderer/src/App.tsx`, `src/renderer/src/components/DeviceScreen.tsx`, `src/renderer/src/app.css`
- Test: `src/renderer/src/App.test.tsx`, `src/renderer/src/components/DeviceScreen.test.tsx`

**Interfaces:**
- Consumes: `ScreenHeader`, `ScreenBoundary` (Task 6), `targetSerial` (기존), Task 5의 `DeviceScreen`.
- `DeviceScreen({ screen, isTarget, onMakeTarget, onFocusNext })`:
  - 지금의 머리줄(`.screen-toolbar`: 제목 `화면`, serial, `다시 연결`)을 `ScreenHeader`로 **대체**한다. `다시 연결`은
    `ScreenHeader`의 `onReconnect`·`canReconnect`로 잇는다(지금 그 버튼이 보이는 조건 그대로).
  - `section`의 `aria-label`은 `` `기기 화면 ${label} ${serial}` ``, 키 버튼 툴바는 `` `기기 버튼 ${label} ${serial}` ``.
  - 포커스 대상은 화면마다 하나이고 `data-screen-focus` 속성을 단다: 캔버스가 있으면 캔버스, 스크린샷으로 강등돼 캔버스가
    없으면 `section` 자체(`tabIndex={-1}`).
  - 키 버튼 툴바의 클릭 처리 끝에 그 화면의 포커스 대상에 `focus()`한다. `다시 연결`로 캔버스가 다시 마운트되면 캔버스에
    포커스를 준다.
  - `F6`은 캔버스가 아니라 `section`의 `onKeyDown`에서 받아 `onFocusNext()`를 부르고 `preventDefault`한다(머리나 툴바 버튼에
    포커스가 있을 때도 동작한다). `F6`은 지금도 기기로 가지 않는다.
- `App`:
  - `serial`이 있는 칸을 모두 그린다. 화면 묶음은 `<div className="screens" style={{ '--screen-count': n } as CSSProperties}>`.
    칸마다 `` <ScreenBoundary key={`${id}:${epoch}`}> `` 안에 `DeviceScreen`.
  - 화면이 하나 이상이고 `targetSerial(snapshot)`이 null이면 묶음 위에 `notice notice-info`로 대상 없음 안내.
  - `onMakeTarget`은 `window.api.selectDevice(serial)`.
  - `onFocusNext`: `.screens` 컨테이너에서 `[data-screen-focus]`를 DOM 순서로 찾아, 지금 포커스가 든 화면의 다음 것에
    `focus()`한다(끝에서 처음으로. 하나면 아무것도 하지 않는다).
  - 찬 칸이 없으면 Task 5의 빈 상태 그대로.
- `app.css`:
  - `.pane-screen`을 `flex-direction: column`으로(안내 줄이 위에 온다).
  - `.screens { flex: 1; min-width: 0; min-height: 0; display: grid; grid-template-columns: repeat(var(--screen-count), minmax(0, 1fr)); grid-template-rows: minmax(0, 1fr); gap: var(--space-2); }`
  - 각 화면의 캔버스는 제 칸 안에서 종횡비를 지키며 줄어든다(지금의 `height: 100%` 사슬이 그 칸 안에서 유지되게).
  - `.device-screen:focus-within`이면 머리와 테두리를 강조한다(기존 색 토큰).
  - 화면이 하나일 때 캔버스의 크기와 자리는 지금과 같아야 한다.

- [x] **Step 1: 실패하는 테스트를 쓴다**
  - `App.test.tsx`: `screens`가 임의 id(`'x'`, `'y'`)의 찬 칸 둘이면 이름이 `기기 화면`으로 시작하는 region이 둘이고 이름이 서로
    다르다 / 찬 칸 하나면 region 하나 / 화면이 하나든 둘이든 대상이 없으면 안내가 보이고, 대상이 있으면 없다 / 한 화면의
    `DeviceScreen`이 던져도 다른 화면의 region이 남는다(`vi.mock`과 `importActual`로 한 serial에서만 던지는 `DeviceScreen`을 쓴다.
    `console.error`는 spy) / 한 칸의 세대만 오르면 그 화면만 다시 마운트된다 / `대상으로`를 누르면 `window.api.selectDevice`가 그
    칸의 serial로 불린다 / 화면 둘에서 첫 화면의 `F6`이 둘째 화면의 포커스 대상으로, 둘째의 `F6`이 첫째로 포커스를 옮긴다.
  - `DeviceScreen.test.tsx`: `section`과 툴바의 접근성 이름이 `label`과 `serial`을 담는다(정확한 이름 `기기 화면`·`기기 버튼`으로
    찾던 기존 단언을 고친다) / 툴바 키 버튼을 누른 뒤 `document.activeElement`가 그 화면의 캔버스다 / 머리의 버튼에 포커스가
    있을 때 `F6`을 눌러도 `onFocusNext`가 불린다 / 캔버스를 클릭하고 타이핑해도 `window.api.selectDevice`가 불리지 않는다 /
    스크린샷으로 강등된 화면에서는 `section`이 `data-screen-focus`를 가진다.
- [x] **Step 2: 실패를 확인한다** — Run: `npx vitest run src/renderer/src` / Expected: FAIL.
- [x] **Step 3: 구현한다.**
- [x] **Step 4: 통과를 확인한다** — Run: `npm test && npm run typecheck` / Expected: PASS.
- [x] **Step 5: 커밋** — `git commit -m "feat(renderer): 칸마다 화면을 그리고 포커스를 표시한다"`

---

### Task 8: 실제 앱 확인과 문서

**Files:**
- Create: `src/main/stream/screenSlots.integration.test.ts`
- Modify: `docs/superpowers/specs/2026-10-06-m5-multi-screen.md`, `docs/architecture/main-layers.md`,
  `docs/adr/0017-screen-slots-separate-from-target.md`·`0018-jpeg-frame-ack-flow-control.md`, 이 계획 문서

- [x] **Step 1: 통합 테스트를 쓴다**

실제 `createStreamManager`와 `createScreenSlots`를 최소 `PortLike` 가짜로 조립한다(`scrcpySession.integration.test.ts`의 Android 조립과
`axeStreamSession.ios.integration.test.ts`의 iOS 조립을 따른다). 두 묶음으로 나눈다. (가) 기기가 **하나라도** 있으면: 그 칸을 열어
포트가 `session`과 프레임(또는 `packet`)을 받는다 / 낡은 세대의 `open`은 아무 포트도 내놓지 않는다. (나) Android 기기와 부팅된 iOS
시뮬레이터가 **둘 다** 있으면: 두 칸을 함께 열어 둘 다 받는다 / 한 칸을 `stop`해도 다른 칸의 프레임이 계속 온다 / 각 칸이 일정
장 수를 받는 데 걸린 시간으로 fps를 `console.info`에 남긴다. 조건이 안 되면 그 묶음은 skip. 기다림은 `sleep`이 아니라 받은 메시지의
promise다.

Run: `npm run test:integration -- src/main/stream/screenSlots.integration.test.ts` / Expected: PASS(또는 skip).

- [x] **Step 2: 실제 앱에서 본다**

macOS 호스트에서 `npm run dev`로 띄운다. Android 기기와 iOS 시뮬레이터가 함께 붙어 있어야 한다(iOS가 없으면 `xcrun simctl boot`로
하나 부팅하고 끝나면 그것만 끈다. Android가 없으면 두 화면 항목은 "미검증 — Android 기기 없음"으로 적는다). 앱 창만 캡처해서 본다
(창 id를 얻어 `screencapture -l`. 권한이 없어 캡처가 안 되면 "미검증"으로 적는다): 두 화면이 나란히 뜨고 둘 다 실시간이다 / 고르지
않았을 때 대상 없음 안내가 보인다 / 앱의 MCP HTTP 엔드포인트로 `device_select`를 부르면 대상 표시가 옮겨 가고 오른쪽 탭이 그 기기를
따른다 / 한쪽 기기를 끄면 그 화면만 사라지고 다른 쪽은 계속 돈다 / 기기가 하나일 때 캔버스의 크기와 자리가 M5 이전과 같다. 두
스트림이 함께 돌 때 앱 프로세스들의 CPU를 `ps`로 잰다(fps는 Step 1의 통합 테스트 값이다). 끝나면 dev 프로세스를 끝낸다.

"사람 확인 필요"로 남긴다: `대상으로` 버튼 클릭, 화면 클릭·타이핑, 포커스 강조와 `F6`, 창을 좁혔을 때의 배치, `Cmd+R` 뒤 두 화면이
다시 뜨는지, 창을 닫았다 다시 열었을 때, Windows 호스트의 회귀.

- [x] **Step 3: 문서를 고치고 커밋한다**

스펙 끝에 "M5-3 검증 결과" 절(본 것 / 부분적으로 본 것 / 못 본 것, 잰 fps·CPU)을 쓴다. 잰 부하에 비추어 "열린 질문"의
`MAX_SCREEN_SLOTS` 항목을 갱신한다. `main-layers.md`에 화면 칸 층(조정자, 칸마다 관리자, renderer 라우터)을 더하고 `verified`를
갱신한다. 두 ADR의 `related_plan`을 채운다. 스펙·ADR-0017·이 계획의 `related_code`에서 사라진 `streamPort.ts#onStreamPort`를
`streamPort.ts#createStreamPortRouter`로 고친다. 스펙 `status`는 앱 창 확인이 사람에게 남아 있으면 `in-progress`로 둔다.

Run: `python3 docs/script/docs.py lint && python3 docs/script/docs.py links` / Expected: 문제 0건.

`git commit -m "docs(stream): M5-3 화면 칸의 확인 결과를 남긴다"`
