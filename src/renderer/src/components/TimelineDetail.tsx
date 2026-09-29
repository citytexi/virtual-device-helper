import type { JSX } from 'react'
import type { TimelineEntry } from '../../../shared/types/ipc'

export type ToolCallEntry = Extract<TimelineEntry, { kind: 'tool_call' }>

export interface TimelineDetailProps {
  entry: ToolCallEntry
  /** 로그 탭과 같은 기준(useAppState.ts#targetSerial)의 활성 기기. */
  targetSerial: string | null
  onJumpToLogs?: (entry: ToolCallEntry) => void
}

const JUMP_DISABLED_REASON = '활성 기기의 호출만 로그로 이동할 수 있다'

/** `detail.args`를 들여쓴 JSON으로 보인다. 2KB 상한에 잘려 파싱이 안 되면 원문을 그대로 보인다. */
function formatArgs(raw: string): string {
  try {
    return JSON.stringify(JSON.parse(raw), null, 2)
  } catch {
    return raw
  }
}

/**
 * 활동 탭에서 펼친 툴 호출 한 건의 상세. 전체 인자, 실패면 message·hint, 성공이면 결과
 * 요약을 보여 준다. "이 시점 로그 보기"는 호출의 serial이 로그 탭의 활성 기기와 같을 때만 켠다 —
 * 점프 자체가 활성 기기를 바꾸지는 않는다.
 */
export function TimelineDetail({ entry, targetSerial, onJumpToLogs }: TimelineDetailProps): JSX.Element {
  const canJump = entry.serial !== undefined && entry.serial !== null && entry.serial === targetSerial

  return (
    <div className="timeline-detail">
      <pre className="timeline-detail-args mono">{formatArgs(entry.detail.args)}</pre>

      {entry.ok ? (
        entry.detail.resultSummary !== undefined ? (
          <p className="timeline-detail-summary">{entry.detail.resultSummary}</p>
        ) : null
      ) : (
        <div className="timeline-detail-error">
          {entry.detail.error ? (
            <>
              <p className="timeline-detail-message">{entry.detail.error.message}</p>
              <p className="timeline-detail-hint">{entry.detail.error.hint}</p>
            </>
          ) : null}
        </div>
      )}

      <div className="timeline-detail-actions">
        <button
          type="button"
          className="btn"
          disabled={!canJump}
          title={canJump ? undefined : JUMP_DISABLED_REASON}
          onClick={() => onJumpToLogs?.(entry)}
        >
          이 시점 로그 보기
        </button>
        {!canJump && <span className="timeline-detail-reason">{JUMP_DISABLED_REASON}</span>}
      </div>
    </div>
  )
}
