import { describe, expect, it, vi } from 'vitest'
import { deviceError } from '../../shared/types/errors'
import { IPC_CHANNELS } from '../../shared/types/ipc'
import type { AppState } from './appState'
import { registerIpcBridge, type BridgeActions } from './ipcBridge'

function harness() {
  const handlers = new Map<string, (event: unknown, ...args: unknown[]) => unknown>()
  const ipcMain = {
    handle: (channel: string, handler: (event: unknown, ...args: unknown[]) => unknown) => {
      handlers.set(channel, handler)
    }
  }

  const state = {
    snapshot: vi.fn(async () => ({ sdk: { ok: true, sdkRoot: '/opt/sdk' } })),
    recordToolCall: vi.fn(),
    onEvent: vi.fn((listener: (event: unknown) => void) => {
      listeners.push(listener)
      return () => {}
    })
  } as unknown as AppState

  const listeners: Array<(event: unknown) => void> = []
  const sent: Array<{ channel: string; payload: unknown }> = []

  const actions: BridgeActions = {
    selectDevice: vi.fn(),
    bootAvd: vi.fn(async () => {}),
    shutdownDevice: vi.fn(async () => {}),
    captureScreenshot: vi.fn(async () => ({ base64: 'QUJD', width: 1, height: 1 }))
  }

  registerIpcBridge(ipcMain as never, state, actions, (channel, payload) =>
    sent.push({ channel, payload })
  )

  return { handlers, actions, sent, fire: (event: unknown) => listeners.forEach((l) => l(event)) }
}

describe('registerIpcBridge', () => {
  it('registers exactly the whitelisted channels', () => {
    const h = harness()

    expect([...h.handlers.keys()].sort()).toEqual(
      [
        IPC_CHANNELS.getSnapshot,
        IPC_CHANNELS.selectDevice,
        IPC_CHANNELS.bootAvd,
        IPC_CHANNELS.shutdownDevice,
        IPC_CHANNELS.captureScreenshot
      ].sort()
    )
  })

  it('routes selectDevice to the action with its argument', async () => {
    const h = harness()

    await h.handlers.get(IPC_CHANNELS.selectDevice)?.({}, 'emulator-5554')

    expect(h.actions.selectDevice).toHaveBeenCalledWith('emulator-5554')
  })

  it('returns a serialisable error payload instead of throwing across the boundary', async () => {
    const h = harness()
    ;(h.actions.bootAvd as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
      deviceError('command_failed', '그런 AVD가 없다', 'device_list로 확인해라')
    )

    const result = await h.handlers.get(IPC_CHANNELS.bootAvd)?.({}, 'Nope')

    expect(result).toEqual({
      ok: false,
      error: { kind: 'command_failed', message: '그런 AVD가 없다', hint: 'device_list로 확인해라' }
    })
  })

  it('wraps a plain Error in a generic command_failed payload, ignoring any toolError-like field', async () => {
    const h = harness()
    ;(h.actions.shutdownDevice as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
      Object.assign(new Error('adb가 응답하지 않는다'), {
        toolError: { kind: 'no_device', message: '가짜', hint: '가짜' }
      })
    )

    const result = await h.handlers.get(IPC_CHANNELS.shutdownDevice)?.({}, 'emulator-5554')

    expect(result).toEqual({
      ok: false,
      error: {
        kind: 'command_failed',
        message: 'adb가 응답하지 않는다',
        hint: '다시 시도하고, 반복되면 활동 탭에서 맥락을 확인해라'
      }
    })
  })

  it('stringifies a thrown non-Error value into the generic payload', async () => {
    const h = harness()
    ;(h.actions.bootAvd as ReturnType<typeof vi.fn>).mockRejectedValueOnce('문자열 실패')

    const result = await h.handlers.get(IPC_CHANNELS.bootAvd)?.({}, 'Pixel_7_API_34')

    expect(result).toEqual({
      ok: false,
      error: { kind: 'command_failed', message: '문자열 실패', hint: '다시 시도하고, 반복되면 활동 탭에서 맥락을 확인해라' }
    })
  })

  it('broadcasts main events on the single event channel', () => {
    const h = harness()

    h.fire({ type: 'active_changed', serial: 'emulator-5554' })

    expect(h.sent).toEqual([
      { channel: IPC_CHANNELS.event, payload: { type: 'active_changed', serial: 'emulator-5554' } }
    ])
  })
})

describe('registerIpcBridge argument checks', () => {
  const cases = [
    ['selectDevice', IPC_CHANNELS.selectDevice],
    ['bootAvd', IPC_CHANNELS.bootAvd],
    ['shutdownDevice', IPC_CHANNELS.shutdownDevice],
    ['captureScreenshot', IPC_CHANNELS.captureScreenshot]
  ] as const

  for (const [action, channel] of cases) {
    for (const bad of [undefined, '', 42, { serial: 'emulator-5554' }]) {
      it(`rejects ${JSON.stringify(bad) ?? 'undefined'} for ${action} without calling the action`, async () => {
        const h = harness()

        const result = (await h.handlers.get(channel)?.({}, bad)) as {
          ok: boolean
          error?: { kind: string; message: string; hint: string }
        }

        expect(result.ok).toBe(false)
        expect(result.error?.kind).toBe('command_failed')
        expect(result.error?.message).toEqual(expect.any(String))
        expect(result.error?.hint).toEqual(expect.any(String))
        expect(h.actions[action]).not.toHaveBeenCalled()
      })
    }
  }
})
