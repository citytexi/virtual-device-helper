import { describe, expect, it } from 'vitest'
import type { LogRow } from '../hooks/useLogStream'
import { findJumpIndex } from './logJump'

const line = (seq: number, at: number): LogRow => ({
  kind: 'line',
  entry: { timestamp: 't', level: 'I', tag: 'A', pid: 1, message: `m${seq}`, seq, at }
})
const gap = (fromSeq: number, toSeq: number): LogRow => ({ kind: 'gap', fromSeq, toSeq })

describe('findJumpIndex', () => {
  const all = [line(0, 100), line(1, 200), gap(2, 3), line(4, 300), line(5, 400)]
  // 필터가 seq 1·5만 남겼다고 친다(gap은 언제나 남는다).
  const visible = [all[1], all[2], all[4]] as LogRow[]

  it('picks the first visible row at or after the time', () => {
    expect(findJumpIndex(all, visible, 150)).toEqual({ index: 0 })
    expect(findJumpIndex(all, visible, 200)).toEqual({ index: 0 })
    // gap 행은 시각이 없으니 건너뛴다.
    expect(findJumpIndex(all, visible, 250)).toEqual({ index: 2 })
  })

  it('falls back to the last visible row and reports evicted for an old time', () => {
    expect(findJumpIndex(all, visible, 999)).toEqual({ index: 2 })
    expect(findJumpIndex(all, visible, 99)).toBe('evicted')
    // 버퍼 첫 행이 gap이어도 가장 오래된 line 행으로 판단한다.
    expect(findJumpIndex([gap(0, 3), ...all.slice(3)], [all[4] as LogRow], 250)).toBe('evicted')
  })

  it('checks eviction only against the live part of the buffer from start', () => {
    // all[0..2)는 이미 밀려난 앞부분이다. 살아있는 가장 오래된 줄은 at=300.
    expect(findJumpIndex(all, [all[4] as LogRow], 250, 2)).toBe('evicted')
    expect(findJumpIndex(all, [all[4] as LogRow], 350, 2)).toEqual({ index: 0 })
  })

  it('returns -1 when nothing is visible', () => {
    expect(findJumpIndex(all, [], 150)).toEqual({ index: -1 })
    expect(findJumpIndex([], [], 150)).toEqual({ index: -1 })
  })
})
