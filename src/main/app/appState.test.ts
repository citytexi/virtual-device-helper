import { describe, expect, it, vi } from 'vitest'
import type { VirtualDeviceCatalog } from '../device/virtualDeviceCatalog'
import type { DeviceRegistry, RegistryEvent } from '../device/registry'
import type { McpServerHandle } from '../mcp/httpServer'
import { deviceError } from '../../shared/types/errors'
import type { AppSnapshot, MainEvent } from '../../shared/types/ipc'
import { createAppState } from './appState'

function parts() {
  let registryListener: ((event: RegistryEvent) => void) | undefined

  const registry = {
    start: vi.fn(),
    stop: vi.fn(),
    serials: vi.fn(() => ['emulator-5554']),
    resolve: vi.fn(),
    setActive: vi.fn(),
    clearActive: vi.fn(),
    getActive: vi.fn(() => 'emulator-5554'),
    run: vi.fn((_serial: string, task: () => Promise<unknown>) => task()),
    on: vi.fn((listener: (event: RegistryEvent) => void) => {
      registryListener = listener
      return () => {}
    })
  } as unknown as DeviceRegistry

  const catalog = {
    list: vi.fn(async () => [{ platform: 'android', id: 'Pixel_7_API_34', name: 'Pixel_7_API_34', running: true, serial: 'emulator-5554', osVersion: null }]),
    boot: vi.fn(async () => 'emulator-5554'),
    shutdown: vi.fn(async () => {})
  } as unknown as VirtualDeviceCatalog

  const server: McpServerHandle = {
    url: 'http://127.0.0.1:9321/mcp',
    port: 9321,
    token: 'token-value',
    close: vi.fn(async () => {})
  }

  return { registry, catalog, server, fire: (event: RegistryEvent) => registryListener?.(event) }
}

const ANDROID_READY: AppSnapshot['platforms'] = {
  android: { ok: true, location: '/opt/sdk', notes: [] },
  ios: { ok: false, reason: 'macOS에서만 iOS 시뮬레이터를 쓸 수 있다', searched: [] }
}
const NONE_READY: AppSnapshot['platforms'] = {
  android: { ok: false, reason: 'Android SDK를 찾지 못했다', searched: ['/opt/sdk/platform-tools/adb'] },
  ios: { ok: false, reason: 'macOS에서만 iOS 시뮬레이터를 쓸 수 있다', searched: [] }
}

describe('createAppState snapshot', () => {
  it('reports the platform status it was given', async () => {
    const p = parts()
    const state = createAppState({
      platforms: NONE_READY,
      registry: p.registry,
      catalog: p.catalog,
      server: null
    })

    const snapshot = await state.snapshot()

    expect(snapshot.platforms).toEqual(NONE_READY)
    expect(snapshot.virtualDevices).toEqual([])
    expect(snapshot.server).toBeNull()
  })

  it('includes virtualDevices, devices, active serial and the server endpoint', async () => {
    const p = parts()
    const state = createAppState({
      platforms: ANDROID_READY,
      registry: p.registry,
      catalog: p.catalog,
      server: p.server
    })

    const snapshot = await state.snapshot()

    expect(snapshot.virtualDevices).toEqual([{ platform: 'android', id: 'Pixel_7_API_34', name: 'Pixel_7_API_34', running: true, serial: 'emulator-5554', osVersion: null }])
    expect(snapshot.devices).toEqual(['emulator-5554'])
    expect(snapshot.activeSerial).toBe('emulator-5554')
    expect(snapshot.server).toEqual({ url: 'http://127.0.0.1:9321/mcp', port: 9321, token: 'token-value' })
  })

  it('lists virtual devices when only iOS is ready', async () => {
    const p = parts()
    const state = createAppState({
      platforms: { android: NONE_READY.android, ios: { ok: true, location: '/Applications/Xcode.app/Contents/Developer', notes: [] } },
      registry: p.registry,
      catalog: p.catalog,
      server: p.server
    })

    const snapshot = await state.snapshot()

    expect(snapshot.virtualDevices).toHaveLength(1)
  })

  it('keeps at most 1000 timeline entries', async () => {
    const p = parts()
    const state = createAppState({
      platforms: ANDROID_READY,
      registry: p.registry,
      catalog: p.catalog,
      server: p.server
    })

    for (let i = 0; i < 1005; i += 1) {
      state.recordToolCall({
        id: String(i),
        tool: 'ui_tap',
        argsSummary: '{}',
        startedAt: i,
        durationMs: 1,
        ok: true,
        detail: { args: '{}' }
      })
    }

    const snapshot = await state.snapshot()

    expect(snapshot.timeline).toHaveLength(1000)
    expect(snapshot.timeline[0]?.id).toBe('5')
    expect(snapshot.timeline.at(-1)?.id).toBe('1004')
  })

  it('keeps entries in record order even when a later tool call started earlier', async () => {
    const p = parts()
    const state = createAppState({
      platforms: ANDROID_READY,
      registry: p.registry,
      catalog: p.catalog,
      server: p.server
    })

    p.fire({ type: 'device_connected', serial: 'emulator-5554' })
    state.recordToolCall({
      id: 'late',
      tool: 'ui_tap',
      argsSummary: '{}',
      startedAt: 0,
      durationMs: 1,
      ok: true,
      detail: { args: '{}' }
    })

    const snapshot = await state.snapshot()

    expect(snapshot.timeline.map((entry) => entry.kind)).toEqual(['device', 'tool_call'])
  })
})

