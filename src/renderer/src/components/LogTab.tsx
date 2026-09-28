import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import type { JSX, UIEvent } from 'react'
import type { LogEntry } from '../../../shared/types/logs'
import { useLogStream, type LogRow, type LogStream, type LogStreamDeps } from '../hooks/useLogStream'
import { EMPTY_FILTER, compileFilter, topTags, type CompiledFilter, type LogFilter } from '../logs/logFilter'
import { visibleRange } from '../logs/virtualRange'
import { LogFilters } from './LogFilters'

/** 행 높이(px). 고정이라 보이는 범위를 계산만으로 구한다. app.css의 .log-row와 맞춘다. */
export const LOG_ROW_HEIGHT = 20

/** 태그 칩으로 보여 줄 태그 수. */
export const TOP_TAG_LIMIT = 12

export interface LogTabProps {
  serial: string | null
  visible: boolean
  /** 주면 useLogStream 대신 이것을 쓴다(테스트용). */
  stream?: LogStream
  /** useLogStream에 넘길 의존성(테스트용). */
  deps?: LogStreamDeps
  /** 이 구간(`entry.at` 기준, 양끝 포함) 안의 행에 data-highlight를 단다. M3-3이 채운다. */
  highlight?: { fromAt: number; toAt: number }
}

/** 행의 seq. gap은 덮는 구간의 끝(toSeq)을 쓴다 — useLogStream이 gap 뒤 lastSeq를 그렇게 올린다. */
function rowSeq(row: LogRow): number {
  return row.kind === 'line' ? row.entry.seq : row.toSeq
}

/** seq로 정렬된 rows[from..to)에서 seq > after인 첫 인덱스. */
function firstAfter(rows: readonly LogRow[], from: number, to: number, after: number): number {
  let lo = from
  let hi = to
  while (lo < hi) {
    const mid = (lo + hi) >>> 1
    if (rowSeq(rows[mid] as LogRow) > after) hi = mid
    else lo = mid + 1
  }
  return lo
}

/** 증분 필터의 상태. 렌더 중에 고쳐 쓰므로 ref에 둔다. */
export interface FilterCache {
  /** 결과를 만든 필터. 바뀌면 전체를 다시 거른다. */
  filterKey: CompiledFilter | null
  /** 결과를 만든 버퍼 배열. useLogStream은 비울 때 새 배열을 만드니 이것이 바뀌면 새 세션이다. */
  rows: readonly LogRow[] | null
  /** 이 seq까지의 행은 이미 걸렀다. */
  processedUpToSeq: number
  result: LogRow[]
  /** 전체를 다시 거를 때마다 1 오른다. */
  epoch: number
  /** 이번 epoch에서 버퍼 앞이 잘려 결과 앞에서 떼어 낸 행 수(누적). 스크롤 위치 보정에 쓴다. */
  dropped: number
}

export function createFilterCache(): FilterCache {
  return { filterKey: null, rows: null, processedUpToSeq: -1, result: [], epoch: 0, dropped: 0 }
}

/**
 * 버퍼의 살아있는 행(`rows[start..)`)에 맞춰 cache.result를 갱신한다. 처리한 마지막 seq를
 * 기준으로 하므로 여러 번 불려도(StrictMode 이중 렌더) 결과가 같다.
 *
 * - 필터나 버퍼 배열이 바뀌었거나 버퍼가 거꾸로 짧아졌으면 처음부터 다시 거른다.
 * - 버퍼 앞이 잘렸으면 결과에서 버퍼 첫 행보다 seq가 작은 행(줄과 그 앞 gap)을 떼어 낸다.
 * - 그다음 processedUpToSeq보다 큰 seq의 행만 걸러 붙인다.
 */
export function refreshFilter(
  cache: FilterCache,
  rows: readonly LogRow[],
  start: number,
  filter: CompiledFilter
): void {
  const last = rows.length > start ? rows[rows.length - 1] : undefined
  const lastSeq = last ? rowSeq(last) : -1

  if (cache.filterKey !== filter || cache.rows !== rows || lastSeq < cache.processedUpToSeq) {
    cache.filterKey = filter
    cache.rows = rows
    cache.processedUpToSeq = -1
    cache.result = []
    cache.epoch += 1
    cache.dropped = 0
  }

  const first = rows[start]
  if (first && cache.result.length > 0) {
    const drop = firstAfter(cache.result, 0, cache.result.length, rowSeq(first) - 1)
    if (drop > 0) {
      cache.result.splice(0, drop)
      cache.dropped += drop
    }
  }

  for (let i = firstAfter(rows, start, rows.length, cache.processedUpToSeq); i < rows.length; i++) {
    const row = rows[i] as LogRow
    if (filter.match(row)) cache.result.push(row)
  }
  if (lastSeq > cache.processedUpToSeq) cache.processedUpToSeq = lastSeq
}

