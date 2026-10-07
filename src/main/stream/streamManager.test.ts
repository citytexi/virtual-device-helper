import { describe, expect, it, vi, type Mock } from 'vitest'
import { deviceError } from '../../shared/types/errors'
import type { ControlIntent, DeviceKey, StreamDown } from '../../shared/types/stream'
import type { StreamSession, StreamSessionHandlers } from './streamSession'
import { createStreamManager, isFrameAck, RECONNECT_DELAYS_MS, toControlIntent, type PortLike } from './streamManager'

class FakePort implements PortLike {
  readonly sent: StreamDown[] = []
  readonly start = vi.fn()
  readonly close = vi.fn()
  private listener: ((event: { data: unknown }) => void) | null = null
  private closeListener: (() => void) | null = null
  postMessage(message: StreamDown): void {
    this.sent.push(message)
  }
  on(event: 'message', listener: (event: { data: unknown }) => void): void
  on(event: 'close', listener: () => void): void
  on(event: 'message' | 'close', listener: ((event: { data: unknown }) => void) | (() => void)): void {
    if (event === 'close') this.closeListener = listener as () => void
    else this.listener = listener as (event: { data: unknown }) => void
  }
  receive(data: unknown): void {
    this.listener?.({ data })
  }
  /** renderer 쪽 포트가 끊긴 것처럼 close 이벤트를 낸다. */
  disconnect(): void {
    this.closeListener?.()
  }
  statuses(): string[] {
    return this.sent.flatMap((m) => (m.type === 'status' ? [m.status.state] : []))
  }
}

interface FakeSession extends StreamSession {
  handlers: StreamSessionHandlers
  start: Mock<() => Promise<void>>
  close: Mock<() => Promise<void>>
  sendControl: Mock<(intent: ControlIntent) => void>
}

function harness(opts: { startResults?: Array<'ok' | 'fail' | 'pending'>; connected?: () => boolean } = {}) {
  const results = [...(opts.startResults ?? [])]
  const sessions: FakeSession[] = []
  const ports: FakePort[] = []
  const posted: Array<{ serial: string; sessionId: string }> = []
  let resolveSleep: (() => void) | null = null
  const sleeps: number[] = []
  let id = 0
  const states: Array<[string, string]> = []

  const manager = createStreamManager({
    onState: (serial, state) => states.push([serial, state]),
    createSession: (serial, handlers) => {
      const outcome = results.shift() ?? 'ok'
      // 'pending'은 close()가 불릴 때까지 끝나지 않는 start다. 실제 세션처럼 시작 중 닫히면 던진다.
      let abortStart: (() => void) | null = null
      const session: FakeSession = {
        serial,
        handlers,
        start: vi.fn(async () => {
          if (outcome === 'fail') throw deviceError('device_unresponsive', 'no server', 'retry')
          if (outcome === 'pending') {
            await new Promise<void>((_resolve, reject) => {
              abortStart = () => reject(deviceError('command_failed', '세션이 시작 중에 닫혔다', '다시 연결해라'))
            })
          }
        }),
        close: vi.fn(async () => {
          abortStart?.()
        }),
        sendControl: vi.fn()
      }
      sessions.push(session)
      return session
    },
    createChannel: () => {
      const local = new FakePort()
      ports.push(local)
      return { local, remote: { remoteOf: ports.length - 1 } }
    },
    postPort: (meta) => posted.push(meta),
    isConnected: opts.connected ?? (() => true),
    sleep: (ms) => {
      sleeps.push(ms)
      return new Promise<void>((resolve) => {
        resolveSleep = resolve
      })
    },
    newSessionId: () => `s${(id += 1)}`
  })

  async function wake(): Promise<void> {
    await vi.waitFor(() => expect(resolveSleep).not.toBeNull())
    const resolve = resolveSleep as unknown as () => void
    resolveSleep = null
    resolve()
    await new Promise((r) => setImmediate(r))
  }

  return { manager, sessions, ports, posted, sleeps, wake, states }
}

const endError = deviceError('command_failed', '비디오 스트림이 끊겼다', '다시 연결해라')

