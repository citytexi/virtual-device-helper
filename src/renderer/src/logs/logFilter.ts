import type { LogLevel } from '../../../shared/types/device'
import type { LogRow } from '../hooks/useLogStream'

/** 태그 칩의 상태. 누를 때마다 없음 → include → exclude → 없음으로 돈다. */
export type ChipState = 'include' | 'exclude'

/** 로그 탭의 필터 상태. 전부 renderer에서 적용한다. */
export interface LogFilter {
  minLevel: LogLevel
  /** 태그·메시지 부분일치(대소문자 무시). regex가 켜져 있으면 정규식으로 본다. */
  text: string
  regex: boolean
  chips: Record<string, ChipState>
  /** 고른 패키지. null이면 패키지로 거르지 않는다. */
  pkg: string | null
}

export const EMPTY_FILTER: LogFilter = { minLevel: 'V', text: '', regex: false, chips: {}, pkg: null }

/** V < D < I < W < E < F. */
const LEVEL_ORDER: Record<LogLevel, number> = { V: 0, D: 1, I: 2, W: 3, E: 4, F: 5 }

export interface CompiledFilter {
  match(row: LogRow): boolean
  /** text를 정규식으로 못 만들면 그 메시지. 이때는 텍스트 필터를 끈 것과 같다. */
  regexError: string | null
}

/** 필터 하나를 빠르게 반복 적용할 수 있는 형태로 미리 컴파일한다. */
export function compileFilter(filter: LogFilter): CompiledFilter {
  let regexError: string | null = null
  let textRegex: RegExp | null = null
  const lowerText = filter.text.toLowerCase()

  if (filter.regex && filter.text !== '') {
    try {
      textRegex = new RegExp(filter.text, 'i')
    } catch (err) {
      regexError = err instanceof Error ? err.message : String(err)
    }
  }

  const includeTags = Object.entries(filter.chips)
    .filter(([, state]) => state === 'include')
    .map(([tag]) => tag)
  const excludeTags = new Set(
    Object.entries(filter.chips)
      .filter(([, state]) => state === 'exclude')
      .map(([tag]) => tag)
  )

  function matchesText(tag: string, message: string): boolean {
    if (textRegex) return textRegex.test(tag) || textRegex.test(message)
    if (filter.regex || lowerText === '') return true
    return tag.toLowerCase().includes(lowerText) || message.toLowerCase().includes(lowerText)
  }

  function match(row: LogRow): boolean {
    if (row.kind === 'gap') return true
    const { entry } = row

    if (LEVEL_ORDER[entry.level] < LEVEL_ORDER[filter.minLevel]) return false
    if (!matchesText(entry.tag, entry.message)) return false
    if (excludeTags.has(entry.tag)) return false
    if (includeTags.length > 0 && !includeTags.includes(entry.tag)) return false
    if (filter.pkg !== null && entry.pkg !== filter.pkg) return false

    return true
  }

  return { match, regexError }
}

/** 없음 → include → exclude → 없음. */
export function cycleChip(chips: Record<string, ChipState>, tag: string): Record<string, ChipState> {
  const current = chips[tag]
  const next: Record<string, ChipState> = { ...chips }
  if (current === undefined) {
    next[tag] = 'include'
  } else if (current === 'include') {
    next[tag] = 'exclude'
  } else {
    delete next[tag]
  }
  return next
}

/**
 * `start`(기본 0) 이후 줄(line) 행에서 많이 나온 태그 순으로 `limit`개를 돌려준다.
 * 개수가 같으면 이름순. gap 행은 세지 않는다.
 */
export function topTags(rows: readonly LogRow[], limit: number, start = 0): string[] {
  const counts = new Map<string, number>()
  for (let i = start; i < rows.length; i++) {
    const row = rows[i]
    if (!row || row.kind !== 'line') continue
    counts.set(row.entry.tag, (counts.get(row.entry.tag) ?? 0) + 1)
  }
  return [...counts.entries()]
    .sort(([tagA, countA], [tagB, countB]) => countB - countA || tagA.localeCompare(tagB))
    .slice(0, limit)
    .map(([tag]) => tag)
}
