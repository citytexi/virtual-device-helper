import { randomUUID } from 'node:crypto'
import type { LogDown, LogEntry, LogPortMeta, LogUp, TailState } from '../../shared/types/logs'
import { createLogBuffer, LOG_BUFFER_CAPACITY, type LogBuffer } from './logBuffer'
import { createPidTracker, type PidTracker } from './pidTracker'
import type { LogTailHandlers } from './logTail'

/** 100ms마다 새 줄을 배치로 보낸다. */
const DEFAULT_BATCH_MS = 100
/** snapshot·resume 배치를 이 크기로 쪼갠다. 5만 줄을 한 번에 structured clone하지 않기 위해서다. */
const DEFAULT_SNAPSHOT_CHUNK = 5000

/** MessagePortMain에서 쓰는 부분. index.ts가 실제 포트를 이 모양으로 감싼다. */
export interface LogPortLike {
  postMessage(message: LogDown): void
  on(event: 'message', listener: (event: { data: unknown }) => void): unknown
  /** 반대쪽(renderer) 포트가 끊겼을 때. 창 닫힘·reload·크래시가 여기로 온다. */
  on(event: 'close', listener: () => void): unknown
  start(): void
  close(): void
}

/** deps.createTail이 돌려주는 tail 핸들. LogTail 중 매니저가 쓰는 부분만. */
type TailHandle = { start(): Promise<void>; stop(): void }

export interface LogManagerDeps {
  createTail(serial: string, handlers: LogTailHandlers): TailHandle
  /** `ps -A -o PID,NAME` 실행. 실패는 seed 없음으로 처리한다. */
  seedPids(serial: string): Promise<string>
  /** 실패는 빈 배열로 처리한다. */
  pidof(serial: string, pkg: string): Promise<number[]>
  /** remote는 renderer로 건넬 반대쪽 포트다. 매니저는 그 내용을 모른다. */
  createChannel(): { local: LogPortLike; remote: unknown }
  postPort(meta: LogPortMeta, remote: unknown): void
  newSessionId?: () => string
  batchMs?: number
  snapshotChunk?: number
  capacity?: number
}

export interface LogManager {
  /** 기기 연결. 이미 그 serial의 상태가 있으면 기존 tail을 멈추고 seq 0부터 새로 시작한다. */
  handleConnect(serial: string): void
  /** 기기 연결 해제. 열린 포트가 그 기기 것이면 stopped를 보내고 닫는다. 버퍼는 버린다. */
  handleDisconnect(serial: string): void
  /** 이전 포트를 닫고 그 serial로 새 로그 포트를 연다. */
  open(serial: string): void
  /** 현재 포트를 닫는다. 버퍼는 남는다. */
  close(): void
  pidHistory(serial: string, pkg: string): Promise<number[]>
  /** 모든 tail을 멈추고 포트를 닫는다. */
  stopAll(): void
}

interface DeviceState {
  tail: TailHandle
  buffer: LogBuffer
  tracker: PidTracker
  state: TailState
}

