import type { JSX } from 'react'
import type { TimelineEntry } from '../../../shared/types/ipc'

export interface ActivityTabProps {
  entries: TimelineEntry[]
}

type ToolCallEntry = Extract<TimelineEntry, { kind: 'tool_call' }>

function formatTime(epochMs: number): string {
  return new Date(epochMs).toLocaleTimeString('ko-KR', { hour12: false })
}

/**
 * 툴 호출을 한 줄씩 쌓는다. 필터·검색·상세는 M3다.
 * M1에서 이것이 필요한 이유는 예쁨이 아니라 디버깅이다 —
 * 에이전트가 무엇을 하는지 안 보이면 개발이 안 된다.
 */
export function ActivityTab({ entries }: ActivityTabProps): JSX.Element {
  // 기기 이벤트 줄은 아직 그리지 않는다. 툴 호출만 지금 모양으로 보여 준다.
  const records = entries.filter((entry): entry is ToolCallEntry => entry.kind === 'tool_call')
  if (records.length === 0) {
    return <p className="empty">아직 호출이 없다. 외부 에이전트를 붙이면 여기에 쌓인다.</p>
  }

  return (
    <ul className="activity-list">
      {[...records].reverse().map((record) => (
        <li key={record.id} className="activity-row" data-ok={String(record.ok)}>
          <time className="activity-time mono">{formatTime(record.at)}</time>
          <strong className="activity-tool">{record.tool}</strong>
          <code className="activity-args">{record.argsSummary}</code>
          <span className="activity-duration mono">{record.durationMs}ms</span>
          <span className="activity-result">
            {record.ok ? '성공' : record.errorKind ? `실패 ${record.errorKind}` : '실패'}
          </span>
        </li>
      ))}
    </ul>
  )
}