describe('createStreamManager', () => {
  it('sends the port before starting, then reports streaming', async () => {
    const h = harness()

    await h.manager.open('emulator-5554')

    expect(h.posted).toEqual([{ serial: 'emulator-5554', sessionId: 's1' }])
    expect(h.ports[0]?.start).toHaveBeenCalled()
    expect(h.ports[0]?.statuses()).toEqual(['connecting', 'streaming'])
  })

  it('relays session and packet events to the port', async () => {
    const h = harness()
    await h.manager.open('emulator-5554')
    const data = new Uint8Array([1, 2, 3])
    const keys: DeviceKey[] = ['home', 'enter']

    h.sessions[0]?.handlers.onSession({ width: 472, height: 1024, codec: 'jpeg', keys })
    h.sessions[0]?.handlers.onPacket({ config: false, key: true, ptsUs: 10, data })

    expect(h.ports[0]?.sent.slice(-2)).toEqual([
      { type: 'session', width: 472, height: 1024, codec: 'jpeg', keys },
      { type: 'packet', config: false, key: true, ptsUs: 10, data }
    ])
  })

  it('relays jpeg frames to the port as frame messages', async () => {
    const h = harness()
    await h.manager.open('emulator-5554')
    const bytes = new Uint8Array([0xff, 0xd8, 0xff, 0xd9])

    h.sessions[0]?.handlers.onFrame(bytes)

    expect(h.ports[0]?.sent.at(-1)).toEqual({ type: 'frame', data: bytes })
  })

  it('closes the previous port and session when opening another device', async () => {
    const h = harness()
    await h.manager.open('emulator-5554')

    await h.manager.open('emulator-5556')

    expect(h.ports[0]?.close).toHaveBeenCalled()
    expect(h.sessions[0]?.close).toHaveBeenCalled()
    expect(h.posted.map((m) => m.serial)).toEqual(['emulator-5554', 'emulator-5556'])
  })

  it('leaves no orphan when a second open arrives before the first finishes', async () => {
    const h = harness()

    await Promise.all([h.manager.open('A'), h.manager.open('B'), h.manager.open('A')])

    const openPorts = h.ports.filter((port) => port.close.mock.calls.length === 0)
    expect(openPorts).toHaveLength(1)
    const liveSessions = h.sessions.filter((session) => session.close.mock.calls.length === 0)
    expect(liveSessions).toHaveLength(1)
    expect(liveSessions[0]?.serial).toBe('A')
  })

  it('reports failed when the first start fails and keeps the port for the message', async () => {
    const h = harness({ startResults: ['fail'] })

    await h.manager.open('emulator-5554')

    expect(h.ports[0]?.statuses()).toEqual(['connecting', 'failed'])
    const failed = h.ports[0]?.sent.at(-1)
    expect(failed).toMatchObject({ status: { state: 'failed', error: { kind: 'device_unresponsive' } } })
    expect(h.ports[0]?.close).not.toHaveBeenCalled()
  })

  it('reconnects with 1s, 2s, 4s backoff and then fails', async () => {
    const h = harness({ startResults: ['ok', 'fail', 'fail', 'fail'] })
    await h.manager.open('emulator-5554')

    h.sessions[0]?.handlers.onEnded(endError)
    await h.wake()
    await h.wake()
    await h.wake()

    await vi.waitFor(() => expect(h.ports[0]?.statuses().at(-1)).toBe('failed'))
    expect(h.sleeps).toEqual([...RECONNECT_DELAYS_MS])
    expect(h.ports[0]?.sent.filter((m) => m.type === 'status' && m.status.state === 'reconnecting')).toHaveLength(3)
    expect(h.sessions[0]?.close).toHaveBeenCalled()
  })

  it('goes back to streaming when a reconnect attempt succeeds and routes input to the new session', async () => {
    const h = harness({ startResults: ['ok', 'fail', 'ok'] })
    await h.manager.open('emulator-5554')

    h.sessions[0]?.handlers.onEnded(endError)
    await h.wake()
    await h.wake()
    await vi.waitFor(() => expect(h.ports[0]?.statuses().at(-1)).toBe('streaming'))

    h.ports[0]?.receive({ type: 'key', key: 'home' })
    expect(h.sessions[2]?.sendControl).toHaveBeenCalledWith({ type: 'key', key: 'home' })
    expect(h.sessions[0]?.sendControl).not.toHaveBeenCalled()
  })

  it('does not reconnect when the device is gone', async () => {
    const h = harness({ connected: () => false })
    await h.manager.open('emulator-5554')

    h.sessions[0]?.handlers.onEnded(endError)

    await vi.waitFor(() => expect(h.ports[0]?.close).toHaveBeenCalled())
    expect(h.sleeps).toEqual([])
    expect(h.sessions).toHaveLength(1)
  })

  it('opens nothing after stop is called during a reconnect wait', async () => {
    const h = harness()
    await h.manager.open('emulator-5554')
    h.sessions[0]?.handlers.onEnded(endError)
    await vi.waitFor(() => expect(h.sleeps).toHaveLength(1))

    await h.manager.stop()
    await h.wake()

    expect(h.sessions).toHaveLength(1)
    expect(h.ports[0]?.close).toHaveBeenCalled()
  })

  it('stops the reconnect loop of the old device when another device opens', async () => {
    const h = harness()
    await h.manager.open('A')
    h.sessions[0]?.handlers.onEnded(endError)
    await vi.waitFor(() => expect(h.sleeps).toHaveLength(1))

    await h.manager.open('B')
    await h.wake()

    expect(h.sessions.map((s) => s.serial)).toEqual(['A', 'B'])
  })

  it('forwards valid input and drops malformed input', async () => {
    const h = harness()
    await h.manager.open('emulator-5554')

    h.ports[0]?.receive({ type: 'key', key: 'home' })
    h.ports[0]?.receive({ type: 'key', key: 'self_destruct' })
    h.ports[0]?.receive('garbage')

    expect(h.sessions[0]?.sendControl).toHaveBeenCalledTimes(1)
  })

  it('closes a session that is still starting when stop is called', async () => {
    const h = harness({ startResults: ['pending'] })
    const opening = h.manager.open('emulator-5554')
    await vi.waitFor(() => expect(h.sessions[0]?.start).toHaveBeenCalled())

    await h.manager.stop()
    await opening

    expect(h.sessions[0]?.close).toHaveBeenCalled()
    expect(h.ports[0]?.close).toHaveBeenCalled()
    expect(h.ports[0]?.statuses()).toEqual(['connecting'])
  })

  it('closes the starting session of the previous device when another device opens', async () => {
    const h = harness({ startResults: ['pending', 'ok'] })
    const openingA = h.manager.open('A')
    await vi.waitFor(() => expect(h.sessions[0]?.start).toHaveBeenCalled())

    await h.manager.open('B')
    await openingA

    expect(h.sessions[0]?.close).toHaveBeenCalled()
    expect(h.ports[0]?.statuses()).toEqual(['connecting'])
    expect(h.ports[1]?.statuses()).toEqual(['connecting', 'streaming'])
    expect(h.sessions[1]?.close).not.toHaveBeenCalled()
  })

  it('closes the session without reconnecting when the renderer side of the port goes away', async () => {
    const h = harness()
    await h.manager.open('emulator-5554')

    h.ports[0]?.disconnect()

    await vi.waitFor(() => expect(h.sessions[0]?.close).toHaveBeenCalled())
    expect(h.ports[0]?.close).toHaveBeenCalled()
    expect(h.sleeps).toEqual([])
    expect(h.sessions).toHaveLength(1)
  })

  it('closes a starting session when the renderer side of the port goes away', async () => {
    const h = harness({ startResults: ['pending'] })
    const opening = h.manager.open('emulator-5554')
    await vi.waitFor(() => expect(h.sessions[0]?.start).toHaveBeenCalled())

    h.ports[0]?.disconnect()
    await opening

    expect(h.sessions[0]?.close).toHaveBeenCalled()
    expect(h.ports[0]?.statuses()).toEqual(['connecting'])
  })

  it('ignores a close from a superseded port', async () => {
    const h = harness()
    await h.manager.open('A')
    await h.manager.open('B')

    h.ports[0]?.disconnect()
    await new Promise((r) => setImmediate(r))

    expect(h.sessions[1]?.close).not.toHaveBeenCalled()
    expect(h.ports[1]?.close).not.toHaveBeenCalled()
    h.ports[1]?.receive({ type: 'key', key: 'home' })
    expect(h.sessions[1]?.sendControl).toHaveBeenCalledWith({ type: 'key', key: 'home' })
  })

  it('ignores stale session events after the device changed', async () => {
    const h = harness()
    await h.manager.open('A')
    const stale = h.sessions[0]
    await h.manager.open('B')

    stale?.handlers.onSession({ width: 1, height: 1, codec: 'h264', keys: [] })

    expect(h.ports[0]?.sent.some((m) => m.type === 'session')).toBe(false)
    expect(h.ports[1]?.sent.some((m) => m.type === 'session')).toBe(false)
  })
})

