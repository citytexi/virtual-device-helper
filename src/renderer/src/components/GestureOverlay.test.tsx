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

    const circle = container.querySelector('g.gesture-swipe circle')
    expect(circle?.getAttribute('cx')).toBe('50')
    expect(circle?.getAttribute('cy')).toBe('200')
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

  it('clears marks and timers when the serial prop switches to another device', () => {
    vi.useFakeTimers()
    const b = bus()
    const { container, rerender } = render(
      <GestureOverlay serial="emulator-5554" video={video} subscribe={b.subscribe} />
    )

    b.emit(toolCall('1', { kind: 'tap', serial: 'emulator-5554', screen: portrait, x: 1, y: 1 }))
    expect(container.querySelectorAll('circle.gesture-tap')).toHaveLength(1)

    rerender(<GestureOverlay serial="emulator-5556" video={video} subscribe={b.subscribe} />)

    expect(container.querySelectorAll('circle.gesture-tap')).toHaveLength(0)
    expect(vi.getTimerCount()).toBe(0)

    // A용 이벤트는 더 이상 그려지지 않고, B용 이벤트만 그려진다.
    b.emit(toolCall('2', { kind: 'tap', serial: 'emulator-5554', screen: portrait, x: 1, y: 1 }))
    expect(container.querySelectorAll('circle.gesture-tap')).toHaveLength(0)

    b.emit(toolCall('3', { kind: 'tap', serial: 'emulator-5556', screen: portrait, x: 1, y: 1 }))
    expect(container.querySelectorAll('circle.gesture-tap')).toHaveLength(1)
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
