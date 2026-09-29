import { useMemo, useState } from 'react'
import type { JSX } from 'react'
import type { DeviceTimelineEvent, TimelineEntry } from '../../../shared/types/ipc'
import { EMPTY_TIMELINE_FILTER, matchTimeline, type TimelineFilter } from '../timeline/timelineFilter'
import { TimelineDetail, type ToolCallEntry } from './TimelineDetail'
import { TimelineFilters } from './TimelineFilters'

export interface ActivityTabProps {
  entries: TimelineEntry[]
  /** 로그 탭과 같은 기준(useAppState.ts#targetSerial). 상세의 로그 점프 버튼이 쓴다. */
  targetSerial: string | null
  onJumpToLogs?: (entry: ToolCallEntry) => void
}

const DEVICE_EVENT_LABELS: Record<DeviceTimelineEvent, string> = {
  connected: '연결됨',
  disconnected: '연결 끊김',
  active_changed: '활성 기기로 선택됨',
  stream_started: '화면 스트림 시작',
  stream_stopped: '화면 스트림 종료',
  stream_reconnecting: '화면 스트림 재연결 중',
  log_stopped: '로그 수집 멈춤'
}

function formatTime(epochMs: number): string {
  return new Date(epochMs).toLocaleTimeString('ko-KR', { hour12: false })
}

function deviceLabel(serial: string | null, event: DeviceTimelineEvent): string {
  const label = DEVICE_EVENT_LABELS[event]
  return serial ? `${serial} ${label}` : label
}

/**
 * 툴 호출과 기기 이벤트를 기록한 순서대로(최신이 위) 한 줄씩 쌓는다. 기기 이벤트는
 * 흐린 구분선 행이라 펼치지 않는다. 툴 호출 행을 누르면 그 자리에서 상세를 펼친다 —
 * 가상 스크롤은 쓰지 않는다. 펼친 행 높이가 제각각이라 고정 높이 가상화와 맞지 않는다.
 */
export function ActivityTab({ entries, targetSerial, onJumpToLogs }: ActivityTabProps): JSX.Element {
  const [filter, setFilter] = useState<TimelineFilter>(EMPTY_TIMELINE_FILTER)
  const [expandedId, setExpandedId] = useState<string | null>(null)

  // 툴 이름 선택지는 받은 항목에서 모은다.
  const tools = useMemo(() => {
    const names = new Set<string>()
    for (const entry of entries) {
      if (entry.kind === 'tool_call') names.add(entry.tool)
    }
    return [...names].sort()
  }, [entries])

  const filtered = useMemo(() => entries.filter((entry) => matchTimeline(entry, filter)), [entries, filter])

  if (entries.length === 0) {
    return <p className="empty">아직 호출이 없다. 외부 에이전트를 붙이면 여기에 쌓인다.</p>
  }

  return (
    <div className="activity-tab">
      <TimelineFilters filter={filter} tools={tools} onChange={setFilter} />

      {filtered.length === 0 ? (
        <p className="empty">필터에 맞는 항목이 없다.</p>
      ) : (
        <ul className="activity-list">
          {[...filtered].reverse().map((entry) => {
            if (entry.kind === 'device') {
              return (
                <li key={entry.id} className="activity-row activity-row-device">
                  {deviceLabel(entry.serial, entry.event)}
                </li>
              )
            }

            const isExpanded = expandedId === entry.id
            return (
              <li key={entry.id} className="activity-row" data-ok={String(entry.ok)}>
                <button
                  type="button"
                  className="activity-row-toggle"
                  aria-expanded={isExpanded}
                  onClick={() => setExpandedId(isExpanded ? null : entry.id)}
                >
                  <time className="activity-time mono">{formatTime(entry.at)}</time>
                  <strong className="activity-tool">{entry.tool}</strong>
                  <code className="activity-args">{entry.argsSummary}</code>
                  <span className="activity-duration mono">{entry.durationMs}ms</span>
                  <span className="activity-result">
                    {entry.ok ? '성공' : entry.errorKind ? `실패 ${entry.errorKind}` : '실패'}
                  </span>
                </button>
                {isExpanded && (
                  <TimelineDetail entry={entry} targetSerial={targetSerial} onJumpToLogs={onJumpToLogs} />
                )}
              </li>
            )
          })}
        </ul>
      )}
    </div>
  )
}
