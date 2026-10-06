---
id: m5-multi-screen
title: M5 — 여러 기기 화면 동시 보기
status: draft
verified: 2026-10-06
scope: [main, renderer, preload, shared, streaming, android, ios]
hosts: []
supersedes:
superseded_by:
related_adr: [ADR-0017, ADR-0018, ADR-0015, ADR-0016, ADR-0010]
related_spec: m4-ios-simulator
related_architecture: main-layers
related_plan:
related_code: [streamManager.ts#createStreamManager, bootstrap.ts#bootstrapApp, registry.ts#createDeviceRegistry, ipc.ts#AppSnapshot, stream.ts#StreamUp, stream.ts#StreamPortMeta, useAppState.ts#targetSerial, App.tsx, DeviceScreen.tsx#DeviceScreen, useScrcpyStream.ts#useScrcpyStream, jpegRenderer.ts#createJpegRenderer, DevicePanel.tsx#DevicePanel]
tags: [spec, streaming, multi-screen]
---

# Spec: M5 — 여러 기기 화면 동시 보기

> 상태·날짜·관련 문서는 위 frontmatter가 단일 출처. 본문은 설계 내용에 집중한다.

## 목표

Android 기기 한 대와 iOS 기기 한 대의 화면을 앱 창에 나란히 실시간으로 보이고, 둘 다 마우스·키보드로
조작한다. 같은 앱을 두 플랫폼에서 나란히 놓고 비교하려는 것이다.

설계 기준은 구현의 쉬움이 아니라 **확장성과 안정성**이다. 칸 수와 배정 규칙을 나중에 바꿀 때 세션 기계와
renderer를 고치지 않아야 하고, 한 화면의 실패가 다른 화면으로 번지지 않아야 한다.

## 범위

- 포함
  - 화면 칸(screen slot) 모델: 칸마다 스트림 세션 관리자 하나.
  - 칸 배정 규칙: 플랫폼당 한 칸.
  - 화면 표시와 MCP 대상의 분리.
  - JPEG 프레임 흐름 제어(renderer 확인 뒤 다음 장).
  - 화면별 실패 격리(renderer error boundary, 칸 꼬리표가 붙은 포트).
  - 기기 카드의 배지 겹침 수정.
- 제외
  - 같은 플랫폼 기기 둘을 동시에 보기. 배정 규칙만 바꾸면 되게 만들되 이번에는 만들지 않는다.
  - 한 번의 조작을 두 기기에 함께 보내기(미러 입력).
  - MCP 툴에 호출마다 `serial`을 주는 인자. `registry.ts`의 `resolve(serial?)`가 이미 받으므로 나중에 더할 수 있다.
  - h264 경로의 흐름 제어. 중간 프레임을 버릴 수 없어 같은 방식이 맞지 않는다.

## 지금 구조

- `streamManager.ts`의 `createStreamManager`는 세션 하나(`current`)만 든다. `open(serial)`은 이전 세션을 닫는다.
- renderer `App.tsx`는 `targetSerial(snapshot)` 하나로 `DeviceScreen` 하나를 그린다. `DeviceScreen`의
  `useScrcpyStream`이 `startStream(serial)`을 부르고, 포트는 `StreamPortMeta`의 `serial`로 가려 받는다.
- `AppSnapshot.activeSerial`은 사람이나 MCP `device_select`가 명시적으로 고른 기기다. `targetSerial`은
  이 값이 없고 연결된 기기가 하나뿐이면 그 기기를 대상으로 본다.

즉 "화면에 보이는 기기"가 "MCP 대상"에서 파생된다. 이 파생을 끊는 것이 이 스펙의 중심이다.

## 인터페이스

### 세 가지를 따로 둔다

| 것 | 책임 | 위치 |
|---|---|---|
| 세션 기계 | 칸 하나의 스트림 수명(열기·재연결·포트·닫기) | `streamManager.ts` — 그대로 두고 칸마다 인스턴스 하나 |
| 배정 규칙 | 어느 기기가 어느 칸에 가는가 | 새 `screenSlots.ts`가 받는 함수 하나 |
| MCP 대상 | 툴 호출이 가는 기기 | `registry.ts` — 그대로 |

### 화면 칸 조정자 (`src/main/stream/screenSlots.ts`)

```ts
/** 칸 id는 불투명한 문자열이다. renderer와 세션 기계는 그 뜻을 읽지 않는다. */
export interface SlotSpec { id: string; label: string }

/** 기기가 갈 칸의 id. 갈 칸이 없으면 null. 플랫폼을 보는 유일한 곳은 이 함수의 구현이다. */
export type SlotPolicy = (device: { serial: string; platform: Platform }) => string | null

export interface ScreenSlotsDeps {
  slots: SlotSpec[]                       // 순서가 곧 화면 순서
  policy: SlotPolicy
  createManager(slotId: string): StreamManager
  platformOf(serial: string): Platform | null
  onChange(screens: ScreenSlot[]): void
}

export interface ScreenSlots {
  /** 기기를 제 칸에 보인다. 같은 칸의 이전 기기는 내려간다. 스트림은 열지 않는다. */
  show(serial: string): void
  /** 연결·끊김을 알린다. 빈 칸은 채우고, 보이던 기기가 끊기면 같은 칸의 다른 기기로 넘긴다. */
  handleConnect(serial: string): void
  handleDisconnect(serial: string): Promise<void>
  /** serial이 지금 칸에 보이는 기기일 때만 그 칸의 관리자로 연다. 아니면 거절한다. */
  open(serial: string): Promise<void>
  stop(serial: string): Promise<void>
  screens(): ScreenSlot[]
  closeAll(): Promise<void>
}
```

- `MAX_SCREEN_SLOTS = 2`를 상수로 둔다. `slots` 길이가 이를 넘으면 조립에서 던진다. 칸을 늘릴 때는 이 값과
  부하 측정을 함께 본다.
- 지금의 배정 규칙은 `platformSlotPolicy`: `android` → `'android'` 칸, `ios` → `'ios'` 칸. 칸 라벨은
  `Android`, `iOS`. 이 함수와 조립 지점 밖에서는 칸 id를 플랫폼으로 해석하지 않는다.

### 스냅샷과 이벤트 (`src/shared/types/ipc.ts`)

```ts
export interface ScreenSlot {
  id: string
  /** 사람이 읽는 칸 이름. main이 정한다. renderer는 이 값으로 동작을 나누지 않는다. */
  label: string
  /** 이 칸에 보이는 기기. 없으면 null. */
  serial: string | null
}

export interface AppSnapshot {
  // … 기존 필드
  activeSerial: string | null   // 뜻 그대로: 명시적으로 고른 MCP 대상
  screens: ScreenSlot[]         // 새 필드. 순서는 main이 정한다
}

export type MainEvent =
  // … 기존
  | { type: 'screens_changed'; screens: ScreenSlot[] }
```

`activeSerial`은 이름과 뜻을 바꾸지 않는다. 원래부터 "명시적으로 고른 MCP 대상"이었고, 바뀌는 것은
화면이 더 이상 이 값에서 파생되지 않는다는 점뿐이다. renderer의 `targetSerial(snapshot)`도 그대로
MCP 대상을 뜻하며 활동·로그 탭과 대상 표시에만 쓴다.

### IPC (`src/preload/index.ts`)

- `startStream(serial)` — 그대로. main은 `screenSlots.open(serial)`로 넘긴다.
- `stopStream(serial)` — `serial` 인자를 더한다. 지금은 인자가 없어 "하나뿐인 세션"을 닫는다.
- `selectDevice(serial)` — 그대로. 대상으로 삼고 제 칸에 보인다.
- `setTarget(serial)` — 새로 더한다. 칸은 건드리지 않고 대상만 바꾼다.

### 포트 꼬리표와 흐름 제어 (`src/shared/types/stream.ts`)

```ts
export interface StreamPortMeta {
  serial: string
  sessionId: string
  slotId: string     // 새 필드
}

/** renderer → main 포트 메시지 */
export type StreamUp = ControlIntent | { type: 'frame_ack' }
```

- renderer는 `slotId`와 `serial`이 모두 제 화면과 같을 때만 포트를 쓴다.
- `frame_ack`는 `jpeg` 세션에서만 쓴다. renderer는 `frame` 한 장을 그렸거나 버렸거나 디코드에 실패했을 때
  한 번 보낸다. 규칙은 [ADR-0018](../../adr/0018-jpeg-frame-ack-flow-control.md)에 있다.

## 동작 / 상태

### 칸 배정

- 기기가 연결되면 `policy`로 칸을 구한다. 그 칸이 비어 있으면 채운다. 차 있으면 그대로 둔다.
- 사람이 기기 카드를 누르거나 MCP `device_select`가 오면 그 기기를 제 칸에 보인다(`show`). 같은 칸의 이전
  기기는 내려가고 그 스트림 세션은 닫힌다.
- 보이던 기기가 끊기면 그 칸의 세션을 닫고, 같은 칸에 갈 수 있는 다른 연결 기기 중 먼저 연결된 것으로
  채운다. 없으면 칸을 비운다.
- 칸이 바뀔 때마다 `screens_changed`를 낸다.

### MCP 대상

| 조작 | 칸 | 대상(`activeSerial`) |
|---|---|---|
| 기기 카드 클릭 (`selectDevice`) | 그 기기를 제 칸에 보인다 | 그 기기 |
| 화면 머리의 "대상으로" (`setTarget`) | 그대로 | 그 기기 |
| MCP `device_select` | 그 기기를 제 칸에 보인다 | 그 기기 |
| 화면을 클릭·타이핑 | 그대로 | **바뀌지 않는다** |

- 두 기기가 연결돼 있고 아무도 고르지 않았으면 대상이 없다. MCP 툴은 지금처럼 `ambiguous_device`로 끝난다.
  두 화면은 대상 표시 없이 모두 보인다.
- 사람이 화면을 만져도 대상이 바뀌지 않게 한 이유: 에이전트가 일하는 도중 사람이 다른 화면을 누르면
  에이전트의 다음 호출이 엉뚱한 기기로 간다.

### renderer

- `App.tsx`는 `snapshot.screens`를 순서대로 돌며 `serial`이 있는 칸마다 화면 하나를 그린다. 화면이 하나면
  지금 모습이고, 둘이면 나란히 놓는다. renderer는 "둘"을 알지 못한다 — 목록을 그릴 뿐이다.
- 화면 머리(`ScreenHeader`)에 칸 라벨, 기기 serial, 대상 표시, "대상으로" 버튼을 둔다. 이미 대상이면 버튼을
  끈다.
- 화면마다 `useScrcpyStream`이 따로 돈다. 훅은 `slotId`를 받아 포트를 가린다.
- 키보드 입력은 포커스가 있는 캔버스로만 간다. 지금 동작 그대로다.
- 화면이 둘일 때 창이 좁으면 둘 다 줄여서 한 줄에 맞춘다. 세로로 쌓지 않는다. 각 캔버스는 종횡비를 지킨다.
- 오른쪽 활동·로그 탭은 지금처럼 `targetSerial`을 따른다.

### JPEG 흐름 제어

- `streamManager`의 `onFrame` 전달부가 칸마다 "확인을 기다리는 중" 플래그와 "대기 중인 최신 한 장"을 든다.
  - 기다리는 중이 아니면 프레임을 보내고 플래그를 세운다.
  - 기다리는 중이면 대기 칸을 새 프레임으로 덮어쓴다(앞의 것은 버린다).
  - `frame_ack`가 오면 대기 중인 장이 있을 때 그것을 보내고, 없으면 플래그를 내린다.
- main에 쌓이는 것은 칸마다 최대 한 장이다. renderer가 멈춰도 포트 큐가 자라지 않는다.
- 새 `session` 메시지를 보낼 때와 포트가 바뀔 때 플래그와 대기 칸을 비운다.
- 이 변경은 메시지 전달부에만 있다. 재연결·포트·세션 수명 로직은 바꾸지 않는다.

### 기기 카드

`DevicePanel.tsx`의 `.device-row` 안에서 플랫폼 배지와 `(대상)` 배지가 `app.css`의 같은 grid 칸에 놓여
포개진다. 배지들을 한 묶음(`.device-badges`)으로 싸서 한 칸에 나란히 놓고, 이름과 serial은 넘치면 말줄임으로
자르며, 동작 버튼은 줄어들지 않게 한다. 대상 배지 옆에 "화면에 보이는 중" 배지는 더하지 않는다 — 화면 머리가
이미 말한다.

## 실패 처리

| 상황 | 결과 |
|---|---|
| 한 칸의 스트림이 죽는다 | 그 칸만 지금처럼 재연결하고, 실패하면 스크린샷으로 강등한다. 다른 칸은 영향이 없다 |
| 한 화면 컴포넌트가 렌더 중 던진다 | 그 화면의 error boundary가 "이 화면을 그리지 못했다"와 다시 시도 버튼을 보인다. 다른 화면과 오른쪽 패널은 산다 |
| 칸에 보이지 않는 serial로 `startStream`이 온다 | `command_failed`로 거절한다. hint는 "기기를 먼저 골라라". 칸 수 상한을 우회할 수 없다 |
| 칸을 바꾸는 도중 옛 포트가 늦게 온다 | `slotId`·`serial`이 맞지 않아 renderer가 버린다 |
| renderer가 멈춘다(중단점, 가려진 창) | `frame_ack`가 오지 않아 main은 칸마다 최신 한 장만 든다. 다시 돌면 그 한 장부터 이어진다 |
| 보이던 기기가 끊긴다 | 칸이 같은 칸의 다른 기기로 넘어가거나 빈다. 대상이었다면 지금처럼 `registry`가 대상을 비운다 |
| 두 기기 연결, 대상 없음 | MCP 툴은 `ambiguous_device`. 에이전트 가이드의 안내는 그대로 유효하다 |

## 테스트

- **`screenSlots.test.ts`** — 빈 칸 채우기 / 찬 칸은 그대로 / `show`가 같은 칸의 이전 세션을 닫는다 /
  끊김 시 같은 칸의 다른 기기로 넘어간다 / 칸에 없는 serial의 `open`은 거절 / 한 칸의 `open` 실패가 다른
  칸의 관리자를 건드리지 않는다 / `slots`가 상한을 넘으면 던진다 / `policy`가 null을 주는 기기는 어느 칸에도
  가지 않는다.
- **`streamManager.test.ts`** — 확인 전에 온 프레임 셋 중 첫 장과 마지막 장만 포트로 간다 / `frame_ack` 뒤
  대기 장이 간다 / 새 `session` 뒤 플래그가 비워진다 / h264 `packet`은 흐름 제어를 타지 않는다.
- **`bootstrap.test.ts`** — `selectDevice`는 대상과 칸을 함께, `setTarget`은 대상만 바꾼다 / 스냅샷에
  `screens`가 실린다 / `device_select`가 칸을 바꾼다.
- **renderer** — `screens` 개수만큼 화면이 그려진다 / "대상으로" 버튼이 `setTarget`을 부르고 대상이면 꺼진다 /
  한 화면이 던져도 다른 화면이 남는다 / 훅이 다른 `slotId`의 포트를 버린다 / `jpegRenderer`가 그린 뒤·버린
  뒤·실패한 뒤 각각 `frame_ack`를 한 번 보낸다 / 기기 카드에서 배지 둘이 같은 묶음 안에 있다.
- **실기기** — Android 에뮬레이터와 iOS 시뮬레이터를 함께 띄워 두 스트림이 동시에 도는지, 각 fps, 한쪽을
  껐을 때 다른 쪽이 유지되는지, renderer를 멈췄다 풀었을 때 지연이 쌓이지 않는지 본다. 앱 창을 봐야 하는
  항목은 사람이 확인한다.

## 파일 구성

- 만든다
  - `src/main/stream/screenSlots.ts` — 칸 조정자와 `platformSlotPolicy`.
  - `src/renderer/src/components/ScreenHeader.tsx` — 화면 머리.
  - `src/renderer/src/components/ScreenBoundary.tsx` — 화면별 error boundary.
- 고친다
  - `src/main/stream/streamManager.ts` — `frame_ack` 처리와 프레임 전달부.
  - `src/main/app/bootstrap.ts`, `src/main/index.ts` — 관리자를 칸마다 만들고 조정자를 잇는다.
  - `src/shared/types/ipc.ts`, `src/shared/types/stream.ts`, `src/preload/index.ts` — 위 인터페이스.
  - `src/renderer/src/App.tsx`, `DeviceScreen.tsx`, `useScrcpyStream.ts`, `jpegRenderer.ts`, `useAppState.ts`,
    `DevicePanel.tsx`, `app.css`.
  - `docs/architecture/main-layers.md` — 화면 칸 층.

## 열린 질문

- h264 경로의 흐름 제어. renderer가 멈추면 `packet`은 여전히 포트에 쌓인다. 키프레임 요청과 함께 풀어야
  하므로 이번 범위에서 뺐다.
- 화면이 둘일 때의 실제 부하(scrcpy 디코드 + JPEG 15fps)는 실기기에서 잰 뒤 `MAX_SCREEN_SLOTS`를 다시 본다.
- 가려진 칸의 스트림을 멈출지. 지금은 창이 가려져도 세션을 유지한다(`frame_ack`가 전송량은 막는다).
