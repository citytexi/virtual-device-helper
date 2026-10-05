import { useRef } from 'react'
import type { JSX, KeyboardEvent, PointerEvent, WheelEvent } from 'react'
import type { DeviceKey, SessionStatus } from '../../../shared/types/stream'
import { useScrcpyStream } from '../hooks/useScrcpyStream'
import { keyToIntent, toVideoPoint, wheelToScroll } from '../stream/inputMapper'
import { GestureOverlay } from './GestureOverlay'
import { ScreenshotView } from './ScreenshotView'

export interface DeviceScreenProps {
  serial: string | null
}

const DEVICE_BUTTONS: ReadonlyArray<{ key: DeviceKey; label: string; glyph: string }> = [
  { key: 'back', label: '뒤로', glyph: '◀' },
  { key: 'home', label: '홈', glyph: '●' },
  { key: 'app_switch', label: '최근 앱', glyph: '■' },
  { key: 'volume_down', label: '볼륨 낮추기', glyph: '−' },
  { key: 'volume_up', label: '볼륨 높이기', glyph: '+' },
  { key: 'power', label: '전원', glyph: '⏻' }
]

function statusText(status: SessionStatus): string | null {
  if (status.state === 'connecting') return '연결 중…'
  if (status.state === 'reconnecting') return `다시 연결 중 (${status.attempt}/3)`
  return null
}

/**
 * 기기 화면 영역. 실시간 스트림을 그리고 사람 입력을 기기로 보낸다. 스트림이 끝내 실패하면
 * 스크린샷 화면으로 강등된다. 바깥 경계(props)는 M1 그대로라 App은 이 변화를 모른다.
 */
export function DeviceScreen({ serial }: DeviceScreenProps): JSX.Element {
  if (!serial) {
    return (
      <section aria-label="기기 화면" className="device-screen">
        <p className="empty">기기를 선택해라. 왼쪽 목록에서 실행 중인 기기를 누르면 화면이 뜬다.</p>
      </section>
    )
  }
  // key로 기기마다 새 캔버스를 만든다. 이전 기기의 마지막 프레임이 새 기기 화면처럼 남지 않는다.
  return <LiveScreen key={serial} serial={serial} />
}

function LiveScreen({ serial }: { serial: string }): JSX.Element {
  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  const dragging = useRef(false)
  const stream = useScrcpyStream(serial, canvasRef)
  const { status, video, keys, send } = stream
  const live = status.state === 'streaming'
  const overlayText = statusText(status)

  function pointAt(clientX: number, clientY: number, clamp: boolean) {
    const canvas = canvasRef.current
    if (!canvas || !video) return null
    return toVideoPoint(clientX, clientY, canvas.getBoundingClientRect(), video, { clamp })
  }

  function onPointerDown(event: PointerEvent<HTMLCanvasElement>): void {
    if (event.button !== 0) return
    const point = pointAt(event.clientX, event.clientY, false)
    if (!point) return
    dragging.current = true
    event.currentTarget.setPointerCapture?.(event.pointerId)
    event.currentTarget.focus()
    send({ type: 'touch', action: 'down', point })
  }

  function onPointerMove(event: PointerEvent<HTMLCanvasElement>): void {
    if (!dragging.current) return
    const point = pointAt(event.clientX, event.clientY, true)
    if (point) send({ type: 'touch', action: 'move', point })
  }

  function onPointerEnd(event: PointerEvent<HTMLCanvasElement>): void {
    if (!dragging.current) return
    dragging.current = false
    const point = pointAt(event.clientX, event.clientY, true)
    if (point) send({ type: 'touch', action: 'up', point })
  }

  function onWheel(event: WheelEvent<HTMLCanvasElement>): void {
    const point = pointAt(event.clientX, event.clientY, false)
    const scroll = wheelToScroll(event.deltaX, event.deltaY, event.deltaMode)
    if (point && scroll) send({ type: 'scroll', point, ...scroll })
  }

  function onKeyDown(event: KeyboardEvent<HTMLCanvasElement>): void {
    const intent = keyToIntent({
      key: event.key,
      isComposing: event.nativeEvent.isComposing,
      ctrlKey: event.ctrlKey,
      metaKey: event.metaKey,
      altKey: event.altKey,
      shiftKey: event.shiftKey
    })
    if (!intent) return
    // Tab·화살표·Backspace가 페이지 포커스 이동이나 뒤로 가기로 새지 않게 막는다.
    // (Shift+Tab은 keyToIntent가 null을 돌려주니 여기 오지 않는다 — 브라우저 포커스 이동이 그대로 된다.)
    event.preventDefault()
    send(intent)
  }

  return (
    <section aria-label="기기 화면" className="device-screen">
      <div className="screen-toolbar">
        <h2 className="pane-title">화면</h2>
        <span className="device-serial mono">{serial}</span>
        {status.state === 'failed' ? (
          <button type="button" className="btn" onClick={stream.reconnect}>
            다시 연결
          </button>
        ) : null}
      </div>

      {status.state === 'failed' ? (
        <>
          <p role="alert" className="notice notice-error">
            실시간 화면을 열지 못했다: {status.error.message} — {status.error.hint}
          </p>
          <ScreenshotView serial={serial} />
        </>
      ) : (
        <div className="screen-frame">
          <div className="screen-stage">
            <canvas
              ref={canvasRef}
              className="screen-canvas"
              tabIndex={0}
              aria-label={`${serial}의 실시간 화면`}
              onPointerDown={onPointerDown}
              onPointerMove={onPointerMove}
              onPointerUp={onPointerEnd}
              onPointerCancel={onPointerEnd}
              onWheel={onWheel}
              onKeyDown={onKeyDown}
            />
            <GestureOverlay serial={serial} video={video} />
            {overlayText ? (
              <p role="status" className="screen-status">
                {overlayText}
              </p>
            ) : null}
          </div>
        </div>
      )}

      <div className="device-keys" role="toolbar" aria-label="기기 버튼">
        {DEVICE_BUTTONS.filter((button) => keys.includes(button.key)).map((button) => (
          <button
            key={button.key}
            type="button"
            className="btn device-key"
            aria-label={button.label}
            title={button.label}
            disabled={!live}
            onClick={() => send({ type: 'key', key: button.key })}
          >
            {button.glyph}
          </button>
        ))}
      </div>
    </section>
  )
}