describe('createAppState events', () => {
  it('forwards registry events to subscribers', async () => {
    const p = parts()
    const state = createAppState({
      platforms: ANDROID_READY,
      registry: p.registry,
      catalog: p.catalog,
      server: p.server
    })

    const seen: unknown[] = []
    state.onEvent((event) => seen.push(event))

    p.fire({ type: 'active_changed', serial: 'emulator-5556' })

    expect(seen).toContainEqual({ type: 'active_changed', serial: 'emulator-5556' })
  })

  it('emits a timeline event for a tool call and puts it in the snapshot', async () => {
    const p = parts()
    const state = createAppState({
      platforms: ANDROID_READY,
      registry: p.registry,
      catalog: p.catalog,
      server: p.server
    })

    const seen: unknown[] = []
    state.onEvent((event) => seen.push(event))

    state.recordToolCall({
      id: 'a',
      tool: 'ui_tap',
      argsSummary: '{"x":1}',
      startedAt: 10,
      durationMs: 2,
      ok: true,
      serial: 'emulator-5554',
      gesture: { kind: 'tap', serial: 'emulator-5554', x: 0.5, y: 0.5 },
      detail: { args: '{"x":1}', resultSummary: '탭' }
    })

    const entry = {
      kind: 'tool_call',
      id: 'a',
      at: 10,
      serial: 'emulator-5554',
      tool: 'ui_tap',
      argsSummary: '{"x":1}',
      durationMs: 2,
      ok: true,
      gesture: { kind: 'tap', serial: 'emulator-5554', x: 0.5, y: 0.5 },
      detail: { args: '{"x":1}', resultSummary: '탭' }
    }
    expect(seen).toEqual([{ type: 'timeline', entry }])
    await expect(state.snapshot().then((snapshot) => snapshot.timeline)).resolves.toEqual([entry])
  })

  it('carries the error kind of a failed tool call', async () => {
    const p = parts()
    const state = createAppState({
      platforms: ANDROID_READY,
      registry: p.registry,
      catalog: p.catalog,
      server: p.server
    })

    state.recordToolCall({
      id: 'a',
      tool: 'ui_tap',
      argsSummary: '{}',
      startedAt: 10,
      durationMs: 2,
      ok: false,
      errorKind: 'no_device',
      detail: { args: '{}' }
    })

    const [entry] = (await state.snapshot()).timeline
    expect(entry).toMatchObject({ kind: 'tool_call', ok: false, errorKind: 'no_device' })
    expect(entry).not.toHaveProperty('serial')
  })

  it('records registry connect, disconnect and active change as device entries', async () => {
    const p = parts()
    const state = createAppState({
      platforms: ANDROID_READY,
      registry: p.registry,
      catalog: p.catalog,
      server: p.server
    })

    const seen: MainEvent[] = []
    state.onEvent((event) => seen.push(event))

    p.fire({ type: 'device_connected', serial: 'emulator-5554' })
    p.fire({ type: 'active_changed', serial: 'emulator-5554' })
    p.fire({ type: 'active_changed', serial: null })
    p.fire({ type: 'device_disconnected', serial: 'emulator-5554' })
    p.fire({ type: 'tracking_failed', failure: { error: null, exitCode: 1 } })

    const timeline = (await state.snapshot()).timeline
    expect(timeline.map((entry) => (entry.kind === 'device' ? [entry.event, entry.serial] : null))).toEqual([
      ['connected', 'emulator-5554'],
      ['active_changed', 'emulator-5554'],
      ['active_changed', null],
      ['disconnected', 'emulator-5554']
    ])
    for (const entry of timeline) {
      expect(typeof entry.id).toBe('string')
      expect(typeof entry.at).toBe('number')
    }
    expect(new Set(timeline.map((entry) => entry.id)).size).toBe(timeline.length)
    expect(seen.filter((event) => event.type === 'timeline').map((event) => event.entry)).toEqual(timeline)
  })

  it('records device events given by the managers', async () => {
    const p = parts()
    const state = createAppState({
      platforms: ANDROID_READY,
      registry: p.registry,
      catalog: p.catalog,
      server: p.server
    })

    state.recordDeviceEvent('emulator-5554', 'stream_started')
    state.recordDeviceEvent('emulator-5554', 'log_stopped')

    const timeline = (await state.snapshot()).timeline
    expect(timeline).toMatchObject([
      { kind: 'device', serial: 'emulator-5554', event: 'stream_started' },
      { kind: 'device', serial: 'emulator-5554', event: 'log_stopped' }
    ])
  })

  it('emits server_changed and updates the snapshot when the endpoint opens', async () => {
    const p = parts()
    const state = createAppState({
      platforms: ANDROID_READY,
      registry: p.registry,
      catalog: p.catalog,
      server: null
    })

    const seen: unknown[] = []
    state.onEvent((event) => seen.push(event))

    state.setServer(p.server)

    expect(seen).toContainEqual({
      type: 'server_changed',
      server: { url: 'http://127.0.0.1:9321/mcp', port: 9321, token: 'token-value' }
    })
    await expect(state.snapshot().then((snapshot) => snapshot.server)).resolves.toEqual({
      url: 'http://127.0.0.1:9321/mcp',
      port: 9321,
      token: 'token-value'
    })
  })

  it('emits virtual_devices_changed after a device connects so the list refreshes', async () => {
    const p = parts()
    const state = createAppState({
      platforms: ANDROID_READY,
      registry: p.registry,
      catalog: p.catalog,
      server: p.server
    })

    const seen: Array<{ type: string }> = []
    state.onEvent((event) => seen.push(event))

    p.fire({ type: 'device_connected', serial: 'emulator-5554' })
    await vi.waitFor(() => expect(seen.some((event) => event.type === 'virtual_devices_changed')).toBe(true))
  })
})

