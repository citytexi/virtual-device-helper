---
id: m2-3-gesture-overlay          # 파일명에서 날짜 접두사를 뺀 slug
title: M2-3 — 에이전트 동작 오버레이와 완료 검증
status: draft                   # draft | in-progress | done | abandoned | superseded
type: work-order                # work-order | handoff
created: 2026-09-23
updated: 2026-09-23
owner: virtual-device-helper 팀
scope: [main, mcp, renderer, shared, docs]
hosts: []                       # windows | macos — 호스트 OS마다 작업이 갈릴 때만 채운다
archived_reason:                # done/abandoned 시 사유 (활성 계획은 비움)
related_adr: [ADR-0002, ADR-0010]
related_spec: m2-live-streaming
related_architecture:
related_plan: [m2-1-stream-core, m2-2-renderer-stream]
related_code: [runTool.ts#runTool, screenSize.ts#screenSizeOf, GestureOverlay.tsx#GestureOverlay, GestureOverlay.tsx#gestureToVideo]
tags: [plan, streaming, mcp, overlay]
---

# M2-3 — 에이전트 동작 오버레이와 완료 검증 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: `superpowers:subagent-driven-development`(권장) 또는
> `superpowers:executing-plans`로 task 단위 구현. 각 단계는 체크박스(`- [ ]`)로 추적한다.

**Goal:** 에이전트가 `ui_tap`·`ui_swipe`를 부르면 실시간 화면 위에 그 위치가 잠깐 표시되고, M2 스펙의 완료 조건을
실제 앱과 에이전트로 확인한 뒤 문서를 닫는다.

**Architecture:** main은 성공한 `ui_tap`·`ui_swipe` 호출의 `ToolCallRecord`에 기기 픽셀 좌표와 자연 방향 화면 크기를
`gesture`로 싣는다. 화면 크기는 `Device` 인스턴스별로 한 번 조회해 캐시한다. renderer의 `GestureOverlay`는
`tool_call` 이벤트를 직접 구독하고, 회전을 고려해 비디오 좌표로 바꾼 뒤 캔버스와 같은 letterbox의 SVG에 그린다.

**Tech Stack:** TypeScript, React 19, SVG, `@modelcontextprotocol/sdk`, Vitest, @testing-library/react, jsdom

**Spec:** [`../specs/2026-09-23-m2-live-streaming.md`](../specs/2026-09-23-m2-live-streaming.md)

**선행 조건:** [M2-1](2026-09-23-m2-1-stream-core.md)과 [M2-2](2026-09-23-m2-2-renderer-stream.md)가 끝나 있어야 한다.
이 계획은 M2-2의 `DeviceScreen` 안 `screen-stage`와 `useScrcpyStream`의 `video`를 쓴다.

## Global Constraints

- 답변·주석·문서는 한국어로 쓴다. 기술 용어·API 이름·명령어·에러 문자열은 원문 그대로 둔다.
- gesture 기록 실패(화면 크기 조회 실패 등)는 툴 결과를 바꾸지 않는다. gesture만 빠진다.
- 실패한 툴 호출에는 gesture를 싣지 않는다.
- 활동 탭(`ActivityTab`)의 표시는 바꾸지 않는다. gesture는 오버레이만 쓴다.
- 오버레이는 입력을 가로채지 않는다(`pointer-events: none`). 사람 입력은 그 아래 캔버스로 간다.
- 새 npm 의존성을 들이지 않는다.
- 스타일은 `app.css`의 기존 토큰만 쓴다. `prefers-reduced-motion`이면 크기 애니메이션 없이 흐려지기만 한다.
- 각 task 끝에서 `npm test`와 `npm run typecheck`가 통과해야 한다.
- 기존 테스트가 쓰는 텍스트·role·aria가 바뀌면 그 테스트를 같은 task에서 고친다.
- 문서에는 라인번호, 파일·툴 개수, 진행률을 적지 않는다. 파일명과 심볼명으로 가리킨다.
- 문서를 고치면 `python3 docs/script/docs.py lint`와 `python3 docs/script/docs.py links`를 돌린다.
- 커밋 메시지는 한국어 Conventional Commits(`feat(renderer): ...한다`)이고, 끝에 다음 줄을 붙인다:
  `Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>`

## Review Focus

- **가로 모드에서의 에이전트 탭**: 기기를 돌린 상태에서 `ui_tap`의 좌표는 회전된 공간이다. 표시가 엉뚱한 곳에 나오면 안 된다. → Task 2 테스트.
- **다른 기기를 향한 툴 호출**: 기기가 둘일 때 화면에 없는 기기의 탭을 그리면 안 된다. → Task 2 테스트.
- **빠른 연속 탭**: 에이전트가 짧은 간격으로 여러 번 누르면 표시가 겹쳐도 각각 제시간에 사라져야 한다. → Task 2 테스트.
- **`wm size` 실패**: 부팅 직후 기기처럼 크기 조회가 실패해도 탭은 성공으로 돌아가야 한다. 다음 호출에서는 다시 조회해야 한다. → Task 1 테스트.
- **화면을 떠난 뒤의 타이머**: 기기를 바꾸거나 화면이 사라진 뒤 남은 타이머가 상태를 건드리면 안 된다. → Task 2 테스트.

---

### Task 1: 툴 호출 기록에 gesture를 싣는다

**Files:**
- Modify: `src/shared/types/ipc.ts`
- Create: `src/main/mcp/screenSize.ts`
- Modify: `src/main/mcp/runTool.ts`
- Modify: `src/main/mcp/tools/ui.ts`
- Test: `src/main/mcp/screenSize.test.ts`, `src/main/mcp/tools/ui.test.ts`, `src/main/mcp/runTool.test.ts`

**Interfaces:**
- Consumes: `Device` (`src/shared/types/device.ts`), `runTool`, `ToolContext`
- Produces:
  - `src/shared/types/ipc.ts`: `interface ScreenSize { width: number; height: number }`,
    `type Gesture = { kind: 'tap'; serial: string; screen: ScreenSize; x: number; y: number } | { kind: 'swipe'; serial: string; screen: ScreenSize; x1: number; y1: number; x2: number; y2: number }`,
    `ToolCallRecord.gesture?: Gesture`
  - `screenSizeOf(device: Device): Promise<ScreenSize>`
  - `runTool(sink, tool, args, handler, opts?: RunToolOpts)` — `interface RunToolOpts { gesture?: () => Promise<Gesture | undefined> }`

- [ ] **Step 1: 실패하는 테스트를 쓴다**

`src/main/mcp/screenSize.test.ts`:

```ts
import { describe, expect, it, vi } from 'vitest'
import type { Device } from '../../shared/types/device'
import { screenSizeOf } from './screenSize'

function deviceWith(info: Device['info']): Device {
  return { serial: 'emulator-5554', info } as Device
}

describe('screenSizeOf', () => {
  it('asks the device once and reuses the answer', async () => {
    const info = vi.fn(async () => ({ serial: 'emulator-5554', model: 'x', apiLevel: 34, width: 1080, height: 2400 }))
    const device = deviceWith(info)

    await screenSizeOf(device)
    const size = await screenSizeOf(device)

    expect(size).toEqual({ width: 1080, height: 2400 })
    expect(info).toHaveBeenCalledTimes(1)
  })

  it('asks again after a failure', async () => {
    const info = vi
      .fn()
      .mockRejectedValueOnce(new Error('wm size 실패'))
      .mockResolvedValueOnce({ serial: 'emulator-5554', model: 'x', apiLevel: 34, width: 1080, height: 2400 })
    const device = deviceWith(info)

    await expect(screenSizeOf(device)).rejects.toThrow('wm size 실패')
    await expect(screenSizeOf(device)).resolves.toEqual({ width: 1080, height: 2400 })
  })

  it('keeps separate answers for separate device instances', async () => {
    const a = deviceWith(vi.fn(async () => ({ serial: 'a', model: 'x', apiLevel: 34, width: 1, height: 2 })))
    const b = deviceWith(vi.fn(async () => ({ serial: 'b', model: 'x', apiLevel: 34, width: 3, height: 4 })))

    expect(await screenSizeOf(a)).toEqual({ width: 1, height: 2 })
    expect(await screenSizeOf(b)).toEqual({ width: 3, height: 4 })
  })
})
```

`src/main/mcp/tools/ui.test.ts`에 더한다(파일의 `harnessFor`를 그대로 쓴다).

```ts
const info = async () => ({ serial: 'emulator-5554', model: 'Pixel', apiLevel: 34, width: 1080, height: 2400 })

describe('gesture records', () => {
  it('records a successful tap with its pixel position and the natural screen size', async () => {
    const harness = await harnessFor({ tap: vi.fn(async () => {}), info })

    await harness.call('ui_tap', { x: 540, y: 930 })

    expect(harness.records[0]?.gesture).toEqual({
      kind: 'tap',
      serial: 'emulator-5554',
      screen: { width: 1080, height: 2400 },
      x: 540,
      y: 930
    })
    await harness.close()
  })

  it('records a successful swipe with both ends', async () => {
    const harness = await harnessFor({ swipe: vi.fn(async () => {}), info })

    await harness.call('ui_swipe', { x1: 100, y1: 1800, x2: 100, y2: 400, durationMs: 300 })

    expect(harness.records[0]?.gesture).toEqual({
      kind: 'swipe',
      serial: 'emulator-5554',
      screen: { width: 1080, height: 2400 },
      x1: 100,
      y1: 1800,
      x2: 100,
      y2: 400
    })
    await harness.close()
  })

  it('records no gesture for a failed tap', async () => {
    const harness = await harnessFor({
      tap: vi.fn(async () => {
        throw deviceError('device_unresponsive', 'timeout', 'retry')
      }),
      info
    })

    await harness.callExpectingError('ui_tap', { x: 1, y: 1 })

    expect(harness.records[0]?.gesture).toBeUndefined()
    await harness.close()
  })

  it('still succeeds without a gesture when the screen size cannot be read', async () => {
    const harness = await harnessFor({
      tap: vi.fn(async () => {}),
      info: async () => {
        throw deviceError('command_failed', 'wm size 출력에서 화면 크기를 읽지 못했다', 'x')
      }
    })

    const result = await harness.raw('ui_tap', { x: 1, y: 1 })

    expect(result.isError).toBeFalsy()
    expect(harness.records[0]?.ok).toBe(true)
    expect(harness.records[0]?.gesture).toBeUndefined()
    await harness.close()
  })
})
```

`deviceError`가 이미 import돼 있는지 확인한다(이 파일은 이미 `deviceError`를 import한다).

`src/main/mcp/runTool.test.ts`에 더한다. 이 파일이 쓰는 가짜 sink 이름에 맞춘다 — 기록을 배열에 모으는 sink다.

```ts
describe('runTool gesture', () => {
  it('attaches the gesture of a successful call', async () => {
    const sink = collector()
    const gesture = { kind: 'tap' as const, serial: 's', screen: { width: 1, height: 2 }, x: 0, y: 0 }

    await runTool(sink, 'ui_tap', {}, async () => ({ ok: true }), {
      gesture: async () => gesture
    })

    expect(sink.records[0]?.gesture).toEqual(gesture)
  })

  it('does not ask for a gesture when the call fails', async () => {
    const sink = collector()
    const gesture = vi.fn(async () => undefined)

    await runTool(sink, 'ui_tap', {}, async () => {
      throw new Error('boom')
    }, { gesture })

    expect(gesture).not.toHaveBeenCalled()
    expect(sink.records[0]?.gesture).toBeUndefined()
  })

  it('keeps the success when building the gesture throws', async () => {
    const sink = collector()

    const result = await runTool(sink, 'ui_tap', {}, async () => ({ ok: true }), {
      gesture: async () => {
        throw new Error('no size')
      }
    })

    expect(result.isError).toBeFalsy()
    expect(sink.records[0]).toMatchObject({ ok: true })
    expect(sink.records[0]?.gesture).toBeUndefined()
  })
})
```

이 파일의 `collector()`로 기록을 모은다. `vi`·`ToolCallRecord`는 이미 import돼 있다.

- [ ] **Step 2: 테스트가 실패하는지 확인한다**

Run: `npx vitest run src/main/mcp`
Expected: FAIL — `./screenSize`가 없고 gesture가 기록되지 않는다

- [ ] **Step 3: 타입과 캐시를 더한다**

`src/shared/types/ipc.ts`의 `ToolCallRecord` 위에 더한다.

```ts
/** wm size가 돌려주는 자연 방향 화면 크기(기기 픽셀) */
export interface ScreenSize {
  width: number
  height: number
}

/**
 * 에이전트의 화면 동작. 좌표는 툴이 받은 기기 픽셀 그대로다. 회전 상태는 main이 모르므로
 * 정규화는 renderer가 비디오 크기와 screen을 비교해서 한다.
 */
export type Gesture =
  | { kind: 'tap'; serial: string; screen: ScreenSize; x: number; y: number }
  | { kind: 'swipe'; serial: string; screen: ScreenSize; x1: number; y1: number; x2: number; y2: number }
```

`ToolCallRecord`에 더한다.

```ts
  /** 화면 위 동작이 있는 툴(ui_tap·ui_swipe)이 성공했을 때만 붙는다. 실시간 화면 오버레이가 쓴다. */
  gesture?: Gesture
```

`src/main/mcp/screenSize.ts`:

```ts
import type { Device } from '../../shared/types/device'
import type { ScreenSize } from '../../shared/types/ipc'

/**
 * Device 인스턴스별 화면 크기. registry는 기기가 다시 연결되면 새 인스턴스를 만들므로
 * WeakMap 키가 곧 "이번 연결"이다. 탭마다 wm size를 부르지 않으려는 캐시다.
 */
const cache = new WeakMap<Device, Promise<ScreenSize>>()

export function screenSizeOf(device: Device): Promise<ScreenSize> {
  const cached = cache.get(device)
  if (cached) return cached

  const pending = device.info().then((info) => ({ width: info.width, height: info.height }))
  cache.set(device, pending)
  // 실패를 캐시하지 않는다. 부팅 직후처럼 잠깐 실패한 기기는 다음 호출에서 다시 묻는다.
  pending.catch(() => {
    if (cache.get(device) === pending) cache.delete(device)
  })
  return pending
}
```

- [ ] **Step 4: runTool에 gesture 자리를 더한다**

`src/main/mcp/runTool.ts`의 import에 `import type { Gesture } from '../../shared/types/ipc'`를 더하고, `runTool` 위에 더한다.

```ts
export interface RunToolOpts {
  /**
   * 성공한 호출에만 부른다. 던지거나 undefined면 gesture 없이 기록한다 — 오버레이용
   * 부가 정보가 툴 결과를 바꾸면 안 된다.
   */
  gesture?: () => Promise<Gesture | undefined>
}
```

시그니처에 `opts: RunToolOpts = {}`를 다섯 번째 인자로 더하고, 성공 분기의 `recordSafely` 호출을 바꾼다.

```ts
    const payload = await handler()

    let gesture: Gesture | undefined
    try {
      gesture = await opts.gesture?.()
    } catch {
      gesture = undefined
    }

    recordSafely({
      id,
      tool,
      argsSummary: summariseArgs(args),
      startedAt,
      durationMs: Date.now() - startedAt,
      ok: true,
      ...(gesture ? { gesture } : {})
    })
```

- [ ] **Step 5: ui_tap·ui_swipe가 gesture를 싣게 한다**

`src/main/mcp/tools/ui.ts`의 import에 더한다.

```ts
import type { Device } from '../../../shared/types/device'
import { screenSizeOf } from '../screenSize'
```

`ui_tap`의 콜백을 바꾼다.

```ts
    async (args) => {
      // 핸들러가 고른 기기를 gesture도 쓴다. 다시 resolve하면 그사이 활성 기기가 바뀔 수 있다.
      let target: Device | null = null
      return runTool(
        context,
        'ui_tap',
        args,
        async () => {
          const device = context.registry.resolve(args.serial)
          target = device
          await context.registry.run(device.serial, () => device.tap(args.x, args.y))
          return { tapped: { x: args.x, y: args.y } }
        },
        {
          gesture: async () => {
            if (!target) return undefined
            return { kind: 'tap', serial: target.serial, screen: await screenSizeOf(target), x: args.x, y: args.y }
          }
        }
      )
    }
```

`ui_swipe`의 콜백을 같은 모양으로 바꾼다.

```ts
    async (args) => {
      let target: Device | null = null
      return runTool(
        context,
        'ui_swipe',
        args,
        async () => {
          const device = context.registry.resolve(args.serial)
          target = device
          await context.registry.run(device.serial, () =>
            device.swipe(args.x1, args.y1, args.x2, args.y2, args.durationMs)
          )
          return { swiped: true }
        },
        {
          gesture: async () => {
            if (!target) return undefined
            return {
              kind: 'swipe',
              serial: target.serial,
              screen: await screenSizeOf(target),
              x1: args.x1,
              y1: args.y1,
              x2: args.x2,
              y2: args.y2
            }
          }
        }
      )
    }
```

`ui_swipe`의 `return { swiped: true }`와 스키마는 지금 코드 그대로 둔다. 위 코드와 지금 코드의 반환값이 다르면
지금 코드를 따른다.

- [ ] **Step 6: 테스트가 통과하는지 확인한다**

Run: `npm test && npm run typecheck`
Expected: PASS. 기존 `ui.test.ts`의 탭·스와이프 테스트는 가짜 기기에 `info`가 없어도 통과해야 한다 — 크기 조회
실패는 gesture만 뺀다.

- [ ] **Step 7: 커밋한다**

```bash
git add src/shared/types/ipc.ts src/main/mcp/
git commit -m "feat(mcp): ui_tap·ui_swipe 기록에 오버레이용 gesture를 싣는다

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task 2: GestureOverlay

**Files:**
- Create: `src/renderer/src/components/GestureOverlay.tsx`
- Test: `src/renderer/src/components/GestureOverlay.test.tsx`
- Modify: `src/renderer/src/app.css`

**Interfaces:**
- Consumes: `Gesture`, `MainEvent` (Task 1, M1), `VideoSize` (M2-2 `inputMapper.ts`)
- Produces:
  - `GESTURE_VISIBLE_MS = 700`
  - `type VideoGesture = { kind: 'tap'; x: number; y: number } | { kind: 'swipe'; x1: number; y1: number; x2: number; y2: number }`
  - `gestureToVideo(gesture: Gesture, video: VideoSize): VideoGesture`
  - `interface GestureOverlayProps { serial: string; video: VideoSize | null; subscribe?: (listener: (event: MainEvent) => void) => () => void }`
  - `GestureOverlay(props: GestureOverlayProps): JSX.Element | null` — SVG `className="gesture-overlay"`, 탭은 `circle.gesture-tap`, 스와이프는 `g.gesture-swipe`

- [ ] **Step 1: 실패하는 테스트를 쓴다**

`src/renderer/src/components/GestureOverlay.test.tsx`:

```tsx
// @vitest-environment jsdom
import { act, render } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Gesture, MainEvent, ToolCallRecord } from '../../../shared/types/ipc'
import { GESTURE_VISIBLE_MS, GestureOverlay, gestureToVideo } from './GestureOverlay'

