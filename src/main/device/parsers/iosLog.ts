import type { LogLevel, LogLine } from '../../../shared/types/device'

/** iOS에는 W·V가 없다. 모르는 messageType은 Default와 같이 I로 본다. */
const LEVELS: Record<string, LogLevel> = { Debug: 'D', Info: 'I', Default: 'I', Error: 'E', Fault: 'F' }

const TIMESTAMP = /^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2}):(\d{2})\.(\d{3})\d*([+-])(\d{2})(\d{2})$/

const pad = (n: number) => String(n).padStart(2, '0')

/**
 * `log show --style ndjson`·`log stream --style ndjson`의 한 줄을 `LogLine`으로 바꾼다.
 * `timestamp`는 기기 로컬 시각(`MM-DD HH:mm:ss.SSS`)이고, `epochMs`는 원문 오프셋까지 반영한다.
 * JSON이 아니거나 `eventType`이 `logEvent`가 아니거나(`activityCreateEvent` 등) 메시지가 없으면 null이다.
 */
export function parseIosLogLine(line: string): (LogLine & { epochMs: number }) | null {
  let raw: Record<string, unknown>
  try {
    const parsed: unknown = JSON.parse(line)
    if (typeof parsed !== 'object' || parsed === null) return null
    raw = parsed as Record<string, unknown>
  } catch {
    return null
  }

  if (raw.eventType !== 'logEvent') return null
  if (typeof raw.eventMessage !== 'string' || typeof raw.timestamp !== 'string') return null

  const match = TIMESTAMP.exec(raw.timestamp)
  if (!match) return null
  const [, year, month, day, hour, minute, second, ms, sign, offH, offM] = match as unknown as string[]
  const offsetMin = (sign === '-' ? -1 : 1) * (Number(offH) * 60 + Number(offM))
  const epochMs =
    Date.UTC(Number(year), Number(month) - 1, Number(day), Number(hour), Number(minute), Number(second), Number(ms)) -
    offsetMin * 60_000

  const subsystem = typeof raw.subsystem === 'string' ? raw.subsystem : ''
  const imagePath = typeof raw.processImagePath === 'string' ? raw.processImagePath : ''
  const tag = subsystem || imagePath.split('/').pop() || ''

  return {
    timestamp: `${month}-${day} ${hour}:${minute}:${second}.${ms}`,
    level: LEVELS[String(raw.messageType)] ?? 'I',
    tag,
    pid: typeof raw.processID === 'number' ? raw.processID : 0,
    message: raw.eventMessage,
    epochMs
  }
}

/** 호스트 로컬 시각을 `YYYY-MM-DD HH:mm:ss`로. 시뮬레이터는 호스트 시계·tz를 쓴다. */
export function formatLogShowStart(epochMs: number): string {
  const d = new Date(epochMs)
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
}

/**
 * `MM-DD HH:mm:ss.SSS`를 `log show --start`가 받는 `YYYY-MM-DD HH:mm:ss`로 바꾼다.
 * 연도가 없으므로 올해로 읽어 미래면 작년으로 본다(`logClock.ts` `toHostEpoch`의 연말 규칙과 같은 생각).
 * 형식이 다르면 그대로 돌려준다.
 */
export function toLogShowStart(since: string, nowMs: number): string {
  const match = /^(\d{2})-(\d{2}) (\d{2}):(\d{2}):(\d{2})/.exec(since)
  if (!match) return since
  const [, month, day, hour, minute, second] = match.map(Number) as number[]
  const year = new Date(nowMs).getFullYear()
  const atYear = (y: number) => new Date(y, month! - 1, day!, hour!, minute!, second!).getTime()
  return formatLogShowStart(atYear(year) > nowMs ? atYear(year - 1) : atYear(year))
}

/**
 * `--predicate` 한 인자. 사용자 입력의 `\`와 `"`를 이스케이프해 리터럴 밖으로 나가지 못하게 한다.
 */
export function logFilterPredicate(filter: string): string {
  const f = filter.replace(/[\\"]/g, (ch) => `\\${ch}`)
  return `eventMessage CONTAINS[c] "${f}" OR subsystem CONTAINS[c] "${f}" OR process CONTAINS[c] "${f}"`
}
