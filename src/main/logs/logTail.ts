import type { LogLine } from '../../shared/types/device'
import type { TailState } from '../../shared/types/logs'
import type { AdbClient } from '../adb/adbClient'
import { RECONNECT_DELAYS_MS } from '../stream/streamManager'
import { parseLogcatLine } from '../device/parsers/logcat'
import { clockOffset, DEVICE_CLOCK_ARGS, parseDeviceClock, toHostEpoch } from './logClock'

/** logcat -v threadtime 고정 인자. -T 뒤에 시작 시각을 붙인다. */
const LOGCAT_BASE_ARGS = ['logcat', '-v', 'threadtime']
/** 최초 시작에 쓰는 -T 값. 초가 아니라 줄 수다 — 버퍼의 마지막 2000줄만 받아 과거 로그 폭주를 피한다. */
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
  // 기기 tz offset(분). %z를 못 읽었으면 null이고, 그때 timestamp는 호스트 tz로 해석한다.
  let tzOffsetMin: number | null = null
  let lastLineTimestamp: string | null = null
  // 이번 스트림을 재시작할 때 넘긴 -T 값(=재생 기준 timestamp). 최초 스트림('2000'으로 시작)은
  // 실제 timestamp가 아니므로 null — 이 경우 줄을 하나라도 받으면 곧장 재시도 카운터를 되돌린다.
  let restartedFromTimestamp: string | null = null
  // 줄의 timestamp가 restartedFromTimestamp와 달라야(=재생분이 아니어야) 0으로 되돌아간다.
  // 재시작 직후 받는 줄은 -T로 지정한 timestamp를 다시 주므로(재생), 그 줄만으로는 리셋하지 않는다
  // — 그러지 않으면 재생 줄을 받자마자 죽는 기기에서 재시도가 끝없이 이어진다.
  // RECONNECT_DELAYS_MS.length에 닿으면 포기한다.
  let attempt = 0
  // stop()과 포기(재시도 소진·기기 끊김) 양쪽이 공유하는 종결 플래그다. 한 번 서면
  // 'stopped'는 다시 나가지 않고, 뒤늦게 오는 close·stop() 호출은 전부 조용히 물러난다.
  let stopped = false
  let currentStream: ReturnType<AdbClient['stream']> | null = null

  function setState(state: TailState): void {
    handlers.onState(state)
  }

  function handleLine(raw: string): void {
    const parsed = parseLogcatLine(raw)
    if (!parsed) return // 파싱 못 하는 줄은 버린다

    if (restartedFromTimestamp === null || parsed.timestamp !== restartedFromTimestamp) {
      attempt = 0
    }
    lastLineTimestamp = parsed.timestamp

    const at = offsetMs === null ? now() : toHostEpoch(parsed.timestamp, offsetMs, now(), tzOffsetMin)
    handlers.onLine(parsed, at)
  }

  function handleClose(): void {
    if (stopped) return
    currentStream = null
    void handleUnexpectedClose()
  }

  /**
   * @param sinceArg 이번 스트림에 넘길 -T 값
   * @param resumeTimestamp sinceArg가 실제 마지막 줄의 timestamp면 그 값, 최초 시작('2000')이면 null
   */
  function spawnStream(sinceArg: string, resumeTimestamp: string | null): void {
    const stream = deps.adb.stream(deps.serial, [...LOGCAT_BASE_ARGS, '-T', sinceArg])
    currentStream = stream
    restartedFromTimestamp = resumeTimestamp
    stream.onLine(handleLine)
    stream.onClose(handleClose)
    // 에러 뒤에는 반드시 onClose가 뒤따르므로(adbClient.ts) 재시작 판단은 handleClose 하나로 충분하다.
    // 등록만 해서 stdout/stderr 에러가 조용히 사라지지 않게 한다.
    stream.onError(() => {})
    setState('running')
  }

  async function handleUnexpectedClose(): Promise<void> {
    if (!deps.isConnected()) {
      stopped = true
      setState('stopped')
      return
    }
    if (attempt >= RECONNECT_DELAYS_MS.length) {
      stopped = true
      setState('stopped')
      return
    }

    handlers.onResume()
    setState('reconnecting')
    const delay = RECONNECT_DELAYS_MS[attempt] as number
    attempt += 1
    await sleep(delay)
    if (stopped) return

    spawnStream(lastLineTimestamp ?? INITIAL_SINCE, lastLineTimestamp)
  }

  async function start(): Promise<void> {
    const hostBefore = now()
    try {
      const result = await deps.adb.exec(deps.serial, DEVICE_CLOCK_ARGS)
      const hostAfter = now()
      const clock = parseDeviceClock(result.stdout)
      offsetMs = clock === null ? null : clockOffset(hostBefore, clock.epochMs, hostAfter)
      tzOffsetMin = clock?.tzOffsetMin ?? null
    } catch {
      offsetMs = null
      tzOffsetMin = null
    }
    // exec을 기다리는 동안 stop()이 왔으면 여기서 멈춘다. 그러지 않으면 이미 'stopped'를
    // 알린 뒤에 아무도 못 끄는 logcat 프로세스를 새로 띄우게 된다.
    if (stopped) return

    spawnStream(INITIAL_SINCE, null)
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