const portrait = { width: 1080, height: 2400 }

function toolCall(id: string, gesture?: Gesture): MainEvent {
  const record: ToolCallRecord = {
    id,
    tool: gesture?.kind === 'swipe' ? 'ui_swipe' : 'ui_tap',
    argsSummary: '{}',
    startedAt: 0,
    durationMs: 1,
    ok: true,
    ...(gesture ? { gesture } : {})
  }
  return { type: 'tool_call', record }
}

function bus() {
  let listener: ((event: MainEvent) => void) | null = null
  const subscribe = vi.fn((l: (event: MainEvent) => void) => {
    listener = l
    return () => {
      listener = null
    }
  })
  return { subscribe, emit: (event: MainEvent) => act(() => listener?.(event)), listening: () => listener !== null }
}

afterEach(() => {
  vi.useRealTimers()
})

describe('gestureToVideo', () => {
  it('scales a portrait tap into portrait video', () => {
    expect(gestureToVideo({ kind: 'tap', serial: 's', screen: portrait, x: 540, y: 930 }, { width: 540, height: 1200 })).toEqual({
      kind: 'tap',
      x: 270,
      y: 465
    })
  })

  it('swaps the screen axes when the video is rotated', () => {
    // 가로 모드의 탭 좌표는 회전된 공간(2400 x 1080)에 있다.
    expect(gestureToVideo({ kind: 'tap', serial: 's', screen: portrait, x: 1000, y: 500 }, { width: 1200, height: 540 })).toEqual({
      kind: 'tap',
      x: 500,
      y: 250
    })
  })

  it('scales both ends of a swipe', () => {
    expect(
      gestureToVideo({ kind: 'swipe', serial: 's', screen: portrait, x1: 100, y1: 1800, x2: 100, y2: 400 }, { width: 540, height: 1200 })
    ).toEqual({ kind: 'swipe', x1: 50, y1: 900, x2: 50, y2: 200 })
  })
})

