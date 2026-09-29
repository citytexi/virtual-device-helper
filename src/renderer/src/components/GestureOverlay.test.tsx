// @vitest-environment jsdom
import { act, render } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Gesture, MainEvent, TimelineEntry } from '../../../shared/types/ipc'
import { GESTURE_VISIBLE_MS, GestureOverlay, gestureToVideo } from './GestureOverlay'

function toolCall(id: string, gesture?: Gesture): MainEvent {
  const entry: TimelineEntry = {
    kind: 'tool_call',
    id,
    at: 0,
    tool: gesture?.kind === 'swipe' ? 'ui_swipe' : 'ui_tap',
    argsSummary: '{}',
    durationMs: 1,
    ok: true,
    detail: { args: '{}' },
    ...(gesture ? { gesture } : {})
  }
  return { type: 'timeline', entry }
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
  it('scales normalized coordinates by the video size', () => {
    expect(gestureToVideo({ kind: 'tap', serial: 's', x: 0.5, y: 0.25 }, { width: 1024, height: 2048 })).toEqual({
      kind: 'tap',
      x: 512,
      y: 512
    })
  })

  it('draws a landscape video without any rotation guess', () => {
    expect(
      gestureToVideo({ kind: 'swipe', serial: 's', x1: 0, y1: 0.5, x2: 1, y2: 0.5 }, { width: 2048, height: 1024 })
    ).toEqual({ kind: 'swipe', x1: 0, y1: 512, x2: 2048, y2: 512 })
  })
})

describe('GestureOverlay', () => {
  const video = { width: 540, height: 1200 }

  it('draws the gesture of a timeline tool_call entry', () => {
    const b = bus()
    const { container } = render(<GestureOverlay serial="emulator-5554" video={video} subscribe={b.subscribe} />)

    b.emit(toolCall('1', { kind: 'tap', serial: 'emulator-5554', x: 0.5, y: 0.25 }))

    const circle = container.querySelector('circle.gesture-tap')
    expect(circle?.getAttribute('cx')).toBe('270')
    expect(circle?.getAttribute('cy')).toBe('300')
  })

  it('draws a tap of its own device', () => {
    const b = bus()
    const { container } = render(<GestureOverlay serial="emulator-5554" video={video} subscribe={b.subscribe} />)

    b.emit(toolCall('1', { kind: 'tap', serial: 'emulator-5554', x: 0.5, y: 0.5 }))

    const circle = container.querySelector('circle.gesture-tap')
    expect(circle?.getAttribute('cx')).toBe('270')
    expect(circle?.getAttribute('cy')).toBe('600')
  })

  it('draws a swipe as a line with an end mark', () => {
    const b = bus()
    const { container } = render(<GestureOverlay serial="emulator-5554" video={video} subscribe={b.subscribe} />)

    b.emit(toolCall('1', { kind: 'swipe', serial: 'emulator-5554', x1: 0.2, y1: 0.75, x2: 0.2, y2: 0.25 }))

    const line = container.querySelector('g.gesture-swipe line')
    expect(line?.getAttribute('y1')).toBe('900')
    expect(line?.getAttribute('y2')).toBe('300')

    const circle = container.querySelector('g.gesture-swipe circle')
    expect(circle?.getAttribute('cx')).toBe('108')
    expect(circle?.getAttribute('cy')).toBe('300')
  })

  it.each([
    ['another device', toolCall('1', { kind: 'tap', serial: 'emulator-5556', x: 0.1, y: 0.1 })],
    ['a call without a gesture', toolCall('1')],
    ['a non timeline event', { type: 'active_changed', serial: 'emulator-5554' } as MainEvent],
    [
      'a device timeline entry',
      {
        type: 'timeline',
        entry: { kind: 'device', id: 'd', at: 0, serial: 'emulator-5554', event: 'stream_started' }
      } as MainEvent
    ]
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
    const tap = (id: string) => toolCall(id, { kind: 'tap', serial: 'emulator-5554', x: 0.1, y: 0.1 })

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

    b.emit(toolCall('1', { kind: 'tap', serial: 'emulator-5554', x: 0.1, y: 0.1 }))
    expect(container.querySelectorAll('circle.gesture-tap')).toHaveLength(1)

    rerender(<GestureOverlay serial="emulator-5556" video={video} subscribe={b.subscribe} />)

    expect(container.querySelectorAll('circle.gesture-tap')).toHaveLength(0)
    expect(vi.getTimerCount()).toBe(0)

    // A용 이벤트는 더 이상 그려지지 않고, B용 이벤트만 그려진다.
    b.emit(toolCall('2', { kind: 'tap', serial: 'emulator-5554', x: 0.1, y: 0.1 }))
    expect(container.querySelectorAll('circle.gesture-tap')).toHaveLength(0)

    b.emit(toolCall('3', { kind: 'tap', serial: 'emulator-5556', x: 0.1, y: 0.1 }))
    expect(container.querySelectorAll('circle.gesture-tap')).toHaveLength(1)
  })

  it('unsubscribes and cancels pending timers when unmounted', () => {
    vi.useFakeTimers()
    const b = bus()
    const { unmount } = render(<GestureOverlay serial="emulator-5554" video={video} subscribe={b.subscribe} />)
    b.emit(toolCall('1', { kind: 'tap', serial: 'emulator-5554', x: 0.1, y: 0.1 }))

    unmount()

    expect(b.listening()).toBe(false)
    expect(vi.getTimerCount()).toBe(0)
  })
})
