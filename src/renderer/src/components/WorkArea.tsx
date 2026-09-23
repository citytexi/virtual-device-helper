import type { JSX } from 'react'
import type { AppSnapshot } from '../../../shared/types/ipc'
import { ActivityTab } from './ActivityTab'

export interface WorkAreaProps {
  snapshot: AppSnapshot
}

/**
 * 오른쪽 작업 영역. M1에는 탭이 하나뿐이지만 탭 구조로 만들어 둔다.
 * M3에서 "로그" 탭이 옆에 붙는다.
 */
export function WorkArea({ snapshot }: WorkAreaProps): JSX.Element {
  return (
    <section aria-label="작업 영역" className="pane pane-work">
      <div role="tablist" className="tablist">
        <button type="button" role="tab" className="tab" aria-selected="true" id="tab-activity" aria-controls="panel-activity">
          활동
        </button>
      </div>

      <div role="tabpanel" className="tabpanel" id="panel-activity" aria-labelledby="tab-activity">
        <ActivityTab records={snapshot.toolCalls} />
      </div>
    </section>
  )
}
