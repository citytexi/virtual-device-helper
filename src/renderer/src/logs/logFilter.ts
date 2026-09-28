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

/** 개수 많은 순, 같으면 이름순으로 `limit`개. */
export function rankTags(counts: ReadonlyMap<string, number>, limit: number): string[] {
  return [...counts.entries()]
    .sort(([tagA, countA], [tagB, countB]) => countB - countA || tagA.localeCompare(tagB))
    .slice(0, limit)
    .map(([tag]) => tag)
}

/**
 * `start`(기본 0) 이후 줄(line) 행에서 많이 나온 태그 순으로 `limit`개를 돌려준다.
 * 개수가 같으면 이름순. gap 행은 세지 않는다. 버퍼 전체를 훑으므로 자라는 버퍼에는
 * refreshTagCounts를 쓴다.
 */
export function topTags(rows: readonly LogRow[], limit: number, start = 0): string[] {
  const counts = new Map<string, number>()
  for (let i = start; i < rows.length; i++) {
    const row = rows[i]
    if (!row || row.kind !== 'line') continue
    counts.set(row.entry.tag, (counts.get(row.entry.tag) ?? 0) + 1)
  }
  return rankTags(counts, limit)
}

/** 행의 seq. gap은 덮는 구간의 끝(toSeq)을 쓴다 — useLogStream이 gap 뒤 lastSeq를 그렇게 올린다. */
export function rowSeq(row: LogRow): number {
  return row.kind === 'line' ? row.entry.seq : row.toSeq
}

/** seq로 정렬된 rows[from..to)에서 seq > after인 첫 인덱스. */
export function firstAfter(rows: readonly LogRow[], from: number, to: number, after: number): number {
  let lo = from
  let hi = to
  while (lo < hi) {
    const mid = (lo + hi) >>> 1
    if (rowSeq(rows[mid] as LogRow) > after) hi = mid
    else lo = mid + 1
  }
  return lo
}

/**
 * 살아있는 버퍼의 태그별 줄 수를 증분으로 센다. 버퍼 배열은 압축(splice)되면 밀려난 행이
 * 사라지므로, 센 줄을 `queue`에 따로 들고 있다가 앞이 잘리면 거기서 빼 간다(행 참조만 든다).
 */
export interface TagCounts {
  /** 센 버퍼 배열. 바뀌면 새 세션이다. */
  rows: readonly LogRow[] | null
  processedUpToSeq: number
  counts: Map<string, number>
  /** 센 line 행들, seq 순. `queue[head..)`가 아직 살아있다. */
  queue: LogRow[]
  head: number
}

export function createTagCounts(): TagCounts {
  return { rows: null, processedUpToSeq: -1, counts: new Map(), queue: [], head: 0 }
}

/**
 * `rows[start..)`에 맞춰 counts를 갱신한다. 처리한 마지막 seq를 기준으로 해서 여러 번
 * 불려도(StrictMode 이중 렌더) 결과가 같다.
 */
export function refreshTagCounts(cache: TagCounts, rows: readonly LogRow[], start: number): void {
  const last = rows.length > start ? rows[rows.length - 1] : undefined
  const lastSeq = last ? rowSeq(last) : -1

  if (cache.rows !== rows || lastSeq < cache.processedUpToSeq) {
    cache.rows = rows
    cache.processedUpToSeq = -1
    cache.counts = new Map()
    cache.queue = []
    cache.head = 0
  }

  // 앞이 잘린 줄을 뺀다.
  const first = rows[start]
  const firstSeq = first ? rowSeq(first) : Infinity
  while (cache.head < cache.queue.length) {
    const row = cache.queue[cache.head] as LogRow
    if (row.kind !== 'line' || row.entry.seq >= firstSeq) break
    const n = (cache.counts.get(row.entry.tag) ?? 0) - 1
    if (n > 0) cache.counts.set(row.entry.tag, n)
    else cache.counts.delete(row.entry.tag)
    cache.head += 1
  }
  if (cache.head > 1024 && cache.head * 2 > cache.queue.length) {
    cache.queue.splice(0, cache.head)
    cache.head = 0
  }

  // 새 줄을 더한다.
  for (let i = firstAfter(rows, start, rows.length, cache.processedUpToSeq); i < rows.length; i++) {
    const row = rows[i] as LogRow
    if (row.kind !== 'line') continue
    cache.queue.push(row)
    cache.counts.set(row.entry.tag, (cache.counts.get(row.entry.tag) ?? 0) + 1)
  }
  if (lastSeq > cache.processedUpToSeq) cache.processedUpToSeq = lastSeq
}
