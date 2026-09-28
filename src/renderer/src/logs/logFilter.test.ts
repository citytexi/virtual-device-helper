import { describe, expect, it } from 'vitest'
import type { LogEntry } from '../../../shared/types/logs'
import type { LogRow } from '../hooks/useLogStream'
import { EMPTY_FILTER, compileFilter, cycleChip, topTags } from './logFilter'

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
