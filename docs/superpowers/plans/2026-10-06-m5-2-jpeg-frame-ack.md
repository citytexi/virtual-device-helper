---
id: m5-2-jpeg-frame-ack
title: M5-2 — JPEG 프레임 흐름 제어
status: draft
type: work-order
created: 2026-10-06
updated: 2026-10-06
owner: virtual-device-helper 팀
scope: [main, renderer, shared, streaming]
hosts: []
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

**Tech Stack:** TypeScript, Electron MessagePort, React, Vitest

**Spec:** [`../specs/2026-10-06-m5-multi-screen.md`](../specs/2026-10-06-m5-multi-screen.md) — "JPEG 흐름 제어" 절. 결정 근거는 [ADR-0018](../../adr/0018-jpeg-frame-ack-flow-control.md).

**선행 조건:** 없다. 화면 하나에서 검증한다. [M5-3](2026-10-06-m5-3-screen-slots.md)보다 먼저 한다.

## Global Constraints

- 답변·주석·문서는 한국어로 쓴다. 기술 용어·API 이름·명령어·에러 문자열은 원문 그대로 둔다.
- ADR-0015: mcp·renderer는 `platform`으로 분기하지 않는다. 칸 id나 라벨로 돌려서 분기하지도 않는다.
- 새 npm 의존성을 들이지 않는다.
- 각 task 끝에서 `npm test`와 `npm run typecheck`가 통과해야 한다. 테스트 출력에 경고가 없어야 한다.
- 문서에는 라인번호, 파일·툴 개수, 진행률을 적지 않는다. 문서를 고치면 `docs.py lint`와 `docs.py links`를 돌린다.
- 커밋 메시지는 한국어 Conventional Commits이고, 끝에 다음 줄을 붙인다:
  `Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>`
- `StreamUp`은 `ControlIntent | { type: 'frame_ack' }`다.
- `streamManager`의 재연결·포트·세션 수명 로직은 바꾸지 않는다. 바뀌는 것은 메시지 전달부와 `Entry`의 필드뿐이다.
- `frame_ack`는 세션의 `sendControl`로 넘기지 않는다.
- h264 `packet`은 흐름 제어를 타지 않는다.
- `FRAME_RESYNC_MS = 2000`. renderer의 상수 하나로 둔다.

## Review Focus

- **확인 누락**: renderer의 어느 출구에서든 확인이 빠지면 화면이 멈춘다. 그린 경우, 최신 한 장 규칙으로 버린 경우, 디코드 실패, 그리기 실패, 연속 실패 한도로 포기하는 경우 모두 프레임마다 정확히 한 번 보낸다. → Task 2 테스트.
- **재연결 뒤의 옛 확인**: 재연결은 같은 포트에 새 세션을 붙인다. 옛 세션의 프레임에 대한 확인이 늦게 와도 새 세션이 멈추거나 순서가 어긋나지 않는다. → Task 1 테스트.
- **멈춘 renderer**: 확인이 오지 않는 동안 프레임이 얼마나 오든 main이 드는 것은 한 장이다. → Task 1 테스트.
- **닫힌 뒤**: `close()` 뒤에 끝난 디코드는 확인을 보내지 않고, 닫힌 entry의 대기 장은 포트로 가지 않는다. → Task 1·2 테스트.
- **Android 회귀**: h264 세션의 동작과 프레임 속도가 그대로다. → Task 1 테스트, Task 3 측정.

---

### Task 1: main — `Entry`의 흐름 상태와 `frame_ack`

**Files:**
- Modify: `src/shared/types/stream.ts`, `src/main/stream/streamManager.ts`
- Test: `src/main/stream/streamManager.test.ts`

**Interfaces:**
- Produces (`stream.ts`): `export type StreamUp = ControlIntent | { type: 'frame_ack' }`.
- Produces (`streamManager.ts`): `export function isFrameAck(value: unknown): boolean` — `toControlIntent` 옆에 둔다. 객체이고 `type === 'frame_ack'`일 때만 true.
- `Entry`에 `awaitingAck: boolean`과 `pendingFrame: Uint8Array | null`을 더한다.
- `handlersFor(entry).onFrame(data)`: `awaitingAck`가 false면 `{ type: 'frame', data }`를 보내고 true로 세운다. true면 `pendingFrame = data`.
- 포트 `message` 핸들러: `isFrameAck`이면 — `current !== entry`면 무시 / `awaitingAck`가 false면 무시 / `pendingFrame`이 있으면 그것을 보내고 비운다(`awaitingAck`는 true 유지) / 없으면 `awaitingAck = false`. 그 밖의 메시지는 지금처럼 `toControlIntent`로 간다.
- `onSession`을 포트로 보내기 직전과 재연결(`recover`가 새 세션을 붙이기 전)에 `awaitingAck = false; pendingFrame = null`.
- entry를 닫을 때 `pendingFrame = null`.

