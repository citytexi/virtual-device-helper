import { describe, expect, it } from 'vitest'
import type { LogEntry } from '../../../shared/types/logs'
import type { LogRow } from '../hooks/useLogStream'
import { EMPTY_FILTER, compileFilter, createTagCounts, cycleChip, rankTags, refreshTagCounts, topTags } from './logFilter'

const e = (over: Partial<LogEntry>): LogRow => ({
  kind: 'line',
  entry: { timestamp: 't', level: 'I', tag: 'A', pid: 1, message: 'hello', seq: 0, at: 0, ...over }
})

const gap: LogRow = { kind: 'gap', fromSeq: 0, toSeq: 1 }

describe('compileFilter', () => {
  it('drops lines below the minimum level', () => {
    expect(compileFilter({ ...EMPTY_FILTER, minLevel: 'W' }).match(e({ level: 'I' }))).toBe(false)
    expect(compileFilter({ ...EMPTY_FILTER, minLevel: 'W' }).match(e({ level: 'E' }))).toBe(true)
  })

  it('matches text case-insensitively on tag or message', () => {
    const f = compileFilter({ ...EMPTY_FILTER, text: 'HEL' })
    expect(f.match(e({ message: 'hello world' }))).toBe(true)
    expect(f.match(e({ tag: 'hello-tag', message: 'nope' }))).toBe(true)
    expect(f.match(e({ tag: 'A', message: 'nope' }))).toBe(false)
  })

  it('uses the text as a regex when regex is on', () => {
    expect(compileFilter({ ...EMPTY_FILTER, text: '^hel+o$', regex: true }).match(e({}))).toBe(true)
    expect(compileFilter({ ...EMPTY_FILTER, text: '^hel+o$', regex: true }).match(e({ message: 'nope' }))).toBe(false)
  })

  it('reports an invalid regex and does not filter by text', () => {
    const f = compileFilter({ ...EMPTY_FILTER, text: '[', regex: true })
    expect(f.regexError).not.toBeNull()
    expect(f.match(e({}))).toBe(true)
  })

  it('has no regexError and no text filter when text is empty', () => {
    const f = compileFilter({ ...EMPTY_FILTER, text: '', regex: true })
    expect(f.regexError).toBeNull()
    expect(f.match(e({ message: 'anything at all' }))).toBe(true)
  })

  it('shows only included tags when any chip is included, and always hides excluded', () => {
    const f = compileFilter({ ...EMPTY_FILTER, chips: { A: 'include', B: 'exclude' } })
    expect([f.match(e({ tag: 'A' })), f.match(e({ tag: 'B' })), f.match(e({ tag: 'C' }))]).toEqual([true, false, false])
  })

  it('filters by pkg and hides lines without pkg while a package is chosen', () => {
    const f = compileFilter({ ...EMPTY_FILTER, pkg: 'com.example' })
    expect(f.match(e({ pkg: 'com.example' }))).toBe(true)
    expect(f.match(e({ pkg: 'com.other' }))).toBe(false)
    expect(f.match(e({}))).toBe(false)
  })

  it('always keeps gap rows', () => {
    const f = compileFilter({
      ...EMPTY_FILTER,
      minLevel: 'F',
      text: 'zzz',
      chips: { A: 'exclude' },
      pkg: 'com.example'
    })
    expect(f.match(gap)).toBe(true)
  })
})

describe('cycleChip', () => {
  it('cycles a chip through include, exclude, none', () => {
    expect(cycleChip(cycleChip(cycleChip({}, 'A'), 'A'), 'A')).toEqual({})
  })

  it('leaves other chips untouched', () => {
    const chips = cycleChip({ B: 'include' }, 'A')
    expect(chips).toEqual({ A: 'include', B: 'include' })
  })
})

describe('topTags', () => {
  it('ranks tags by count then name', () => {
    const rows: LogRow[] = [e({ tag: 'A' }), e({ tag: 'B' }), e({ tag: 'B' }), e({ tag: 'C' }), e({ tag: 'A' })]
    expect(topTags(rows, 2)).toEqual(['A', 'B'])
  })

  it('ignores gap rows', () => {
    const rows: LogRow[] = [e({ tag: 'A' }), gap, e({ tag: 'A' })]
    expect(topTags(rows, 5)).toEqual(['A'])
  })

  it('counts only rows from the given start index', () => {
    const rows: LogRow[] = [e({ tag: 'A' }), e({ tag: 'A' }), e({ tag: 'B' })]
    expect(topTags(rows, 5, 2)).toEqual(['B'])
  })
})

describe('refreshTagCounts', () => {
  const t = (seq: number, tag: string): LogRow => e({ seq, tag })

  it('adds counts only for lines after the processed seq and is idempotent', () => {
    const cache = createTagCounts()
    const rows: LogRow[] = [t(0, 'A'), t(1, 'B')]
    refreshTagCounts(cache, rows, 0)
    rows.push(t(2, 'A'), { kind: 'gap', fromSeq: 3, toSeq: 4 }, t(5, 'C'))
    refreshTagCounts(cache, rows, 0)
    refreshTagCounts(cache, rows, 0)

    expect(Object.fromEntries(cache.counts)).toEqual({ A: 2, B: 1, C: 1 })
    expect(rankTags(cache.counts, 2)).toEqual(['A', 'B'])
  })

  it('subtracts lines trimmed from the front, even after the backing array was compacted', () => {
    const cache = createTagCounts()
    const rows: LogRow[] = [t(0, 'A'), t(1, 'A'), t(2, 'B')]
    refreshTagCounts(cache, rows, 0)

    // 앞 두 줄이 밀려나고 압축(splice)돼 배열에서 사라졌다. 같은 배열이다.
    rows.push(t(3, 'C'))
    rows.splice(0, 2)
    refreshTagCounts(cache, rows, 0)

    expect(Object.fromEntries(cache.counts)).toEqual({ B: 1, C: 1 })
  })

  it('starts over for a new session', () => {
    const cache = createTagCounts()
    refreshTagCounts(cache, [t(0, 'A'), t(1, 'A')], 0)

    refreshTagCounts(cache, [t(0, 'Z')], 0)

    expect(Object.fromEntries(cache.counts)).toEqual({ Z: 1 })
  })
})
