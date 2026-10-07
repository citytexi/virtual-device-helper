import { randomUUID } from 'node:crypto'
import { isDeviceError, type ToolError } from '../../shared/types/errors'
import {
  DEVICE_KEYS,
  type ControlIntent,
  type DeviceKey,
  type StreamDown,
  type SessionPortMeta,
  type VideoPoint
} from '../../shared/types/stream'
import type { StreamSession, StreamSessionHandlers } from './streamSession'
import { INJECT_TEXT_MAX_BYTES } from './scrcpyProtocol'

export const RECONNECT_DELAYS_MS = [1000, 2000, 4000] as const

/** MessagePortMain에서 쓰는 부분. index.ts가 실제 포트를 이 모양으로 감싼다. */
export interface PortLike {
  postMessage(message: StreamDown): void
  on(event: 'message', listener: (event: { data: unknown }) => void): unknown
  /** 반대쪽(renderer) 포트가 끊겼을 때. 창 닫힘·reload·크래시가 여기로 온다. */
  on(event: 'close', listener: () => void): unknown
  start(): void
  close(): void
}

export interface StreamManagerDeps {
  createSession(serial: string, handlers: StreamSessionHandlers): StreamSession
  /** remote는 renderer로 건넬 반대쪽 포트다. 매니저는 그 내용을 모른다. */
  createChannel(): { local: PortLike; remote: unknown }
  postPort(meta: SessionPortMeta, remote: unknown): void
  isConnected(serial: string): boolean
  sleep?: (ms: number) => Promise<void>
  newSessionId?: () => string
  /**
   * 스트림 상태 변화. 화면이 나오기 시작하면 started, 재시도에 들어가면 reconnecting,
   * 나오던 세션이 닫히거나 끝내 실패하면 stopped다. 앱 상태가 이것으로 타임라인에 stream_* 항목을 쌓는다.
   */
  onState?: (serial: string, state: StreamLifecycle) => void
}

export type StreamLifecycle = 'started' | 'reconnecting' | 'stopped'

export interface StreamManager {
  /** 이전 세션을 닫고 serial로 새 세션을 연다. 실패는 던지지 않고 포트의 status로 알린다. */
  open(serial: string): Promise<void>
  stop(): Promise<void>
}

interface Entry {
  serial: string
  sessionId: string
  port: PortLike
  /** 시작 중인 세션도 여기 붙는다. 그래야 closeEntry가 시작을 중단시킬 수 있다. */
  session: StreamSession | null
  /** onState로 마지막에 알린 상태. 한 번도 알리지 않았으면 null이다. */
  reported: StreamLifecycle | null
  /** jpeg 프레임을 보냈고 renderer의 frame_ack를 아직 못 받았다. */
  awaitingAck: boolean
  /** 확인을 기다리는 동안 들어온 가장 새 프레임. 더 새 프레임이 오면 덮어쓴다. */
  pendingFrame: Uint8Array | null
}

const DEVICE_KEY_SET: ReadonlySet<string> = new Set(DEVICE_KEYS)
const MAX_DIMENSION = 0xffff

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value)
}

function toVideoPoint(value: unknown): VideoPoint | null {
  if (typeof value !== 'object' || value === null) return null
  const { x, y, width, height } = value as Record<string, unknown>
  if (!isFiniteNumber(x) || !isFiniteNumber(y)) return null
  if (!Number.isInteger(width) || !Number.isInteger(height)) return null
  const w = width as number
  const h = height as number
  if (w < 1 || h < 1 || w > MAX_DIMENSION || h > MAX_DIMENSION) return null
  return { x, y, width: w, height: h }
}

/**
 * renderer가 보낸 값을 입력 의도로 바꾼다. 모양이 하나라도 어긋나면 null이다.
 * 모르는 필드는 버리고 새 객체를 만든다 — renderer 입력을 그대로 흘리지 않는다.
 */
