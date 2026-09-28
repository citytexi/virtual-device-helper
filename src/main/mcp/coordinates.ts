import type { DisplayFrame, NormalizedRect } from '../../shared/types/device'

export type Direction = 'up' | 'down' | 'left' | 'right'

export interface NormalizedPoint {
  x: number
  y: number
}

export const REF_SWIPE_INSET = 0.1
export const DEFAULT_SWIPE_MS = 300

/**
 * 소수 4자리로 반올림한다.
 */
function round4(v: number): number {
  return Math.round(v * 10000) / 10000
}

/**
 * 정규화 좌표를 기기 픽셀로 변환한다.
 * 화면의 먼 끝(1.0)은 size - 1 픽셀이 된다.
 */
export function toPixel(point: NormalizedPoint, frame: DisplayFrame): { x: number; y: number } {
  return {
    x: Math.min(Math.round(point.x * frame.width), frame.width - 1),
    y: Math.min(Math.round(point.y * frame.height), frame.height - 1)
  }
}

/**
 * 사각형의 중심을 반환한다.
 * 결과는 소수 4자리로 반올림한다.
 */
export function centerOf(rect: NormalizedRect): NormalizedPoint {
  return {
    x: round4(rect.x + rect.w / 2),
    y: round4(rect.y + rect.h / 2)
  }
}

/**
 * 사각형 안의 스와이프 궤적을 반환한다.
 * 궤적은 방향 축에서 rect 양 끝을 REF_SWIPE_INSET * 길이만큼 안으로 당긴 두 점이다.
 * 다른 축은 중심을 사용한다.
 * 모든 결과는 소수 4자리로 반올림한다.
 *
 * direction이 나타내는 것은 스크롤 방향이다:
 * - 'down': 콘텐츠를 아래로 스크롤하려면 손가락은 위로 움직인다
 * - 'up': 콘텐츠를 위로 스크롤하려면 손가락은 아래로 움직인다
 * - 'right': 콘텐츠를 오른쪽으로 스크롤하려면 손가락은 왼쪽으로 움직인다
 * - 'left': 콘텐츠를 왼쪽으로 스크롤하려면 손가락은 오른쪽으로 움직인다
 */
export function swipeWithin(rect: NormalizedRect, direction: Direction): { from: NormalizedPoint; to: NormalizedPoint } {
  const center = centerOf(rect)
  const top = rect.y
  const bottom = rect.y + rect.h
  const left = rect.x
  const right = rect.x + rect.w

  const verticalInset = rect.h * REF_SWIPE_INSET
  const horizontalInset = rect.w * REF_SWIPE_INSET

  const innerTop = round4(top + verticalInset)
  const innerBottom = round4(bottom - verticalInset)
  const innerLeft = round4(left + horizontalInset)
  const innerRight = round4(right - horizontalInset)

  switch (direction) {
    case 'down':
      // 손가락이 아래에서 위로 움직인다 (콘텐츠는 아래로 스크롤)
      return {
        from: { x: center.x, y: innerBottom },
        to: { x: center.x, y: innerTop }
      }
    case 'up':
      // 손가락이 위에서 아래로 움직인다 (콘텐츠는 위로 스크롤)
      return {
        from: { x: center.x, y: innerTop },
        to: { x: center.x, y: innerBottom }
      }
    case 'right':
      // 손가락이 오른쪽에서 왼쪽으로 움직인다 (콘텐츠는 오른쪽으로 스크롤)
      return {
        from: { x: innerRight, y: center.y },
        to: { x: innerLeft, y: center.y }
      }
    case 'left':
      // 손가락이 왼쪽에서 오른쪽으로 움직인다 (콘텐츠는 왼쪽으로 스크롤)
      return {
        from: { x: innerLeft, y: center.y },
        to: { x: innerRight, y: center.y }
      }
  }
}