- [ ] **Step 1: 실패하는 테스트를 쓴다** — 가짜 세션이 `onSession` 뒤 `onFrame`을 세 번 부르면 포트에 `frame`이 한 번만 간다(첫 장) / 그 뒤 포트로 `{ type: 'frame_ack' }`를 올리면 셋째 장이 간다(둘째 장은 가지 않는다) / 한 번 더 올리면 아무것도 가지 않고, 다음 `onFrame`은 바로 간다 / 기다리지 않을 때 올린 확인 뒤의 `onFrame` 두 번은 첫 장만 간다(초과 확인이 쌓이지 않는다) / 프레임 둘을 보낸 상태에서 `onSession`을 다시 부르면 그 뒤 첫 `onFrame`이 확인 없이 바로 간다 / 재연결 뒤 새 세션의 첫 `onFrame`이 확인 없이 바로 간다 / `frame_ack`를 올려도 가짜 세션의 `sendControl`이 불리지 않는다 / `stop()` 뒤에 온 확인은 대기 장을 보내지 않는다 / `onPacket`은 확인과 무관하게 매번 간다 / `isFrameAck`가 `null`, 문자열, `{ type: 'touch' }`에 false.
- [ ] **Step 2: 실패를 확인한다** — Run: `npx vitest run src/main/stream/streamManager.test.ts` / Expected: FAIL.
- [ ] **Step 3: 구현한다.**
- [ ] **Step 4: 통과를 확인한다** — Run: `npm test && npm run typecheck` / Expected: PASS. 이 시점에는 renderer가 확인을 보내지 않으므로 앱의 `jpeg` 화면은 첫 장에서 멈춘다. Task 2까지 한 묶음이다.
- [ ] **Step 5: 커밋** — `git commit -m "feat(stream): JPEG 프레임을 확인 뒤에 보내고 기다리는 동안 최신 한 장만 든다"`

---

### Task 2: renderer — 확인 보내기와 재동기

**Files:**
- Modify: `src/renderer/src/stream/jpegRenderer.ts`, `src/renderer/src/hooks/useScrcpyStream.ts`
- Test: `src/renderer/src/stream/jpegRenderer.test.ts`, `src/renderer/src/hooks/useScrcpyStream.test.tsx`

**Interfaces:**
- Consumes: `StreamUp`의 `frame_ack` (Task 1).
- Produces (`jpegRenderer.ts`):
  - `JpegRendererDeps`에 `ack(): void`를 더한다 — 프레임 한 장의 처리가 끝났다.
  - `push`로 받은 프레임마다 정확히 한 번 `ack`를 부른다: 그린 뒤 / 디코드나 그리기에 실패한 뒤 / 더 새 프레임에 덮여 버려질 때(덮이는 순간) / 연속 실패 한도로 포기할 때의 그 장. `close()` 뒤에는 부르지 않는다. `close()`가 버린 대기 장에도 부르지 않는다.
- `useScrcpyStream`:
  - JPEG 경로를 만들 때 `ack`를 **그 포트를 닫힌 변수로 잡아** `port.postMessage({ type: 'frame_ack' })`로 잇는다. `portRef.current`를 읽지 않는다.
  - `export const FRAME_RESYNC_MS = 2000`. `codec: 'jpeg'` 세션이고 상태가 `streaming`인 동안, 마지막 `frame` 뒤 `FRAME_RESYNC_MS`가 지나면 `frame_ack`를 한 번 보내고 타이머를 다시 건다. `frame`이 오면 타이머를 다시 건다. 포트를 놓거나 codec이 바뀌거나 언마운트되면 타이머를 지운다. 타이머는 `ScrcpyStreamDeps`의 `setTimer`/`clearTimer`로 주입한다(기본은 `setTimeout`/`clearTimeout`).

