import type { JSX } from 'react'
import type { ToolCallRecord } from '../../../shared/types/ipc'

export interface ActivityTabProps {
  records: ToolCallRecord[]
}

function formatTime(epochMs: number): string {
  return new Date(epochMs).toLocaleTimeString('ko-KR', { hour12: false })
}

/**
 * 툴 호출을 한 줄씩 쌓는다. 필터·검색·상세는 M3다.
 * M1에서 이것이 필요한 이유는 예쁨이 아니라 디버깅이다 —
 * 에이전트가 무엇을 하는지 안 보이면 개발이 안 된다.
 */
export function ActivityTab({ records }: ActivityTabProps): JSX.Element {
  if (records.length === 0) {
    return <p>아직 호출이 없다. 외부 에이전트를 붙이면 여기에 쌓인다.</p>
  }

  return (
    <ul>
      {[...records].reverse().map((record) => (
        <li key={record.id} data-ok={String(record.ok)}>
          <time>{formatTime(record.startedAt)}</time>
          <strong>{record.tool}</strong>
          <code>{record.argsSummary}</code>
          <span>{record.durationMs}ms</span>
          <span>
            {record.ok ? '성공' : record.errorKind ? `실패 ${record.errorKind}` : '실패'}
          </span>
        </li>
      ))}
    </ul>
  )
}