describe('GestureOverlay', () => {
  const video = { width: 540, height: 1200 }

  it('draws a tap of its own device', () => {
    const b = bus()
    const { container } = render(<GestureOverlay serial="emulator-5554" video={video} subscribe={b.subscribe} />)

    b.emit(toolCall('1', { kind: 'tap', serial: 'emulator-5554', screen: portrait, x: 540, y: 930 }))

    const circle = container.querySelector('circle.gesture-tap')
    expect(circle?.getAttribute('cx')).toBe('270')
    expect(circle?.getAttribute('cy')).toBe('465')
  })

  it('draws a swipe as a line with an end mark', () => {
    const b = bus()
    const { container } = render(<GestureOverlay serial="emulator-5554" video={video} subscribe={b.subscribe} />)

    b.emit(toolCall('1', { kind: 'swipe', serial: 'emulator-5554', screen: portrait, x1: 100, y1: 1800, x2: 100, y2: 400 }))

    const line = container.querySelector('g.gesture-swipe line')
    expect(line?.getAttribute('y1')).toBe('900')
    expect(line?.getAttribute('y2')).toBe('200')
  })

  it.each([
    ['another device', toolCall('1', { kind: 'tap', serial: 'emulator-5556', screen: portrait, x: 1, y: 1 })],
    ['a call without a gesture', toolCall('1')],
    ['a non tool_call event', { type: 'active_changed', serial: 'emulator-5554' } as MainEvent]
  ])('draws nothing for %s', (_name, event) => {
    const b = bus()
    const { container } = render(<GestureOverlay serial="emulator-5554" video={video} subscribe={b.subscribe} />)

    b.emit(event)

    expect(container.querySelectorAll('circle, line')).toHaveLength(0)
  })

  it('removes each mark after its own display time', () => {
    vi.useFakeTimers()
    const b = bus()
    const { container } = render(<GestureOverlay serial="emulator-5554" video={video} subscribe={b.subscribe} />)
    const tap = (id: string) => toolCall(id, { kind: 'tap', serial: 'emulator-5554', screen: portrait, x: 1, y: 1 })

    b.emit(tap('1'))
    act(() => vi.advanceTimersByTime(GESTURE_VISIBLE_MS / 2))
    b.emit(tap('2'))
    expect(container.querySelectorAll('circle.gesture-tap')).toHaveLength(2)

    act(() => vi.advanceTimersByTime(GESTURE_VISIBLE_MS / 2))
    expect(container.querySelectorAll('circle.gesture-tap')).toHaveLength(1)

    act(() => vi.advanceTimersByTime(GESTURE_VISIBLE_MS / 2))
    expect(container.querySelectorAll('circle.gesture-tap')).toHaveLength(0)
  })

  it('renders nothing before the video size is known', () => {
    const b = bus()
    const { container } = render(<GestureOverlay serial="emulator-5554" video={null} subscribe={b.subscribe} />)

    expect(container.querySelector('svg')).toBeNull()
  })

  it('unsubscribes and cancels pending timers when unmounted', () => {
    vi.useFakeTimers()
    const b = bus()
    const { unmount } = render(<GestureOverlay serial="emulator-5554" video={video} subscribe={b.subscribe} />)
    b.emit(toolCall('1', { kind: 'tap', serial: 'emulator-5554', screen: portrait, x: 1, y: 1 }))

    unmount()

    expect(b.listening()).toBe(false)
    expect(vi.getTimerCount()).toBe(0)
  })
})
```

- [ ] **Step 2: 테스트가 실패하는지 확인한다**

Run: `npx vitest run src/renderer/src/components/GestureOverlay.test.tsx`
Expected: FAIL — 모듈이 없다

- [ ] **Step 3: 구현한다**

`src/renderer/src/components/GestureOverlay.tsx`:

```tsx
import { useEffect, useState } from 'react'
import type { JSX } from 'react'
import type { Gesture, MainEvent } from '../../../shared/types/ipc'
import type { VideoSize } from '../stream/inputMapper'

