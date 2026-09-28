import { describe, expect, it, vi } from 'vitest'
import type { AvdController } from '../device/avdController'
import type { DeviceRegistry } from '../device/registry'
import type { McpServerHandle } from '../mcp/httpServer'
import { deviceError } from '../../shared/types/errors'
import { IPC_CHANNELS, type AppSnapshot, type Outcome } from '../../shared/types/ipc'
import { bootstrapApp, rendererSender, type BootstrapDeps } from './bootstrap'

type Handler = (event: unknown, ...args: unknown[]) => unknown

function fakeStack() {
  const device = { serial: 'emulator-5554', screenshot: vi.fn(async () => ({ base64: 'QUJD', width: 1, height: 1 })) }
  const registry = {
    start: vi.fn(),
    stop: vi.fn(),
    serials: vi.fn(() => ['emulator-5554']),
    resolve: vi.fn(() => device),
    setActive: vi.fn(),
    clearActive: vi.fn(),
    getActive: vi.fn(() => null),
    run: vi.fn((_serial: string, task: () => Promise<unknown>) => task()),
    on: vi.fn(() => () => {})
  } as unknown as DeviceRegistry
  const avd = {
    list: vi.fn(async () => []),
    boot: vi.fn(async () => 'emulator-5554'),
    shutdown: vi.fn(async () => {})
  } as unknown as AvdController
  return { registry, avd, device }
}

function harness(overrides: Partial<BootstrapDeps> = {}) {
  const handlers = new Map<string, Handler>()
  const ipcMain = { handle: (channel: string, handler: Handler) => handlers.set(channel, handler) }
  const stack = fakeStack()
  const registryListeners: Array<(event: unknown) => void> = []
  ;(stack.registry.on as ReturnType<typeof vi.fn>).mockImplementation((listener: (event: unknown) => void) => {
    registryListeners.push(listener)
    return () => {}
  })
  // registry.start()가 불리는 바로 그 순간, 그때까지 등록된 리스너에게만 동기로
  // device_connected를 쏜다. 실제 registry도 추적을 시작하자마자 이미 붙어 있던 기기를
  // 이렇게 알린다. 구독이 start() 뒤에 걸리면 이 리스너 목록에 없으니 이벤트를 놓친다 —
  // fireRegistry를 나중에 수동으로 불러서는 이 순서를 검증할 수 없다.
  ;(stack.registry.start as ReturnType<typeof vi.fn>).mockImplementation(() => {
    registryListeners.forEach((listener) => listener({ type: 'device_connected', serial: 'emulator-5554' }))
  })
  const stream = {
    open: vi.fn(async () => {}),
    stop: vi.fn(async () => {}),
    handleDisconnect: vi.fn(async () => {})
  }
  const logs = {
    handleConnect: vi.fn(),
    handleDisconnect: vi.fn(),
    open: vi.fn(),
    close: vi.fn(),
    pidHistory: vi.fn(async () => [] as number[]),
    stopAll: vi.fn()
  }
  const server: McpServerHandle = {
    url: 'http://127.0.0.1:9321/mcp',
    port: 9321,
    token: 'token-value',
    close: vi.fn(async () => {})
  }
  const deps: BootstrapDeps = {
    located: {
      ok: true,
      paths: { sdkRoot: '/opt/sdk', adb: '/opt/sdk/platform-tools/adb', emulator: '/opt/sdk/emulator/emulator', source: 'ANDROID_HOME' }
    },
    ipcMain: ipcMain as never,
    send: vi.fn(),
    createDeviceStack: vi.fn(() => ({ registry: stack.registry, avd: stack.avd })),
    createStreamManager: vi.fn(() => stream),
    createLogManager: vi.fn(() => logs),
    startServer: vi.fn(async () => server),
    ...overrides
  }

  const invoke = async <T>(channel: string, ...args: unknown[]): Promise<T> => {
    const handler = handlers.get(channel)
    if (!handler) throw new Error(`no handler for ${channel}`)
    return (await handler({}, ...args)) as T
  }

  return {
    deps,
    handlers,
    invoke,
    stack,
    server,
    stream,
    logs,
    fireRegistry: (event: unknown) => registryListeners.forEach((listener) => listener(event))
  }
}

