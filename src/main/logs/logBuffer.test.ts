import { describe, expect, it } from 'vitest'
import { createLogBuffer, type LogBuffer } from './logBuffer'
import type { LogEntry } from '../../shared/types/logs'

// LogLine을 뺀 항목을 만드는 헬퍼
const line = (
  timestamp: string,
  message: string,
  pid: number = 1,
  tag: string = 'T'
): Omit<LogEntry, 'seq'> => ({
  timestamp,
  level: 'I' as const,
  tag,
  pid,
  message,
  at: 0, // 테스트에서 실제 값을 설정하거나 무시한다
})

describe('LogBuffer', () => {
  it('numbers entries from 0 without holes', () => {
    const b = createLogBuffer()
    expect([b.append(line('a', '1'))!.seq, b.append(line('a', '2'))!.seq]).toEqual([0, 1])
  })

  it('drops the oldest past capacity', () => {
    const b = createLogBuffer(3)
    for (let i = 0; i < 5; i++) b.append(line('t', String(i)))
    expect(b.all().map((e) => e.seq)).toEqual([2, 3, 4])
  })

  it('reports a gap when afterSeq was evicted', () => {
    const b = createLogBuffer(3)
    for (let i = 0; i < 5; i++) b.append(line('t', String(i)))
    expect(b.since(0)).toEqual({ gap: { fromSeq: 1, toSeq: 1 }, entries: b.all() })
    expect(b.since(3).gap).toBeNull()
    expect(b.since(3).entries.map((e) => e.seq)).toEqual([4])
  })

  it('returns nothing and no gap when afterSeq is at or past the end', () => {
    const b = createLogBuffer()
    b.append(line('t', '0'))
    expect(b.since(0)).toEqual({ gap: null, entries: [] })
    expect(b.since(7)).toEqual({ gap: null, entries: [] })
  })

  it('starts from the beginning for afterSeq -1', () => {
    const b = createLogBuffer()
    b.append(line('a', '1'))
    b.append(line('b', '2'))
    b.append(line('c', '3'))
    const result = b.since(-1)
    expect(result.gap).toBeNull()
    expect(result.entries.map((e) => e.seq)).toEqual([0, 1, 2])
  })

  it('reports a gap in since(-1) when there was eviction', () => {
    const b = createLogBuffer(3)
    for (let i = 0; i < 5; i++) b.append(line('t', String(i)))
    const result = b.since(-1)
    expect(result.gap).toEqual({ fromSeq: 0, toSeq: 1 })
    expect(result.entries.map((e) => e.seq)).toEqual([2, 3, 4])
  })

  it('finds the first entry at or after a time', () => {
    const b = createLogBuffer()
    const e1 = b.append(line('a', '1'))!
    e1.at = 100
    const e2 = b.append(line('b', '2'))!
    e2.at = 200
    const e3 = b.append(line('c', '3'))!
    e3.at = 300

    // at=150을 요청 → e2 (at=200)를 반환
    const found = b.firstAtOrAfter(150)
    expect(found?.seq).toBe(1)

    // at=300 이상을 요청 → e3 (at=300)를 반환
    expect(b.firstAtOrAfter(300)?.seq).toBe(2)

    // at=350 이상을 요청 → 없음
    expect(b.firstAtOrAfter(350)).toBeNull()
  })

  it('after markResume drops a repeat of the last timestamp but keeps new lines at that timestamp', () => {
    const b = createLogBuffer()
    b.append(line('10:00.000', 'x'))
    b.append(line('10:00.000', 'y'))
    b.markResume()
    expect(b.append(line('10:00.000', 'x'))).toBeNull()
    expect(b.append(line('10:00.000', 'z'))!.seq).toBe(2)
    expect(b.append(line('10:00.001', 'x'))!.seq).toBe(3)
  })

  it('after markResume drops as many repeats as there were identical lines, not just one', () => {
    // 같은 timestamp에 똑같은 줄이 두 번 있었으면 재생도 두 번 온다. 둘 다 버리고, 그 뒤 세 번째는 새 줄이다.
    const b = createLogBuffer()
    b.append(line('10:00.000', 'x'))
    b.append(line('10:00.000', 'x'))
    b.markResume()
    expect(b.append(line('10:00.000', 'x'))).toBeNull()
    expect(b.append(line('10:00.000', 'x'))).toBeNull()
    expect(b.append(line('10:00.000', 'x'))!.seq).toBe(2)
  })

  it('stops deduping once a later timestamp arrives', () => {
    const b = createLogBuffer()
    b.append(line('10:00.000', 'x'))
    b.markResume()
    b.append(line('10:00.001', 'n'))
    expect(b.append(line('10:00.000', 'x'))).not.toBeNull()
  })
})
