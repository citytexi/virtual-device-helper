import { useCallback, useEffect, useRef, useState } from 'react'
import type { JSX } from 'react'
import type { ToolError } from '../../../shared/types/errors'
import type { ScreenshotResult } from '../../../shared/types/device'

export interface ScreenshotViewProps {
  serial: string
}

/**
 * 정지 스크린샷 화면. M1의 기기 화면이었고, M2에서는 실시간 스트림이 끝내 실패했을 때의
 * 강등 화면이다. 스트림 없이도 기기를 볼 수 있는 마지막 경로라 동작을 바꾸지 않는다.
 */
export function ScreenshotView({ serial }: ScreenshotViewProps): JSX.Element {
  const [shot, setShot] = useState<ScreenshotResult | null>(null)
  const [failure, setFailure] = useState<ToolError | null>(null)
  const [capturing, setCapturing] = useState(false)

  // 요청 번호. serial이 바뀌거나 새 capture가 시작되면 올라간다 — 응답이
  // 돌아왔을 때 이 번호가 최신 요청과 다르면(추월당했으면) 결과를 버린다.
  // unmount 이후 응답도 같은 방식으로 걸러진다.
  const requestId = useRef(0)
  const mounted = useRef(true)

  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
    }
  }, [])

  const capture = useCallback(async (target: string) => {
    const myRequest = (requestId.current += 1)
    setCapturing(true)
    setFailure(null)

    try {
      const result = await window.api.captureScreenshot(target)

      if (!mounted.current || myRequest !== requestId.current) return

      if (result.ok) setShot(result.value)
      else setFailure(result.error)
    } catch (thrown: unknown) {
      if (!mounted.current || myRequest !== requestId.current) return

      setFailure({
        kind: 'command_failed',
        message: thrown instanceof Error ? thrown.message : String(thrown),
        hint: '연결을 확인하고 다시 시도해라'
      })
    } finally {
      if (mounted.current && myRequest === requestId.current) setCapturing(false)
    }
  }, [])

  useEffect(() => {
    // serial이 바뀌면 이전 기기의 화면·실패를 먼저 지운다. 지우지 않으면
    // 새 캡처가 끝나기 전까지 사용자가 이전 기기의 화면을 새 기기의 것으로
    // 착각한다.
    setShot(null)
    setFailure(null)
    void capture(serial)
  }, [serial, capture])

  return (
    <div className="screenshot-view">
      <div className="screen-toolbar">
        <span className="screenshot-label">정지 화면</span>
        <button type="button" className="btn" onClick={() => void capture(serial)} disabled={capturing}>
          새로고침
        </button>
      </div>

      {failure ? (
        <p role="alert" className="notice notice-error">
          {failure.message} — {failure.hint}
        </p>
      ) : null}

      <div className="screen-frame" aria-busy={capturing}>
        {shot ? (
          <img
            src={`data:image/png;base64,${shot.base64}`}
            alt={`${serial}의 화면`}
            width={shot.width}
            height={shot.height}
          />
        ) : null}
      </div>
    </div>
  )
}