const missing: BootstrapDeps['located'] = { ok: false, searched: ['/opt/sdk/platform-tools/adb'] }

describe('bootstrapApp without an SDK', () => {
  it('still registers the bridge and serves a snapshot with the sdk guidance data', async () => {
    const h = harness({ located: missing })

    await bootstrapApp(h.deps)
    const snapshot = await h.invoke<AppSnapshot>(IPC_CHANNELS.getSnapshot)

    expect(snapshot).toEqual({
      sdk: { ok: false, searched: ['/opt/sdk/platform-tools/adb'] },
      server: null,
      avds: [],
      devices: [],
      activeSerial: null,
      toolCalls: [],
      trackingFailure: null
    })
  })

  it('does not open the MCP server or build the device stack', async () => {
    const h = harness({ located: missing })

    await bootstrapApp(h.deps)

    expect(h.deps.startServer).not.toHaveBeenCalled()
    expect(h.deps.createDeviceStack).not.toHaveBeenCalled()
    expect(h.deps.createLogManager).not.toHaveBeenCalled()
  })

  it('answers every action with sdk_not_found', async () => {
    const h = harness({ located: missing })

    await bootstrapApp(h.deps)

    for (const channel of [
      IPC_CHANNELS.selectDevice,
      IPC_CHANNELS.bootAvd,
      IPC_CHANNELS.shutdownDevice,
      IPC_CHANNELS.captureScreenshot,
      IPC_CHANNELS.openLogs,
      IPC_CHANNELS.closeLogs
    ]) {
      const result = await h.invoke<Outcome<unknown>>(channel, 'emulator-5554')
      expect(result.ok).toBe(false)
      if (!result.ok) {
        expect(result.error.kind).toBe('sdk_not_found')
        expect(result.error.hint).toEqual(expect.any(String))
      }
    }
  })
})

describe('bootstrapApp with an SDK: logs', () => {
  it('subscribes the log manager before registry.start so initial devices get a tail', async () => {
    const h = harness()

    // registry.start()의 가짜 구현이 그 순간까지 등록된 리스너에게 device_connected를
    // 동기로 쏜다(harness 참고). 로그 구독이 start() 앞에 걸려 있어야만 이 호출을 받는다.
    await bootstrapApp(h.deps)

    expect(h.logs.handleConnect).toHaveBeenCalledWith('emulator-5554')
  })

  it('closes the log tail when its device disconnects', async () => {
    const h = harness()
    await bootstrapApp(h.deps)

    h.fireRegistry({ type: 'device_disconnected', serial: 'emulator-5554' })

    expect(h.logs.handleDisconnect).toHaveBeenCalledWith('emulator-5554')
  })

  it('hands logManager.pidHistory to the MCP tool context', async () => {
    const h = harness()
    h.logs.pidHistory.mockResolvedValueOnce([111])

    await bootstrapApp(h.deps)
    const context = vi.mocked(h.deps.startServer).mock.calls[0]![0].context
    const result = await context.pidHistory('emulator-5554', 'com.example')

    expect(result).toEqual([111])
    expect(h.logs.pidHistory).toHaveBeenCalledWith('emulator-5554', 'com.example')
  })

  it('stops all tails on app stop even if the stream stop throws', async () => {
    const h = harness()
    h.stream.stop.mockRejectedValueOnce(new Error('boom'))
    const app = await bootstrapApp(h.deps)

    await expect(app.stop()).rejects.toThrow('boom')

    expect(h.logs.stopAll).toHaveBeenCalled()
  })

  it('opens logs for a known serial', async () => {
    const h = harness()
    await bootstrapApp(h.deps)

    await h.invoke<Outcome<void>>(IPC_CHANNELS.openLogs, 'emulator-5554')

    expect(h.logs.open).toHaveBeenCalledWith('emulator-5554')
  })

  it('refuses to open logs for a serial the registry does not know', async () => {
    const h = harness()
    ;(h.stack.registry.resolve as ReturnType<typeof vi.fn>).mockImplementation(() => {
      throw deviceError('no_device', 'gone', 'x')
    })
    await bootstrapApp(h.deps)

    const result = await h.invoke<Outcome<void>>(IPC_CHANNELS.openLogs, 'emulator-9999')

    expect(result.ok).toBe(false)
    expect(h.logs.open).not.toHaveBeenCalled()
  })

  it('closes logs', async () => {
    const h = harness()
    await bootstrapApp(h.deps)

    await h.invoke<Outcome<void>>(IPC_CHANNELS.closeLogs)

    expect(h.logs.close).toHaveBeenCalled()
  })

  it('refuses log actions without an SDK and never builds a log manager', async () => {
    const h = harness({ located: missing })
    await bootstrapApp(h.deps)

    const openResult = await h.invoke<Outcome<void>>(IPC_CHANNELS.openLogs, 'emulator-5554')
    const closeResult = await h.invoke<Outcome<void>>(IPC_CHANNELS.closeLogs)

    expect(openResult.ok).toBe(false)
    if (!openResult.ok) expect(openResult.error.kind).toBe('sdk_not_found')
    expect(closeResult.ok).toBe(false)
    if (!closeResult.ok) expect(closeResult.error.kind).toBe('sdk_not_found')
    expect(h.deps.createLogManager).not.toHaveBeenCalled()
  })
})