export function toControlIntent(value: unknown): ControlIntent | null {
  if (typeof value !== 'object' || value === null) return null
  const record = value as Record<string, unknown>

  switch (record.type) {
    case 'touch': {
      const point = toVideoPoint(record.point)
      const action = record.action
      if (!point || (action !== 'down' && action !== 'move' && action !== 'up')) return null
      return { type: 'touch', action, point }
    }
    case 'scroll': {
      const point = toVideoPoint(record.point)
      if (!point || !isFiniteNumber(record.hScroll) || !isFiniteNumber(record.vScroll)) return null
      return { type: 'scroll', point, hScroll: record.hScroll, vScroll: record.vScroll }
    }
    case 'text': {
      const text = record.text
      if (typeof text !== 'string' || text.length === 0) return null
      if (Buffer.byteLength(text, 'utf8') > INJECT_TEXT_MAX_BYTES) return null
      return { type: 'text', text }
    }
    case 'key': {
      const key = record.key
      if (typeof key !== 'string' || !DEVICE_KEY_SET.has(key)) return null
      return { type: 'key', key: key as DeviceKey }
    }
    default:
      return null
  }
}

/** renderer가 프레임 하나를 처리했다는 확인인지. 다른 필드가 더 있어도 true다. */
export function isFrameAck(value: unknown): boolean {
  return typeof value === 'object' && value !== null && (value as Record<string, unknown>).type === 'frame_ack'
}

function toToolError(thrown: unknown): ToolError {
  if (isDeviceError(thrown)) return thrown.toolError
  return {
    kind: 'command_failed',
    message: thrown instanceof Error ? thrown.message : String(thrown),
    hint: '다시 연결해라'
  }
}

