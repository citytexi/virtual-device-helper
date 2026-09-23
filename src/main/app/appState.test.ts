import { describe, expect, it, vi } from 'vitest'
import type { AvdController } from '../device/avdController'
import type { DeviceRegistry, RegistryEvent } from '../device/registry'
import type { McpServerHandle } from '../mcp/httpServer'
import { deviceError } from '../../shared/types/errors'
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

  const avd = {
    list: vi.fn(async () => [{ name: 'Pixel_7_API_34', running: true, serial: 'emulator-5554' }]),
    boot: vi.fn(async () => 'emulator-5554'),
    shutdown: vi.fn(async () => {})
  } as unknown as AvdController

  const server: McpServerHandle = {
    url: 'http://127.0.0.1:9321/mcp',
    port: 9321,
    token: 'token-value',
    close: vi.fn(async () => {})
  }

  return { registry, avd, server, fire: (event: RegistryEvent) => registryListener?.(event) }
}

describe('createAppState snapshot', () => {
  it('reports the sdk status it was given', async () => {
    const p = parts()
    const state = createAppState({
      sdk: { ok: false, searched: ['/opt/sdk/platform-tools/adb'] },
      registry: p.registry,
      avd: p.avd,
      server: null
    })

    const snapshot = await state.snapshot()

    expect(snapshot.sdk).toEqual({ ok: false, searched: ['/opt/sdk/platform-tools/adb'] })
    expect(snapshot.server).toBeNull()
  })

  it('includes avds, devices, active serial and the server endpoint', async () => {
    const p = parts()
    const state = createAppState({
      sdk: { ok: true, sdkRoot: '/opt/sdk' },
      registry: p.registry,
      avd: p.avd,
      server: p.server
    })

    const snapshot = await state.snapshot()

    expect(snapshot.avds).toEqual([{ name: 'Pixel_7_API_34', running: true, serial: 'emulator-5554' }])
    expect(snapshot.devices).toEqual(['emulator-5554'])
    expect(snapshot.activeSerial).toBe('emulator-5554')
    expect(snapshot.server).toEqual({ url: 'http://127.0.0.1:9321/mcp', port: 9321, token: 'token-value' })
  })

  it('keeps recorded tool calls newest last and caps how many it holds', async () => {
    const p = parts()
    const state = createAppState({
      sdk: { ok: true, sdkRoot: '/opt/sdk' },
      registry: p.registry,
      avd: p.avd,
      server: p.server,
      toolCallLimit: 3
    })

    for (let i = 0; i < 5; i += 1) {
      state.recordToolCall({
        id: String(i),
        tool: 'ui_tap',
        argsSummary: '{}',
        startedAt: i,
        durationMs: 1,
        ok: true
      })
    }

    const snapshot = await state.snapshot()

    expect(snapshot.toolCalls.map((record) => record.id)).toEqual(['2', '3', '4'])
  })
})

describe('createAppState events', () => {
  it('forwards registry events to subscribers', async () => {
    const p = parts()
    const state = createAppState({
      sdk: { ok: true, sdkRoot: '/opt/sdk' },
      registry: p.registry,
      avd: p.avd,
      server: p.server
    })

    const seen: unknown[] = []
    state.onEvent((event) => seen.push(event))

    p.fire({ type: 'active_changed', serial: 'emulator-5556' })

    expect(seen).toContainEqual({ type: 'active_changed', serial: 'emulator-5556' })
  })

  it('emits a tool_call event when a call is recorded', () => {
    const p = parts()
    const state = createAppState({
      sdk: { ok: true, sdkRoot: '/opt/sdk' },
      registry: p.registry,
      avd: p.avd,
      server: p.server
    })

    const seen: unknown[] = []
    state.onEvent((event) => seen.push(event))

    const record = {
      id: 'a',
      tool: 'screenshot',
      argsSummary: '{}',
      startedAt: 1,
      durationMs: 2,
      ok: true
    }
    state.recordToolCall(record)

    expect(seen).toEqual([{ type: 'tool_call', record }])
  })

  it('emits server_changed and updates the snapshot when the endpoint opens', async () => {
    const p = parts()
    const state = createAppState({
      sdk: { ok: true, sdkRoot: '/opt/sdk' },
      registry: p.registry,
      avd: p.avd,
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

  it('emits avds_changed after a device connects so the list refreshes', async () => {
    const p = parts()
    const state = createAppState({
      sdk: { ok: true, sdkRoot: '/opt/sdk' },
      registry: p.registry,
      avd: p.avd,
      server: p.server
    })

    const seen: Array<{ type: string }> = []
    state.onEvent((event) => seen.push(event))

    p.fire({ type: 'device_connected', serial: 'emulator-5554' })
    await vi.waitFor(() => expect(seen.some((event) => event.type === 'avds_changed')).toBe(true))
  })
})

describe('createAppState tracking failures', () => {
  it('has no tracking failure in the snapshot until one happens', async () => {
    const p = parts()
    const state = createAppState({
      sdk: { ok: true, sdkRoot: '/opt/sdk' },
      registry: p.registry,
      avd: p.avd,
      server: p.server
    })

    const snapshot = await state.snapshot()

    expect(snapshot.trackingFailure).toBeNull()
  })

  it('flattens the DeviceError into a plain ToolError so it survives IPC', async () => {
    const p = parts()
    const state = createAppState({
      sdk: { ok: true, sdkRoot: '/opt/sdk' },
      registry: p.registry,
      avd: p.avd,
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
      sdk: { ok: true, sdkRoot: '/opt/sdk' },
      registry: p.registry,
      avd: p.avd,
      server: p.server
    })

    p.fire({ type: 'tracking_failed', failure: { error: null, exitCode: 1 } })

    await expect(state.snapshot().then((snapshot) => snapshot.trackingFailure)).resolves.toEqual({
      error: null,
      exitCode: 1
    })
  })

  it('does not refresh the avd list for a tracking failure', async () => {
    const p = parts()
    const state = createAppState({
      sdk: { ok: true, sdkRoot: '/opt/sdk' },
      registry: p.registry,
      avd: p.avd,
      server: p.server
    })

    const seen: Array<{ type: string }> = []
    state.onEvent((event) => seen.push(event))

    p.fire({ type: 'tracking_failed', failure: { error: null, exitCode: 1 } })
    await new Promise((resolve) => setTimeout(resolve, 0))

    expect(p.avd.list).not.toHaveBeenCalled()
    expect(seen.map((event) => event.type)).toEqual(['tracking_failed'])
  })
})

describe('createAppState avd refresh failures', () => {
  it('swallows a failing avd list after a device event instead of leaking a rejection', async () => {
    const p = parts()
    ;(p.avd.list as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('emulator가 없다'))
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {})
    const unhandled = vi.fn()
    process.on('unhandledRejection', unhandled)

    try {
      const state = createAppState({
        sdk: { ok: true, sdkRoot: '/opt/sdk' },
        registry: p.registry,
        avd: p.avd,
        server: p.server
      })
      const seen: Array<{ type: string }> = []
      state.onEvent((event) => seen.push(event))

      p.fire({ type: 'device_disconnected', serial: 'emulator-5554' })
      await vi.waitFor(() => expect(errors).toHaveBeenCalled())
      await new Promise((resolve) => setTimeout(resolve, 10))

      expect(unhandled).not.toHaveBeenCalled()
      expect(seen.map((event) => event.type)).toEqual(['device_disconnected'])
    } finally {
      process.off('unhandledRejection', unhandled)
      errors.mockRestore()
    }
  })
})