describe('bootstrapApp with an SDK', () => {
  it('builds the stack, starts tracking and exposes the server endpoint', async () => {
    const h = harness()

    const app = await bootstrapApp(h.deps)
    const snapshot = await h.invoke<AppSnapshot>(IPC_CHANNELS.getSnapshot)

    expect(h.deps.createDeviceStack).toHaveBeenCalledWith(expect.objectContaining({ sdkRoot: '/opt/sdk' }))
    expect(h.stack.registry.start).toHaveBeenCalled()
    // 상태가 먼저 구독해야 처음 붙어 있던 기기의 device_connected를 놓치지 않는다.
    const onOrder = vi.mocked(h.stack.registry.on).mock.invocationCallOrder[0]!
    const startOrder = vi.mocked(h.stack.registry.start).mock.invocationCallOrder[0]!
    expect(onOrder).toBeLessThan(startOrder)
    expect(snapshot.sdk).toEqual({ ok: true, sdkRoot: '/opt/sdk' })
    expect(snapshot.server).toEqual({ url: 'http://127.0.0.1:9321/mcp', port: 9321, token: 'token-value' })
    expect(app.server).toBe(h.server)
  })

  it('records tool calls from the server context into the app state', async () => {
    const h = harness()

    await bootstrapApp(h.deps)
    const context = vi.mocked(h.deps.startServer).mock.calls[0]![0].context
    context.onToolCall({
      id: 'a',
      tool: 'ui_tap',
      argsSummary: '{}',
      startedAt: 1,
      durationMs: 1,
      ok: true,
      detail: { args: '{}' }
    })
    const snapshot = await h.invoke<AppSnapshot>(IPC_CHANNELS.getSnapshot)

    expect(snapshot.toolCalls.map((record) => record.id)).toEqual(['a'])
    expect(context.registry).toBe(h.stack.registry)
    expect(context.avd).toBe(h.stack.avd)
  })

  it('keeps going without a server when the server fails to start', async () => {
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {})
    const h = harness({ startServer: vi.fn(async () => Promise.reject(new Error('EADDRINUSE'))) })

    try {
      const app = await bootstrapApp(h.deps)
      const snapshot = await h.invoke<AppSnapshot>(IPC_CHANNELS.getSnapshot)

      expect(app.server).toBeNull()
      expect(snapshot.server).toBeNull()
      expect(errors).toHaveBeenCalled()
    } finally {
      errors.mockRestore()
    }
  })

  it('routes the actions to the registry and avd controller', async () => {
    const h = harness()

    await bootstrapApp(h.deps)
    await h.invoke(IPC_CHANNELS.selectDevice, 'emulator-5554')
    await h.invoke(IPC_CHANNELS.bootAvd, 'Pixel_7_API_34')
    await h.invoke(IPC_CHANNELS.shutdownDevice, 'emulator-5554')
    const shot = await h.invoke<Outcome<unknown>>(IPC_CHANNELS.captureScreenshot, 'emulator-5554')

    expect(h.stack.registry.setActive).toHaveBeenCalledWith('emulator-5554')
    expect(h.stack.avd.boot).toHaveBeenCalledWith('Pixel_7_API_34')
    expect(h.stack.avd.shutdown).toHaveBeenCalledWith('emulator-5554')
    expect(h.stack.registry.run).toHaveBeenCalledWith('emulator-5554', expect.any(Function))
    expect(shot).toEqual({ ok: true, value: { base64: 'QUJD', width: 1, height: 1 } })
  })

  it('stops tracking and closes the server on stop', async () => {
    const h = harness()

    const app = await bootstrapApp(h.deps)
    await app.stop()

    expect(h.stack.registry.stop).toHaveBeenCalled()
    expect(h.server.close).toHaveBeenCalled()
  })

  it('starts a stream for a known serial', async () => {
    const h = harness()
    await bootstrapApp(h.deps)

    const result = await h.invoke<Outcome<void>>(IPC_CHANNELS.startStream, 'emulator-5554')

    expect(result.ok).toBe(true)
    expect(h.stream.open).toHaveBeenCalledWith('emulator-5554')
  })

  it('refuses a stream for a serial the registry does not know', async () => {
    const h = harness()
    ;(h.stack.registry.resolve as ReturnType<typeof vi.fn>).mockImplementation(() => {
      throw deviceError('no_device', 'gone', 'x')
    })
    await bootstrapApp(h.deps)

    const result = await h.invoke<Outcome<void>>(IPC_CHANNELS.startStream, 'emulator-9999')

    expect(result.ok).toBe(false)
    expect(h.stream.open).not.toHaveBeenCalled()
  })

  it('closes the stream when its device disconnects', async () => {
    const h = harness()
    await bootstrapApp(h.deps)

    h.fireRegistry({ type: 'device_disconnected', serial: 'emulator-5554' })

    expect(h.stream.handleDisconnect).toHaveBeenCalledWith('emulator-5554')
  })

  it('stops the stream on shutdown', async () => {
    const h = harness()
    const app = await bootstrapApp(h.deps)

    await app.stop()

    expect(h.stream.stop).toHaveBeenCalled()
  })

  it('still stops tracking and closes the server when stopping the stream throws', async () => {
    const h = harness()
    h.stream.stop.mockRejectedValueOnce(new Error('boom'))
    const app = await bootstrapApp(h.deps)

    await expect(app.stop()).rejects.toThrow('boom')

    expect(h.stack.registry.stop).toHaveBeenCalled()
    expect(h.server.close).toHaveBeenCalled()
  })

  it('refuses a stream without an SDK and never builds a stream manager', async () => {
    const h = harness({ located: missing })
    await bootstrapApp(h.deps)

    const result = await h.invoke<Outcome<void>>(IPC_CHANNELS.startStream, 'emulator-5554')

    expect(result.ok).toBe(false)
    expect(h.deps.createStreamManager).not.toHaveBeenCalled()
  })
})

describe('rendererSender', () => {
  it('does nothing while there is no window', () => {
    expect(() => rendererSender(() => null)(IPC_CHANNELS.event, { type: 'active_changed', serial: null })).not.toThrow()
  })

  it('skips a destroyed window', () => {
    const send = vi.fn()
    const window = { isDestroyed: () => true, webContents: { send } }

    rendererSender(() => window)(IPC_CHANNELS.event, { type: 'active_changed', serial: null })

    expect(send).not.toHaveBeenCalled()
  })

  it('sends to a live window', () => {
    const send = vi.fn()
    const window = { isDestroyed: () => false, webContents: { send } }

    rendererSender(() => window)(IPC_CHANNELS.event, { type: 'active_changed', serial: null })

    expect(send).toHaveBeenCalledWith(IPC_CHANNELS.event, { type: 'active_changed', serial: null })
  })
})
