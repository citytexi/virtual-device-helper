import { describe, expect, it, vi } from 'vitest'
import { IPC_CHANNELS } from '../../../shared/types/ipc'
import { onLogPort, type MessageTarget } from './logPort'

function fakeTarget() {
  let listener: ((event: MessageEvent) => void) | null = null
  const target: MessageTarget = {
    addEventListener: (_type, l) => {
      listener = l
    },
    removeEventListener: vi.fn(() => {
      listener = null
    })
  }
  const dispatch = (event: Partial<MessageEvent>) => listener?.(event as MessageEvent)
  return { target, dispatch, isListening: () => listener !== null }
}

const data = { channel: IPC_CHANNELS.logPort, serial: 'emulator-5554', sessionId: 's1' }

describe('onLogPort', () => {
  it('accepts a log port from the same window with one port', () => {
    const t = fakeTarget()
    const callback = vi.fn()
    const port = {} as MessagePort
    onLogPort(callback, t.target)

    t.dispatch({ source: t.target as unknown as Window, data, ports: [port] })

    expect(callback).toHaveBeenCalledWith({ serial: 'emulator-5554', sessionId: 's1' }, port)
  })

  it.each([
    ['another source', { source: {} as Window, data, ports: [{} as MessagePort] }],
    ['the stream-port channel', { data: { ...data, channel: IPC_CHANNELS.streamPort }, ports: [{} as MessagePort] }],
    ['another channel', { data: { ...data, channel: 'x' }, ports: [{} as MessagePort] }],
    ['no port', { data, ports: [] }],
    ['two ports', { data, ports: [{} as MessagePort, {} as MessagePort] }],
    ['a missing serial', { data: { channel: data.channel, sessionId: 's1' }, ports: [{} as MessagePort] }],
    ['a non-object payload', { data: 'hello', ports: [{} as MessagePort] }]
  ])('ignores a message from %s', (_name, event) => {
    const t = fakeTarget()
    const callback = vi.fn()
    onLogPort(callback, t.target)

    t.dispatch({ source: t.target as unknown as Window, ...event })

    expect(callback).not.toHaveBeenCalled()
  })

  it('stops listening when unsubscribed', () => {
    const t = fakeTarget()
    const stop = onLogPort(vi.fn(), t.target)

    stop()

    expect(t.isListening()).toBe(false)
  })
})
