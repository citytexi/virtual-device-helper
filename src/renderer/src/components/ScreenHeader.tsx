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
      <span className="screen-label">{screen.label}</span>
      <span className="mono" title={screen.serial}>
        {screen.serial}
      </span>
      {isTarget ? <span className="badge">(대상)</span> : null}
      <button
        type="button"
        aria-label={`${screen.label} ${screen.serial} 대상으로`}
        disabled={isTarget}
        onClick={onMakeTarget}
      >
        대상으로
      </button>
      {canReconnect ? (
        <button type="button" onClick={onReconnect}>
          다시 연결
        </button>
      ) : null}
    </header>
  )
}
