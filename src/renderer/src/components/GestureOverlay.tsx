import { useEffect, useState } from 'react'
import type { JSX } from 'react'
import type { Gesture, MainEvent } from '../../../shared/types/ipc'
import type { VideoSize } from '../stream/inputMapper'

/** 표시 하나가 떠 있는 시간. app.css의 gesture 애니메이션 길이와 같다. */
export const GESTURE_VISIBLE_MS = 700

export type VideoGesture =
  | { kind: 'tap'; x: number; y: number }
  | { kind: 'swipe'; x1: number; y1: number; x2: number; y2: number }

/**
 * 기기 픽셀 좌표를 비디오 좌표로 바꾼다. screen은 자연 방향 크기이고 툴 좌표는 현재 방향
 * 공간에 있다. 비디오의 가로·세로 방향이 screen과 다르면 회전된 것으로 보고 축을 바꿔 나눈다.
 */
export function gestureToVideo(gesture: Gesture, video: VideoSize): VideoGesture {
  const rotated = video.width > video.height !== gesture.screen.width > gesture.screen.height
  const screenWidth = rotated ? gesture.screen.height : gesture.screen.width
  const screenHeight = rotated ? gesture.screen.width : gesture.screen.height
  const fx = video.width / screenWidth
  const fy = video.height / screenHeight

  if (gesture.kind === 'tap') return { kind: 'tap', x: gesture.x * fx, y: gesture.y * fy }
  return { kind: 'swipe', x1: gesture.x1 * fx, y1: gesture.y1 * fy, x2: gesture.x2 * fx, y2: gesture.y2 * fy }
}

export interface GestureOverlayProps {
  serial: string
  video: VideoSize | null
  /** 기본값은 window.api.onEvent. 테스트는 가짜 이벤트 버스를 넘긴다. */
  subscribe?: (listener: (event: MainEvent) => void) => () => void
}

// 모듈 수준에 둔다. 렌더마다 새 함수면 effect가 매번 다시 구독한다.
const subscribeToMain = (listener: (event: MainEvent) => void): (() => void) => window.api.onEvent(listener)

interface Mark {
  id: string
  gesture: Gesture
}

/**
 * 에이전트의 탭·스와이프를 실시간 화면 위에 잠깐 그린다. 구독한 뒤에 온 툴 호출만 그린다 —
 * 이미 지난 호출을 다시 그리면 지금 화면과 맞지 않는다. viewBox를 비디오 크기로 두고
 * preserveAspectRatio를 meet으로 두면 캔버스의 object-fit: contain과 같은 자리에 그려진다.
 */
export function GestureOverlay({ serial, video, subscribe = subscribeToMain }: GestureOverlayProps): JSX.Element | null {
  const [marks, setMarks] = useState<Mark[]>([])

  useEffect(() => {
    const timers = new Set<ReturnType<typeof setTimeout>>()
    const unsubscribe = subscribe((event) => {
      if (event.type !== 'tool_call') return
      const gesture = event.record.gesture
      if (!gesture || gesture.serial !== serial) return

      const mark: Mark = { id: event.record.id, gesture }
      setMarks((current) => [...current, mark])
      const timer = setTimeout(() => {
        timers.delete(timer)
        setMarks((current) => current.filter((m) => m !== mark))
      }, GESTURE_VISIBLE_MS)
      timers.add(timer)
    })

    return () => {
      unsubscribe()
      for (const timer of timers) clearTimeout(timer)
      setMarks([])
    }
  }, [serial, subscribe])

  if (!video) return null
  const radius = Math.max(video.width, video.height) * 0.03

  return (
    <svg
      className="gesture-overlay"
      viewBox={`0 0 ${video.width} ${video.height}`}
      preserveAspectRatio="xMidYMid meet"
      aria-hidden="true"
    >
      {marks.map((mark) => {
        const g = gestureToVideo(mark.gesture, video)
        if (g.kind === 'tap') {
          return <circle key={mark.id} className="gesture-tap" cx={g.x} cy={g.y} r={radius} />
        }
        return (
          <g key={mark.id} className="gesture-swipe">
            <line x1={g.x1} y1={g.y1} x2={g.x2} y2={g.y2} />
            <circle cx={g.x2} cy={g.y2} r={radius / 2} />
          </g>
        )
      })}
    </svg>
  )
}
