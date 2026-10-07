import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { logFilterPredicate, parseIosLogLine, toLogShowStart } from './iosLog'

const dir = join(__dirname, '__fixtures__', 'ios')
const linesOf = (name: string) => readFileSync(join(dir, name), 'utf8').split('\n').filter(Boolean)

describe.each(['log-show.ndjson', 'log-stream.ndjson'])('parseIosLogLine (%s)', (name) => {
  const raw = linesOf(name)

  it('returns null only for non-logEvent lines', () => {
    for (const line of raw) {
      const isLogEvent = (JSON.parse(line) as { eventType: string }).eventType === 'logEvent'
      expect(parseIosLogLine(line) !== null).toBe(isLogEvent)
    }
  })

  it('formats timestamp as MM-DD HH:mm:ss.SSS and honors the offset in epochMs', () => {
    const parsed = raw.map(parseIosLogLine).filter((line) => line !== null)
    expect(parsed.length).toBeGreaterThan(0)
    for (const line of parsed) {
      expect(line.timestamp).toMatch(/^\d{2}-\d{2} \d{2}:\d{2}:\d{2}\.\d{3}$/)
    }
    const first = raw.find((line) => JSON.parse(line).eventType === 'logEvent')!
    const source = (JSON.parse(first) as { timestamp: string }).timestamp
    expect(parseIosLogLine(first)!.epochMs).toBe(Date.parse(source.replace(' ', 'T').replace(/(\d{2}:\d{2}:\d{2}\.\d{3})\d*/, '$1')))
  })

  it('maps Default to I and Error to E', () => {
    const levels = new Set(raw.map(parseIosLogLine).filter((line) => line !== null).map((line) => line.level))
    expect(levels).toEqual(new Set(['I', 'E']))
  })
})

describe('parseIosLogLine mapping', () => {
  const base = JSON.parse(linesOf('log-show.ndjson').find((line) => JSON.parse(line).eventType === 'logEvent')!) as Record<string, unknown>
  const make = (patch: Record<string, unknown>) => JSON.stringify({ ...base, ...patch })

  it.each([
    ['Default', 'I'],
    ['Info', 'I'],
    ['Error', 'E'],
    ['Fault', 'F'],
    ['Debug', 'D']
  ])('maps messageType %s to level %s', (messageType, level) => {
    expect(parseIosLogLine(make({ messageType }))!.level).toBe(level)
  })

  it('uses subsystem as tag, pid as processID, message as eventMessage', () => {
    const line = parseIosLogLine(make({ subsystem: 'com.x.y', processID: 42, eventMessage: 'hi' }))!
    expect(line).toMatchObject({ tag: 'com.x.y', pid: 42, message: 'hi' })
  })

  it('falls back to the process name when subsystem is empty', () => {
    const line = parseIosLogLine(make({ subsystem: '', processImagePath: '/usr/libexec/lsd' }))!
    expect(line.tag).toBe('lsd')
  })

  it('returns null for invalid JSON and lines without eventMessage', () => {
    expect(parseIosLogLine('not json')).toBeNull()
    expect(parseIosLogLine(make({ eventMessage: undefined }))).toBeNull()
  })

  it('truncates microseconds and keeps device-local wall time', () => {
    const line = parseIosLogLine(make({ timestamp: '2026-09-30 14:40:14.608720+0900' }))!
    expect(line.timestamp).toBe('09-30 14:40:14.608')
    expect(line.epochMs).toBe(Date.UTC(2026, 8, 30, 5, 40, 14, 608))
  })
})

describe('logFilterPredicate', () => {
  it('wraps the filter in the three-field predicate', () => {
    expect(logFilterPredicate('abc')).toBe(
      'eventMessage CONTAINS[c] "abc" OR subsystem CONTAINS[c] "abc" OR process CONTAINS[c] "abc"'
    )
  })

  it('escapes quotes and backslashes so the input cannot leave the string literal', () => {
    const predicate = logFilterPredicate('a" OR 1==1 OR "\\')
    const literal = /"((?:[^"\\]|\\.)*)"/g
    // 이스케이프를 걷어낸 따옴표 쌍만 남기면 리터럴 3개 외의 조각이 없어야 한다.
    const outside = predicate.replace(literal, '')
    expect(outside).toBe('eventMessage CONTAINS[c]  OR subsystem CONTAINS[c]  OR process CONTAINS[c] ')
    expect(predicate).toContain('a\\" OR 1==1 OR \\"\\\\')
  })
})

describe('toLogShowStart', () => {
  it('resolves a 12-31 stamp read on Jan 1 to last year', () => {
    const now = new Date(2027, 0, 1, 0, 0, 5).getTime()
    expect(toLogShowStart('12-31 23:59:59.000', now)).toBe('2026-12-31 23:59:59')
  })

  it('uses the current year for past dates', () => {
    const now = new Date(2026, 8, 30, 15, 0, 0).getTime()
    expect(toLogShowStart('09-30 14:40:14.608', now)).toBe('2026-09-30 14:40:14')
  })
})
