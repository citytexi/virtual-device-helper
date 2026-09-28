import type { LogLine } from '../../shared/types/device'
import type { TailState } from '../../shared/types/logs'
import type { AdbClient } from '../adb/adbClient'
import { RECONNECT_DELAYS_MS } from '../stream/streamManager'
import { parseLogcatLine } from '../device/parsers/logcat'
import { clockOffset, parseDeviceEpoch, toHostEpoch } from './logClock'

/** logcat -v threadtime 고정 인자. -T 뒤에 시작 시각을 붙인다. */
const LOGCAT_BASE_ARGS = ['logcat', '-v', 'threadtime']
/** 최초 시작에 쓰는 -T 값. 최근 몇 초만 받아 과거 로그 폭주를 피한다. */
const INITIAL_SINCE = '2000'

export interface LogTailDeps {
  serial: string
  adb: Pick<AdbClient, 'exec' | 'stream'>
  isConnected(): boolean
  now?: () => number
  sleep?: (ms: number) => Promise<void>
}

export interface LogTailHandlers {
  onLine(line: LogLine, at: number): void
  onResume(): void
  onState(state: TailState): void
}

export interface LogTail {
  start(): Promise<void>
  stop(): void
  /** 마지막으로 받은 줄의 기기 timestamp. 한 줄도 못 받았으면 null. */
  lastTimestamp(): string | null
}

/**
 * 기기 하나의 logcat tail. 시계 오프셋을 한 번 재고, 끊기면
 * `RECONNECT_DELAYS_MS` 간격으로 마지막 timestamp부터 다시 붙는다.
 */
export function createLogTail(deps: LogTailDeps, handlers: LogTailHandlers): LogTail {
  const now = deps.now ?? Date.now
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)))

  // 시계 측정이 실패하면 null로 두고 수신 시각으로 폴백한다.
  let offsetMs: number | null = null
  let lastLineTimestamp: string | null = null
  // 줄을 한 번이라도 받으면 0으로 되돌아간다. RECONNECT_DELAYS_MS.length에 닿으면 포기한다.
  let attempt = 0
  let stopped = false
  let currentStream: ReturnType<AdbClient['stream']> | null = null

  function setState(state: TailState): void {
    handlers.onState(state)
  }

  function handleLine(raw: string): void {
    const parsed = parseLogcatLine(raw)
    if (!parsed) return // 파싱 못 하는 줄은 버린다

    lastLineTimestamp = parsed.timestamp
    attempt = 0

    const at = offsetMs === null ? now() : toHostEpoch(parsed.timestamp, offsetMs, now())
    handlers.onLine(parsed, at)
  }

  function handleClose(): void {
    if (stopped) return
    currentStream = null
    void handleUnexpectedClose()
  }

  function spawnStream(sinceArg: string): void {
    const stream = deps.adb.stream(deps.serial, [...LOGCAT_BASE_ARGS, '-T', sinceArg])
    currentStream = stream
    stream.onLine(handleLine)
    stream.onClose(handleClose)
    // 에러 뒤에는 반드시 onClose가 뒤따르므로(adbClient.ts) 재시작 판단은 handleClose 하나로 충분하다.
    // 등록만 해서 stdout/stderr 에러가 조용히 사라지지 않게 한다.
    stream.onError(() => {})
    setState('running')
  }

  async function handleUnexpectedClose(): Promise<void> {
    if (!deps.isConnected()) {
      setState('stopped')
      return
    }
    if (attempt >= RECONNECT_DELAYS_MS.length) {
      setState('stopped')
      return
    }

    handlers.onResume()
    setState('reconnecting')
    const delay = RECONNECT_DELAYS_MS[attempt] as number
    attempt += 1
    await sleep(delay)
    if (stopped) return

    spawnStream(lastLineTimestamp ?? INITIAL_SINCE)
  }

  async function start(): Promise<void> {
    const hostBefore = now()
    try {
      const result = await deps.adb.exec(deps.serial, ['shell', 'date', '+%s%3N'])
      const hostAfter = now()
      const deviceEpoch = parseDeviceEpoch(result.stdout)
      offsetMs = deviceEpoch === null ? null : clockOffset(hostBefore, deviceEpoch, hostAfter)
    } catch {
      offsetMs = null
    }

    spawnStream(INITIAL_SINCE)
  }

  function stop(): void {
    if (stopped) return
    stopped = true
    currentStream?.close()
    currentStream = null
    setState('stopped')
  }

  function lastTimestamp(): string | null {
    return lastLineTimestamp
  }

  return { start, stop, lastTimestamp }
}