function pad(value: number, width: number): string {
  return String(value).padStart(width, '0')
}

/** `HH:mm:ss.SSS`. logcat timestamp에서 꺼내고, 못 꺼내면 호스트 시각(at)으로 만든다. */
function formatTime(entry: LogEntry): string {
  const match = /(\d{2}:\d{2}:\d{2})[.,](\d{3})/.exec(entry.timestamp)
  if (match) return `${match[1]}.${match[2]}`
  const d = new Date(entry.at)
  return `${pad(d.getHours(), 2)}:${pad(d.getMinutes(), 2)}:${pad(d.getSeconds(), 2)}.${pad(d.getMilliseconds(), 3)}`
}

/**
 * 활성 기기의 logcat을 보여 준다. 필터는 전부 여기서 적용하고, 목록은 고정 행 높이로 직접
 * 가상 스크롤한다. 맨 아래에 있으면 새 줄을 따라가고, 위로 스크롤하면 멈춘 채 "맨 아래로"
 * 버튼을 띄운다. 숨겨진 패널에서는 clientHeight가 0이라, 다시 보일 때 따라가기 위치를 다시 잡는다.
 */
export function LogTab({ serial, visible, stream, deps, highlight }: LogTabProps): JSX.Element {
  // 훅은 항상 부른다. stream을 받았으면 serial을 null로 줘서 포트를 열지 않는다.
  const own = useLogStream(stream ? null : serial, visible, deps)
  const s = stream ?? own

  const [filter, setFilter] = useState<LogFilter>(EMPTY_FILTER)
  const compiled = useMemo(() => compileFilter(filter), [filter])

  const cacheRef = useRef<FilterCache | null>(null)
  if (!cacheRef.current) cacheRef.current = createFilterCache()
  const cache = cacheRef.current
  refreshFilter(cache, s.rows, s.start, compiled)
  const visibleRows = cache.result
  const count = visibleRows.length

  // version이 바뀔 때만 다시 센다 — rows는 같은 배열이 제자리에서 자란다.
  const tags = useMemo(() => {
    const top = topTags(s.rows, TOP_TAG_LIMIT, s.start)
    // 목록에서 밀려난 태그라도 켜 둔 칩은 끌 수 있게 남겨 둔다.
    const extra = Object.keys(filter.chips).filter((tag) => !top.includes(tag))
    return [...top, ...extra]
  }, [s.version, s.start, s.rows, filter.chips])

  const listRef = useRef<HTMLDivElement | null>(null)
  const [scrollTop, setScrollTop] = useState(0)
  const [viewport, setViewport] = useState(0)
  const [following, setFollowing] = useState(true)
  // 직접 맞춘 scrollTop. 그 결과로 오는 scroll 이벤트를 사용자 스크롤로 오해하지 않으려고 둔다.
  const autoTopRef = useRef<number | null>(null)
  const appliedRef = useRef({ epoch: -1, dropped: 0 })
  const [selected, setSelected] = useState<LogEntry | null>(null)

  function scrollToBottom(): void {
    const el = listRef.current
    if (!el) return
    const total = (cacheRef.current as FilterCache).result.length * LOG_ROW_HEIGHT
    el.scrollTop = Math.max(0, total - el.clientHeight)
    autoTopRef.current = el.scrollTop
    setScrollTop(el.scrollTop)
    setViewport(el.clientHeight)
  }

  useLayoutEffect(() => {
    const el = listRef.current
    if (!el) return
    const applied = appliedRef.current
    const shift = applied.epoch === cache.epoch ? cache.dropped - applied.dropped : 0
    appliedRef.current = { epoch: cache.epoch, dropped: cache.dropped }

    if (following) {
      scrollToBottom()
    } else {
      // 버퍼 앞이 잘려 결과가 위로 당겨졌으면 보던 줄이 제자리에 있도록 그만큼 올린다.
      if (shift > 0) {
        el.scrollTop = Math.max(0, el.scrollTop - shift * LOG_ROW_HEIGHT)
        autoTopRef.current = el.scrollTop
        setScrollTop(el.scrollTop)
      }
      setViewport(el.clientHeight)
    }
  }, [count, cache.epoch, cache.dropped, visible, following, serial])

  // 창 크기가 바뀌면 보이는 범위를 다시 잡는다. jsdom에는 ResizeObserver가 없다.
  useEffect(() => {
    const el = listRef.current
    if (!el || typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(() => setViewport(el.clientHeight))
    observer.observe(el)
    return () => observer.disconnect()
  }, [serial])

  function onScroll(event: UIEvent<HTMLDivElement>): void {
    const el = event.currentTarget
    const top = el.scrollTop
    setScrollTop(top)
    setViewport(el.clientHeight)
    if (top === autoTopRef.current) return
    autoTopRef.current = null
    const total = (cacheRef.current as FilterCache).result.length * LOG_ROW_HEIGHT
    setFollowing(top + el.clientHeight >= total - LOG_ROW_HEIGHT)
  }

  function jumpToBottom(): void {
    setFollowing(true)
    scrollToBottom()
  }

  if (serial === null) {
    return (
      <div className="log-tab">
        <p className="empty">활성 기기가 없다. 기기를 고르면 로그가 여기 흐른다.</p>
      </div>
    )
  }

  const range = visibleRange(scrollTop, viewport, LOG_ROW_HEIGHT, count)
  const liveCount = s.rows.length - s.start

  return (
    <div className="log-tab">
      {s.status === 'reconnecting' && (
        <p role="status" className="notice notice-warn">
          로그 연결을 다시 잇는 중이다
        </p>
      )}
      {s.status === 'stopped' && (
        <p role="status" className="notice notice-error">
          로그 수집이 멈췄다. 받은 줄은 그대로 남아 있다.
        </p>
      )}

      <LogFilters
        filter={filter}
        onChange={setFilter}
        tags={tags}
        packages={s.packages}
        regexError={compiled.regexError}
      />

      <div className="log-list-wrap">
        <div className="log-list mono" data-testid="log-list" ref={listRef} onScroll={onScroll}>
          <div className="log-spacer" style={{ height: `${count * LOG_ROW_HEIGHT}px` }}>
            {visibleRows.slice(range.start, range.end).map((row, offset) => {
              const index = range.start + offset
              const top = `${index * LOG_ROW_HEIGHT}px`
              if (row.kind === 'gap') {
                return (
                  <div key={`gap-${row.toSeq}`} className="log-row log-gap" style={{ top }}>
                    밀려난 구간 (seq {row.fromSeq}–{row.toSeq})
                  </div>
                )
              }
              const { entry } = row
              const lit = highlight !== undefined && entry.at >= highlight.fromAt && entry.at <= highlight.toAt
              return (
                <button
                  key={entry.seq}
                  type="button"
                  className="log-row"
                  style={{ top }}
                  data-level={entry.level}
                  data-highlight={lit ? 'true' : undefined}
                  aria-current={selected === entry ? 'true' : undefined}
                  onClick={() => setSelected(entry)}
                >
                  <span className="log-time">{formatTime(entry)}</span>
                  <span className="log-level">{entry.level}</span>
                  <span className="log-tag">{entry.tag}</span>
                  <span className="log-message">{entry.message}</span>
                </button>
              )
            })}
          </div>
        </div>

        {count === 0 && (
          <p className="empty log-empty">{liveCount === 0 ? '아직 받은 로그가 없다.' : '필터에 맞는 줄이 없다.'}</p>
        )}

        {!following && (
          <button type="button" className="btn log-to-bottom" onClick={jumpToBottom}>
            맨 아래로
          </button>
        )}
      </div>

      {selected && (
        <section aria-label="로그 상세" className="log-detail">
          <p className="log-detail-meta mono">
            {selected.timestamp} · {selected.level} · {selected.tag} · pid {selected.pid}
            {selected.pkg ? ` · ${selected.pkg}` : ''}
          </p>
          <pre className="log-detail-message">{selected.message}</pre>
        </section>
      )}
    </div>
  )
}