describe('createAppState tracking failures', () => {
  it('has no tracking failure in the snapshot until one happens', async () => {
    const p = parts()
    const state = createAppState({
      platforms: ANDROID_READY,
      registry: p.registry,
      catalog: p.catalog,
      server: p.server
    })

    const snapshot = await state.snapshot()

    expect(snapshot.trackingFailure).toBeNull()
  })

  it('flattens the DeviceError into a plain ToolError so it survives IPC', async () => {
    const p = parts()
    const state = createAppState({
      platforms: ANDROID_READY,
      registry: p.registry,
      catalog: p.catalog,
      server: p.server
    })

    const seen: unknown[] = []
    state.onEvent((event) => seen.push(event))

    p.fire({
      type: 'tracking_failed',
      failure: {
        error: deviceError('adb_not_found', 'adb를 실행할 수 없다', 'SDK 경로를 확인해라'),
        exitCode: null
      }
    })

    const expected = {
      error: { kind: 'adb_not_found', message: 'adb를 실행할 수 없다', hint: 'SDK 경로를 확인해라', details: undefined },
      exitCode: null
    }
    expect(seen).toEqual([{ type: 'tracking_failed', failure: expected }])
    // 클래스 인스턴스가 아니라 평평한 객체여야 structured clone을 버틴다.
    const event = seen[0] as { failure: { error: object } }
    expect(Object.getPrototypeOf(event.failure.error)).toBe(Object.prototype)
    await expect(state.snapshot().then((snapshot) => snapshot.trackingFailure)).resolves.toEqual(expected)
  })

  it('keeps a null error when the tracker exited without one', async () => {
    const p = parts()
    const state = createAppState({
      platforms: ANDROID_READY,
      registry: p.registry,
      catalog: p.catalog,
      server: p.server
    })

    p.fire({ type: 'tracking_failed', failure: { error: null, exitCode: 1 } })

    await expect(state.snapshot().then((snapshot) => snapshot.trackingFailure)).resolves.toEqual({
      error: null,
      exitCode: 1
    })
  })

  it('does not refresh the catalog list for a tracking failure', async () => {
    const p = parts()
    const state = createAppState({
      platforms: ANDROID_READY,
      registry: p.registry,
      catalog: p.catalog,
      server: p.server
    })

    const seen: Array<{ type: string }> = []
    state.onEvent((event) => seen.push(event))

    p.fire({ type: 'tracking_failed', failure: { error: null, exitCode: 1 } })
    await new Promise((resolve) => setTimeout(resolve, 0))

    expect(p.catalog.list).not.toHaveBeenCalled()
    expect(seen.map((event) => event.type)).toEqual(['tracking_failed'])
  })
})

