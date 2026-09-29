import { useCallback, useRef, useState } from 'react'
import type { JSX, KeyboardEvent } from 'react'
import type { AppSnapshot } from '../../../shared/types/ipc'
import type { LogStreamDeps } from '../hooks/useLogStream'
import { targetSerial } from '../state/useAppState'
import { ActivityTab } from './ActivityTab'
import { AgentTab } from './AgentTab'
import { JUMP_LEAD_MS, LogTab, type LogJump } from './LogTab'
import type { ToolCallEntry } from './TimelineDetail'

export interface WorkAreaProps {
  snapshot: AppSnapshot
  /** 로그 탭의 useLogStream에 넘길 의존성(테스트용). */
  logDeps?: LogStreamDeps
}

const TABS = [
  { id: 'activity', label: '활동' },
  { id: 'logs', label: '로그' },
  { id: 'agent', label: '에이전트' }
] as const

type TabId = (typeof TABS)[number]['id']

/**
 * 오른쪽 작업 영역. WAI-ARIA tabs 패턴을 따른다 — 선택된 탭만 Tab 순서에 두고,
 * 좌우 화살표로 옮기며 끝에서 반대쪽 끝으로 돈다. 선택되지 않은 패널은 hidden이다.
 * 숨겨진 패널도 마운트된 채로 남는다 — 로그 탭은 숨겨진 동안 pause, 다시 보이면 resume한다.
 */
export function WorkArea({ snapshot, logDeps }: WorkAreaProps): JSX.Element {
  const [selected, setSelected] = useState<TabId>('activity')
  const tabRefs = useRef<Partial<Record<TabId, HTMLButtonElement | null>>>({})
  // 점프 요청은 여기서 들고 로그 탭에 넘긴다. 활성 기기는 건드리지 않는다.
  const [jump, setJump] = useState<LogJump | null>(null)

  function jumpToLogs(entry: ToolCallEntry): void {
    setJump({
      id: entry.id,
      at: entry.at - JUMP_LEAD_MS,
      highlight: { fromAt: entry.at, toAt: entry.at + entry.durationMs }
    })
    setSelected('logs')
  }

  // 적용이 끝난 요청은 치운다. 그래야 같은 호출을 다시 눌렀을 때 다시 점프한다.
  const onJumpDone = useCallback((id: string): void => {
    setJump((current) => (current?.id === id ? null : current))
  }, [])

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
        <ActivityTab entries={snapshot.timeline} targetSerial={targetSerial(snapshot)} onJumpToLogs={jumpToLogs} />
      </div>

      <div
        role="tabpanel"
        className="tabpanel tabpanel-logs"
        id="panel-logs"
        aria-labelledby="tab-logs"
        hidden={selected !== 'logs'}
      >
        <LogTab
          serial={targetSerial(snapshot)}
          visible={selected === 'logs'}
          deps={logDeps}
          jump={jump}
          onJumpDone={onJumpDone}
        />
      </div>

      <div role="tabpanel" className="tabpanel" id="panel-agent" aria-labelledby="tab-agent" hidden={selected !== 'agent'}>
        <AgentTab server={snapshot.server} targetSerial={targetSerial(snapshot)} />
      </div>
    </section>
  )
}
