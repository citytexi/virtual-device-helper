import { beforeEach, describe, expect, it, vi } from 'vitest'
import { IPC_CHANNELS } from '../shared/types/ipc'

const exposed = vi.fn()
const invoke = vi.fn(async () => ({}))
const on = vi.fn()
const removeListener = vi.fn()

vi.mock('electron', () => ({
  contextBridge: { exposeInMainWorld: exposed },
  ipcRenderer: { invoke, on, removeListener }
}))

async function loadPreload(): Promise<Record<string, unknown>> {
  vi.resetModules()
  exposed.mockClear()
  await import('./index')
  return exposed.mock.calls[0]?.[1] as Record<string, unknown>
}

describe('preload API surface', () => {
  beforeEach(() => {
    invoke.mockClear()
    on.mockClear()
  })

  it('exposes the api under a single namespace', async () => {
    await loadPreload()

    expect(exposed).toHaveBeenCalledTimes(1)
    expect(exposed.mock.calls[0]?.[0]).toBe('api')
  })

  it('exposes exactly the whitelisted methods and nothing else', async () => {
    const api = await loadPreload()

    expect(Object.keys(api).sort()).toEqual(
      ['bootAvd', 'captureScreenshot', 'getSnapshot', 'onEvent', 'selectDevice', 'shutdownDevice'].sort()
    )
  })

  it('does not expose a generic invoke that would open arbitrary channels', async () => {
    const api = await loadPreload()

    expect(api.invoke).toBeUndefined()
    expect(api.send).toBeUndefined()
    expect(api.ipcRenderer).toBeUndefined()
  })

  it.each([
    ['getSnapshot', IPC_CHANNELS.getSnapshot, []],
    ['selectDevice', IPC_CHANNELS.selectDevice, ['emulator-5554']],
    ['bootAvd', IPC_CHANNELS.bootAvd, ['Pixel_7_API_34']],
    ['shutdownDevice', IPC_CHANNELS.shutdownDevice, ['emulator-5554']],
    ['captureScreenshot', IPC_CHANNELS.captureScreenshot, ['emulator-5554']]
  ] as const)('routes %s to its own named channel with its argument', async (method, channel, args) => {
    const api = await loadPreload()

    await (api[method] as (...callArgs: unknown[]) => Promise<unknown>)(...args)

    expect(invoke).toHaveBeenCalledWith(channel, ...args)
  })

  it('delivers only the event payload to subscribers, never the IpcRendererEvent', async () => {
    const api = await loadPreload()
    const received: unknown[] = []

    ;(api.onEvent as (callback: (event: unknown) => void) => () => void)((event) => received.push(event))

    const handler = on.mock.calls[0]?.[1] as (event: unknown, payload: unknown) => void
    handler({ sender: 'should not leak' }, { type: 'active_changed', serial: 'emulator-5554' })

    expect(received).toEqual([{ type: 'active_changed', serial: 'emulator-5554' }])
  })

  it('unsubscribes when the returned function is called', async () => {
    const api = await loadPreload()

    const off = (api.onEvent as (callback: (event: unknown) => void) => () => void)(() => {})
    off()

    expect(removeListener).toHaveBeenCalledWith(IPC_CHANNELS.event, expect.any(Function))
  })
})
