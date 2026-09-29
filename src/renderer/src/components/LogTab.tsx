import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import type { JSX, KeyboardEvent, PointerEvent, UIEvent, WheelEvent } from 'react'
import type { LogEntry } from '../../../shared/types/logs'
import { useLogStream, type LogRow, type LogStream, type LogStreamDeps } from '../hooks/useLogStream'
import {
  EMPTY_FILTER,
  compileFilter,
  createTagCounts,
  firstAfter,
  rankTags,
  refreshTagCounts,
  rowSeq,
  type CompiledFilter,
  type LogFilter,
  type TagCounts
} from '../logs/logFilter'
import { findJumpIndex } from '../logs/logJump'
import { visibleRange } from '../logs/virtualRange'
import { LogFilters } from './LogFilters'

/** 행 높이(px). 고정이라 보이는 범위를 계산만으로 구한다. app.css의 .log-row와 맞춘다. */
export const LOG_ROW_HEIGHT = 20

/** 점프 대상 시각을 호출 시각보다 이만큼(ms) 앞으로 잡는다. 호출 직전 맥락을 함께 보이려는 것이다. */
export const JUMP_LEAD_MS = 2000

/** 활동 탭에서 "이 시점 로그 보기"로 온 점프 요청. `at` 이후 첫 줄로 가고 `highlight` 구간을 강조한다. */
export interface LogJump {
  id: string
  /** 호출의 대상 기기. 로그 탭의 `serial`과 다르면 적용하지 않는다 — 다른 기기 로그에 옛 시각을 대면 안 된다. */
  serial: string
  at: number
  highlight: { fromAt: number; toAt: number }
}

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
  /** 점프 요청. 보이고 따라잡은(caughtUp) 뒤 첫 렌더에서 한 번만 적용한다. 같은 id는 다시 적용하지 않는다. */
  jump?: LogJump | null
  /**
   * 점프 요청을 끝냈을 때 부른다. 대상 시각이 버퍼에서 밀려났으면 'evicted', 요청의 기기가
   * 지금 로그 탭의 기기와 달라 적용하지 않고 버렸으면 'skipped'다.
   */
  onJumpDone?: (id: string, result: 'ok' | 'evicted' | 'skipped') => void
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
export function LogTab({ serial, visible, stream, deps, highlight, jump, onJumpDone }: LogTabProps): JSX.Element {
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

  // 태그 수는 증분으로 센다(새 줄만 더하고 밀려난 줄만 뺀다). 순위는 version이 바뀔 때만
  // 다시 매긴다 — rows는 같은 배열이 제자리에서 자란다.
  const tagCountsRef = useRef<TagCounts | null>(null)
  if (!tagCountsRef.current) tagCountsRef.current = createTagCounts()
  const tagCounts = tagCountsRef.current
  refreshTagCounts(tagCounts, s.rows, s.start)
  const tags = useMemo(() => {
    const top = rankTags(tagCounts.counts, TOP_TAG_LIMIT)
    // 목록에서 밀려난 태그라도 켜 둔 칩은 끌 수 있게 남겨 둔다.
    const extra = Object.keys(filter.chips).filter((tag) => !top.includes(tag))
    return [...top, ...extra]
  }, [s.version, s.start, s.rows, filter.chips, tagCounts])

  const liveCount = s.rows.length - s.start
  // 기기가 끊겨 serial이 null이 돼도 받은 줄이 남아 있으면 목록을 그대로 보인다.
  const showHint = serial === null && liveCount === 0

  const listRef = useRef<HTMLDivElement | null>(null)
  const [scrollTop, setScrollTop] = useState(0)
  const [viewport, setViewport] = useState(0)
  const [following, setFollowing] = useState(true)
  const followingRef = useRef(following)
  followingRef.current = following
  // 직접 맞춘 scrollTop. 그 결과로 오는 scroll 이벤트를 사용자 스크롤로 오해하지 않으려고 둔다.
  const autoTopRef = useRef<number | null>(null)
  const appliedRef = useRef({ epoch: -1, dropped: 0 })
  const prevVisibleRef = useRef(visible)
  const [selected, setSelected] = useState<LogEntry | null>(null)
  // 적용한 점프가 남긴 강조 구간과 밀려남 안내. 점프 prop이 치워져도 남는다.
  const [jumpHighlight, setJumpHighlight] = useState<LogJump['highlight'] | null>(null)
  const [jumpEvicted, setJumpEvicted] = useState(false)
  // 마지막으로 적용한 점프 id. 같은 id로 다시 렌더돼도 스크롤을 다시 잡지 않는다.
  const appliedJumpRef = useRef<string | null>(null)

  // 세션이 바뀌면(버퍼 배열이 새로 생김, 또는 다른 기기로 바뀜) 선택·따라가기·스크롤을 처음으로 돌린다.
  // 렌더 중에 이전 값과 비교해 state를 고치는 React의 "이전 렌더 정보 저장" 패턴이다.
  // session.serial은 마지막으로 본 null 아닌 serial이다 — 기기가 끊겨 null이 된 것은 세션 변경이 아니다.
  const [session, setSession] = useState({ rows: s.rows, serial })
  const sessionSerial = serial ?? session.serial
  if (session.rows !== s.rows || sessionSerial !== session.serial) {
    setSelected(null)
    setFollowing(true)
    setJumpHighlight(null)
    setJumpEvicted(false)
    setScrollTop(0)
    setSession({ rows: s.rows, serial: sessionSerial })
  }

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
    const becameVisible = visible && !prevVisibleRef.current
    prevVisibleRef.current = visible
    if (!el) return
    const applied = appliedRef.current
    const shift = applied.epoch === cache.epoch ? cache.dropped - applied.dropped : 0
    appliedRef.current = { epoch: cache.epoch, dropped: cache.dropped }
    const maxTop = Math.max(0, count * LOG_ROW_HEIGHT - el.clientHeight)

    if (!visible) {
      // 숨겨진 패널(display: none)은 clientHeight·scrollTop이 0이다. 따라가지 않는 중이면
      // 보던 자리는 state에만 두고, 다시 보일 때 되돌린다.
      if (following) scrollToBottom()
      else if (shift > 0) setScrollTop((top) => Math.max(0, top - shift * LOG_ROW_HEIGHT))
      return
    }

    // scroll 이벤트는 한 프레임 늦게 온다. 그 사이 batch가 렌더되면 사용자가 올린 위치를 맨 아래로
    // 되돌려 버린다. 마지막으로 맞춘 위치보다 위에 있으면(그 위치가 아직 닿을 수 있는데도) 사용자
    // 스크롤로 보고 따라가기를 멈춘다. 방금 보이게 된 경우는 display: none이 위치를 0으로 돌린
    // 것이라 뺀다.
    if (
      following &&
      !becameVisible &&
      autoTopRef.current !== null &&
      autoTopRef.current <= maxTop &&
      el.scrollTop < autoTopRef.current
    ) {
      autoTopRef.current = null
      setFollowing(false)
      setScrollTop(el.scrollTop)
      setViewport(el.clientHeight)
      return
    }

    if (following) {
      scrollToBottom()
      return
    }

    if (becameVisible) {
      // display: none이 버린 스크롤 위치를 state에서 되돌린다.
      el.scrollTop = Math.min(Math.max(0, scrollTop - shift * LOG_ROW_HEIGHT), maxTop)
      autoTopRef.current = el.scrollTop
      setScrollTop(el.scrollTop)
    } else if (shift > 0) {
      // 버퍼 앞이 잘려 결과가 위로 당겨졌으면 보던 줄이 제자리에 있도록 그만큼 올린다.
      el.scrollTop = Math.max(0, el.scrollTop - shift * LOG_ROW_HEIGHT)
      autoTopRef.current = el.scrollTop
      setScrollTop(el.scrollTop)
    }
    setViewport(el.clientHeight)
  }, [count, cache.epoch, cache.dropped, visible, following, showHint])

  // 점프는 위 effect 다음에 둔다 — 같은 커밋에서 따라가기가 맨 아래로 맞춘 위치를 덮어써야 한다.
  // 숨겨졌거나 resumed 전(caughtUp false)이면 아직 오지 않은 줄 때문에 위치가 틀리니 기다린다.
  useLayoutEffect(() => {
    if (!jump) {
      // 요청이 치워졌으면 같은 호출을 다시 눌렀을 때 다시 점프할 수 있다.
      appliedJumpRef.current = null
      return
    }
    if (appliedJumpRef.current === jump.id) return
    // 요청 뒤 적용 전에 활성 기기가 바뀌거나 끊겼다. 새 기기 로그에 옛 호출 시각·강조를 대지 않고
    // 요청을 치운다(부모가 null로 바꾸면 appliedJumpRef도 풀린다).
    if (jump.serial !== serial) {
      appliedJumpRef.current = jump.id
      onJumpDone?.(jump.id, 'skipped')
      return
    }
    if (!visible || !s.caughtUp) return
    const el = listRef.current
    if (!el) return
    appliedJumpRef.current = jump.id

    const found = findJumpIndex(s.rows, cache.result, jump.at, s.start)
    setJumpHighlight(jump.highlight)
    if (found === 'evicted') {
      setJumpEvicted(true)
      onJumpDone?.(jump.id, 'evicted')
      return
    }
    setJumpEvicted(false)
    if (found.index >= 0) {
      const maxTop = Math.max(0, count * LOG_ROW_HEIGHT - el.clientHeight)
      el.scrollTop = Math.min(found.index * LOG_ROW_HEIGHT, maxTop)
      autoTopRef.current = el.scrollTop
      setScrollTop(el.scrollTop)
      setViewport(el.clientHeight)
      setFollowing(false)
    }
    onJumpDone?.(jump.id, 'ok')
  }, [jump, serial, visible, s.caughtUp, s.rows, s.start, count, cache, onJumpDone])

  // 창 크기가 바뀌면 보이는 범위를 다시 잡고, 따라가는 중이면 맨 아래를 다시 맞춘다.
  // jsdom에는 ResizeObserver가 없다.
  useEffect(() => {
    const el = listRef.current
    if (!el || typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(() => {
      if (followingRef.current) scrollToBottom()
      else setViewport(el.clientHeight)
    })
    observer.observe(el)
    return () => observer.disconnect()
  }, [showHint])

  function onScroll(event: UIEvent<HTMLDivElement>): void {
    // 숨겨지면서 위치가 0으로 돌아간 것은 사용자 스크롤이 아니다.
    if (!visible) return
    const el = event.currentTarget
    const top = el.scrollTop
    setScrollTop(top)
    setViewport(el.clientHeight)
    if (top === autoTopRef.current) return
    autoTopRef.current = null
    setFollowing(atBottom(el))
  }

  function atBottom(el: HTMLElement): boolean {
    const total = (cacheRef.current as FilterCache).result.length * LOG_ROW_HEIGHT
    return el.scrollTop + el.clientHeight >= total - LOG_ROW_HEIGHT
  }

  // 위로 갈 수 있는 목록인가. 넘치지 않거나 이미 맨 위면 scroll 이벤트가 오지 않아, 여기서 멈추면
  // onScroll의 맨 아래 재판정이 돌지 않고 영영 멈춘 채로 남는다. 넘침은 scrollHeight 대신
  // 행 수로 잰다 — 따라가기 판정과 같은 기준이고 jsdom에서도 잴 수 있다.
  function canScrollUp(el: HTMLElement): boolean {
    const total = (cacheRef.current as FilterCache).result.length * LOG_ROW_HEIGHT
    return total > el.clientHeight && el.scrollTop > 0
  }

  // 위로 가려는 의도가 보이면 scroll 이벤트를 기다리지 않고 바로 따라가기를 멈춘다.
  function stopFollowing(): void {
    autoTopRef.current = null
    setFollowing(false)
  }

  function onWheel(event: WheelEvent<HTMLDivElement>): void {
    if (event.deltaY < 0 && canScrollUp(event.currentTarget)) stopFollowing()
  }

  function onKeyDown(event: KeyboardEvent<HTMLDivElement>): void {
    const up = event.key === 'PageUp' || event.key === 'ArrowUp' || event.key === 'Home'
    if (up && canScrollUp(event.currentTarget)) stopFollowing()
  }

  // pointerup은 목록 밖에서 떼도 받도록 window에서 듣는다. 언마운트 때 떼어 낸다.
  const pointerUpRef = useRef<(() => void) | null>(null)
  useEffect(
    () => () => {
      if (pointerUpRef.current) window.removeEventListener('pointerup', pointerUpRef.current)
    },
    []
  )

  function onPointerDown(event: PointerEvent<HTMLDivElement>): void {
    // 목록 자체(스크롤바·빈 곳)를 잡은 것만 본다. 행을 누르는 것은 상세 보기다.
    if (event.target !== event.currentTarget) return
    const el = event.currentTarget
    if (!canScrollUp(el)) return
    stopFollowing()
    // 끌지 않고 놓았으면 scroll 이벤트가 없다. 놓는 순간 아직 맨 아래면 따라가기를 되살린다.
    if (pointerUpRef.current) window.removeEventListener('pointerup', pointerUpRef.current)
    const onUp = (): void => {
      window.removeEventListener('pointerup', onUp)
      pointerUpRef.current = null
      if (atBottom(el)) {
        setFollowing(true)
        scrollToBottom()
      }
    }
    pointerUpRef.current = onUp
    window.addEventListener('pointerup', onUp)
  }

  function jumpToBottom(): void {
    setFollowing(true)
    scrollToBottom()
  }

  if (showHint) {
    return (
      <div className="log-tab">
        <p className="empty">활성 기기가 없다. 기기를 고르면 로그가 여기 흐른다.</p>
      </div>
    )
  }

  const range = visibleRange(scrollTop, viewport, LOG_ROW_HEIGHT, count)
  // 적용한 점프의 강조가 prop으로 받은 강조보다 우선한다.
  const lit = jumpHighlight ?? highlight
  return (
    <div className="log-tab">
      {jumpEvicted && (
        <p role="status" className="notice notice-warn">
          로그 버퍼에서 밀려난 구간이다
        </p>
      )}
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
        <div
          className="log-list mono"
          data-testid="log-list"
          ref={listRef}
          onScroll={onScroll}
          onWheel={onWheel}
          onKeyDown={onKeyDown}
          onPointerDown={onPointerDown}
        >
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
              const inWindow = lit !== undefined && entry.at >= lit.fromAt && entry.at <= lit.toAt
              return (
                <button
                  key={entry.seq}
                  type="button"
                  className="log-row"
                  style={{ top }}
                  data-level={entry.level}
                  data-highlight={inWindow ? 'true' : undefined}
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