/** 표시 하나가 떠 있는 시간. app.css의 gesture 애니메이션 길이와 같다. */
export const GESTURE_VISIBLE_MS = 700

export type VideoGesture =
  | { kind: 'tap'; x: number; y: number }
  | { kind: 'swipe'; x1: number; y1: number; x2: number; y2: number }

/**
 * 기기 픽셀 좌표를 비디오 좌표로 바꾼다. screen은 자연 방향 크기이고 툴 좌표는 현재 방향
 * 공간에 있다. 비디오의 가로·세로 방향이 screen과 다르면 회전된 것으로 보고 축을 바꿔 나눈다.
 */
export function gestureToVideo(gesture: Gesture, video: VideoSize): VideoGesture {
  const rotated = video.width > video.height !== gesture.screen.width > gesture.screen.height
  const screenWidth = rotated ? gesture.screen.height : gesture.screen.width
  const screenHeight = rotated ? gesture.screen.width : gesture.screen.height
  const fx = video.width / screenWidth
  const fy = video.height / screenHeight

  if (gesture.kind === 'tap') return { kind: 'tap', x: gesture.x * fx, y: gesture.y * fy }
  return { kind: 'swipe', x1: gesture.x1 * fx, y1: gesture.y1 * fy, x2: gesture.x2 * fx, y2: gesture.y2 * fy }
}

