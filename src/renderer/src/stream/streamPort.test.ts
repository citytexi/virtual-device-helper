import { describe, expect, it, vi } from 'vitest'
import { IPC_CHANNELS } from '../../../shared/types/ipc'
import { createStreamPortRouter, onStreamPort, type MessageTarget } from './streamPort'

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

const data = { channel: IPC_CHANNELS.streamPort, serial: 'emulator-5554', sessionId: 's1' }

describe('onStreamPort', () => {
  it('hands over the port and meta posted by our preload', () => {
    const t = fakeTarget()
    const callback = vi.fn()
    const port = {} as MessagePort
    onStreamPort(callback, t.target)

    t.dispatch({ source: t.target as unknown as Window, data, ports: [port] })

    expect(callback).toHaveBeenCalledWith({ serial: 'emulator-5554', sessionId: 's1' }, port)
  })

  it.each([
    ['another source', { source: {} as Window, data, ports: [{} as MessagePort] }],
    ['another channel', { data: { ...data, channel: 'x' }, ports: [{} as MessagePort] }],
    ['no port', { data, ports: [] }],
    ['two ports', { data, ports: [{} as MessagePort, {} as MessagePort] }],
    ['a missing serial', { data: { channel: data.channel, sessionId: 's1' }, ports: [{} as MessagePort] }],
    ['a non-object payload', { data: 'hello', ports: [{} as MessagePort] }]
  ])('ignores a message from %s', (_name, event) => {
    const t = fakeTarget()
    const callback = vi.fn()
    onStreamPort(callback, t.target)

    t.dispatch({ source: t.target as unknown as Window, ...event })

    expect(callback).not.toHaveBeenCalled()
  })

  it('stops listening when unsubscribed', () => {
    const t = fakeTarget()
    const stop = onStreamPort(vi.fn(), t.target)

    stop()

    expect(t.isListening()).toBe(false)
  })
})

describe('createStreamPortRouter', () => {
  const routed = (slotId: string, epoch: number) => ({ ...data, slotId, epoch })
  const fakePort = () => ({ close: vi.fn() }) as unknown as MessagePort & { close: ReturnType<typeof vi.fn> }
  const send = (t: ReturnType<typeof fakeTarget>, payload: unknown, port: MessagePort = fakePort()) => {
    t.dispatch({ source: t.target as unknown as Window, data: payload, ports: [port] })
    return port as MessagePort & { close: ReturnType<typeof vi.fn> }
  }

  it('routes a port only to the subscriber whose slot and epoch match', () => {
    const t = fakeTarget()
    const router = createStreamPortRouter(t.target)
    const onX = vi.fn()
    const onY = vi.fn()
    router.subscribe({ slotId: 'x', epoch: 1 }, onX)
    router.subscribe({ slotId: 'y', epoch: 1 }, onY)

    const px = send(t, routed('x', 1))
    expect(onX).toHaveBeenCalledTimes(1)
    expect(onX.mock.calls[0]?.[1]).toBe(px)
    expect(onY).not.toHaveBeenCalled()
    expect(px.close).not.toHaveBeenCalled()

    const py = send(t, routed('y', 1))
    expect(onY).toHaveBeenCalledTimes(1)
    expect(onY.mock.calls[0]?.[1]).toBe(py)
    expect(onX).toHaveBeenCalledTimes(1)
    expect(py.close).not.toHaveBeenCalled()
  })

  it('closes a port of another epoch and hands it to nobody', () => {
    const t = fakeTarget()
    const router = createStreamPortRouter(t.target)
    const onX = vi.fn()
    router.subscribe({ slotId: 'x', epoch: 1 }, onX)

    const port = send(t, routed('x', 2))

    expect(onX).not.toHaveBeenCalled()
    expect(port.close).toHaveBeenCalledTimes(1)
  })

  it('closes a port that arrives after unsubscribe', () => {
    const t = fakeTarget()
    const router = createStreamPortRouter(t.target)
    const onX = vi.fn()
    const off = router.subscribe({ slotId: 'x', epoch: 1 }, onX)
    off()

    const port = send(t, routed('x', 1))

    expect(onX).not.toHaveBeenCalled()
    expect(port.close).toHaveBeenCalledTimes(1)
  })

  it('keeps the newer subscription when a replaced one is unsubscribed', () => {
    const t = fakeTarget()
    const router = createStreamPortRouter(t.target)
    const first = vi.fn()
    const second = vi.fn()
    const offFirst = router.subscribe({ slotId: 'x', epoch: 1 }, first)
    router.subscribe({ slotId: 'x', epoch: 1 }, second)

    offFirst()
    const port = send(t, routed('x', 1))

    expect(first).not.toHaveBeenCalled()
    expect(second).toHaveBeenCalledTimes(1)
    expect(port.close).not.toHaveBeenCalled()
  })

  it.each([
    ['no slotId', { ...data, epoch: 1 }],
    ['a string epoch', { ...data, slotId: 'x', epoch: '1' }]
  ])('ignores a message with %s and leaves its port open', (_name, payload) => {
    const t = fakeTarget()
    const router = createStreamPortRouter(t.target)
    const onX = vi.fn()
    router.subscribe({ slotId: 'x', epoch: 1 }, onX)

    const port = send(t, payload)

    expect(onX).not.toHaveBeenCalled()
    expect(port.close).not.toHaveBeenCalled()
  })

  it('ignores a message from another window and leaves its port open', () => {
    const t = fakeTarget()
    const router = createStreamPortRouter(t.target)
    const onX = vi.fn()
    router.subscribe({ slotId: 'x', epoch: 1 }, onX)
    const port = fakePort()

    t.dispatch({ source: {} as Window, data: routed('x', 1), ports: [port] })

    expect(onX).not.toHaveBeenCalled()
    expect(port.close).not.toHaveBeenCalled()
  })

  it('passes serial, sessionId, slotId and epoch in meta', () => {
    const t = fakeTarget()
    const router = createStreamPortRouter(t.target)
    const onX = vi.fn()
    router.subscribe({ slotId: 'x', epoch: 3 }, onX)

    send(t, routed('x', 3))

    expect(onX.mock.calls[0]?.[0]).toEqual({
      serial: 'emulator-5554',
      sessionId: 's1',
      slotId: 'x',
      epoch: 3
    })
  })

  it('does not throw when created without a target and never subscribed', () => {
    expect(() => createStreamPortRouter()).not.toThrow()
  })
})
