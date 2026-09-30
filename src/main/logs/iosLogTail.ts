import type { SimctlClient } from '../ios/simctlClient'
import { RECONNECT_DELAYS_MS } from '../stream/streamManager'
import { parseIosLogLine } from '../device/parsers/iosLog'
import type { LogTail, LogTailHandlers } from './logTail'

export interface IosLogTailDeps {
  udid: string
  simctl: Pick<SimctlClient, 'stream'>
  isConnected(): boolean
  sleep?: (ms: number) => Promise<void>
}

/**
 * 시뮬레이터 하나의 `log stream` tail. 기본 레벨(info 이상)의 ndjson을 줄마다 읽는다.
 * `log stream`은 지난 로그를 다시 주지 않으므로 재연결 때 재생 중복을 걸러낼 필요가 없다.
 * 시작 배너(`Filtering the log data using ...`)와 파이프가 닫힐 때의
 * `Child process terminated with signal 13`은 ndjson이 아니라 파서가 null로 버린다.
 * 상태 전이는 `createLogTail`(logTail.ts)과 같다.
 */
export function createIosLogTail(deps: IosLogTailDeps, handlers: LogTailHandlers): LogTail {
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)))

  let lastLineTimestamp: string | null = null
  let attempt = 0
  // stop()과 포기(재시도 소진·기기 끊김) 양쪽이 공유하는 종결 플래그. 한 번 서면 조용하다.
  let stopped = false
  let currentStream: ReturnType<SimctlClient['stream']> | null = null

  function handleLine(raw: string): void {
    if (stopped) return
    const parsed = parseIosLogLine(raw)
    if (!parsed) return
    attempt = 0
    lastLineTimestamp = parsed.timestamp
    const { epochMs, ...line } = parsed
    handlers.onLine(line, epochMs)
  }

  function handleClose(): void {
    if (stopped) return
    currentStream = null
    void handleUnexpectedClose()
  }

  function spawnStream(): void {
    const stream = deps.simctl.stream(['spawn', deps.udid, 'log', 'stream', '--style', 'ndjson'])
    currentStream = stream
    stream.onLine(handleLine)
    stream.onClose(handleClose)
    // 에러 뒤에는 반드시 onClose가 뒤따르므로 재시작 판단은 handleClose 하나로 충분하다.
    stream.onError(() => {})
    handlers.onState('running')
  }

  async function handleUnexpectedClose(): Promise<void> {
    if (!deps.isConnected() || attempt >= RECONNECT_DELAYS_MS.length) {
      stopped = true
      handlers.onState('stopped')
      return
    }
    handlers.onResume()
    handlers.onState('reconnecting')
    const delay = RECONNECT_DELAYS_MS[attempt] as number
    attempt += 1
    await sleep(delay)
    if (stopped) return
    spawnStream()
  }

  async function start(): Promise<void> {
    if (stopped) return
    spawnStream()
  }

  function stop(): void {
    if (stopped) return
    stopped = true
    currentStream?.close()
    currentStream = null
    handlers.onState('stopped')
  }

  return { start, stop, lastTimestamp: () => lastLineTimestamp }
}