export interface GestureOverlayProps {
  serial: string
  video: VideoSize | null
  /** 기본값은 window.api.onEvent. 테스트는 가짜 이벤트 버스를 넘긴다. */
  subscribe?: (listener: (event: MainEvent) => void) => () => void
}

// 모듈 수준에 둔다. 렌더마다 새 함수면 effect가 매번 다시 구독한다.
const subscribeToMain = (listener: (event: MainEvent) => void): (() => void) => window.api.onEvent(listener)

interface Mark {
  id: string
  gesture: Gesture
}

/**
 * 에이전트의 탭·스와이프를 실시간 화면 위에 잠깐 그린다. 구독한 뒤에 온 툴 호출만 그린다 —
 * 이미 지난 호출을 다시 그리면 지금 화면과 맞지 않는다. viewBox를 비디오 크기로 두고
 * preserveAspectRatio를 meet으로 두면 캔버스의 object-fit: contain과 같은 자리에 그려진다.
 */
export function GestureOverlay({ serial, video, subscribe = subscribeToMain }: GestureOverlayProps): JSX.Element | null {
  const [marks, setMarks] = useState<Mark[]>([])

  useEffect(() => {
    const timers = new Set<ReturnType<typeof setTimeout>>()
    const unsubscribe = subscribe((event) => {
      if (event.type !== 'tool_call') return
      const gesture = event.record.gesture
      if (!gesture || gesture.serial !== serial) return

      const mark: Mark = { id: event.record.id, gesture }
      setMarks((current) => [...current, mark])
      const timer = setTimeout(() => {
        timers.delete(timer)
        setMarks((current) => current.filter((m) => m !== mark))
      }, GESTURE_VISIBLE_MS)
      timers.add(timer)
    })

    return () => {
      unsubscribe()
      for (const timer of timers) clearTimeout(timer)
      setMarks([])
    }
  }, [serial, subscribe])

  if (!video) return null
  const radius = Math.max(video.width, video.height) * 0.03

  return (
    <svg
      className="gesture-overlay"
      viewBox={`0 0 ${video.width} ${video.height}`}
      preserveAspectRatio="xMidYMid meet"
      aria-hidden="true"
    >
      {marks.map((mark) => {
        const g = gestureToVideo(mark.gesture, video)
        if (g.kind === 'tap') {
          return <circle key={mark.id} className="gesture-tap" cx={g.x} cy={g.y} r={radius} />
        }
        return (
          <g key={mark.id} className="gesture-swipe">
            <line x1={g.x1} y1={g.y1} x2={g.x2} y2={g.y2} />
            <circle cx={g.x2} cy={g.y2} r={radius / 2} />
          </g>
        )
      })}
    </svg>
  )
}
```

`app.css`의 `.device-key` 규칙 아래에 더한다.

```css
.gesture-overlay {
  position: absolute;
  inset: 0;
  width: 100%;
  height: 100%;
  pointer-events: none;
}