describe('createStreamManager onState', () => {
  it('reports started when streaming, reconnecting on retry, stopped on close and failure', async () => {
    const h = harness({ startResults: ['ok', 'fail', 'ok', 'fail'] })

    await h.manager.open('emulator-5554')
    expect(h.states).toEqual([['emulator-5554', 'started']])

    // 끊김 → 재시도 1회 실패 → 재시도 2회 성공
    h.sessions[0]?.handlers.onEnded(endError)
    await h.wake()
    await h.wake()
    await vi.waitFor(() => expect(h.states).toHaveLength(4))
    expect(h.states.slice(1)).toEqual([
      ['emulator-5554', 'reconnecting'],
      ['emulator-5554', 'reconnecting'],
      ['emulator-5554', 'started']
    ])

    // 닫힘 → stopped
    await h.manager.stop()
    expect(h.states.at(-1)).toEqual(['emulator-5554', 'stopped'])

    // 첫 시작이 실패해도 stopped
    await h.manager.open('emulator-5556')
    expect(h.states.at(-1)).toEqual(['emulator-5556', 'stopped'])
  })

  it('reports stopped when the first start fails, and does not repeat it on close', async () => {
    const h = harness({ startResults: ['fail'] })

    await h.manager.open('emulator-5554')
    await h.manager.stop()

    expect(h.states).toEqual([['emulator-5554', 'stopped']])
  })

  it('reports stopped once when every reconnect attempt fails', async () => {
    const h = harness({ startResults: ['ok', 'fail', 'fail', 'fail'] })
    await h.manager.open('emulator-5554')

    h.sessions[0]?.handlers.onEnded(endError)
    await h.wake()
    await h.wake()
    await h.wake()
    await vi.waitFor(() => expect(h.states.at(-1)).toEqual(['emulator-5554', 'stopped']))
    await h.manager.stop()

    expect(h.states.map(([, state]) => state)).toEqual(['started', 'reconnecting', 'reconnecting', 'reconnecting', 'stopped'])
  })

  it('reports stopped for the previous device when another opens, and on stop', async () => {
    const h = harness()
    await h.manager.open('emulator-5554')
    await h.manager.open('emulator-5556')
    await h.manager.stop()

    expect(h.states).toEqual([
      ['emulator-5554', 'started'],
      ['emulator-5554', 'stopped'],
      ['emulator-5556', 'started'],
      ['emulator-5556', 'stopped']
    ])
  })

  it('does not report stopped for a session closed before it ever started', async () => {
    const h = harness({ startResults: ['pending'] })
    const opening = h.manager.open('emulator-5554')
    await vi.waitFor(() => expect(h.sessions).toHaveLength(1))

    await h.manager.stop()
    await opening

    expect(h.states).toEqual([])
  })
})

