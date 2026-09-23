import type { ToolError } from './errors'

/** 사람이 보낼 수 있는 기기 키. 툴바 버튼과 캔버스 키보드 입력이 같은 목록을 쓴다. */
export type DeviceKey =
  | 'back'
  | 'home'
  | 'app_switch'
  | 'power'
  | 'volume_up'
  | 'volume_down'
  | 'enter'
  | 'backspace'
  | 'forward_delete'
  | 'tab'
  | 'escape'
  | 'up'
  | 'down'
  | 'left'
  | 'right'

/** main이 renderer 입력을 검증할 때 쓰는 목록. DeviceKey와 같은 값을 같은 순서로 둔다. */
export const DEVICE_KEYS: readonly DeviceKey[] = [
  'back',
  'home',
  'app_switch',
  'power',
  'volume_up',
  'volume_down',
  'enter',
  'backspace',
  'forward_delete',
  'tab',
  'escape',
  'up',
  'down',
  'left',
  'right'
]

/**
 * 비디오 프레임 좌표와 그 프레임의 크기. 서버는 width·height가 자기 비디오 크기와 다르면
 * 이벤트를 버린다 — 회전 직후의 오래된 좌표가 엉뚱한 곳을 누르지 않게 하는 장치다.
 */
export interface VideoPoint {
  x: number
  y: number
  width: number
  height: number
}

export type TouchAction = 'down' | 'move' | 'up'

/** 사람 입력의 의도. 바이트로 바꾸는 일은 main의 scrcpyProtocol만 한다. */
export type ControlIntent =
  | { type: 'touch'; action: TouchAction; point: VideoPoint }
  /** hScroll·vScroll는 Android 축 의미다. 양수가 오른쪽·위쪽이고 범위는 [-16, 16]이다. */
  | { type: 'scroll'; point: VideoPoint; hScroll: number; vScroll: number }
  | { type: 'text'; text: string }
  | { type: 'key'; key: DeviceKey }

export type SessionStatus =
  | { state: 'connecting' }
  | { state: 'streaming' }
  | { state: 'reconnecting'; attempt: number }
  | { state: 'failed'; error: ToolError }

/** main → renderer 포트 메시지 */
export type StreamDown =
  | { type: 'status'; status: SessionStatus }
  | { type: 'session'; width: number; height: number }
  | { type: 'packet'; config: boolean; key: boolean; ptsUs: number | null; data: Uint8Array }

/** renderer → main 포트 메시지 */
export type StreamUp = ControlIntent

/** 포트와 함께 오는 꼬리표. renderer는 자기 serial과 같은 포트만 쓴다. */
export interface StreamPortMeta {
  serial: string
  sessionId: string
}
