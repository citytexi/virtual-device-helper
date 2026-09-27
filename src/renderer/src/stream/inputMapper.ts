import type { ControlIntent, DeviceKey, VideoPoint } from '../../../shared/types/stream'

export interface Rect {
  left: number
  top: number
  width: number
  height: number
}

export interface VideoSize {
  width: number
  height: number
}

/** 픽셀 단위 휠 한 칸의 크기. 대부분의 마우스가 한 칸에 100px 안팎을 보낸다. */
const PIXELS_PER_NOTCH = 100
const LINES_PER_NOTCH = 3
const SCROLL_LIMIT = 16

/**
 * 요소 안의 클라이언트 좌표를 비디오 좌표로 바꾼다. 캔버스는 CSS object-fit: contain으로
 * 그려지므로 요소 크기와 그림 크기가 다르다. 같은 배율과 여백을 여기서 다시 계산한다.
 * 여백을 누르면 null이다. clamp면 여백 쪽 좌표를 프레임 가장자리로 붙인다 — 드래그가
 * 밖에서 끝나도 up을 보내야 기기에 터치가 눌린 채 남지 않는다.
 */
export function toVideoPoint(
  clientX: number,
  clientY: number,
  rect: Rect,
  video: VideoSize,
  opts: { clamp?: boolean } = {}
): VideoPoint | null {
  if (video.width <= 0 || video.height <= 0 || rect.width <= 0 || rect.height <= 0) return null

  const scale = Math.min(rect.width / video.width, rect.height / video.height)
  const offsetX = (rect.width - video.width * scale) / 2
  const offsetY = (rect.height - video.height * scale) / 2
  let x = Math.floor((clientX - rect.left - offsetX) / scale)
  let y = Math.floor((clientY - rect.top - offsetY) / scale)

  const inside = x >= 0 && y >= 0 && x < video.width && y < video.height
  if (!inside) {
    if (!opts.clamp) return null
    x = Math.min(Math.max(x, 0), video.width - 1)
    y = Math.min(Math.max(y, 0), video.height - 1)
  }
  return { x, y, width: video.width, height: video.height }
}

function clampScroll(value: number): number {
  return Math.max(-SCROLL_LIMIT, Math.min(SCROLL_LIMIT, value))
}

/**
 * 브라우저 휠 delta를 Android 스크롤 축 값으로 바꾼다. 브라우저 deltaY는 아래가 양수이고
 * Android AXIS_VSCROLL은 위가 양수라 세로만 부호를 뒤집는다.
 */
export function wheelToScroll(deltaX: number, deltaY: number, deltaMode: number): { hScroll: number; vScroll: number } | null {
  const unit = deltaMode === 1 ? LINES_PER_NOTCH : deltaMode === 2 ? 1 : PIXELS_PER_NOTCH
  const hScroll = clampScroll(deltaX / unit)
  const vScroll = clampScroll(-deltaY / unit)
  if (hScroll === 0 && vScroll === 0) return null
  // -0이 섞이면 테스트 비교와 직렬화가 헷갈린다.
  return { hScroll: hScroll + 0, vScroll: vScroll + 0 }
}

export interface KeyInput {
  key: string
  isComposing: boolean
  ctrlKey: boolean
  metaKey: boolean
  altKey: boolean
  shiftKey: boolean
}

const NAMED_KEYS: ReadonlyMap<string, DeviceKey> = new Map([
  ['Enter', 'enter'],
  ['Backspace', 'backspace'],
  ['Delete', 'forward_delete'],
  ['Tab', 'tab'],
  ['Escape', 'escape'],
  ['ArrowUp', 'up'],
  ['ArrowDown', 'down'],
  ['ArrowLeft', 'left'],
  ['ArrowRight', 'right']
])

/**
 * 캔버스에 포커스가 있을 때의 키 입력을 의도로 바꾼다. 수정자 키가 눌린 조합은 호스트
 * 단축키로 남겨 둔다. IME 조합 중인 키와 ASCII 밖의 문자는 보내지 않는다(스펙 범위).
 */
export function keyToIntent(event: KeyInput): ControlIntent | null {
  if (event.isComposing) return null
  if (event.metaKey || event.ctrlKey || event.altKey) return null
  // Shift+Tab은 브라우저 포커스를 캔버스 밖으로 내보내야 한다(WCAG 2.1.2 키보드 트랩 금지).
  // intent 없이 그냥 통과시켜 DeviceScreen이 preventDefault를 하지 않게 한다.
  if (event.key === 'Tab' && event.shiftKey) return null

  const named = NAMED_KEYS.get(event.key)
  if (named) return { type: 'key', key: named }

  if (event.key.length === 1) {
    const code = event.key.charCodeAt(0)
    if (code >= 0x20 && code <= 0x7e) return { type: 'text', text: event.key }
  }
  return null
}