.gesture-tap {
  fill: var(--accent-soft);
  stroke: var(--accent);
  stroke-width: 3;
  vector-effect: non-scaling-stroke;
  transform-box: fill-box;
  transform-origin: center;
  animation: gesture-tap 700ms ease-out forwards;
}

.gesture-swipe {
  stroke: var(--accent);
  stroke-width: 4;
  stroke-linecap: round;
  fill: var(--accent);
  vector-effect: non-scaling-stroke;
  animation: gesture-fade 700ms ease-out forwards;
}

.gesture-swipe line {
  vector-effect: non-scaling-stroke;
}

@keyframes gesture-tap {
  from {
    transform: scale(0.4);
    opacity: 1;
  }
  to {
    transform: scale(1.4);
    opacity: 0;
  }
}

@keyframes gesture-fade {
  from {
    opacity: 1;
  }
  to {
    opacity: 0;
  }
}

@media (prefers-reduced-motion: reduce) {
  .gesture-tap {
    animation-name: gesture-fade;
  }
}
```

- [ ] **Step 4: 테스트가 통과하는지 확인한다**

Run: `npx vitest run src/renderer/src/components && npm run typecheck`
Expected: PASS

- [ ] **Step 5: 커밋한다**

```bash
git add src/renderer/src/components/GestureOverlay.tsx src/renderer/src/components/GestureOverlay.test.tsx src/renderer/src/app.css
git commit -m "feat(renderer): 에이전트의 탭·스와이프를 그리는 GestureOverlay를 더한다

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task 3: 오버레이를 실시간 화면에 얹는다

