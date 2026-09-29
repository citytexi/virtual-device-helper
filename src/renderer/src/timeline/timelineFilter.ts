import type { TimelineEntry } from '../../../shared/types/ipc'

/**
 * 활동 탭 필터 상태. `tool`은 하나만 고르거나(`null`은 전체), `result`는 성공·실패·전체,
 * `showDevice`는 기기 이벤트 행을 보일지, `text`는 툴 이름·`detail.args`·에러 message를
 * 대소문자 구분 없이 찾는 검색어다.
 */
export interface TimelineFilter {
  tool: string | null
  result: 'all' | 'ok' | 'fail'
  showDevice: boolean
  text: string
}

export const EMPTY_TIMELINE_FILTER: TimelineFilter = {
  tool: null,
  result: 'all',
  showDevice: true,
  text: ''
}

/**
 * 기기 이벤트 행은 `showDevice`만 본다 — 툴 이름·성공/실패·텍스트 검색은 툴 호출에만
 * 적용되는 값이라 기기 이벤트를 가리지 않는다.
 */
export function matchTimeline(entry: TimelineEntry, filter: TimelineFilter): boolean {
  if (entry.kind === 'device') return filter.showDevice

  if (filter.tool !== null && entry.tool !== filter.tool) return false
  if (filter.result === 'ok' && !entry.ok) return false
  if (filter.result === 'fail' && entry.ok) return false

  const needle = filter.text.trim().toLowerCase()
  if (needle === '') return true

  const haystack = [entry.tool, entry.detail.args, entry.detail.error?.message]
    .filter((value): value is string => typeof value === 'string')
    .join('\n')
    .toLowerCase()

  return haystack.includes(needle)
}
