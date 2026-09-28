import { useId } from 'react'
import type { JSX } from 'react'
import type { LogLevel } from '../../../shared/types/device'
import { cycleChip, type LogFilter } from '../logs/logFilter'

export interface LogFiltersProps {
  filter: LogFilter
  onChange(next: LogFilter): void
  /** 칩으로 보여 줄 태그. 순서대로 그린다. */
  tags: readonly string[]
  /** 앱 선택지. main이 보내 준 정렬된 목록이다. */
  packages: readonly string[]
  /** 정규식을 못 만들었을 때의 메시지. */
  regexError: string | null
}

const LEVELS: readonly LogLevel[] = ['V', 'D', 'I', 'W', 'E', 'F']

const CHIP_TITLE = { include: '포함', exclude: '제외', off: '해제' } as const

/**
 * 로그 탭 위쪽 필터 줄. 상태는 LogTab이 쥐고, 여기서는 바뀐 필터를 통째로 돌려준다.
 * 태그 칩은 누를 때마다 포함 → 제외 → 해제로 돈다. 포함은 aria-pressed로, 세 상태 전부는
 * data-state와 title로 드러낸다 — 색만으로 구분하지 않는다.
 */
export function LogFilters({ filter, onChange, tags, packages, regexError }: LogFiltersProps): JSX.Element {
  const errorId = useId()
  const pkgOptions = filter.pkg !== null && !packages.includes(filter.pkg) ? [...packages, filter.pkg] : packages

  return (
    <div className="log-filters">
      <div className="log-filter-row">
        <select
          aria-label="최소 레벨"
          className="log-select"
          value={filter.minLevel}
          onChange={(event) => onChange({ ...filter, minLevel: event.target.value as LogLevel })}
        >
          {LEVELS.map((level) => (
            <option key={level} value={level}>
              {level}
            </option>
          ))}
        </select>

        <input
          type="text"
          aria-label="검색"
          className="log-search mono"
          placeholder="태그·메시지"
          value={filter.text}
          aria-invalid={regexError !== null}
          aria-describedby={regexError !== null ? errorId : undefined}
          onChange={(event) => onChange({ ...filter, text: event.target.value })}
        />

        <label className="log-regex">
          <input
            type="checkbox"
            checked={filter.regex}
            onChange={(event) => onChange({ ...filter, regex: event.target.checked })}
          />
          정규식
        </label>

        <select
          aria-label="앱"
          className="log-select log-pkg"
          value={filter.pkg ?? ''}
          onChange={(event) => onChange({ ...filter, pkg: event.target.value === '' ? null : event.target.value })}
        >
          <option value="">전체</option>
          {pkgOptions.map((pkg) => (
            <option key={pkg} value={pkg}>
              {pkg}
            </option>
          ))}
        </select>
      </div>

      {regexError !== null && (
        <p id={errorId} className="log-filter-error">
          {regexError}
        </p>
      )}

      {tags.length > 0 && (
        <div role="group" aria-label="태그" className="log-chips">
          {tags.map((tag) => {
            const state = filter.chips[tag] ?? 'off'
            return (
              <button
                key={tag}
                type="button"
                className="log-chip mono"
                aria-pressed={state === 'include'}
                data-state={state}
                title={CHIP_TITLE[state]}
                onClick={() => onChange({ ...filter, chips: cycleChip(filter.chips, tag) })}
              >
                {tag}
              </button>
            )
          })}
        </div>
      )}
    </div>
  )
}
