import { useEffect, useRef } from 'react'
import type { JSX, KeyboardEvent, PointerEvent, WheelEvent } from 'react'
import type { ScreenSlot } from '../../../shared/types/ipc'
import type { DeviceKey, SessionStatus } from '../../../shared/types/stream'
import { useScrcpyStream } from '../hooks/useScrcpyStream'
import { keyToIntent, toVideoPoint, wheelToScroll } from '../stream/inputMapper'
import { GestureOverlay } from './GestureOverlay'
import { ScreenHeader } from './ScreenHeader'
import { ScreenshotView } from './ScreenshotView'

/** 기기가 놓인 칸. 빈 칸은 호출부가 걸러서 이 컴포넌트까지 오지 않는다. */
export type OccupiedScreen = ScreenSlot & { serial: string }

export interface DeviceScreenProps {
  screen: OccupiedScreen
  /** 이 화면의 기기가 지금 MCP 대상인가. */
  isTarget: boolean
  onMakeTarget(): void
  /** F6: 다음 화면의 포커스 대상으로 옮긴다. */
  onFocusNext(): void
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
 * 스크린샷 화면으로 강등된다. 칸의 세대가 바뀌면 호출부의 key가 바뀌어 새 캔버스로 다시 마운트된다.
 */
export function DeviceScreen(props: DeviceScreenProps): JSX.Element {
  return <LiveScreen {...props} />
}

function LiveScreen({ screen, isTarget, onMakeTarget, onFocusNext }: DeviceScreenProps): JSX.Element {
  const { serial, label } = screen
  const sectionRef = useRef<HTMLElement | null>(null)
  const refocusAfterReconnect = useRef(false)
  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  const dragging = useRef(false)
  // 훅의 effect는 slotId와 epoch만 본다. 이 객체는 렌더마다 새로 만들어도 스트림을 다시 열지 않는다.
  const stream = useScrcpyStream({ slotId: screen.id, epoch: screen.epoch }, canvasRef)
  const { status, video, keys, send } = stream
  const live = status.state === 'streaming'
  const overlayText = statusText(status)
  const failed = status.state === 'failed'

  /** 이 화면의 포커스 대상: 캔버스가 있으면 캔버스, 없으면 section 자체. */
  function focusTarget(): void {
    sectionRef.current?.querySelector<HTMLElement>('[data-screen-focus]')?.focus()
  }

  // 다시 연결로 캔버스가 다시 마운트되면 캔버스에 포커스를 준다.
  useEffect(() => {
    if (refocusAfterReconnect.current && !failed) {
      refocusAfterReconnect.current = false
      focusTarget()
    }
  }, [failed])

  function reconnect(): void {
    refocusAfterReconnect.current = true
    stream.reconnect()
  }

  function onSectionKeyDown(event: KeyboardEvent<HTMLElement>): void {
    if (event.key !== 'F6') return
    event.preventDefault()
    onFocusNext()
  }

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
    <section
      ref={sectionRef}
      aria-label={`기기 화면 ${label} ${serial}`}
      className="device-screen"
      {...(failed ? { 'data-screen-focus': '', tabIndex: -1 } : {})}
      onKeyDown={onSectionKeyDown}
    >
      <ScreenHeader
        screen={screen}
        isTarget={isTarget}
        onMakeTarget={onMakeTarget}
        onReconnect={reconnect}
        canReconnect={failed}
      />

      {failed ? (
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
              data-screen-focus=""
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

      <div className="device-keys" role="toolbar" aria-label={`기기 버튼 ${label} ${serial}`}>
        {DEVICE_BUTTONS.filter((button) => keys.includes(button.key)).map((button) => (
          <button
            key={button.key}
            type="button"
            className="btn device-key"
            aria-label={button.label}
            title={button.label}
            disabled={!live}
            onClick={() => {
              send({ type: 'key', key: button.key })
              focusTarget()
            }}
          >
            {button.glyph}
          </button>
        ))}
      </div>
    </section>
  )
}
