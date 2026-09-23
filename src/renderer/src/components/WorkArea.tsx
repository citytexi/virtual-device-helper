import { useRef, useState } from 'react'
import type { JSX, KeyboardEvent } from 'react'
import type { AppSnapshot } from '../../../shared/types/ipc'
import { targetSerial } from '../state/useAppState'
import { ActivityTab } from './ActivityTab'
import { AgentTab } from './AgentTab'

export interface WorkAreaProps {
  snapshot: AppSnapshot
}

const TABS = [
  { id: 'activity', label: '활동' },
  { id: 'agent', label: '에이전트' }
] as const

type TabId = (typeof TABS)[number]['id']

/**
 * 오른쪽 작업 영역. WAI-ARIA tabs 패턴을 따른다 — 선택된 탭만 Tab 순서에 두고,
 * 좌우 화살표로 옮기며 끝에서 반대쪽 끝으로 돈다. 선택되지 않은 패널은 hidden이다.
 * M3에서 "로그" 탭이 여기 붙는다.
 */
export function WorkArea({ snapshot }: WorkAreaProps): JSX.Element {
  const [selected, setSelected] = useState<TabId>('activity')
  const tabRefs = useRef<Partial<Record<TabId, HTMLButtonElement | null>>>({})

  function onKeyDown(event: KeyboardEvent<HTMLDivElement>): void {
    if (event.key !== 'ArrowRight' && event.key !== 'ArrowLeft') return
    event.preventDefault()

    const index = TABS.findIndex((tab) => tab.id === selected)
    const step = event.key === 'ArrowRight' ? 1 : -1
    const next = TABS[(index + step + TABS.length) % TABS.length] as (typeof TABS)[number]

    setSelected(next.id)
    tabRefs.current[next.id]?.focus()
  }

  return (
    <section aria-label="작업 영역" className="pane pane-work">
      <div role="tablist" aria-label="작업 영역 탭" className="tablist" onKeyDown={onKeyDown}>
        {TABS.map((tab) => {
          const isSelected = tab.id === selected
          return (
            <button
              key={tab.id}
              ref={(element) => {
                tabRefs.current[tab.id] = element
              }}
              type="button"
              role="tab"
              className="tab"
              id={`tab-${tab.id}`}
              aria-controls={`panel-${tab.id}`}
              aria-selected={isSelected}
              tabIndex={isSelected ? 0 : -1}
              onClick={() => setSelected(tab.id)}
            >
              {tab.label}
            </button>
          )
        })}
      </div>

      <div
        role="tabpanel"
        className="tabpanel"
        id="panel-activity"
        aria-labelledby="tab-activity"
        hidden={selected !== 'activity'}
      >
        <ActivityTab records={snapshot.toolCalls} />
      </div>

      <div role="tabpanel" className="tabpanel" id="panel-agent" aria-labelledby="tab-agent" hidden={selected !== 'agent'}>
        <AgentTab server={snapshot.server} targetSerial={targetSerial(snapshot)} />
      </div>
    </section>
  )
}