**Files:**
- Modify: `src/renderer/src/components/DeviceScreen.tsx`
- Modify: `src/renderer/src/components/DeviceScreen.test.tsx`

**Interfaces:**
- Consumes: `GestureOverlay` (Task 2), `LiveScreen`의 `video` (M2-2)

- [ ] **Step 1: 실패하는 테스트를 쓴다**

`DeviceScreen.test.tsx`의 `beforeEach`에서 `window.api`에 `onEvent`를 더한다 — 오버레이가 기본값으로 구독한다.

```ts
  ;(window as unknown as { api: Partial<RendererApi> }).api = {
    captureScreenshot,
    onEvent: (listener: (event: MainEvent) => void) => {
      eventListeners.push(listener)
      return () => {}
    }
  } as unknown as RendererApi
```

파일 위쪽에 `const eventListeners: Array<(event: MainEvent) => void> = []`를 두고 `beforeEach`에서 `eventListeners.length = 0`으로
비운다. `MainEvent`를 `../../../shared/types/ipc`에서 import하고, `act`를 `@testing-library/react`에서 import한다. 테스트를 더한다.

```ts
  it('draws an agent tap over the live canvas', () => {
    streamWith({ state: 'streaming' }, { width: 540, height: 1200 })
    const { container } = render(<DeviceScreen serial="emulator-5554" />)

    act(() =>
      eventListeners.forEach((listener) =>
        listener({
          type: 'tool_call',
          record: {
            id: '1',
            tool: 'ui_tap',
            argsSummary: '{}',
            startedAt: 0,
            durationMs: 1,
            ok: true,
            gesture: { kind: 'tap', serial: 'emulator-5554', screen: { width: 1080, height: 2400 }, x: 540, y: 930 }
          }
        })
      )
    )

    expect(container.querySelector('.screen-stage svg.gesture-overlay circle.gesture-tap')).not.toBeNull()
  })
```

- [ ] **Step 2: 테스트가 실패하는지 확인한다**

Run: `npx vitest run src/renderer/src/components/DeviceScreen.test.tsx`
Expected: FAIL — 오버레이가 없다

- [ ] **Step 3: 오버레이를 얹는다**

`DeviceScreen.tsx`에 `import { GestureOverlay } from './GestureOverlay'`를 더하고, `screen-stage` 안 `<canvas ... />` 바로 뒤에 넣는다.

```tsx
            <GestureOverlay serial={serial} video={video} />
```

캔버스 뒤에 두므로 SVG가 위에 그려지고, `pointer-events: none`이라 입력은 캔버스로 간다.

- [ ] **Step 4: 테스트가 통과하는지 확인한다**

Run: `npm test && npm run typecheck`
Expected: PASS

- [ ] **Step 5: 커밋한다**