export function createStreamManager(deps: StreamManagerDeps): StreamManager {
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)))
  const newSessionId = deps.newSessionId ?? (() => randomUUID())
  let current: Entry | null = null

  function post(entry: Entry, message: StreamDown): void {
    if (current !== entry) return
    try {
      entry.port.postMessage(message)
    } catch {
      // 창이 닫혀 포트가 끊겼다. 다음 open이나 stop이 정리한다.
    }
  }

  function report(entry: Entry, state: StreamLifecycle): void {
    if (entry.reported === state && state === 'stopped') return
    entry.reported = state
    deps.onState?.(entry.serial, state)
  }

  /** 실패를 포트로 알리고, 이 entry가 아직 현재면 stopped로 알린다. */
  function fail(entry: Entry, error: ToolError): void {
    post(entry, { type: 'status', status: { state: 'failed', error } })
    if (current === entry) report(entry, 'stopped')
  }

  async function closeEntry(entry: Entry): Promise<void> {
    // 화면이 나오고 있었거나 재시도 중이던 세션만 멈췄다고 알린다. 시작도 못 한 세션이나
    // 이미 실패로 stopped를 알린 세션은 다시 알리지 않는다.
    if (entry.reported === 'started' || entry.reported === 'reconnecting') report(entry, 'stopped')
    entry.pendingFrame = null
    try {
      entry.port.close()
    } catch {
      // 이미 닫힌 포트다.
    }
    const session = entry.session
    entry.session = null
    await session?.close()
  }

  async function closeIfCurrent(entry: Entry): Promise<void> {
    if (current !== entry) return
    current = null
    await closeEntry(entry)
  }

  function handlersFor(entry: Entry): StreamSessionHandlers {
    return {
      onSession: (info) => {
        // 새 세션 정보가 오면 이전 확인 대기는 의미가 없다.
        entry.awaitingAck = false
        entry.pendingFrame = null
        post(entry, { type: 'session', width: info.width, height: info.height, codec: info.codec, keys: info.keys })
      },
      onPacket: (packet) =>
        post(entry, { type: 'packet', config: packet.config, key: packet.key, ptsUs: packet.ptsUs, data: packet.data }),
      onFrame: (data) => {
        if (current !== entry) return
        if (entry.awaitingAck) {
          entry.pendingFrame = data
          return
        }
        entry.awaitingAck = true
        post(entry, { type: 'frame', data })
      },
      onEnded: (error) => void recover(entry, error.toolError)
    }
  }

  /** 세션 하나를 시작한다. 실패하면 던진다. 시작하는 사이 기기가 바뀌었으면 조용히 닫는다. */
  async function startSession(entry: Entry): Promise<void> {
    const session = deps.createSession(entry.serial, handlersFor(entry))
    // start() 전에 붙여 둔다. 시작하는 사이 stop·open·끊김이 closeEntry를 부르면 이 세션이
    // 닫히고, start()는 closedWhileStarting으로 던진다. 호출자는 current 가드로 조용히 물러난다.
    entry.session = session
    try {
      // start()는 실패하면 스스로 정리하고 던진다.
      await session.start()
    } catch (thrown) {
      if (entry.session === session) entry.session = null
      throw thrown
    }
    if (current !== entry) {
      if (entry.session === session) entry.session = null
      await session.close()
      return
    }
    post(entry, { type: 'status', status: { state: 'streaming' } })
    report(entry, 'started')
  }

  async function recover(entry: Entry, reason: ToolError): Promise<void> {
    if (current !== entry) return
    // 재연결을 기다리는 동안 늦게 온 확인이 죽은 세션의 대기 장을 내보내지 않게 한다.
    entry.awaitingAck = false
    entry.pendingFrame = null
    const ended = entry.session
    entry.session = null
    await ended?.close()

    let lastError = reason
    for (let attempt = 1; attempt <= RECONNECT_DELAYS_MS.length; attempt += 1) {
      if (current !== entry) return
      if (!deps.isConnected(entry.serial)) {
        await closeIfCurrent(entry)
        return
      }
      post(entry, { type: 'status', status: { state: 'reconnecting', attempt } })
      report(entry, 'reconnecting')
      await sleep(RECONNECT_DELAYS_MS[attempt - 1] as number)
      if (current !== entry) return
      try {
        await startSession(entry)
        return
      } catch (thrown) {
        lastError = toToolError(thrown)
      }
    }
    fail(entry, lastError)
  }

  return {
    async open(serial) {
      // current를 await보다 먼저 바꾼다. 앞선 open이 아직 끝나지 않았어도 그 entry는
      // 더 이상 current가 아니므로 post·startSession이 스스로 물러난다.
      const previous = current
      const channel = deps.createChannel()
      const entry: Entry = { serial, sessionId: newSessionId(), port: channel.local, session: null, reported: null, awaitingAck: false, pendingFrame: null }
      current = entry
      if (previous) await closeEntry(previous)
      if (current !== entry) {
        // 이전 세션을 닫는 사이 또 다른 open이 왔다. 이 포트는 renderer에 보내지도 않고 닫는다.
        channel.local.close()
        return
      }

      channel.local.on('message', (event) => {
        if (isFrameAck(event.data)) {
          if (current !== entry || !entry.awaitingAck) return
          const waiting = entry.pendingFrame
          if (waiting) {
            entry.pendingFrame = null
            post(entry, { type: 'frame', data: waiting })
          } else {
            entry.awaitingAck = false
          }
          return
        }
        const intent = toControlIntent(event.data)
        if (intent && current === entry) entry.session?.sendControl(intent)
      })
      // renderer가 포트를 놓으면 소비자가 없다. 재시도 없이 닫는다. 이미 밀려난 entry면 무시한다.
      channel.local.on('close', () => {
        closeIfCurrent(entry).catch(() => {
          // 세션 close는 스스로 정리하고 던지지 않는다. 여기는 만일을 위한 방어다.
        })
      })
      channel.local.start()
      // 시작 실패도 이 포트로 알리므로 세션보다 먼저 보낸다.
      deps.postPort({ serial, sessionId: entry.sessionId }, channel.remote)
      post(entry, { type: 'status', status: { state: 'connecting' } })

      try {
        await startSession(entry)
      } catch (thrown) {
        fail(entry, toToolError(thrown))
      }
    },

    async stop() {
      const entry = current
      current = null
      if (entry) await closeEntry(entry)
    }
  }
}
