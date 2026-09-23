// @vitest-environment jsdom
import { renderHook, act, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { AppSnapshot, MainEvent, RendererApi } from '../../../shared/types/ipc'
import { targetSerial, useAppState } from './useAppState'

const baseSnapshot: AppSnapshot = {
  sdk: { ok: true, sdkRoot: '/opt/sdk' },
  server: { url: 'http://127.0.0.1:9321/mcp', port: 9321, token: 'token-value' },
  avds: [{ name: 'Pixel_7_API_34', running: false, serial: null }],
  devices: [],
  activeSerial: null,
  toolCalls: [],
  trackingFailure: null
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
    expect(result.current.snapshot?.sdk).toEqual({ ok: true, sdkRoot: '/opt/sdk' })
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

  it('appends tool calls in arrival order', async () => {
    const { result } = renderHook(() => useAppState())
    await waitFor(() => expect(result.current.loading).toBe(false))

    const record = { id: 'a', tool: 'ui_tap', argsSummary: '{}', startedAt: 1, durationMs: 2, ok: true }
    act(() => listener?.({ type: 'tool_call', record }))

    expect(result.current.snapshot?.toolCalls).toEqual([record])
  })

  it('replaces the avd list when it changes', async () => {
    const { result } = renderHook(() => useAppState())
    await waitFor(() => expect(result.current.loading).toBe(false))

    act(() =>
      listener?.({
        type: 'avds_changed',
        avds: [{ name: 'Pixel_7_API_34', running: true, serial: 'emulator-5554' }]
      })
    )

    expect(result.current.snapshot?.avds[0]?.running).toBe(true)
  })

  it('records a tracking failure when a tracking_failed event arrives', async () => {
    const { result } = renderHook(() => useAppState())
    await waitFor(() => expect(result.current.loading).toBe(false))

    act(() =>
      listener?.({
        type: 'tracking_failed',
        failure: { error: null, exitCode: 1 }
      })
    )

    expect(result.current.snapshot?.trackingFailure).toEqual({ error: null, exitCode: 1 })
  })

  it('unsubscribes on unmount so events do not hit a dead component', async () => {
    const { result, unmount } = renderHook(() => useAppState())
    await waitFor(() => expect(result.current.loading).toBe(false))

    unmount()

    expect(unsubscribed).toBe(true)
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

  it('does not duplicate a tool_call record that is buffered but already present in the resolved snapshot', async () => {
    const record = { id: 'a', tool: 'ui_tap', argsSummary: '{}', startedAt: 1, durationMs: 2, ok: true }
    const snapshotWithRecord: AppSnapshot = { ...baseSnapshot, toolCalls: [record] }
    const pending = deferred<AppSnapshot>()
    installApi(vi.fn(() => pending.promise))

    const { result } = renderHook(() => useAppState())

    act(() => listener?.({ type: 'tool_call', record }))

    await act(async () => {
      pending.resolve(snapshotWithRecord)
      await pending.promise
    })

    await waitFor(() => expect(result.current.loading).toBe(false))
    expect(result.current.snapshot?.toolCalls).toEqual([record])
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