describe('jpeg frame flow control', () => {
  const info = { width: 472, height: 1024, codec: 'jpeg' as const, keys: [] as DeviceKey[] }
  const frame = (n: number): Uint8Array => new Uint8Array([n])
  const ACK = { type: 'frame_ack' }
  const frames = (port: FakePort | undefined): StreamDown[] => (port?.sent ?? []).filter((m) => m.type === 'frame')

  async function opened(opts: Parameters<typeof harness>[0] = {}) {
    const h = harness(opts)
    await h.manager.open('emulator-5554')
    return h
  }

  it('sends only the first frame until it is acknowledged, then the newest waiting one', async () => {
    const h = await opened()
    const s = h.sessions[0] as FakeSession
    s.handlers.onSession(info)

    s.handlers.onFrame(frame(1))
    s.handlers.onFrame(frame(2))
    s.handlers.onFrame(frame(3))
    expect(frames(h.ports[0])).toEqual([{ type: 'frame', data: frame(1) }])

    h.ports[0]?.receive(ACK)
    expect(frames(h.ports[0])).toEqual([
      { type: 'frame', data: frame(1) },
      { type: 'frame', data: frame(3) }
    ])
  })

  it('goes idle after an ack with nothing waiting, so the next frame is sent at once', async () => {
    const h = await opened()
    const s = h.sessions[0] as FakeSession
    s.handlers.onSession(info)
    s.handlers.onFrame(frame(1))
    s.handlers.onFrame(frame(2))
    expect(frames(h.ports[0])).toHaveLength(1)
    h.ports[0]?.receive(ACK)
    const before = frames(h.ports[0]).length
    expect(before).toBe(2)

    h.ports[0]?.receive(ACK)
    expect(frames(h.ports[0]).length).toBe(before)

    s.handlers.onFrame(frame(4))
    expect(frames(h.ports[0]).at(-1)).toEqual({ type: 'frame', data: frame(4) })
  })

  it('ignores an ack that arrives while nothing is awaited', async () => {
    const h = await opened()
    const s = h.sessions[0] as FakeSession
    s.handlers.onSession(info)

    h.ports[0]?.receive(ACK)
    s.handlers.onFrame(frame(1))
    s.handlers.onFrame(frame(2))

    expect(frames(h.ports[0])).toEqual([{ type: 'frame', data: frame(1) }])
  })

  it('drops the waiting frame and the wait when the session sends onSession again', async () => {
    const h = await opened()
    const s = h.sessions[0] as FakeSession
    s.handlers.onSession(info)
    s.handlers.onFrame(frame(1))
    s.handlers.onFrame(frame(2))

    expect(frames(h.ports[0])).toHaveLength(1)
    s.handlers.onSession(info)
    s.handlers.onFrame(frame(3))
    expect(frames(h.ports[0]).at(-1)).toEqual({ type: 'frame', data: frame(3) })
    const count = frames(h.ports[0]).length

    h.ports[0]?.receive(ACK)
    expect(frames(h.ports[0]).length).toBe(count)
  })

  it('does not release the old waiting frame on an ack while reconnecting', async () => {
    const h = await opened()
    const s = h.sessions[0] as FakeSession
    s.handlers.onSession(info)
    s.handlers.onFrame(frame(1))
    s.handlers.onFrame(frame(2))

    s.handlers.onEnded(endError)
    await vi.waitFor(() => expect(h.sleeps.length).toBe(1))
    h.ports[0]?.receive(ACK)

    expect(frames(h.ports[0])).toEqual([{ type: 'frame', data: frame(1) }])
  })

  it('sends the first frame of a reconnected session without a new onSession', async () => {
    const h = await opened()
    const s = h.sessions[0] as FakeSession
    s.handlers.onSession(info)
    s.handlers.onFrame(frame(1))
    s.handlers.onFrame(frame(2))
    expect(frames(h.ports[0])).toHaveLength(1)

    s.handlers.onEnded(endError)
    await h.wake()
    h.sessions[1]?.handlers.onFrame(frame(9))

    expect(frames(h.ports[0]).at(-1)).toEqual({ type: 'frame', data: frame(9) })
  })

  it('sends nothing on an ack after every retry failed', async () => {
    const h = await opened({ startResults: ['ok', 'fail', 'fail', 'fail'] })
    const s = h.sessions[0] as FakeSession
    s.handlers.onSession(info)
    s.handlers.onFrame(frame(1))
    s.handlers.onFrame(frame(2))

    s.handlers.onEnded(endError)
    await h.wake()
    await h.wake()
    await h.wake()
    expect(h.ports[0]?.statuses().at(-1)).toBe('failed')
    expect(frames(h.ports[0])).toHaveLength(1)
    const count = h.ports[0]?.sent.length

    h.ports[0]?.receive(ACK)
    expect(h.ports[0]?.sent.length).toBe(count)
  })

  it('ignores an ack from a port that open() replaced', async () => {
    const h = await opened()
    const s = h.sessions[0] as FakeSession
    s.handlers.onSession(info)
    s.handlers.onFrame(frame(1))
    s.handlers.onFrame(frame(2))
    await h.manager.open('emulator-5556')
    const countNew = h.ports[1]?.sent.length

    h.ports[0]?.receive(ACK)

    expect(h.ports[1]?.sent.length).toBe(countNew)
  })

  it('does not forward frame_ack to sendControl', async () => {
    const h = await opened()
    const s = h.sessions[0] as FakeSession
    s.handlers.onSession(info)
    s.handlers.onFrame(frame(1))

    h.ports[0]?.receive(ACK)

    expect(s.sendControl).not.toHaveBeenCalled()
  })

  it('leaves the port and sendControl untouched for an ack on a packet-only session', async () => {
    const h = await opened()
    const s = h.sessions[0] as FakeSession
    const count = h.ports[0]?.sent.length

    h.ports[0]?.receive(ACK)

    expect(h.ports[0]?.sent.length).toBe(count)
    expect(s.sendControl).not.toHaveBeenCalled()
  })

  it('sends nothing on an ack after stop()', async () => {
    const h = await opened()
    const s = h.sessions[0] as FakeSession
    s.handlers.onSession(info)
    s.handlers.onFrame(frame(1))
    s.handlers.onFrame(frame(2))
    await h.manager.stop()
    const count = h.ports[0]?.sent.length

    h.ports[0]?.receive(ACK)

    expect(h.ports[0]?.sent.length).toBe(count)
  })

  it('relays every packet regardless of acks', async () => {
    const h = await opened()
    const s = h.sessions[0] as FakeSession
    const data = new Uint8Array([1])

    s.handlers.onPacket({ config: false, key: true, ptsUs: 1, data })
    s.handlers.onPacket({ config: false, key: false, ptsUs: 2, data })
    s.handlers.onPacket({ config: false, key: false, ptsUs: 3, data })

    expect(h.ports[0]?.sent.filter((m) => m.type === 'packet')).toHaveLength(3)
  })
})