describe('createAppState catalog refresh failures', () => {
  it('swallows a failing catalog list after a device event instead of leaking a rejection', async () => {
    const p = parts()
    ;(p.catalog.list as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('emulator가 없다'))
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {})
    const unhandled = vi.fn()
    process.on('unhandledRejection', unhandled)

    try {
      const state = createAppState({
        platforms: ANDROID_READY,
        registry: p.registry,
        catalog: p.catalog,
        server: p.server
      })
      const seen: Array<{ type: string }> = []
      state.onEvent((event) => seen.push(event))

      p.fire({ type: 'device_disconnected', serial: 'emulator-5554' })
      await vi.waitFor(() => expect(errors).toHaveBeenCalled())
      await new Promise((resolve) => setTimeout(resolve, 10))

      expect(unhandled).not.toHaveBeenCalled()
      expect(seen.map((event) => event.type)).toEqual(['device_disconnected', 'timeline'])
    } finally {
      process.off('unhandledRejection', unhandled)
      errors.mockRestore()
    }
  })
})

describe('createAppState snapshot when the catalog list fails', () => {
  it('resolves with an empty catalog list and keeps the other fields', async () => {
    const p = parts()
    ;(p.catalog.list as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('emulator -list-avds가 실패했다'))
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {})

    try {
      const state = createAppState({
        platforms: ANDROID_READY,
        registry: p.registry,
        catalog: p.catalog,
        server: p.server
      })

      const snapshot = await state.snapshot()

      expect(snapshot).toEqual({
        platforms: ANDROID_READY,
        server: { url: 'http://127.0.0.1:9321/mcp', port: 9321, token: 'token-value' },
        virtualDevices: [],
        devices: ['emulator-5554'],
        activeSerial: 'emulator-5554',
        timeline: [],
        trackingFailure: null
      })
      expect(errors).toHaveBeenCalled()
    } finally {
      errors.mockRestore()
    }
  })
})