```bash
git add src/renderer/src/components/DeviceScreen.tsx src/renderer/src/components/DeviceScreen.test.tsx
git commit -m "feat(renderer): 실시간 화면 위에 에이전트 동작 오버레이를 얹는다

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task 4: 완료 조건을 실제 앱으로 확인하고 문서를 닫는다

**Files:**
- Modify: `docs/superpowers/specs/2026-09-23-m2-live-streaming.md`
- Modify: `README.md`
- Modify: `docs/superpowers/plans/2026-09-23-m2-1-stream-core.md`, `2026-09-23-m2-2-renderer-stream.md`, `2026-09-23-m2-3-gesture-overlay.md` (frontmatter `status`)

- [ ] **Step 1: 자동 검증을 돌린다**

Run: `npm test && npm run typecheck && npm run build && npm run test:integration`
Expected: 전부 PASS. 통합 테스트는 에뮬레이터 하나가 떠 있어야 한다.

- [ ] **Step 2: 앱과 에이전트로 완료 조건을 확인한다**

에뮬레이터를 띄우고 `npm run dev`로 앱을 연다. 에이전트 탭의 연결 명령으로 Claude Code를 붙인다.

스펙 "완료 조건"의 여섯 항목을 차례로 확인하고, 각 항목의 결과와 관찰을 적어 둔다.

1. 기기를 고르면 수 초 안에 실시간 화면이 뜬다. Claude Code에 "설정 앱을 열고 디스플레이 메뉴로 들어가라"를 시켜
   새로고침 없이 조작이 보이는지 본다.
2. 같은 작업에서 `ui_tap`·`ui_swipe`마다 화면 위에 표시가 뜨고 사라지는지 본다.
3. 마우스 탭·드래그·휠, 영문 입력, 툴바의 뒤로·홈·최근 앱·볼륨·전원이 먹는지 본다.
4. 에뮬레이터를 가로로 돌린 뒤 클릭 좌표와 에이전트 탭 표시 위치가 맞는지 본다.
5. 기기를 두 대 띄워 여러 번 전환하고, 한 대를 끈 뒤 확인한다.

   ```bash
   adb forward --list                                   # 우리 forward(localabstract:scrcpy_...)가 전환 뒤 하나 이하
   adb -s <serial> shell ps -A | grep app_process       # scrcpy 서버가 하나 이하
   ```

   앱을 종료한 뒤 두 명령에서 우리 흔적이 없어야 한다.
6. 스트리밍 중에 서버를 죽여 재연결을 확인한다.

   ```bash
   adb -s <serial> shell pkill -f com.genymobile.scrcpy.Server
   ```

   화면에 "다시 연결 중"이 잠깐 뜨고 돌아와야 한다. 끝내 실패하는 경로는 서버를 반복해서 죽인다.

   ```bash
   for i in $(seq 1 40); do adb -s <serial> shell pkill -f com.genymobile.scrcpy.Server; sleep 0.25; done
   ```

   재시도를 다 쓰면 스크린샷 화면으로 떨어지고, 루프가 끝난 뒤 "다시 연결"을 누르면 실시간 화면으로 돌아와야 한다.

실패한 항목이 있으면 여기서 멈추고 `superpowers:systematic-debugging`으로 원인을 찾는다. 추측으로 고치지 않는다.

- [ ] **Step 3: 스펙에 결과를 남기고 닫는다**

`docs/superpowers/specs/2026-09-23-m2-live-streaming.md`:

- frontmatter: `status: implemented`, `verified: <오늘 날짜>`, `related_code`에 `scrcpySession.ts#createScrcpySession`,
  `streamManager.ts#createStreamManager`, `useScrcpyStream.ts#useScrcpyStream`, `GestureOverlay.tsx#GestureOverlay`를 더한다.
- "완료 조건" 절 아래에 `### 검증 결과 (<오늘 날짜>)`를 더하고 Step 2의 항목별 결과를 한두 줄씩 적는다. 수치는
  적지 않는다(근거 표기 규칙) — "수 초 안에 떴다", "표시가 탭 위치와 맞았다"처럼 방향만 적는다.
- "열린 질문"의 두 항목(`decodeQueueSize` 임계값, `max_size=1024`)에 확인한 결론을 적는다. 결정됐으면 본문
  "디코딩" 절로 올리고 열린 질문에서 지운다. 결정하지 못했으면 무엇을 봤고 왜 남기는지 적는다.

- [ ] **Step 4: README를 현재 상태로 고친다**

`README.md`의 현재 상태 문단에서 "기기 스크린샷"과 "실시간 화면 스트리밍과 화면 직접 조작은 아직 없다(M2)."를 고친다.

```markdown
현재 상태: v0.1.0 — macOS(Apple Silicon) 호스트, Android 에뮬레이터, MCP 서버, 실시간 기기 화면과 직접 조작,
에이전트 동작 표시, 툴 호출 기록, 에이전트 안내 탭.
```

README의 다른 절에 "스크린샷만 보인다" 같은 M1 시점의 설명이 있으면 같은 커밋에서 고친다.

- [ ] **Step 5: 계획 상태를 닫고 문서 검사를 돌린다**

세 계획의 frontmatter를 `status: done`으로 바꾸고 `archived_reason`에 한 줄로 결과를 적는다. 아카이브로 옮기는 일은
PR 머지 뒤에 한다(이전 마일스톤과 같은 순서).

Run: `python3 docs/script/docs.py lint && python3 docs/script/docs.py links`
Expected: 문제 0건

- [ ] **Step 6: 커밋한다**

```bash
git add README.md docs/
git commit -m "docs: M2 실시간 스트리밍 완료 조건 검증 결과를 남기고 스펙을 닫는다

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```