describe('isFrameAck', () => {
  it.each([[null], ['frame_ack'], [{ type: 'touch' }]])('rejects %j', (value) => {
    expect(isFrameAck(value)).toBe(false)
  })

  it('accepts a frame_ack even with extra fields', () => {
    expect(isFrameAck({ type: 'frame_ack', extra: 1 })).toBe(true)
  })
})

describe('toControlIntent', () => {
  const point = { x: 10, y: 20, width: 472, height: 1024 }

  it.each([
    [{ type: 'touch', action: 'down', point }],
    [{ type: 'scroll', point, hScroll: 0, vScroll: -1 }],
    [{ type: 'text', text: 'hello' }],
    [{ type: 'key', key: 'volume_up' }]
  ])('accepts %j', (value) => {
    expect(toControlIntent(value)).toEqual(value)
  })

  it.each([
    [null],
    ['key'],
    [{ type: 'touch', action: 'hover', point }],
    [{ type: 'touch', action: 'down', point: { ...point, x: Number.NaN } }],
    [{ type: 'touch', action: 'down', point: { ...point, width: 0 } }],
    [{ type: 'touch', action: 'down', point: { ...point, height: 70000 } }],
    [{ type: 'scroll', point, hScroll: Infinity, vScroll: 0 }],
    [{ type: 'text', text: '' }],
    [{ type: 'text', text: 'a'.repeat(301) }],
    [{ type: 'text', text: 42 }],
    [{ type: 'key', key: 'toString' }],
    [{ type: 'eval', code: 'x' }]
  ])('rejects %j', (value) => {
    expect(toControlIntent(value)).toBeNull()
  })

  it('drops fields it does not know', () => {
    expect(toControlIntent({ type: 'key', key: 'back', extra: true })).toEqual({ type: 'key', key: 'back' })
  })
})
