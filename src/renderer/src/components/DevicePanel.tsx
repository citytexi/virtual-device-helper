import { useState } from 'react'
import type { JSX } from 'react'
import type { AppSnapshot, Outcome, TrackingFailure } from '../../../shared/types/ipc'
import type { ToolError } from '../../../shared/types/errors'
import { targetSerial } from '../state/useAppState'

export interface DevicePanelProps {
  snapshot: AppSnapshot
}

/**
 * 기기 추적(adb track-devices)이 멎었을 때 보여주는 경고. main이 죽었다는 뜻이
 * 아니라 목록이 그 순간부터 더 이상 갱신되지 않는다는 뜻이라 role="alert"로
 * 눈에 띄게 두되, 원인(error)이 있으면 메시지·힌트를, 없으면 종료 코드를 보여준다.
 */
function TrackingFailureNotice({ failure }: { failure: TrackingFailure }): JSX.Element {
  const detail = failure.error
    ? `${failure.error.message} — ${failure.error.hint}`
    : failure.exitCode !== null
      ? `(종료 코드: ${failure.exitCode})`
      : '이유를 알 수 없다'

  return (
    <p role="alert" className="notice notice-warn">
      기기 추적이 멈췄다. 목록이 오래된 것일 수 있다. {detail}
    </p>
  )
}

export function DevicePanel({ snapshot }: DevicePanelProps): JSX.Element {
  const [busy, setBusy] = useState<string | null>(null)
  const [failure, setFailure] = useState<ToolError | null>(null)

  async function run(label: string, action: () => Promise<Outcome<unknown>>): Promise<void> {
    setBusy(label)
    setFailure(null)
    try {
      const result = await action()
      if (!result.ok) setFailure(result.error)
    } catch (thrown: unknown) {
      // IPC 프라미스가 reject되는 경우(채널이 끊기는 등)는 정상 Outcome 경로를
      // 타지 않는다. 여기서 잡지 않으면 busy가 영원히 남아 모든 버튼이 잠긴다.
      setFailure({
        kind: 'command_failed',
        message: thrown instanceof Error ? thrown.message : String(thrown),
        hint: '연결을 확인하고 다시 시도해라'
      })
    } finally {
      setBusy(null)
    }
  }

  const trackingNotice = snapshot.trackingFailure ? (
    <TrackingFailureNotice failure={snapshot.trackingFailure} />
  ) : null

  if (snapshot.avds.length === 0) {
    return (
      <section aria-label="기기" className="device-panel">
        <h2 className="pane-title">기기</h2>
        {trackingNotice}
        <p className="empty">AVD가 없다. Android Studio의 Device Manager에서 하나 만들고 앱을 다시 켜라.</p>
      </section>
    )
  }

  const target = targetSerial(snapshot)

  return (
    <section aria-label="기기" className="device-panel">
      <h2 className="pane-title">기기</h2>

      {trackingNotice}
      {busy === 'boot' ? <p className="notice notice-info">부팅 중…</p> : null}
      {failure ? (
        <p role="alert" className="notice notice-error">
          {failure.message} — {failure.hint}
        </p>
      ) : null}

      <ul className="device-list">
        {snapshot.avds.map((avd) => {
          const isActive = avd.serial !== null && avd.serial === target

          return (
            <li
              key={avd.name}
              className="device-row"
              aria-current={isActive ? true : undefined}
              data-running={String(avd.running)}
            >
              <span className="status-dot" data-state={avd.running ? 'on' : 'off'} aria-hidden="true" />

              <button
                type="button"
                className="device-name"
                onClick={() => {
                  if (avd.serial) void run('select', () => window.api.selectDevice(avd.serial as string))
                }}
                disabled={!avd.running || busy !== null}
              >
                {avd.name}
              </button>

              {isActive ? <span className="badge">(대상)</span> : null}

              {avd.serial ? <span className="device-serial mono">{avd.serial}</span> : null}

              {avd.running && avd.serial ? (
                <button
                  type="button"
                  className="btn btn-danger device-action"
                  aria-label={`${avd.name} 종료`}
                  onClick={() => void run('shutdown', () => window.api.shutdownDevice(avd.serial as string))}
                  disabled={busy !== null}
                >
                  종료
                </button>
              ) : (
                <button
                  type="button"
                  className="btn device-action"
                  aria-label={`${avd.name} 부팅`}
                  onClick={() => void run('boot', () => window.api.bootAvd(avd.name))}
                  disabled={busy !== null}
                >
                  부팅
                </button>
              )}
            </li>
          )
        })}
      </ul>
    </section>
  )
}
