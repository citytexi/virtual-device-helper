/**
 * 고정 행 높이 가상 스크롤의 보이는 범위. `end`는 포함하지 않는다(half-open) — 배열
 * `slice(start, end)`에 바로 쓸 수 있게 한다.
 */
export function visibleRange(
  scrollTop: number,
  viewportHeight: number,
  rowHeight: number,
  count: number,
  overscan = 10
): { start: number; end: number } {
  const start = Math.max(0, Math.floor(scrollTop / rowHeight) - overscan)
  const end = Math.min(count, Math.ceil((scrollTop + viewportHeight) / rowHeight) + overscan)
  return { start, end }
}
