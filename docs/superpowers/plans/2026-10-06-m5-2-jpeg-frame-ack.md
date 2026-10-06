---
id: m5-2-jpeg-frame-ack
title: M5-2 — JPEG 프레임 흐름 제어
status: draft
type: work-order
created: 2026-10-06
updated: 2026-10-06
owner: virtual-device-helper 팀
scope: [main, renderer, shared, streaming]
hosts: [macos]
archived_reason:
related_adr: [ADR-0018, ADR-0016, ADR-0010]
related_spec: m5-multi-screen
related_architecture: main-layers
related_plan: [m5-1-device-card-badges, m5-3-screen-slots]
related_code: [stream.ts#StreamUp, streamManager.ts#createStreamManager, streamManager.ts#toControlIntent, jpegRenderer.ts#createJpegRenderer, useScrcpyStream.ts#useScrcpyStream]
tags: [plan, streaming, flow-control]
---

# M5-2 — JPEG 프레임 흐름 제어 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: `superpowers:subagent-driven-development`(권장) 또는
> `superpowers:executing-plans`로 task 단위 구현. 각 단계는 체크박스(`- [ ]`)로 추적한다.

**Goal:** renderer가 멈춰도 `jpeg` 스트림의 프레임이 main과 포트에 쌓이지 않는다.

**Architecture:** renderer가 프레임 한 장의 처리를 끝낼 때마다 `frame_ack`를 그 프레임이 온 포트로 보낸다.
`streamManager`는 확인을 기다리는 동안 온 프레임 중 최신 한 장만 들고, 확인이 오면 보낸다. 흐름 상태는 `Entry`에
둔다. 확인은 멱등이고, renderer는 프레임이 한동안 없으면 확인을 한 번 더 보낸다(재동기).

renderer를 먼저 한다. 지금 main은 모르는 포트 메시지를 `toControlIntent`의 null로 조용히 버리므로, renderer가 확인을
먼저 보내기 시작해도 해가 없다. 그래서 모든 커밋에서 앱이 동작한다.

**Tech Stack:** TypeScript, Electron MessagePort, React, Vitest

**Spec:** [`../specs/2026-10-06-m5-multi-screen.md`](../specs/2026-10-06-m5-multi-screen.md) — "JPEG 흐름 제어" 절.
결정 근거는 [ADR-0018](../../adr/0018-jpeg-frame-ack-flow-control.md).

**선행 조건:** 없다. 화면 하나에서 검증한다. [M5-3](2026-10-06-m5-3-screen-slots.md)보다 먼저 한다.

## Global Constraints

- 답변·주석·문서는 한국어로 쓴다. 기술 용어·API 이름·명령어·에러 문자열은 원문 그대로 둔다.
- 새 npm 의존성을 들이지 않는다.
- 각 task 끝에서 `npm test`와 `npm run typecheck`가 통과해야 한다. 테스트 파일도 typecheck 대상이다. 테스트 출력에 경고가 없어야 한다.
- `StreamUp`은 `ControlIntent | { type: 'frame_ack' }`다.
- `streamManager`의 재연결·포트·세션 수명 로직은 바꾸지 않는다. 바뀌는 것은 메시지 전달부와 `Entry`의 필드다.
  `recover`와 `closeEntry`에 흐름 상태를 비우는 줄이 하나씩 들어가는 것은 예외다.
- `frame_ack`는 세션의 `sendControl`로 넘기지 않는다. h264 `packet`은 흐름 제어를 타지 않는다.
- `FRAME_RESYNC_MS = 2000`. renderer의 상수 하나로 둔다.
- 확인 규칙: **닫히지 않은 동안** `push`로 받은 장마다 정확히 한 번. 닫힌 뒤에는 보내지 않는다. 연속 실패로 포기한 것도 닫힘이다.
- 실제 기기 확인은 macOS 호스트에서만 한다. Simulator.app을 띄우지 않고 호스트 클립보드를 건드리지 않는다. 자신이 부팅한
  시뮬레이터만 끈다.
- 문서에는 라인번호, 파일·툴 개수, 진행률을 적지 않는다. 문서를 고치면 `docs.py lint`와 `docs.py links`를 돌린다.
- 커밋 메시지는 한국어 Conventional Commits이고, 끝에 다음 줄을 붙인다:
  `Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>`

## Review Focus

- **확인 누락**: renderer의 어느 출구에서든 확인이 빠지면 화면이 멈춘다. 닫히기 전에 받은 장은 그렸든, 디코드에 실패했든,
  그리기에 실패했든, 더 새 장에 덮였든 정확히 한 번 확인한다. → Task 1 테스트.
- **재연결 뒤의 옛 확인**: 재연결은 같은 포트에 새 세션을 붙인다. 재연결을 기다리는 동안이나 그 뒤에 옛 확인이 와도 죽은
  세션의 프레임이 나가지 않고 새 세션이 멈추지 않는다. → Task 2 테스트.
- **멈춘 renderer**: 확인이 오지 않는 동안 프레임이 얼마나 오든 main이 드는 대기 장은 한 장이다. → Task 2 테스트.
- **첫 장의 확인이 빠진 경우**: 첫 프레임은 `streaming` 상태보다 먼저 온다. 그때 확인이 빠져도 재동기가 걸려 있다. → Task 1 테스트.
- **h264 세션 회귀(지금은 Android 타깃)**: 동작이 그대로이고, 잘못 온 `frame_ack`는 무시된다. → Task 2 테스트.

---

### Task 1: renderer — 확인 보내기와 재동기

**Files:**
- Modify: `src/shared/types/stream.ts`, `src/renderer/src/stream/jpegRenderer.ts`, `src/renderer/src/hooks/useScrcpyStream.ts`
- Test: `src/renderer/src/stream/jpegRenderer.test.ts`, `src/renderer/src/hooks/useScrcpyStream.test.tsx`

**Interfaces:**
- Produces (`stream.ts`): `export type StreamUp = ControlIntent | { type: 'frame_ack' }`.
- Produces (`jpegRenderer.ts`): `JpegRendererDeps`에 `ack(): void`를 더한다 — 프레임 한 장의 처리가 끝났다.
  - `run`의 루프 한 바퀴가 끝날 때(그림, decode 실패, draw 실패) `closed`가 아니면 `ack()`를 한 번 부른다. decode/draw를 감싼
    `try` **밖에서** 부른다(`ack`가 던져도 프레임 실패로 세지 않는다).
  - `push`가 대기 중인 `latest`를 덮을 때, 덮이는 장에 대해 그 `push` 안에서 `ack()`를 한 번 부른다.
  - `closed`가 선 뒤에는 부르지 않는다: 바깥 `close()` 뒤에 끝난 decode(성공이든 실패든), `close()`가 버린 `latest`, 닫힌 뒤의
    `push`, 그리고 `MAX_CONSECUTIVE_FAILURES`로 포기한 그 장과 그때 버린 `latest`.
  - `latest` 한 칸은 그대로 둔다. 흐름 제어 아래에서도 `session`이 다시 온 뒤·재연결 뒤·재동기 확인 뒤에는 renderer에 두 장이
    있을 수 있다.
  - 이 인자가 필수가 되므로 `jpegRenderer.test.ts`의 모든 `createJpegRenderer` 호출과 `useScrcpyStream.test.tsx` harness의 가짜
    `createJpegRenderer`(받은 `ack`를 잡아 두게)를 함께 고친다.
- `useScrcpyStream`:
  - JPEG 경로를 만드는 함수가 그 포트를 인자로 받는다(`jpegPath(owner: MessagePort)`). 호출부 둘(codec을 정하는 곳과 `frame`
    분기)이 지금 포트를 넘긴다.
  - `ack`는 `if (!active || port !== owner) return` 뒤에 `owner.postMessage({ type: 'frame_ack' } satisfies StreamUp)`다.
    `portRef.current`를 읽지 않는다.
  - `export const FRAME_RESYNC_MS = 2000`. 재동기 타이머는 **JPEG 경로 객체가 소유한다**: 경로를 만들 때 걸고, `push` 때 다시
    걸고, 경로의 `close` 때 지운다. 만료 콜백은 effect 지역 변수 `streaming`(`status` 메시지 분기에서 갱신; React state를 읽지
    않는다)이 true일 때만 위 `ack`와 같은 길로 확인을 보내고, 항상 타이머를 다시 건다.
  - `ScrcpyStreamDeps`에 `setTimer?: typeof setTimeout`, `clearTimer?: typeof clearTimeout`(둘 다 optional, 기본은 전역).
  - 새 hook 테스트는 harness의 `deliverPort`·`deliver`만 거쳐 쓴다(M5-3이 포트 수신부를 바꿀 때 harness 한 곳만 고치게).
    가짜 `setTimer`는 콜백을 잡아 두고 테스트가 `act` 안에서 부른다.

- [x] **Step 1: 실패하는 테스트를 쓴다**
  - `jpegRenderer`: 한 장을 그리면 `ack` 한 번 / 느린 `decode` 중 셋을 push하면 `ack`가 모두 세 번이고 `draw`는 두 번, 둘째 장의
    `ack`는 셋째 `push` 호출 안에서 동기로 나간다 / `decode`가 reject하면 그 장에 `ack` 한 번이고 `draw`는 없다 / `draw`가
    던져도 `ack` 한 번 / `ack`가 던져도 실패 횟수가 늘지 않는다(그 뒤 연속 실패 한도까지의 장 수가 그대로다) / 연속 실패 한도에
    닿은 장과 그 뒤의 `push`에는 `ack`가 없고 `onError`는 한 번 / `close()` 뒤에 resolve된 decode와 reject된 decode 모두 `ack`가
    없다 / `close()`가 버린 `latest`에 `ack`가 없다.
  - `useScrcpyStream`: `jpeg` 세션에서 가짜 renderer가 잡아 둔 `ack`를 부르면 그 포트의 `postMessage`가 `{ type: 'frame_ack' }`로
    불린다 / 포트 A의 경로가 잡아 둔 `ack`를 포트 B로 바뀐 뒤에 부르면 A에도 B에도 가지 않는다 / `session`(jpeg) 뒤 `frame`이
    `streaming`보다 먼저 온 다음 `streaming`이 되고 프레임 없이 `FRAME_RESYNC_MS`가 지나면 확인이 한 번 간다 / `frame`이 오면 그
    타이머가 다시 걸린다 / `reconnecting`이나 `failed` 중에 만료되면 확인이 가지 않고, 다시 `streaming`이 된 뒤의 만료에는 간다 /
    h264 세션에서는 타이머를 걸지 않고 `frame_ack`도 보내지 않는다 / jpeg→h264 전환, 포트 교체, 언마운트 뒤 타이머가 지워진다 /
    포트 교체 뒤 옛 타이머가 새 포트로 보내지 않는다.
- [x] **Step 2: 실패를 확인한다** — Run: `npx vitest run src/renderer/src/stream/jpegRenderer.test.ts src/renderer/src/hooks/useScrcpyStream.test.tsx` / Expected: FAIL.
- [x] **Step 3: 구현한다.**
- [x] **Step 4: 통과를 확인한다** — Run: `npm test && npm run typecheck` / Expected: PASS.
- [x] **Step 5: 커밋** — `git commit -m "feat(renderer): JPEG 프레임마다 확인을 보내고 프레임이 끊기면 한 번 더 보낸다"`

---

### Task 2: main — `Entry`의 흐름 상태와 `frame_ack`

**Files:**
- Modify: `src/main/stream/streamManager.ts`
- Test: `src/main/stream/streamManager.test.ts`

**Interfaces:**
- Consumes: `StreamUp`의 `frame_ack` (Task 1).
- Produces: `export function isFrameAck(value: unknown): boolean` — `toControlIntent` 옆에 둔다. 객체이고 `type === 'frame_ack'`일 때만
  true(다른 필드가 더 있어도 true).
- `Entry`에 `awaitingAck: boolean`과 `pendingFrame: Uint8Array | null`을 더한다.
- `handlersFor(entry).onFrame(data)`: 먼저 `if (current !== entry) return`. `awaitingAck`가 false면 `{ type: 'frame', data }`를 보내고
  true로 세운다. true면 `pendingFrame = data`.
- 포트 `message` 핸들러: `isFrameAck`이면 — `current !== entry`면 무시 / `awaitingAck`가 false면 무시 / `pendingFrame`이 있으면 그것을
  보내고 비운다(`awaitingAck`는 true 유지) / 없으면 `awaitingAck = false`. 그 밖의 메시지는 지금처럼 `toControlIntent`로 간다.
- 흐름 상태를 비우는(`awaitingAck = false; pendingFrame = null`) 자리 셋:
  - (a) `handlersFor`의 `onSession`에서 `post` 직전.
  - (b) `recover`의 `current !== entry` 가드 바로 뒤, `await ended?.close()` 앞. 재연결을 기다리는 동안의 늦은 확인이 죽은 세션의
    대기 장을 내보내지 않게 한다.
  - (c) `closeEntry`에서 `pendingFrame = null`.
  - (a)와 (b)가 겹쳐 비워도 대입뿐이라 해가 없다. (a)의 대가: 같은 세션이 크기 변화로 `session`을 다시 보내면 전송 중인 장이
    잠깐 둘이 된다.

- [x] **Step 1: 실패하는 테스트를 쓴다** — 가짜 세션이 `onSession` 뒤 `onFrame`을 세 번 부르면 포트에 `frame`이 한 번만 간다(첫 장) /
  그 뒤 포트로 `{ type: 'frame_ack' }`를 올리면 셋째 장이 간다(둘째 장은 가지 않는다) / 한 번 더 올리면 아무것도 가지 않고 다음
  `onFrame`은 바로 간다 / 기다리지 않을 때 올린 확인 뒤의 `onFrame` 두 번은 첫 장만 간다 / 프레임 둘을 올린 상태에서 `onSession`을
  다시 부르면 그 뒤 첫 `onFrame`이 확인 없이 바로 가고, 이어 올린 확인은 옛 대기 장을 보내지 않는다 / 세션이 끝나 재연결을 기다리는
  동안 올린 확인은 옛 대기 장을 보내지 않는다 / 재연결 뒤 새 세션이 `onSession` **없이** 부른 첫 `onFrame`이 바로 간다 / 모든
  재시도가 실패한 뒤의 확인은 아무것도 보내지 않는다 / `open`을 다시 불러 entry가 바뀐 뒤 옛 포트로 올린 확인은 새 포트로 아무것도
  보내지 않는다 / `frame_ack`를 올려도 가짜 세션의 `sendControl`이 불리지 않는다 / `onPacket`만 쓰는 세션에 `frame_ack`를
  올려도 포트와 `sendControl`에 변화가 없다 / `isFrameAck`가 `null`, 문자열, `{ type: 'touch' }`에 false이고
  `{ type: 'frame_ack', extra: 1 }`에 true. 회귀 고정용(구현 전에도 통과한다): `stop()` 뒤에 온 확인은 아무것도 보내지 않는다 /
  `onPacket`은 확인과 무관하게 매번 간다.
- [x] **Step 2: 실패를 확인한다** — Run: `npx vitest run src/main/stream/streamManager.test.ts` / Expected: 회귀 고정용 둘을 뺀 나머지가 FAIL.
- [x] **Step 3: 구현한다.**
- [x] **Step 4: 통과를 확인한다** — Run: `npm test && npm run typecheck` / Expected: PASS.
- [x] **Step 5: 커밋** — `git commit -m "feat(stream): JPEG 프레임을 확인 뒤에 보내고 기다리는 동안 최신 한 장만 든다"`

---

### Task 3: 측정과 문서

**Files:**
- Modify: `src/main/stream/axeStreamSession.ios.integration.test.ts`, `docs/superpowers/specs/2026-10-06-m5-multi-screen.md`,
  `docs/architecture/main-layers.md`, 이 계획 문서

- [x] **Step 1: 통합 테스트에 흐름 제어를 태운다**

같은 파일에 `it`을 더한다. 실제 `createStreamManager`를 조립한다: `createSession`은 실제 `createAxeStreamSession`(control은
`{ send() {}, close() {} }` 스텁)을 만들되 handlers를 감싸 세션이 올린 `onFrame` 수를 세고, 포트는 이 파일에 새로 두는 최소
`PortLike` 가짜다. 단언은 시간 창이 아니라 장 수로 건다: 확인을 올리지 않은 채 세션이 여러 장을 올릴 때까지 기다리면 포트로 간
`frame`은 한 장이다 / 받는 대로 확인을 올리면 포트가 여러 장을 받는다. 기다림은 `sleep`이 아니라 장 수의 promise다. 부팅된
시뮬레이터와 axe가 없으면 skip.

Run: `npm run test:integration -- src/main/stream/axeStreamSession.ios.integration.test.ts` / Expected: PASS(또는 skip).

- [x] **Step 2: 실제 시뮬레이터에서 잰다**

이미 부팅된 시뮬레이터가 있으면 그것을 쓰고 끄지 않는다. 없으면 `xcrun simctl boot`로 하나 부팅하고 끝나면 그것만 끈다. 먼저
Step 1의 통합 테스트가 통과하는지로 `stream-video`가 도는지 확인한다. 같은 조립으로 잰다: 받는 대로 확인을 올릴 때 포트로 가는
fps(M4-3 검증 결과와 비교) / 확인을 멈춘 동안 세션이 올린 장 수 대비 포트로 간 장 수 / 풀었을 때 바로 오는 장이 세션이
가장 나중에 올린 장인지(바이트 비교). 다음은 앱 창이 있어야 하므로 "사람 확인 필요"로 남긴다: 재동기로 다시 흐르는지(타이머는
renderer에 있다), 확인 왕복이 실제 fps에 주는 영향(가짜 포트의 확인은 프로세스 안 호출이다), 창을 가렸을 때 확인이 멈추는지.
Windows 호스트는 단위 테스트로만 덮는다.

- [x] **Step 3: 문서를 고치고 커밋한다**

스펙 끝에 "M5-2 검증 결과" 절을 만들어 잰 값과 못 본 것을 적는다. `main-layers.md`의 스트림 절에 흐름 제어를 한 문단 더하고
`verified`를 갱신한다. 이 계획의 체크박스를 채운다.

Run: `python3 docs/script/docs.py lint && python3 docs/script/docs.py links` / Expected: 문제 0건.

`git commit -m "docs(stream): JPEG 흐름 제어의 측정 결과를 남긴다"`
