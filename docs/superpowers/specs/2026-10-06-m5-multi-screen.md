---
id: m5-multi-screen
title: M5 — 여러 기기 화면 동시 보기
status: draft
verified: 2026-10-06
scope: [main, renderer, preload, shared, streaming, android, ios]
hosts: [windows, macos]
supersedes:
superseded_by:
related_adr: [ADR-0017, ADR-0018, ADR-0015, ADR-0016, ADR-0010]
related_spec: m4-ios-simulator
related_architecture: main-layers
related_plan: [m5-1-device-card-badges, m5-2-jpeg-frame-ack, m5-3-screen-slots]
related_code: [streamManager.ts#createStreamManager, bootstrap.ts#bootstrapApp, appState.ts#createAppState, ipcBridge.ts#BridgeActions, registry.ts#createDeviceRegistry, ipc.ts#AppSnapshot, stream.ts#StreamUp, stream.ts#StreamPortMeta, streamPort.ts#onStreamPort, useAppState.ts#targetSerial, App.tsx#App, DeviceScreen.tsx#DeviceScreen, useScrcpyStream.ts#useScrcpyStream, jpegRenderer.ts#createJpegRenderer, DevicePanel.tsx#DevicePanel]
tags: [spec, streaming, multi-screen]
---

# Spec: M5 — 여러 기기 화면 동시 보기

> 상태·날짜·관련 문서는 위 frontmatter가 단일 출처. 본문은 설계 내용에 집중한다.

## 목표

Android 기기 한 대와 iOS 기기 한 대의 화면을 앱 창에 나란히 실시간으로 보이고, 둘 다 마우스·키보드로
조작한다. 같은 앱을 두 플랫폼에서 나란히 놓고 비교하려는 것이다.

설계 기준은 구현의 쉬움이 아니라 **확장성과 안정성**이다. 칸 수와 배정 규칙을 나중에 바꿀 때 세션 수명
로직과 renderer를 고치지 않아야 하고, 한 화면의 실패가 다른 화면의 상태에 닿지 않아야 한다.

호스트 OS에 따른 차이: 두 화면은 두 플랫폼의 기기가 함께 붙을 수 있는 macOS 호스트에서만 생긴다.
Windows 호스트는 iOS 도구를 조립하지 않으므로 늘 화면이 하나다. 그 경우의 동작은 지금과 같아야 한다.

## 범위

- 포함
  - 화면 칸(screen slot) 모델: 칸마다 스트림 세션 관리자 하나, 칸의 진실은 main에 하나.
  - 칸 배정 규칙: 지금은 플랫폼당 한 칸.
  - 화면 표시와 MCP 대상의 분리. 화면은 고르지 않아도 뜬다.
  - renderer의 스트림 포트 수신을 라우터 하나로 모으기.
  - JPEG 프레임 흐름 제어(renderer 확인 뒤 다음 장).
  - 화면별 실패 격리, 포커스된 화면 표시, 화면별 접근성 이름.
  - 기기 카드의 배지 겹침 수정.
- 제외
  - 같은 플랫폼 기기 둘을 동시에 보기. 배정 함수와 칸 목록만 바꾸면 되게 만들되 이번에는 만들지 않는다.
  - 대상은 그대로 두고 다른 기기를 보기만 하기. 대상은 늘 화면에 보이는 기기다(아래 불변식).
  - 한 번의 조작을 두 기기에 함께 보내기(미러 입력).
  - h264 경로의 흐름 제어. 중간 프레임을 버릴 수 없어 같은 방식이 맞지 않는다.

MCP 툴은 지금도 호출마다 `serial`을 받는다(`mcp/tools/`의 `serialArg`, `agentGuide.ts`의 안내). 에이전트는
두 기기를 번갈아 다룰 수 있고, "대상"은 `serial`을 생략한 호출에만 쓰인다. 이 스펙은 MCP 툴 인터페이스를
바꾸지 않는다.

## 지금 구조

- `streamManager.ts`의 `createStreamManager`는 세션 하나(`current`)만 든다. `open(serial)`은 이전 세션을 닫는다.
- renderer `App.tsx`의 `App`은 `targetSerial(snapshot)` 하나로 `DeviceScreen` 하나를 그린다. 그 안의
  `LiveScreen`이 `useScrcpyStream`을 부르고, 훅이 `startStream(serial)`로 스트림을 요청한다.
- 훅은 `streamPort.ts`의 `onStreamPort`로 포트를 받는다. **자기 serial이 아닌 포트는 닫는다.** 훅이 하나라는
  전제에서만 맞는 동작이다. 훅이 둘이면 같은 포트가 두 훅에 전달되어 한쪽이 반드시 닫는다.
- `AppSnapshot.activeSerial`은 사람이나 MCP `device_select`가 명시적으로 고른 기기다. `targetSerial`은 이 값이
  없고 연결된 기기가 하나뿐이면 그 기기를 대상으로 본다.
- `stopStream`은 인자가 없다. 세션이 하나라서다.

즉 "화면에 보이는 기기"가 "MCP 대상"에서 파생되고, renderer 포트 수신과 IPC가 화면 하나를 전제한다.

## 인터페이스

### 세 가지를 따로 둔다

| 것 | 책임 | 위치 |
|---|---|---|
| 세션 기계 | 칸 하나의 스트림 수명(열기·재연결·포트·닫기) | `streamManager.ts` — 수명·재연결 로직은 그대로, 칸마다 인스턴스 하나. 관리자는 칸을 모른다 |
| 배정 | 어느 기기를 어느 칸에 놓는가 | `screenSlots.ts`가 받는 함수 하나 |
| MCP 대상 | `serial`을 생략한 툴 호출이 가는 기기 | `registry.ts` — 그대로 |

### 화면 칸 조정자 (`src/main/stream/screenSlots.ts`)

```ts
/** 칸에 기기를 놓게 된 까닭. */
export type PlaceReason = 'connected' | 'selected' | 'vacated'

/** 지금 각 칸에 놓인 기기. 칸 목록 순서대로다. */
export type Occupancy = ReadonlyArray<{ slotId: string; serial: string | null }>

/**
 * serial을 놓을 칸의 id. 놓지 않으려면 null.
 * - connected: 기기가 붙었다. 보통 빈 칸일 때만 칸을 준다.
 * - selected: 사람이나 MCP가 골랐다. 반드시 칸을 준다(이전 기기는 내려간다).
 * - vacated: 어느 칸이 비었다. 그 칸으로 갈 기기면 그 칸의 id를 준다.
 * 조정자는 이 함수 밖에서 칸 id의 뜻을 읽지 않는다.
 */
export type PlaceFn = (serial: string, occupancy: Occupancy, reason: PlaceReason) => string | null

export interface ScreenSlotsDeps {
  slotIds: string[]                        // 순서가 곧 화면 순서
  place: PlaceFn
  /** 칸에 놓인 기기를 사람이 읽는 이름. 조립 지점이 정한다. */
  labelOf(serial: string): string
  createManager(slotId: string): StreamManager
  onChange(screens: ScreenSlot[]): void
}

export interface ScreenSlots {
  handleConnect(serial: string): void
  handleDisconnect(serial: string): void
  /** 골랐다. place(…, 'selected')가 준 칸에 놓는다. */
  select(serial: string): void
  /** 칸과 세대가 지금과 같을 때만 그 칸의 관리자로 연다. 낡은 요청은 조용히 무시한다. */
  open(ref: SlotRef): Promise<void>
  stop(ref: SlotRef): Promise<void>
  /**
   * 관리자가 내놓은 포트에 칸과 세대를 붙인다. 그 칸에 지금 놓인 기기가 meta.serial이 아니면 null —
   * 호출자는 그 포트를 닫는다.
   */
  tagPort(slotId: string, meta: SessionPortMeta): StreamPortMeta | null
  screens(): ScreenSlot[]
  closeAll(): Promise<void>
}
```

- 칸 id는 플랫폼 이름이 아닌 중립 값(`'a'`, `'b'`)이다. renderer 테스트는 임의 id로 돈다.
- 지금의 배정 함수는 조립 지점(`bootstrap.ts`)의 클로저다. 기기의 플랫폼을 보고 Android는 첫 칸, iOS는 둘째
  칸을 준다. `screenSlots.ts`는 `Platform`을 import하지 않는다. 플랫폼을 보는 곳은 이 클로저뿐이다
  ([ADR-0015](../../adr/0015-platform-difference-surface.md)).
- 칸 수의 상한 `MAX_SCREEN_SLOTS`는 `src/shared/limits.ts`에 둔다. `slotIds`가 이를 넘으면 조립에서 던진다.
  실제 방어는 "칸 밖의 요청은 열지 않는다"이다. 칸을 늘릴 때 함께 볼 곳: 이 상수, `app.css`의 화면 열,
  `index.ts`의 `createWindow`가 정하는 창 최소 폭, 부하 측정.
- 기기는 많아야 한 칸에 있다. `place`가 모르는 칸 id를 주면 놓지 않는다.
- 조정자는 serial→칸과 연결 순서를 스스로 기억한다. `registry`는 끊김 이벤트를 낼 때 이미 기기를 지웠으므로
  그때 물어볼 수 없다.

### 스냅샷과 이벤트 (`src/shared/types/ipc.ts`)

```ts
export interface ScreenSlot {
  id: string
  /** 이 칸에 놓인 기기가 바뀔 때마다 한 번 오른다. 끊김 뒤의 승계나 비움도 한 번의 변화다. */
  epoch: number
  /** 이 칸에 보이는 기기. 없으면 null. */
  serial: string | null
  /** 놓인 기기를 사람이 읽는 이름. main이 정한다. 빈 칸이면 빈 문자열. */
  label: string
}

/** 화면 하나를 가리킨다. 세대가 다르면 낡은 요청이다. */
export interface SlotRef { slotId: string; epoch: number }

export interface AppSnapshot {
  // … 기존 필드
  activeSerial: string | null   // 뜻 그대로: 명시적으로 고른 MCP 대상
  screens: ScreenSlot[]         // 새 필드. 순서는 main이 정한다
}

export type MainEvent =
  // … 기존
  | { type: 'screens_changed'; screens: ScreenSlot[] }
```

`activeSerial`은 이름과 뜻을 바꾸지 않는다. 바뀌는 것은 화면이 더 이상 이 값에서 파생되지 않는다는 점뿐이다.
renderer의 `targetSerial(snapshot)`도 그대로 MCP 대상을 뜻하며 활동·로그 탭과 대상 표시에 쓴다.

### IPC

- `startStream(ref: SlotRef)` / `stopStream(ref: SlotRef)` — serial 대신 칸과 세대를 받는다. 세대가 지금과
  다르거나 칸이 비었으면 성공으로 끝내고 아무것도 하지 않는다. 화면이 내려가는 도중의 요청이 에러 화면을
  깜빡이게 하지 않는다.
- `selectDevice(serial)` — 그대로. `registry.setActive`로 대상을 정한다. 칸은 아래 불변식으로 따라온다.
- 새 IPC는 없다.
- 바뀌는 곳: `ipcBridge.ts`의 `BridgeActions`와 인자 검증, `preload/index.ts`, `bootstrap.ts`의 액션과
  `assembleWithoutPlatforms`(`screens: []`).

### 포트 꼬리표와 흐름 제어 (`src/shared/types/stream.ts`)

```ts
/** 관리자가 내놓는 꼬리표. 관리자는 칸을 모른다. */
export interface SessionPortMeta { serial: string; sessionId: string }

/** renderer로 가는 꼬리표. 칸과 세대는 조정자의 tagPort가 붙인다. */
export interface StreamPortMeta extends SessionPortMeta {
  slotId: string
  epoch: number
}

/** renderer → main 포트 메시지 */
export type StreamUp = ControlIntent | { type: 'frame_ack' }
```

- `preload/index.ts`와 `streamPort.ts`의 `onStreamPort`가 새 필드를 그대로 나른다. 지금은 `serial`과
  `sessionId`를 손으로 옮겨 적는다.
- `frame_ack`는 `jpeg` 세션에서 쓴다. 규칙은 [ADR-0018](../../adr/0018-jpeg-frame-ack-flow-control.md)에 있다.

### renderer 포트 라우터 (`src/renderer/src/stream/streamPort.ts`)

```ts
export interface StreamPortRouter {
  /** 이 칸·세대의 포트를 받겠다고 등록한다. 돌려준 함수로 해제한다. */
  subscribe(ref: SlotRef, onPort: (meta: StreamPortMeta, port: MessagePort) => void): () => void
}
export function createStreamPortRouter(target?: MessageTarget): StreamPortRouter
```

- 창 하나에 라우터 하나다. 창의 `message` 리스너는 라우터만 건다. 포트는 `slotId`와 `epoch`가 모두 맞는 구독자에게만 넘긴다.
- 받을 구독자가 없는 포트만 라우터가 닫는다. **훅은 남의 포트를 닫지 않는다.**
- 같은 칸·세대에 포트가 다시 오면(재시도) 구독자가 이전 포트를 놓고 새 포트를 쓴다. 지금 훅의 동작이다.
- 화면은 **구독을 먼저 하고** 스트림을 요청한다. 포트는 그 요청에 대한 응답으로만 생기므로, 곧 구독할 화면의
  포트를 라우터가 닫는 일이 없다.

## 동작 / 상태

### 불변식

1. **칸의 진실은 main에 하나다.** renderer는 `snapshot.screens`를 그릴 뿐이다.
2. **대상은 늘 화면에 보이는 기기다.** 조정자가 `registry`의 `active_changed`(serial이 null이 아닐 때)를
   구독해 `select(serial)`을 부른다. 기기 카드, 화면 머리의 "대상으로", MCP `device_select`가 모두
   `registry.setActive` 한 길로 가므로 mcp 층은 화면을 알 필요가 없고 새 IPC도 없다.
3. **화면을 클릭·타이핑해도 대상은 바뀌지 않는다.** 에이전트가 일하는 도중 사람이 다른 화면을 만져도
   `serial`을 생략한 다음 호출이 엉뚱한 기기로 가지 않는다.
4. **조정자는 상태를 먼저 바꾸고 닫기는 그 뒤에 한다.** 칸의 serial·epoch 변경과 `onChange`는 await 전에
   동기로 한다. 죽은 기기의 세션 닫기는 `adb forward --remove`를 기다리느라 오래 걸릴 수 있고, 그동안
   죽은 화면이 남으면 안 된다. `closeAll`은 한 칸이 던져도 나머지를 닫고, 실패는 로그로만 남긴다 —
   앱 종료가 스트림 닫기 실패로 실패하지 않는다.
5. **조정자는 `registry.start()`보다 먼저 구독한다.** 그래야 처음부터 붙어 있던 기기도 칸에 들어간다.

### 칸 배정

- 기기가 붙으면 `place(serial, occupancy, 'connected')`를 부른다. 칸을 주면 놓는다.
- 대상이 정해지면 `place(serial, occupancy, 'selected')`가 준 칸에 놓는다. 그 칸의 이전 기기는 내려가고
  세션이 닫힌다. 이미 그 칸에 보이는 기기면 아무것도 바꾸지 않는다(세대도 그대로).
- 보이던 기기가 끊기면 붙어 있지만 어느 칸에도 없는 기기를 연결 순서대로 돌며
  `place(serial, occupancy, 'vacated')`가 그 칸을 주는 첫 기기로 바꾼다. 없으면 칸을 비운다. 어느 쪽이든
  **한 번의 변화**다(세대가 한 번 오르고 알림도 한 번이다). 빈 칸을 거쳐 가지 않는다.
- 칸에 놓인 기기가 바뀔 때마다 그 칸의 `epoch`가 한 번 오른다. 같은 serial이 끊겼다 다시 붙어도 오른다.
- 변화가 있을 때만 `screens_changed`를 낸다.
- 동작 변화: 지금은 기기가 둘이고 아무도 고르지 않았으면 화면이 없다. M5부터는 고르지 않아도 칸이
  채워져 화면이 뜬다.

### MCP 대상

| 조작 | 대상(`activeSerial`) | 칸 |
|---|---|---|
| 기기 카드 클릭 | 그 기기 | 불변식 2로 그 기기가 제 칸에 보인다 |
| 화면 머리의 "대상으로" | 그 기기 | 이미 보이는 기기라 그대로 |
| MCP `device_select` | 그 기기 | 불변식 2로 그 기기가 제 칸에 보인다 |
| 화면을 클릭·타이핑 | **바뀌지 않는다** | 그대로 |
| 대상 기기가 끊긴다 | `registry`가 비운다(지금과 같다) | 칸은 승계되거나 빈다. 승계된 기기가 대상이 되지는 않는다 |

- 대상 표시는 `targetSerial(snapshot)` 기준이다. 기기가 하나뿐이면 고르지 않아도 그 기기가 대상으로 표시된다.
- 두 번째 기기가 붙으면 암묵 대상이 사라진다. `serial`을 생략하던 툴 호출은 그때부터 `ambiguous_device`로
  끝난다. 이것은 지금도 같은 동작이지만 M5에서는 흔한 경로가 되므로, 화면이 하나 이상이고 대상이 없으면 화면
  영역 위에 한 줄 안내를 보인다(같은 플랫폼 기기 둘이면 화면은 하나지만 사정은 같다): `대상 기기가 없다. 화면 머리의 "대상으로"를 누르거나 툴 호출에 serial을 넘겨라`.
- 대상이 없을 때 오른쪽 로그 탭과 에이전트 탭은 지금의 "대상 없음" 동작을 그대로 따른다.

### renderer

- `App`은 `snapshot.screens`를 순서대로 돌며 `serial`이 있는 칸마다 화면 하나를 그린다. React key는
  `` `${id}:${epoch}` ``다. 세대가 바뀌면 화면이 새로 마운트되어 스트림을 다시 연다. 같은 기기가 빠르게
  내려갔다 올라와도 얼어붙지 않는다.
- 화면이 하나도 없으면 빈 상태를 보인다: `연결된 기기가 없다. 왼쪽 목록에서 기기를 부팅해라`. 지금 문구
  "기기를 선택해라"는 자동 배정과 맞지 않아 바꾼다.
- 화면 머리(`ScreenHeader`)가 지금의 화면 머리줄(`.screen-toolbar`: 제목, serial, `다시 연결`)을 대체한다.
  `label`, serial, 대상 표시, "대상으로" 버튼, `다시 연결` 버튼을 둔다. "대상으로"는 `selectDevice`를 부르고,
  이미 대상이면 끈다.
- 화면마다 `useScrcpyStream`이 따로 돌고 `SlotRef`로 라우터에 구독한다.
- 화면마다 `ScreenBoundary`(error boundary)로 싼다. 다시 시도는 boundary의 key를 바꿔 화면을 새로 마운트한다.
- **포커스**: 키보드 입력은 포커스가 있는 캔버스로만 간다(지금과 같다). 캔버스가 둘이면 어느 쪽인지 보여야
  하므로 포커스를 가진 화면의 머리와 테두리를 강조한다(`:focus-within`). 툴바 버튼을 누른 뒤에는 포커스를
  그 화면의 캔버스로 되돌린다. Tab은 기기로 가는 키이므로, 화면 사이를 키보드로 옮기는 키는 `F6`이다.
  화면마다 포커스 대상이 하나 있다 — 캔버스가 있으면 캔버스, 스크린샷으로 강등돼 캔버스가 없으면 화면
  영역 자체다. `F6`은 화면 영역 어디에 포커스가 있든 다음 화면의 포커스 대상으로 옮긴다(끝에서 처음으로).
- **접근성 이름**: 화면 영역은 `` `기기 화면 ${label} ${serial}` ``, 툴바는 `` `기기 버튼 ${label} ${serial}` ``.
  두 화면의 이름이 겹치지 않는다.
- **배치**: 화면 열을 화면 수만큼 같은 폭으로 나눈다. 각 캔버스는 종횡비를 지키며 제 칸 안에 맞춘다. 세로로
  쌓지 않는다. 창 최소 폭은 바꾸지 않는다. 화면이 하나일 때 캔버스의 크기와 자리는 지금과 같다(머리와
  포커스 강조는 새로 생긴다).
- 오른쪽 활동·로그 탭은 지금처럼 `targetSerial`을 따른다.

### JPEG 흐름 제어

- 흐름 상태(확인을 기다리는 중인지, 대기 중인 최신 한 장)는 `streamManager.ts`의 `Entry`에 둔다. 관리자
  클로저에 두면 옛 entry의 늦은 확인이 새 entry에 닿는다.
  - 기다리는 중이 아니면 프레임을 보내고 기다림을 세운다.
  - 기다리는 중이면 대기 칸을 새 프레임으로 덮어쓴다(앞의 것은 버린다).
  - `frame_ack`가 오면 대기 장이 있을 때 그것을 보내고, 없으면 기다림을 내린다. 기다리는 중이 아닐 때 온
    확인은 무시한다 — **확인은 멱등이다.**
- 포트는 `open()`마다 하나이고 재연결(`recover`)은 같은 포트에 새 세션을 붙인다. 그래서 새 `session` 메시지를
  보낼 때와 `recover` 때 흐름 상태를 비운다. 닫힌 entry의 대기 장은 보내지 않는다.
- `frame_ack`는 `ControlIntent`가 아니다. 세션의 `sendControl`로 새지 않는다.
- renderer는 프레임이 **온 그 포트로** 확인을 보낸다. 프레임을 그렸을 때, 최신 한 장 규칙으로 버렸을 때,
  디코드나 그리기에 실패했을 때 각각 한 번이다. 닫힌 뒤에는 보내지 않는다. 연속 실패로 포기한 것도
  닫힘이다 — 포기한 장과 그때 버린 장에는 보내지 않는다.
- **재동기**: `jpeg` 세션이 `streaming`인데 `FRAME_RESYNC_MS` 동안 `frame`이 없으면 renderer가 확인을 한 번
  더 보낸다. 확인 하나를 빠뜨리는 버그가 영영 멈춘 화면이 되지 않게 하는 방어다. renderer가 멈춰 있으면
  이 확인도 나가지 않는다. 첫 프레임은 `streaming` 상태보다 먼저 오므로, 재동기 타이머는 상태가 아니라
  JPEG 경로의 수명에 묶는다.
- main이 드는 대기 장은 entry마다 한 장이다. 전송 중인 장은 보통 한 장이고, `session`을 다시 보낸 뒤·
  재연결 뒤·재동기 확인이 기다리는 중에 닿은 뒤에는 한 장 더 날 수 있다. renderer의 최신 한 장 칸이 그것을
  흡수하므로 그 칸은 방어가 아니라 필요한 구조다.
- 이 변경은 메시지 전달부에 있다. 재연결·포트·세션 수명 로직은 바꾸지 않는다. h264 `packet`은 이 규칙을
  타지 않는다.

### 기기 카드

`DevicePanel.tsx`의 `.device-row` 안에서 플랫폼 배지와 `(대상)` 배지가 `app.css`의 같은 grid 칸에 놓여
포개진다. 배지들을 한 묶음(`.device-badges`)으로 싸서 한 칸에 나란히 놓고, 이름과 serial은 넘치면 말줄임으로
자르며, 동작 버튼은 줄어들지 않게 한다.

## 실패 처리

| 상황 | 결과 |
|---|---|
| 한 칸의 스트림이 죽는다 | 그 칸만 지금처럼 재연결하고, 실패하면 스크린샷으로 강등한다. 다른 칸의 세션 상태에는 닿지 않는다 |
| 한 화면 컴포넌트가 렌더 중 던진다 | 그 화면의 boundary가 `이 화면을 그리지 못했다`와 다시 시도 버튼을 보인다. 다른 화면과 오른쪽 패널은 산다 |
| 낡은 세대의 `startStream`·`stopStream` | 성공으로 끝내고 아무것도 하지 않는다 |
| 칸을 바꾸는 도중 옛 포트가 늦게 온다 | 라우터에 맞는 구독자가 없어 라우터가 닫는다 |
| renderer가 멈춘다(중단점, 무거운 렌더) | 확인이 오지 않아 main은 entry마다 최신 한 장만 든다. 다시 돌면 그 장부터 이어진다 |
| 확인이 하나 빠진다 | renderer의 재동기 확인으로 다시 흐른다 |
| 보이던 기기가 끊긴다 | 칸이 곧바로 승계되거나 빈다. 세션 닫기는 그 뒤에 끝난다 |
| 두 기기 연결, 대상 없음 | `serial` 없는 MCP 호출은 `ambiguous_device`. 화면 영역에 안내 한 줄 |

격리의 범위: 칸끼리 **상태**를 공유하지 않는다는 뜻이다. renderer 스레드와 main 이벤트 루프는 함께 쓰므로
한 칸의 부하는 다른 칸의 속도에 영향을 줄 수 있다. 창을 가렸을 때 확인이 멈추는지는 재 봐야 안다
(`jpegRenderer`는 그리기를 화면 갱신에 맞추지 않는다).

## 테스트

- **`screenSlots.test.ts`** — 빈 칸 채우기 / 찬 칸은 그대로 / `select`가 같은 칸의 이전 세션을 닫는다 /
  이미 보이는 기기의 `select`는 세대를 올리지 않는다 / 끊김 시 연결 순서대로 승계 / 같은 serial이 다시
  붙으면 새 세대 / 닫기가 끝나지 않아도 `onChange`가 먼저 나간다 / 낡은 세대의 `open`·`stop`은 관리자를
  건드리지 않는다 / 진행 중인 `open` 도중의 `select` / 한 칸의 `open` 실패가 다른 칸의 관리자에 닿지
  않는다 / `closeAll`은 한 칸이 던져도 계속한다 / 변화가 없으면 `onChange`를 내지 않는다 / `place`가 null을
  준 기기는 어느 칸에도 가지 않는다 / `slotIds`가 상한을 넘으면 던진다 / `tagPort`가 지금 세대를 붙이고,
  칸의 기기가 다르면 null을 준다.
- **`streamManager.test.ts`** — 확인 전에 온 프레임 중 첫 장과 마지막 장만 포트로 간다 / 확인 뒤 대기 장이
  간다 / 기다리지 않을 때의 확인은 무시 / 새 `session`과 `recover` 뒤 흐름 상태가 비워진다 / 옛 entry
  포트의 확인이 새 entry에 닿지 않는다 / 닫힌 entry의 대기 장은 가지 않는다 / `frame_ack`가 `sendControl`로
  새지 않는다 / h264 `packet`은 흐름 제어를 타지 않는다 / 관리자가 내놓는 꼬리표는 `serial`과 `sessionId`뿐이다.
- **`bootstrap.test.ts`·`ipcBridge.test.ts`** — 처음부터 붙어 있던 기기가 칸에 들어간다 / `selectDevice`와
  `device_select`가 대상과 칸을 함께 바꾼다 / 대상 기기 끊김 → 대상 비움 + 칸 승계 / 스냅샷에 `screens`가
  실린다 / 플랫폼이 없는 조립의 `screens: []` / `startStream`·`stopStream`의 인자 검증.
- **`streamPort.test.ts`** — 구독자 둘이 있을 때 한 칸의 포트가 다른 구독자에게 가지 않고 닫히지도 않는다 /
  받을 곳 없는 포트만 닫힌다 / 꼬리표의 새 필드가 그대로 전달된다.
- **renderer** — `screens`의 개수만큼 화면이 그려진다(임의 칸 id) / 세대가 바뀌면 화면이 다시 마운트된다 /
  화면이 없을 때의 빈 상태 / "대상으로"가 `selectDevice`를 부르고 대상이면 꺼진다 / 화면이 있고 대상이
  없으면 안내가 보인다 / 캔버스를 클릭·타이핑해도 `selectDevice`가 불리지 않는다 / 훅 둘이 라우터 하나에
  붙어 각자의 포트로 `streaming`에 이르고 서로의 포트를 닫지 않는다 / 한 화면이 던져도 다른 화면이 남는다 / 두 화면의 접근성 이름이 다르다 / `F6`이
  다음 캔버스로 포커스를 옮긴다 / 툴바 버튼을 누른 뒤 포커스가 캔버스로 돌아온다 / 확인이 프레임이 온
  포트로 간다 / `close()` 뒤에는 확인이 없다 / 프레임 없이 `FRAME_RESYNC_MS`가 지나면 확인을 한 번 더
  보낸다 / `screens_changed`가 상태에 반영된다 / 기기 카드에서 배지 둘이 한 묶음 안에 있다.
- **에뮬레이터·시뮬레이터에서** — Android 에뮬레이터와 iOS 시뮬레이터를 함께 띄워 두 스트림이 동시에 도는지,
  각 fps, 확인 왕복이 fps에 주는 영향, 한쪽을 껐을 때 다른 쪽이 유지되는지, 창을 가렸을 때 확인이 멈추는지,
  renderer를 멈췄다 풀었을 때 지연이 쌓이지 않는지 본다. 앱 창을 봐야 하는 항목과 Windows 호스트의 회귀는
  사람이 확인한다.

## 파일 구성

- 만든다
  - `src/main/stream/screenSlots.ts` — 칸 조정자.
  - `src/renderer/src/components/ScreenHeader.tsx` — 화면 머리.
  - `src/renderer/src/components/ScreenBoundary.tsx` — 화면별 error boundary.
- 고친다
  - `src/main/stream/streamManager.ts` — `frame_ack`와 프레임 전달부. 조정자가 `stop()`을 쓰므로 부르는 곳이
    없어지는 `handleDisconnect`를 지운다.
  - `src/main/app/bootstrap.ts`(배정 클로저, 관리자 조립, `assembleWithoutPlatforms`), `appState.ts`(`screens`를
    늦게 잇는 자리), `ipcBridge.ts`, `src/main/index.ts`.
  - `src/shared/types/ipc.ts`, `src/shared/types/stream.ts`, `src/shared/limits.ts`, `src/preload/index.ts`.
  - `src/renderer/src/stream/streamPort.ts`(라우터), `jpegRenderer.ts`, `hooks/useScrcpyStream.ts`,
    `state/useAppState.ts`, `App.tsx`, `components/DeviceScreen.tsx`, `DevicePanel.tsx`, `app.css`.
  - `docs/architecture/main-layers.md` — 화면 칸 층.

## 계획

세 계획으로 나눈다. 앞의 둘은 화면 하나에서 검증되고 서로 기대지 않는다.

1. **기기 카드 배지** — 독립된 작은 수정.
2. **JPEG 흐름 제어** — ADR-0018. 화면 하나에서 검증한다. 확인 왕복이 fps에 주는 영향을 먼저 잰다.
3. **화면 칸** — ADR-0017. main(조정자·스냅샷·IPC)부터 renderer(라우터·여러 화면·머리·boundary) 순이다.
   실제 앱에서 훅 둘의 포트 라우팅과 두 스트림의 동시 부하를 먼저 확인한다.

## 열린 질문

- h264 경로의 흐름 제어. renderer가 멈추면 `packet`은 여전히 포트에 쌓인다. 흐름 상태를 `Entry`에 둔 것은
  codec별로 규칙을 붙일 자리를 남긴 것이다.
- 화면이 둘일 때의 실제 부하는 잰 뒤 `MAX_SCREEN_SLOTS`를 다시 본다.
- 가려진 칸의 스트림을 멈출지. 창을 가렸을 때 확인이 멈추는지부터 잰다.
