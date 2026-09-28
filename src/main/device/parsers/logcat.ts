import type { LogLevel, LogLine } from '../../../shared/types/device'

/**
 * `-v threadtime` 한 줄:
 * `09-22 11:06:21.123  1234  1256 I ActivityManager: Start proc`
 *  날짜시각              pid   tid  레벨 태그          메시지
 */
const THREADTIME =
  /^(\d{2}-\d{2} \d{2}:\d{2}:\d{2}\.\d{3})\s+(\d+)\s+(\d+)\s+([VDIWEF])\s+(.*?):\s?(.*)$/

/**
 * 한 줄의 logcat을 파싱한다. 파싱할 수 없는 줄은 null을 돌려준다.
 * 줄 끝 공백·`\r`은 여기서 떼어 낸다. `(.*)$`의 `.`은 `\r`과 맞지 않아서, 떼지 않으면
 * `\r`이 붙은 줄은 통째로 버려진다. `parseLogcat`과 tail(`logTail.ts`)이 같은 규칙을 쓴다.
 */
export function parseLogcatLine(raw: string): LogLine | null {
  const line = raw.trimEnd()
  if (!line) return null
  if (line.startsWith('---------')) return null

  const match = THREADTIME.exec(line)
  if (!match) return null

  return {
    timestamp: match[1] as string,
    level: match[4] as LogLevel,
    tag: (match[5] as string).trim(),
    pid: Number(match[2]),
    message: match[6] as string
  }
}

/**
 * logcat 출력을 구조화한다. 형식은 `-v threadtime`으로 고정한다.
 * 다른 포맷을 추측하지 않는다 — 파싱할 수 없는 줄은 버린다.
 */
export function parseLogcat(stdout: string): LogLine[] {
  const lines: LogLine[] = []

  for (const rawLine of stdout.split('\n')) {
    const parsed = parseLogcatLine(rawLine)
    if (parsed) {
      lines.push(parsed)
    }
  }

  return lines
}
