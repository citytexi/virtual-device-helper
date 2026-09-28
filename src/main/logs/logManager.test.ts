import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest'
import type { LogDown } from '../../shared/types/logs'
import type { LogLine } from '../../shared/types/device'
import { createLogManager, toLogUp, type LogManagerDeps, type LogPortLike } from './logManager'
import type { LogTailHandlers } from './logTail'

/** 가짜 로그 포트. 받은 메시지를 배열에 쌓고, renderer→main 방향은 receive로 흉내낸다. */
class FakePort implements LogPortLike {
  readonly sent: LogDown[] = []
  readonly start = vi.fn()
  readonly close = vi.fn()
  private listener: ((event: { data: unknown }) => void) | null = null
  private closeListener: (() => void) | null = null

  postMessage(message: LogDown): void {
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
}

interface FakeTail {
  start: Mock<() => Promise<void>>
  stop: Mock<() => void>
  handlers: LogTailHandlers
}

function line(overrides: Partial<LogLine> = {}): LogLine {
  return {
    timestamp: '09-28 10:00:00.000',
    level: 'I',
    tag: 'T',
    pid: 1,
    message: 'm',
    ...overrides
  }
}

const startProc = (pid: number, pkg: string, byPid = 500): LogLine => ({
  timestamp: '09-28 10:00:00.000',
  level: 'I',
  tag: 'ActivityManager',
  pid: byPid,
  message: `Start proc ${pid}:${pkg}/u0a1 for top-activity {${pkg}/.Main}`
})

function harness(
  opts: {
    batchMs?: number
    snapshotChunk?: number
    capacity?: number
    pidof?: (serial: string, pkg: string) => Promise<number[]>
  } = {}
) {
  const tails: Record<string, FakeTail> = {}
  const ports: FakePort[] = []
  const posted: Array<{ serial: string; sessionId: string }> = []
  const seedResolvers: Record<string, { resolve: (s: string) => void; reject: (e: unknown) => void }> = {}
  let sessionCounter = 0

  const deps: LogManagerDeps = {
    createTail: (_serial, handlers) => {
      // 실제 LogTail의 stop()은 동기로 onState('stopped')를 낸다. 가짜도 그렇게 해서
      // 매니저가 그 콜백을 올바르게 가드하는지 테스트로 드러낸다.
      const tail: FakeTail = {
        start: vi.fn(async () => {}),
        stop: vi.fn(() => {
          handlers.onState('stopped')
        }),
        handlers
      }
      tails[_serial] = tail
      return tail
    },
    seedPids: (serial) =>
      new Promise<string>((resolve, reject) => {
        seedResolvers[serial] = { resolve, reject }
      }),
    pidof: opts.pidof ?? (() => Promise.resolve([])),
    createChannel: () => {
      const local = new FakePort()
      ports.push(local)
      return { local, remote: { idx: ports.length - 1 } }
    },
    postPort: (meta) => posted.push(meta),
    newSessionId: () => `s${sessionCounter++}`,
    batchMs: opts.batchMs,
    snapshotChunk: opts.snapshotChunk,
    capacity: opts.capacity
  }

  const manager = createLogManager(deps)
  return { manager, tails, ports, posted, seedResolvers }
}

function lastPort(ports: FakePort[]): FakePort {
  const port = ports[ports.length - 1]
  if (!port) throw new Error('no port created')
  return port
}

describe('createLogManager', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('starts a tail on connect and stops it on disconnect', () => {
    const { manager, tails } = harness()
    manager.handleConnect('e1')
    expect(tails.e1!.start).toHaveBeenCalled()
    manager.handleDisconnect('e1')
    expect(tails.e1!.stop).toHaveBeenCalled()
  })

  it('stamps pkg from the pid tracker at ingest time', async () => {
    const { manager, tails, seedResolvers, ports } = harness()
    manager.handleConnect('e1')
    seedResolvers.e1!.resolve('  PID NAME\n 8383 com.android.settings\n')
    await Promise.resolve()
    await Promise.resolve()

    manager.open('e1')
    const port = lastPort(ports)
    port.sent.length = 0

    tails.e1!.handlers.onLine(line({ pid: 8383 }), 1000)
    vi.advanceTimersByTime(100)

    const batch = port.sent.find((m) => m.type === 'batch')
    expect(batch).toBeDefined()
    if (batch?.type !== 'batch') throw new Error('expected batch')
    expect(batch.entries[0]?.pkg).toBe('com.android.settings')
  })

  it('a Start proc line does not stamp pkg onto itself from its own pid mapping mistakenly', () => {
    // observe()가 먼저 실행되어 Start proc 줄 자체는 ActivityManager의 pid(byPid)로 pkg를 매긴다.
    const { manager, tails, ports } = harness()
    manager.handleConnect('e1')
    manager.open('e1')
    const port = lastPort(ports)
    port.sent.length = 0

    tails.e1!.handlers.onLine(startProc(9000, 'com.example.app', 500), 1)
    vi.advanceTimersByTime(100)

    const batch = port.sent.find((m) => m.type === 'batch')
    if (batch?.type !== 'batch') throw new Error('expected batch')
    // pid 500은 이 줄 전에는 알려진 패키지가 없었으므로 pkg가 없다.
    expect(batch.entries[0]?.pkg).toBeUndefined()
  })

  it('sends the buffer as 5000-line snapshot chunks on open', () => {
    const { manager, tails, ports } = harness()
    manager.handleConnect('e1')
    for (let i = 0; i < 12000; i++) {
      tails.e1!.handlers.onLine(line({ message: String(i) }), i)
    }
    manager.open('e1')
    const port = lastPort(ports)
    const snapshots = port.sent.filter((m) => m.type === 'snapshot')
    expect(snapshots).toHaveLength(3)
    if (snapshots[0]?.type !== 'snapshot' || snapshots[1]?.type !== 'snapshot' || snapshots[2]?.type !== 'snapshot') {
      throw new Error('expected snapshots')
    }
    expect(snapshots[0].entries).toHaveLength(5000)
    expect(snapshots[1].entries).toHaveLength(5000)
    expect(snapshots[2].entries).toHaveLength(2000)
    expect(snapshots[0].done).toBe(false)
    expect(snapshots[1].done).toBe(false)
    expect(snapshots[2].done).toBe(true)
  })

  it('sends one empty done snapshot for an empty buffer', () => {
    const { manager, ports } = harness()
    manager.handleConnect('e1')
    manager.open('e1')
    const port = lastPort(ports)
    const snapshots = port.sent.filter((m) => m.type === 'snapshot')
    expect(snapshots).toEqual([{ type: 'snapshot', entries: [], done: true }])
  })

  it('follows the snapshot with the full package list and current status', () => {
    const { manager, tails, ports } = harness()
    manager.handleConnect('e1')
    tails.e1!.handlers.onLine(startProc(9000, 'com.example.app'), 1)

    manager.open('e1')
    const port = lastPort(ports)
    const types = port.sent.map((m) => m.type)
    const snapshotEnd = types.lastIndexOf('snapshot')
    expect(types[snapshotEnd + 1]).toBe('packages')
    expect(types[snapshotEnd + 2]).toBe('status')
    expect(port.sent[snapshotEnd + 1]).toEqual({ type: 'packages', packages: ['com.example.app'] })
    expect(port.sent[snapshotEnd + 2]).toEqual({ type: 'status', state: 'running' })
  })

  it('sends packages again when the ps seed finishes after open', async () => {
    const { manager, ports, seedResolvers } = harness()
    manager.handleConnect('e1')
    manager.open('e1')
    const port = lastPort(ports)
    port.sent.length = 0

    seedResolvers.e1!.resolve('  PID NAME\n 8383 com.android.settings\n')
    await Promise.resolve()
    await Promise.resolve()

    const packagesMsgs = port.sent.filter((m) => m.type === 'packages')
    expect(packagesMsgs).toEqual([{ type: 'packages', packages: ['com.android.settings'] }])
  })

  it('batches new lines every 100ms and sends nothing when idle', () => {
    const { manager, tails, ports } = harness()
    manager.handleConnect('e1')
    manager.open('e1')
    const port = lastPort(ports)

    const push = (n: number) => {
      for (let i = 0; i < n; i++) tails.e1!.handlers.onLine(line({ message: String(i) }), i)
    }
    push(3)
    vi.advanceTimersByTime(100)
    expect(port.sent.filter((x) => x.type === 'batch')).toHaveLength(1)
    vi.advanceTimersByTime(500)
    expect(port.sent.filter((x) => x.type === 'batch')).toHaveLength(1)
  })

  it('holds batches while paused and resumes with gap then resumed', () => {
    const { manager, tails, ports } = harness({ capacity: 10 })
    manager.handleConnect('e1')
    manager.open('e1')
    const port = lastPort(ports)

    const push = (n: number, startAt: number) => {
      for (let i = 0; i < n; i++) tails.e1!.handlers.onLine(line({ message: `m${startAt + i}` }), startAt + i)
    }

    push(3, 0)
    vi.advanceTimersByTime(100)
    expect(port.sent.filter((m) => m.type === 'batch')).toHaveLength(1) // seq 0..2

    port.receive({ type: 'pause' })
    push(27, 3) // seq 3..29, capacity 10이라 버퍼엔 20..29만 남는다
    vi.advanceTimersByTime(500)
    expect(port.sent.filter((m) => m.type === 'batch')).toHaveLength(1) // pause 중엔 더 안 보낸다

    port.receive({ type: 'resume', afterSeq: 2 })

    const gap = port.sent.find((m) => m.type === 'gap')
    expect(gap).toEqual({ type: 'gap', fromSeq: 3, toSeq: 19 })
    const resumed = port.sent.find((m) => m.type === 'resumed')
    expect(resumed).toEqual({ type: 'resumed', lastSeq: 29 })

    const resumeBatch = port.sent.filter((m) => m.type === 'batch')
    expect(resumeBatch).toHaveLength(2) // 처음 1개 + resume으로 온 1개(10줄이 한 청크에 들어간다)
    const last = resumeBatch[resumeBatch.length - 1]
    if (last?.type !== 'batch') throw new Error('expected batch')
    expect(last.entries.map((e) => e.seq)).toEqual([20, 21, 22, 23, 24, 25, 26, 27, 28, 29])
  })

  it('splits a long resume into snapshotChunk-sized batches', () => {
    const { manager, tails, ports } = harness({ snapshotChunk: 5 })
    manager.handleConnect('e1')
    manager.open('e1')
    const port = lastPort(ports)

    for (let i = 0; i < 12; i++) tails.e1!.handlers.onLine(line({ message: String(i) }), i)
    vi.advanceTimersByTime(100)
    port.sent.length = 0

    port.receive({ type: 'resume', afterSeq: -1 })

    const batches = port.sent.filter((m) => m.type === 'batch')
    expect(
      batches.map((b) => {
        if (b.type !== 'batch') throw new Error('expected batch')
        return b.entries.length
      })
    ).toEqual([5, 5, 2])
    expect(port.sent[port.sent.length - 1]).toEqual({ type: 'resumed', lastSeq: 11 })
  })

  it('resets pause state for a new port', () => {
    const { manager, tails, ports } = harness()
    manager.handleConnect('e1')
    manager.open('e1')
    const port1 = lastPort(ports)
    port1.receive({ type: 'pause' })

    manager.open('e1') // 새 포트. pause 상태는 이어지지 않는다
    const port2 = lastPort(ports)

    tails.e1!.handlers.onLine(line(), 1)
    vi.advanceTimersByTime(100)
    expect(port2.sent.filter((m) => m.type === 'batch')).toHaveLength(1)
  })

  it('sends stopped exactly once and closes the port when its device disconnects', () => {
    const { manager, ports } = harness()
    manager.handleConnect('e1')
    manager.open('e1')
    const port = lastPort(ports)

    manager.handleDisconnect('e1')

    // 가짜 tail의 stop()도 onState('stopped')를 내지만, handleDisconnect가 먼저 devices에서
    // 지우므로 그 콜백은 가드에 막히고 명시적 post 하나만 나간다.
    const stoppedMsgs = port.sent.filter((m) => m.type === 'status' && m.state === 'stopped')
    expect(stoppedMsgs).toHaveLength(1)
    expect(port.sent[port.sent.length - 1]).toEqual({ type: 'status', state: 'stopped' })
    expect(port.close).toHaveBeenCalled()
  })

  it('calls markResume on the buffer when the tail resumes', () => {
    const { manager, tails, ports } = harness()
    manager.handleConnect('e1')
    const dup = line({ timestamp: '09-28 10:00:00.000', pid: 1, tag: 'T', message: 'dup' })
    tails.e1!.handlers.onLine(dup, 1000)
    tails.e1!.handlers.onResume()
    tails.e1!.handlers.onLine(dup, 1000) // markResume이 불렸으면 경계 중복으로 걸러진다

    manager.open('e1')
    const port = lastPort(ports)
    const snapshot = port.sent.find((m) => m.type === 'snapshot')
    if (snapshot?.type !== 'snapshot') throw new Error('expected snapshot')
    expect(snapshot.entries).toHaveLength(1)
  })

  it('closes the previous port when opening another', () => {
    const { manager, ports } = harness()
    manager.handleConnect('e1')
    manager.handleConnect('e2')
    manager.open('e1')
    const port1 = lastPort(ports)
    manager.open('e2')
    expect(port1.close).toHaveBeenCalled()
  })

  it('keeps the buffer after the renderer side closes', () => {
    const { manager, tails, ports } = harness()
    manager.handleConnect('e1')
    manager.open('e1')
    const port1 = lastPort(ports)

    tails.e1!.handlers.onLine(line({ message: 'old' }), 1)
    vi.advanceTimersByTime(100)
    port1.disconnect() // renderer 쪽이 포트를 놓았다

    manager.open('e1')
    const port2 = lastPort(ports)
    const snapshot = port2.sent.find((m) => m.type === 'snapshot')
    if (snapshot?.type !== 'snapshot') throw new Error('expected snapshot')
    expect(snapshot.entries.some((e) => e.message === 'old')).toBe(true)
  })

  it('ignores malformed LogUp', () => {
    expect(toLogUp({ type: 'resume' })).toBeNull()
    expect(toLogUp('x')).toBeNull()
    expect(toLogUp(null)).toBeNull()
    expect(toLogUp({ type: 'pause' })).toEqual({ type: 'pause' })
    expect(toLogUp({ type: 'resume', afterSeq: 5 })).toEqual({ type: 'resume', afterSeq: 5 })
  })

  it('the manager silently drops malformed messages from the port', () => {
    const { manager, ports } = harness()
    manager.handleConnect('e1')
    manager.open('e1')
    const port = lastPort(ports)
    port.sent.length = 0

    port.receive({ type: 'resume' }) // afterSeq 없음
    port.receive('x')

    expect(port.sent).toHaveLength(0)
  })

  it('sends packages when a new package appears', () => {
    const { manager, tails, ports } = harness()
    manager.handleConnect('e1')
    manager.open('e1')
    const port = lastPort(ports)
    port.sent.length = 0

    tails.e1!.handlers.onLine(startProc(9000, 'com.example.app'), 1)

    expect(port.sent.filter((m) => m.type === 'packages')).toEqual([
      { type: 'packages', packages: ['com.example.app'] }
    ])
  })

  it('forwards tail state as status', () => {
    const { manager, tails, ports } = harness()
    manager.handleConnect('e1')
    manager.open('e1')
    const port = lastPort(ports)
    port.sent.length = 0

    tails.e1!.handlers.onState('reconnecting')

    expect(port.sent).toEqual([{ type: 'status', state: 'reconnecting' }])
  })

  it('pidHistory merges history and pidof', async () => {
    const { manager, tails } = harness({ pidof: () => Promise.resolve([9100]) })
    manager.handleConnect('e1')
    tails.e1!.handlers.onLine(startProc(9000, 'com.example.app'), 1)

    const pids = await manager.pidHistory('e1', 'com.example.app')
    expect(pids).toEqual([9000, 9100])
  })

  it('pidHistory returns history alone when pidof rejects', async () => {
    const { manager, tails } = harness({ pidof: () => Promise.reject(new Error('exit 1')) })
    manager.handleConnect('e1')
    tails.e1!.handlers.onLine(startProc(9000, 'com.example.app'), 1)

    const pids = await manager.pidHistory('e1', 'com.example.app')
    expect(pids).toEqual([9000])
  })

  it('pidHistory for an unknown device falls back to pidof', async () => {
    const { manager } = harness({ pidof: () => Promise.resolve([42]) })
    const pids = await manager.pidHistory('unknown', 'com.example.app')
    expect(pids).toEqual([42])
  })

  it('survives a rejected ps seed', async () => {
    const { manager, tails, seedResolvers, ports } = harness()
    manager.handleConnect('e1')
    manager.open('e1')
    const port = lastPort(ports)
    port.sent.length = 0

    seedResolvers.e1!.reject(new Error('no ps'))
    await Promise.resolve()
    await Promise.resolve()

    expect(port.sent.filter((m) => m.type === 'packages')).toHaveLength(0)

    // seed 실패 후에도 로그 파이프라인은 계속 동작한다
    tails.e1!.handlers.onLine(line(), 1)
    vi.advanceTimersByTime(100)
    expect(port.sent.filter((m) => m.type === 'batch')).toHaveLength(1)
  })

  it('handleConnect for an already-connected serial starts fresh with seq 0', () => {
    const { manager, tails, ports } = harness()
    manager.handleConnect('e1')
    tails.e1!.handlers.onLine(line({ message: 'old-session' }), 1)
    const oldTail = tails.e1!

    manager.handleConnect('e1') // 재연결
    expect(oldTail.stop).toHaveBeenCalled()

    manager.open('e1')
    const port = lastPort(ports)
    const snapshot = port.sent.find((m) => m.type === 'snapshot')
    if (snapshot?.type !== 'snapshot') throw new Error('expected snapshot')
    expect(snapshot.entries).toHaveLength(0) // 옛 버퍼는 버려졌다

    tails.e1!.handlers.onLine(line({ message: 'new' }), 1)
    vi.advanceTimersByTime(100)
    const batch = port.sent.find((m) => m.type === 'batch')
    if (batch?.type !== 'batch') throw new Error('expected batch')
    expect(batch.entries[0]?.seq).toBe(0)
  })

  it('opens a fresh log port when a device connects while its (disconnected) port was already open', () => {
    const { manager, tails, ports } = harness()
    manager.open('e1') // 아직 연결 전 — 빈 snapshot/packages/status:'stopped', 타이머 없음
    const disconnectedPort = lastPort(ports)
    expect(disconnectedPort.sent).toEqual([
      { type: 'snapshot', entries: [], done: true },
      { type: 'packages', packages: [] },
      { type: 'status', state: 'stopped' }
    ])

    manager.handleConnect('e1')
    expect(disconnectedPort.close).toHaveBeenCalled()

    const connectedPort = lastPort(ports)
    expect(connectedPort).not.toBe(disconnectedPort)
    expect(connectedPort.sent.find((m) => m.type === 'status')).toEqual({ type: 'status', state: 'running' })

    tails.e1!.handlers.onLine(line({ message: 'x' }), 1)
    vi.advanceTimersByTime(100)
    const batch = connectedPort.sent.find((m) => m.type === 'batch')
    if (batch?.type !== 'batch') throw new Error('expected batch')
    expect(batch.entries.map((e) => e.message)).toEqual(['x'])
  })

  it('reopens the log port when handleConnect fires again while it is open (duplicate connect)', () => {
    const { manager, tails, ports } = harness()
    manager.handleConnect('e1')
    tails.e1!.handlers.onLine(line({ message: 'a' }), 1)
    tails.e1!.handlers.onLine(line({ message: 'b' }), 2)
    manager.open('e1')
    const oldPort = lastPort(ports)

    manager.handleConnect('e1') // 포트가 열린 채로 중복 connect

    expect(oldPort.close).toHaveBeenCalled()
    const newPort = lastPort(ports)
    expect(newPort).not.toBe(oldPort)

    const snapshot = newPort.sent.find((m) => m.type === 'snapshot')
    if (snapshot?.type !== 'snapshot') throw new Error('expected snapshot')
    expect(snapshot.entries).toHaveLength(0) // 새 버퍼는 비어 있다 — 옛 줄은 안 이어진다
    expect(snapshot.done).toBe(true)

    tails.e1!.handlers.onLine(line({ message: 'fresh' }), 3)
    vi.advanceTimersByTime(100)
    const batch = newPort.sent.find((m) => m.type === 'batch')
    if (batch?.type !== 'batch') throw new Error('expected batch')
    expect(batch.entries.map((e) => e.message)).toEqual(['fresh'])
  })

  it('ignores late events from a tail that handleConnect already superseded', () => {
    const { manager, tails, ports } = harness()
    manager.handleConnect('e1')
    const oldHandlers = tails.e1!.handlers
    manager.handleConnect('e1') // 교체. 이 안에서 옛 tail.stop()도 불리지만 가드에 막힌다
    manager.open('e1')
    const port = lastPort(ports)
    port.sent.length = 0

    oldHandlers.onLine(line({ message: 'stale' }), 1) // 옛 tail에서 늦게 온 줄
    oldHandlers.onState('reconnecting')
    oldHandlers.onResume()

    vi.advanceTimersByTime(100)
    expect(port.sent.filter((m) => m.type === 'status')).toHaveLength(0)
    expect(port.sent.filter((m) => m.type === 'batch')).toHaveLength(0)
  })

  it('forwards a tail start rejection as stopped status without an unhandled rejection', async () => {
    const ports: FakePort[] = []
    const deps: LogManagerDeps = {
      createTail: () => ({ start: () => Promise.reject(new Error('adb 실행 실패')), stop: vi.fn() }),
      seedPids: () => new Promise(() => {}), // 응답 없음 — 이 테스트와 무관
      pidof: () => Promise.resolve([]),
      createChannel: () => {
        const local = new FakePort()
        ports.push(local)
        return { local, remote: {} }
      },
      postPort: () => {},
      newSessionId: () => 's0'
    }
    const manager = createLogManager(deps)

    manager.open('e1') // 연결 전 — 빈 상태 포트
    manager.handleConnect('e1') // 이 안에서 open을 다시 불러 새 포트를 연다. start()는 곧 reject된다.

    await Promise.resolve()
    await Promise.resolve()

    const port = lastPort(ports)
    const statuses = port.sent.filter((m) => m.type === 'status')
    expect(statuses[statuses.length - 1]).toEqual({ type: 'status', state: 'stopped' })
  })

  it('sends an empty done snapshot and stopped status for a serial with no device state', () => {
    const { manager, ports } = harness()
    manager.open('never-connected')
    const port = lastPort(ports)
    expect(port.sent).toEqual([
      { type: 'snapshot', entries: [], done: true },
      { type: 'packages', packages: [] },
      { type: 'status', state: 'stopped' }
    ])
  })

  it('close() clears the timer and closes the port, keeping the buffer', () => {
    const { manager, tails, ports } = harness()
    manager.handleConnect('e1')
    manager.open('e1')
    const port = lastPort(ports)

    tails.e1!.handlers.onLine(line({ message: 'kept' }), 1)
    vi.advanceTimersByTime(100)

    manager.close()
    expect(port.close).toHaveBeenCalled()

    manager.open('e1')
    const port2 = lastPort(ports)
    const snapshot = port2.sent.find((m) => m.type === 'snapshot')
    if (snapshot?.type !== 'snapshot') throw new Error('expected snapshot')
    expect(snapshot.entries.some((e) => e.message === 'kept')).toBe(true)
  })

  it('stopAll stops every tail and closes the port', () => {
    const { manager, tails, ports } = harness()
    manager.handleConnect('e1')
    manager.handleConnect('e2')
    manager.open('e1')
    const port = lastPort(ports)

    manager.stopAll()

    expect(tails.e1!.stop).toHaveBeenCalled()
    expect(tails.e2!.stop).toHaveBeenCalled()
    expect(port.close).toHaveBeenCalled()
  })
})
