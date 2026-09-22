import type { LogLevel, LogLine } from '../../../shared/types/device'

/**
 * `-v threadtime` 한 줄:
 * `09-22 11:06:21.123  1234  1256 I ActivityManager: Start proc`
 *  날짜시각              pid   tid  레벨 태그          메시지
 */
const THREADTIME =
  /^(\d{2}-\d{2} \d{2}:\d{2}:\d{2}\.\d{3})\s+(\d+)\s+(\d+)\s+([VDIWEF])\s+(.*?):\s?(.*)$/

/**
 * logcat 출력을 구조화한다. 형식은 `-v threadtime`으로 고정한다.
 * 다른 포맷을 추측하지 않는다 — 파싱할 수 없는 줄은 버린다.
 */
export function parseLogcat(stdout: string): LogLine[] {
  const lines: LogLine[] = []

  for (const rawLine of stdout.split('\n')) {
    const line = rawLine.trimEnd()
    if (!line) continue
    if (line.startsWith('---------')) continue

    const match = THREADTIME.exec(line)
    if (!match) continue

    lines.push({
      timestamp: match[1] as string,
      level: match[4] as LogLevel,
      tag: (match[5] as string).trim(),
      pid: Number(match[2]),
      message: match[6] as string
    })
  }

  return lines
}