interface PortEntry {
  serial: string
  sessionId: string
  port: LogPortLike
  /** 이 포트로 마지막까지 보낸 seq. */
  sentSeq: number
  paused: boolean
  timer: ReturnType<typeof setInterval> | null
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

/** renderer가 보낸 값을 검증한다. 모양이 어긋나면 무시하도록 null을 돌려준다. */
export function toLogUp(value: unknown): LogUp | null {
  if (!isRecord(value)) return null
  if (value.type === 'pause') return { type: 'pause' }
  if (value.type === 'resume') {
    const afterSeq = value.afterSeq
    if (typeof afterSeq !== 'number' || !Number.isFinite(afterSeq)) return null
    return { type: 'resume', afterSeq }
  }
  return null
}

export function createLogManager(deps: LogManagerDeps): LogManager {
  const batchMs = deps.batchMs ?? DEFAULT_BATCH_MS
  const snapshotChunk = deps.snapshotChunk ?? DEFAULT_SNAPSHOT_CHUNK
  const capacity = deps.capacity ?? LOG_BUFFER_CAPACITY
  const newSessionId = deps.newSessionId ?? (() => randomUUID())

  const devices = new Map<string, DeviceState>()
  let currentPort: PortEntry | null = null

  function post(entry: PortEntry, message: LogDown): void {
    if (currentPort !== entry) return
    try {
      entry.port.postMessage(message)
    } catch {
      // 포트가 이미 끊겼다. 다음 open·close가 정리한다.
    }
  }

  /** entries를 snapshotChunk 크기로 쪼개 batch로 보낸다. 빈 배열이면 아무것도 보내지 않는다. */
  function sendBatches(entry: PortEntry, entries: LogEntry[]): void {
    for (let i = 0; i < entries.length; i += snapshotChunk) {
      post(entry, { type: 'batch', entries: entries.slice(i, i + snapshotChunk) })
    }
  }

  /** 버퍼 전체를 snapshotChunk 크기로 쪼개 보낸다. 마지막(또는 빈 버퍼일 때 유일한) 메시지만 done: true. */
  function sendSnapshot(entry: PortEntry, all: LogEntry[]): void {
    if (all.length === 0) {
      post(entry, { type: 'snapshot', entries: [], done: true })
      return
    }
    for (let i = 0; i < all.length; i += snapshotChunk) {
      const done = i + snapshotChunk >= all.length
      post(entry, { type: 'snapshot', entries: all.slice(i, i + snapshotChunk), done })
    }
  }

  function flushBatch(entry: PortEntry): void {
    if (currentPort !== entry || entry.paused) return
    const device = devices.get(entry.serial)
    if (!device) return
    if (device.buffer.lastSeq() <= entry.sentSeq) return // 새 줄이 없으면 아무것도 보내지 않는다
    const { entries } = device.buffer.since(entry.sentSeq)
    sendBatches(entry, entries)
    entry.sentSeq = device.buffer.lastSeq()
  }

  function closePortEntry(entry: PortEntry): void {
    if (entry.timer !== null) {
      clearInterval(entry.timer)
      entry.timer = null
    }
    try {
      entry.port.close()
    } catch {
      // 이미 닫힌 포트다.
    }
  }

  function handlePortMessage(entry: PortEntry, data: unknown): void {
    if (currentPort !== entry) return
    const msg = toLogUp(data)
    if (!msg) return // 모양이 어긋난 메시지는 무시한다

    if (msg.type === 'pause') {
      entry.paused = true
      return
    }

    // resume
    entry.paused = false
    const device = devices.get(entry.serial)
    if (!device) return
    const { gap, entries } = device.buffer.since(msg.afterSeq)
    if (gap) post(entry, { type: 'gap', fromSeq: gap.fromSeq, toSeq: gap.toSeq })
    sendBatches(entry, entries)
    const lastSeq = device.buffer.lastSeq()
    post(entry, { type: 'resumed', lastSeq })
    entry.sentSeq = lastSeq
  }

  function handlePortClose(entry: PortEntry): void {
    // renderer 쪽이 스스로 닫았다. 우리 쪽 포트는 이미 끊겼으니 close()를 다시 부르지 않는다.
    if (currentPort !== entry) return
    if (entry.timer !== null) {
      clearInterval(entry.timer)
      entry.timer = null
    }
    currentPort = null
  }

  function handleConnect(serial: string): void {
    // 이미 이 serial의 상태가 있으면 옛 tail을 멈추고 seq 0부터 새로 시작한다.
    const previous = devices.get(serial)

    const buffer = createLogBuffer(capacity)
    const tracker = createPidTracker()
    const device: DeviceState = {
      tail: null as unknown as TailHandle, // 아래서 즉시 채운다
      buffer,
      tracker,
      state: 'running'
    }

    // 이 tail이 아직 유효한(교체되지 않은) 상태인지 확인한다. 옛 tail의 늦은 콜백
    // (stop()이 동기로 내는 onState('stopped'), 이미 끊긴 스트림의 남은 onLine 등)이
    // 새 상태를 건드리지 않도록 막는다.
    function isCurrent(): boolean {
      return devices.get(serial) === device
    }

    const handlers: LogTailHandlers = {
      onLine(line, at) {
        if (!isCurrent()) return
        // Start proc 줄 자신의 pkg에는 영향을 주지 않는다. observe를 먼저 부르고
        // packageOf는 그 이후 값으로 읽는다(그 줄은 ActivityManager의 pid로 온다).
        const isNewPkg = tracker.observe(line)
        const pkg = tracker.packageOf(line.pid)
        buffer.append(pkg === undefined ? { ...line, at } : { ...line, at, pkg })
        if (isNewPkg && currentPort?.serial === serial) {
          post(currentPort, { type: 'packages', packages: tracker.packages() })
        }
      },
      onResume() {
        if (!isCurrent()) return
        buffer.markResume()
      },
      onState(next) {
        if (!isCurrent()) return
        device.state = next
        if (currentPort?.serial === serial) {
          post(currentPort, { type: 'status', state: next })
        }
      }
    }

    device.tail = deps.createTail(serial, handlers)
    // 맵을 새 상태로 먼저 바꾼다. 그래야 바로 아래서 부르는 옛 tail.stop()이 동기로 내는
    // 이벤트가 위 isCurrent() 가드에 막혀 새 상태를 건드리지 않는다.
    devices.set(serial, device)
    previous?.tail.stop()

    device.tail.start().catch(() => {
      // adb 실행 자체가 던지면(예: exec 실패) tail은 시작도 못 하고 끝난다. 이걸 놓치면
      // 포트는 영원히 'running'인 채로 멈춰 있으므로 stopped로 알린다.
      handlers.onState('stopped')
    })

    // 이 serial로 이미 열린 포트가 있으면 새로 연다: 옛 포트를 닫고 새 sessionId로
    // 빈 snapshot부터 다시 시작한다. sentSeq만 되돌리면 옛 세션의 seq 공간과 새 버퍼가
    // 뒤섞여 렌더러가 이미 받은 옛 seq들과 충돌한다.
    if (currentPort?.serial === serial) {
      open(serial)
    }

    // seedPids는 기다리지 않는다. 늦게 와도 그 뒤 줄부터 pkg가 붙는다.
    deps.seedPids(serial).then(
      (stdout) => {
        if (!isCurrent()) return // 그 사이 재연결·연결해제로 상태가 바뀌었다
        tracker.seed(stdout)
        if (currentPort?.serial === serial) {
          post(currentPort, { type: 'packages', packages: tracker.packages() })
        }
      },
      () => {
        // ps 실패는 seed 없음으로 조용히 넘어간다.
      }
    )
  }

  function handleDisconnect(serial: string): void {
    const device = devices.get(serial)
    if (!device) return
    // 맵에서 먼저 지운다. tail.stop()은 동기로 onState('stopped')를 낼 수 있는데,
    // 그 콜백은 이 device가 더 이상 맵에 없으므로(handleConnect의 isCurrent()와 같은 가드) 조용히
    // 물러나고, 아래 명시적 post 하나만 나간다 — 'stopped'가 두 번 가지 않는다.
    devices.delete(serial)
    device.tail.stop()

    if (currentPort?.serial === serial) {
      const entry = currentPort
      post(entry, { type: 'status', state: 'stopped' })
      currentPort = null
      closePortEntry(entry)
    }
  }

  function open(serial: string): void {
    if (currentPort) {
      const previous = currentPort
      currentPort = null
      closePortEntry(previous)
    }

    const channel = deps.createChannel()
    const entry: PortEntry = {
      serial,
      sessionId: newSessionId(),
      port: channel.local,
      sentSeq: -1,
      paused: false,
      timer: null
    }
    currentPort = entry

    channel.local.on('message', (event) => handlePortMessage(entry, event.data))
    channel.local.on('close', () => handlePortClose(entry))

    deps.postPort({ serial, sessionId: entry.sessionId }, channel.remote)
    channel.local.start()

    const device = devices.get(serial)
    if (!device) {
      // 연결되지 않은 기기. 빈 snapshot·packages·status만 보내고 타이머는 두지 않는다.
      post(entry, { type: 'snapshot', entries: [], done: true })
      post(entry, { type: 'packages', packages: [] })
      post(entry, { type: 'status', state: 'stopped' })
      return
    }

    sendSnapshot(entry, device.buffer.all())
    post(entry, { type: 'packages', packages: device.tracker.packages() })
    post(entry, { type: 'status', state: device.state })
    entry.sentSeq = device.buffer.lastSeq()
    entry.timer = setInterval(() => flushBatch(entry), batchMs)
  }

  function close(): void {
    if (!currentPort) return
    const entry = currentPort
    currentPort = null
    closePortEntry(entry)
  }

  async function pidHistory(serial: string, pkg: string): Promise<number[]> {
    const device = devices.get(serial)
    const history = device ? device.tracker.pidsOf(pkg) : []

    let fromPidof: number[]
    try {
      fromPidof = await deps.pidof(serial, pkg)
    } catch {
      fromPidof = []
    }

    const seen = new Set<number>()
    const merged: number[] = []
    for (const pid of [...history, ...fromPidof]) {
      if (seen.has(pid)) continue
      seen.add(pid)
      merged.push(pid)
    }
    return merged
  }

  function stopAll(): void {
    for (const device of devices.values()) {
      device.tail.stop()
    }
    devices.clear()
    close()
  }

  return { handleConnect, handleDisconnect, open, close, pidHistory, stopAll }
}
