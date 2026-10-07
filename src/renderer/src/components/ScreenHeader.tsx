import type { JSX } from 'react'
import type { OccupiedScreen } from './DeviceScreen'

export interface ScreenHeaderProps {
  screen: OccupiedScreen
  isTarget: boolean
  onMakeTarget(): void
  onReconnect(): void
  canReconnect: boolean
}

/** 화면 한 칸의 머리. 어느 기기인지, MCP 대상인지, 대상으로 삼기와 다시 연결을 보인다. */
export function ScreenHeader({ screen, isTarget, onMakeTarget, onReconnect, canReconnect }: ScreenHeaderProps): JSX.Element {
  return (
    <header className="screen-header">
      <span className="screen-ident">
        <span className="screen-label">{screen.label}</span>
        <span className="screen-serial mono" title={screen.serial}>
          {screen.serial}
        </span>
        {isTarget ? <span className="badge">(대상)</span> : null}
      </span>
      <span className="screen-actions">
        <button
          type="button"
          className="btn"
          aria-label={`${screen.label} ${screen.serial} 대상으로`}
          disabled={isTarget}
          onClick={onMakeTarget}
        >
          대상으로
        </button>
        {canReconnect ? (
          <button type="button" className="btn" onClick={onReconnect}>
            다시 연결
          </button>
        ) : null}
      </span>
    </header>
  )
}
