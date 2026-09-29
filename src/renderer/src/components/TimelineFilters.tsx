import type { JSX } from 'react'
import type { TimelineFilter } from '../timeline/timelineFilter'

export interface TimelineFiltersProps {
  filter: TimelineFilter
  /** 받은 항목에서 모은 툴 이름 선택지. */
  tools: readonly string[]
  onChange(next: TimelineFilter): void
}

/** 활동 탭 위쪽 필터 줄. 상태는 ActivityTab이 쥐고, 여기서는 바뀐 필터를 통째로 돌려준다. */
export function TimelineFilters({ filter, tools, onChange }: TimelineFiltersProps): JSX.Element {
  return (
    <div className="timeline-filters">
      <select
        aria-label="툴"
        className="timeline-select"
        value={filter.tool ?? ''}
        onChange={(event) => onChange({ ...filter, tool: event.target.value === '' ? null : event.target.value })}
      >
        <option value="">전체 툴</option>
        {tools.map((tool) => (
          <option key={tool} value={tool}>
            {tool}
          </option>
        ))}
      </select>

      <select
        aria-label="결과"
        className="timeline-select"
        value={filter.result}
        onChange={(event) => onChange({ ...filter, result: event.target.value as TimelineFilter['result'] })}
      >
        <option value="all">전체</option>
        <option value="ok">성공</option>
        <option value="fail">실패</option>
      </select>

      <label className="timeline-checkbox">
        <input
          type="checkbox"
          checked={filter.showDevice}
          onChange={(event) => onChange({ ...filter, showDevice: event.target.checked })}
        />
        기기 이벤트 표시
      </label>

      <input
        type="text"
        aria-label="검색"
        className="timeline-search mono"
        placeholder="툴 이름·인자·에러 검색"
        value={filter.text}
        onChange={(event) => onChange({ ...filter, text: event.target.value })}
      />
    </div>
  )
}