- [ ] **Step 1: 실패하는 테스트를 쓴다** — `jpegRenderer`: 한 장을 그리면 `ack` 한 번 / 느린 `decode` 중 셋을 push하면 `ack`가 모두 세 번이고 `draw`는 두 번(둘째 장은 덮일 때 확인) / `decode`가 reject하면 그 장에 `ack` 한 번이고 `draw`는 없다 / `draw`가 던져도 `ack` 한 번 / 연속 실패 한도에 닿은 장도 `ack` 한 번이고 그 뒤 push는 `ack`가 없다 / `close()` 뒤에 끝난 디코드는 `ack`가 없다. `useScrcpyStream`: `jpeg` 세션에서 `frame`을 그리면 그 포트의 `postMessage`가 `{ type: 'frame_ack' }`로 불린다 / 포트 A에서 온 프레임의 디코드가 끝나기 전에 포트 B로 바뀌면 확인은 A로 가고 B로는 가지 않는다 / `streaming`인 `jpeg` 세션에서 프레임 없이 `FRAME_RESYNC_MS`가 지나면 확인이 한 번 가고, 프레임이 오면 그 타이머가 다시 걸린다 / h264 세션에서는 재동기 타이머를 걸지 않고 `frame_ack`도 보내지 않는다 / 언마운트 뒤 타이머가 지워진다.
- [ ] **Step 2: 실패를 확인한다** — Run: `npx vitest run src/renderer/src/stream/jpegRenderer.test.ts src/renderer/src/hooks/useScrcpyStream.test.tsx` / Expected: FAIL.
- [ ] **Step 3: 구현한다.**
- [ ] **Step 4: 통과를 확인한다** — Run: `npm test && npm run typecheck` / Expected: PASS.
- [ ] **Step 5: 커밋** — `git commit -m "feat(renderer): JPEG 프레임마다 확인을 보내고 프레임이 끊기면 한 번 더 보낸다"`

---

### Task 3: 측정과 문서

**Files:**
- Modify: `src/main/stream/axeStreamSession.ios.integration.test.ts`, `docs/superpowers/specs/2026-10-06-m5-multi-screen.md`, `docs/architecture/main-layers.md`, 이 계획 문서

- [ ] **Step 1: 통합 테스트에 흐름 제어를 태운다**

`axeStreamSession.ios.integration.test.ts`는 세션 핸들러를 직접 본다. 실제 `createStreamManager`와 가짜 포트를 조립해
(M4-3 검증 때의 방식) 다음을 더한다: 확인을 올리지 않으면 2초 동안 포트로 가는 `frame`이 한 장이다 / 받는 대로 확인을
올리면 2초 동안 여러 장이 간다. 부팅된 시뮬레이터와 axe가 없으면 skip. 완료를 `sleep`으로 기다리지 않고 받은 장 수의
promise로 기다린다.

Run: `npm run test:integration -- src/main/stream/axeStreamSession.ios.integration.test.ts` / Expected: PASS(또는 skip).

- [ ] **Step 2: 실제 시뮬레이터에서 잰다**

시뮬레이터 하나를 `simctl`로만 부팅한다(Simulator.app을 띄우지 않고, 호스트 클립보드를 건드리지 않는다). 실제 모듈을
가짜 포트로 조립해: 받는 대로 확인을 올릴 때의 fps(M4-3의 약 15~16과 비교), 확인을 5초 멈췄다 풀었을 때 다음 장이
바로 오는지와 그동안 main에 든 장 수, 확인 하나를 일부러 빠뜨렸을 때 재동기 뒤 다시 흐르는지를 본다. 끝나면 시뮬레이터를
끈다. Android 기기가 붙어 있으면 h264 스트림의 fps가 그대로인지도 본다. 앱 창을 가렸을 때 확인이 멈추는지는 창을 봐야
하므로 "사람 확인 필요"로 남긴다.

- [ ] **Step 3: 문서를 고치고 커밋한다**

스펙 끝에 "M5-2 검증 결과" 절을 만들어 잰 값과 못 본 것을 적는다. `main-layers.md`의 스트림 절에 흐름 제어를 한 문단
더하고 `verified`를 갱신한다. 이 계획의 체크박스를 채운다.

Run: `python3 docs/script/docs.py lint && python3 docs/script/docs.py links` / Expected: 문제 0건.

`git commit -m "docs(stream): JPEG 흐름 제어의 측정 결과를 남긴다"`
