// @vitest-environment jsdom
import { renderHook, act, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { AppSnapshot, MainEvent, RendererApi, TimelineEntry } from '../../../shared/types/ipc'
import { targetSerial, useAppState } from './useAppState'

const baseSnapshot: AppSnapshot = {
  platforms: {
    android: { ok: true, location: '/opt/sdk', notes: [] },
    ios: { ok: true, location: '/Applications/Xcode.app/Contents/Developer', notes: [] }
  },
  server: { url: 'http://127.0.0.1:9321/mcp', port: 9321, token: 'token-value' },
  virtualDevices: [{ platform: 'android', id: 'Pixel_7_API_34', name: 'Pixel_7_API_34', running: false, serial: null, osVersion: null }],
  devices: [],
  activeSerial: null,
  screens: [],
  timeline: [],
  trackingFailures: { android: null, ios: null }
}

function toolCallEntry(id: string, at: number): TimelineEntry {
  return {
    kind: 'tool_call',
    id,
    at,
    tool: 'ui_tap',
    argsSummary: '{}',
    durationMs: 2,
    ok: true,
    detail: { args: '{}' }
  }
}

let listener: ((event: MainEvent) => void) | undefined
let unsubscribed = false

function deferred<T>(): {
  promise: Promise<T>
  resolve: (value: T) => void
  reject: (reason: unknown) => void
} {
  let resolve!: (value: T) => void
  let reject!: (reason: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

function installApi(getSnapshot: RendererApi['getSnapshot']): void {
  const api: Partial<RendererApi> = {
    getSnapshot,
    onEvent: (callback) => {
      listener = callback
      return () => {
        unsubscribed = true
      }
    }
  }
  ;(window as unknown as { api: RendererApi }).api = api as RendererApi
}

beforeEach(() => {
  listener = undefined
  unsubscribed = false
  installApi(vi.fn(async () => baseSnapshot))
})

describe('useAppState', () => {
  it('starts in a loading state and then fills in the snapshot', async () => {
    const { result } = renderHook(() => useAppState())

    expect(result.current.loading).toBe(true)

    await waitFor(() => expect(result.current.loading).toBe(false))
    expect(result.current.snapshot?.platforms.android).toEqual({ ok: true, location: '/opt/sdk', notes: [] })
  })

  it('adds a device when a device_connected event arrives', async () => {
    const { result } = renderHook(() => useAppState())
    await waitFor(() => expect(result.current.loading).toBe(false))

    act(() => listener?.({ type: 'device_connected', serial: 'emulator-5554' }))

    expect(result.current.snapshot?.devices).toEqual(['emulator-5554'])
  })

  it('removes a device when a device_disconnected event arrives', async () => {
    const { result } = renderHook(() => useAppState())
    await waitFor(() => expect(result.current.loading).toBe(false))

    act(() => listener?.({ type: 'device_connected', serial: 'emulator-5554' }))
    act(() => listener?.({ type: 'device_disconnected', serial: 'emulator-5554' }))

    expect(result.current.snapshot?.devices).toEqual([])
  })

  it('updates the active serial', async () => {
    const { result } = renderHook(() => useAppState())
    await waitFor(() => expect(result.current.loading).toBe(false))

    act(() => listener?.({ type: 'active_changed', serial: 'emulator-5554' }))

    expect(result.current.snapshot?.activeSerial).toBe('emulator-5554')
  })

  it('appends timeline entries in arrival order', async () => {
    const { result } = renderHook(() => useAppState())
    await waitFor(() => expect(result.current.loading).toBe(false))

    const first = toolCallEntry('a', 5)
    const second: TimelineEntry = { kind: 'device', id: 'b', at: 1, serial: 'emulator-5554', event: 'connected' }
    act(() => listener?.({ type: 'timeline', entry: first }))
    act(() => listener?.({ type: 'timeline', entry: second }))

    // at으로 다시 정렬하지 않는다.
    expect(result.current.snapshot?.timeline).toEqual([first, second])
  })

  it('trims the renderer timeline to 1000', async () => {
    const full = Array.from({ length: 1000 }, (_, i) => toolCallEntry(String(i), i))
    installApi(vi.fn(async () => ({ ...baseSnapshot, timeline: full })))
    const { result } = renderHook(() => useAppState())
    await waitFor(() => expect(result.current.loading).toBe(false))

    act(() => listener?.({ type: 'timeline', entry: toolCallEntry('new', 1000) }))

    const timeline = result.current.snapshot?.timeline ?? []
    expect(timeline).toHaveLength(1000)
    expect(timeline[0]?.id).toBe('1')
    expect(timeline.at(-1)?.id).toBe('new')
  })

  it('replaces the catalog list when it changes', async () => {
    const { result } = renderHook(() => useAppState())
    await waitFor(() => expect(result.current.loading).toBe(false))

    act(() =>
      listener?.({
        type: 'virtual_devices_changed',
        virtualDevices: [{ platform: 'android', id: 'Pixel_7_API_34', name: 'Pixel_7_API_34', running: true, serial: 'emulator-5554', osVersion: null }]
      })
    )

    expect(result.current.snapshot?.virtualDevices[0]?.running).toBe(true)
  })

  it('records a tracking failure when a tracking_failed event arrives', async () => {
    const { result } = renderHook(() => useAppState())
    await waitFor(() => expect(result.current.loading).toBe(false))

    act(() =>
      listener?.({
        type: 'tracking_failed',
        failure: { platform: 'ios', label: 'iOS', error: null, exitCode: 1 }
      })
    )

    expect(result.current.snapshot?.trackingFailures).toEqual({
      android: null,
      ios: { platform: 'ios', label: 'iOS', error: null, exitCode: 1 }
    })
  })

  it('unsubscribes on unmount so events do not hit a dead component', async () => {
    const { result, unmount } = renderHook(() => useAppState())
    await waitFor(() => expect(result.current.loading).toBe(false))

    unmount()

    expect(unsubscribed).toBe(true)
  })

  it('applies a screens_changed event', async () => {
    const { result } = renderHook(() => useAppState())
    await waitFor(() => expect(result.current.loading).toBe(false))
    const screens = [{ id: 'x', epoch: 2, serial: 'emulator-5554', label: 'Pixel' }]

    act(() => listener?.({ type: 'screens_changed', screens }))

    expect(result.current.snapshot?.screens).toEqual(screens)
  })

  it('applies a screens_changed event that arrived before the snapshot after the replay', async () => {
    const pending = deferred<AppSnapshot>()
    installApi(vi.fn(() => pending.promise))
    const { result } = renderHook(() => useAppState())
    const screens = [{ id: 'y', epoch: 1, serial: 'emulator-5554', label: 'Pixel' }]

    act(() => listener?.({ type: 'screens_changed', screens }))
    await act(async () => {
      pending.resolve(baseSnapshot)
      await pending.promise
    })

    await waitFor(() => expect(result.current.loading).toBe(false))
    expect(result.current.snapshot?.screens).toEqual(screens)
  })

  it('buffers an event that arrives before the initial snapshot resolves and applies it once the snapshot lands', async () => {
    const pending = deferred<AppSnapshot>()
    installApi(vi.fn(() => pending.promise))

    const { result } = renderHook(() => useAppState())
    expect(result.current.loading).toBe(true)

    act(() => listener?.({ type: 'device_connected', serial: 'emulator-5554' }))
    // 스냅샷이 아직 안 왔으니 버퍼에만 쌓이고 화면은 그대로 로딩 중이다.
    expect(result.current.loading).toBe(true)
    expect(result.current.snapshot).toBeNull()

    await act(async () => {
      pending.resolve(baseSnapshot)
      await pending.promise
    })

    await waitFor(() => expect(result.current.loading).toBe(false))
    expect(result.current.snapshot?.devices).toEqual(['emulator-5554'])
  })

  it('does not duplicate an entry that arrives before and inside the snapshot', async () => {
    const entry = toolCallEntry('a', 1)
    const later = toolCallEntry('b', 2)
    const snapshotWithEntry: AppSnapshot = { ...baseSnapshot, timeline: [entry] }
    const pending = deferred<AppSnapshot>()
    installApi(vi.fn(() => pending.promise))

    const { result } = renderHook(() => useAppState())

    act(() => listener?.({ type: 'timeline', entry }))
    act(() => listener?.({ type: 'timeline', entry: later }))

    await act(async () => {
      pending.resolve(snapshotWithEntry)
      await pending.promise
    })

    await waitFor(() => expect(result.current.loading).toBe(false))
    expect(result.current.snapshot?.timeline).toEqual([entry, later])

    // 스냅샷 뒤에 같은 id가 다시 와도 쌓지 않는다.
    act(() => listener?.({ type: 'timeline', entry: later }))
    expect(result.current.snapshot?.timeline).toEqual([entry, later])
  })

  it('sets an error and stops loading when getSnapshot rejects, leaving the snapshot null', async () => {
    installApi(
      vi.fn(async () => {
        throw new Error('ipc offline')
      })
    )

    const { result } = renderHook(() => useAppState())
    expect(result.current.loading).toBe(true)

    await waitFor(() => expect(result.current.loading).toBe(false))

    expect(result.current.error).toBe('ipc offline')
    expect(result.current.snapshot).toBeNull()
  })
})

describe('targetSerial', () => {
  it('prefers the explicit active serial', () => {
    const snapshot: AppSnapshot = {
      ...baseSnapshot,
      devices: ['emulator-5554', 'emulator-5556'],
      activeSerial: 'emulator-5556'
    }

    expect(targetSerial(snapshot)).toBe('emulator-5556')
  })

  it('falls back to the single connected device when nothing is explicitly active', () => {
    const snapshot: AppSnapshot = {
      ...baseSnapshot,
      devices: ['emulator-5554'],
      activeSerial: null
    }

    expect(targetSerial(snapshot)).toBe('emulator-5554')
  })

  it('returns null when there are no devices and nothing is active', () => {
    const snapshot: AppSnapshot = { ...baseSnapshot, devices: [], activeSerial: null }

    expect(targetSerial(snapshot)).toBeNull()
  })

  it('returns null when there are two devices and nothing is explicitly active', () => {
    const snapshot: AppSnapshot = {
      ...baseSnapshot,
      devices: ['emulator-5554', 'emulator-5556'],
      activeSerial: null
    }

    expect(targetSerial(snapshot)).toBeNull()
  })
})
