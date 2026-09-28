import { XMLParser } from 'fast-xml-parser'
import type { DisplayFrame, NormalizedRect, UiDump, UiNode } from '../../../shared/types/device'
import { deviceError } from '../../../shared/types/errors'

interface Rect {
  left: number
  top: number
  right: number
  bottom: number
}

interface RawNode {
  text?: string
  'resource-id'?: string
  'content-desc'?: string
  class?: string
  clickable?: string | boolean
  enabled?: string | boolean
  focused?: string | boolean
  scrollable?: string | boolean
  bounds?: string
  node?: RawNode | RawNode[]
}

const BOUNDS = /^\[(-?\d+),(-?\d+)\]\[(-?\d+),(-?\d+)\]$/

function parseBounds(value: string | undefined): Rect | null {
  const match = BOUNDS.exec((value ?? '').trim())
  if (!match) return null

  return {
    left: Number(match[1]),
    top: Number(match[2]),
    right: Number(match[3]),
    bottom: Number(match[4])
  }
}

/**
 * 덤프 시점의 실제 화면 사각형. 최상위 노드(들)의 bounds를 합친 것이다.
 *
 * `wm size`(자연 방향 크기)를 쓰지 않는 이유는 uiautomator dump가 활성 창 하나만
 * 덤프하기 때문이다. 다이얼로그가 떠 있으면 루트 bounds가 다이얼로그 사각형이
 * 되고, 가로 화면에서는 자연 방향 크기를 넘어선다. 이 사각형은 "중심이 화면
 * 밖인 노드 빼기" 판정에만 쓴다 — 정규화 기준은 별도의 `frame`(디스플레이 전체
 * 크기)이다.
 */
function screenRect(roots: RawNode | RawNode[] | undefined): Rect | null {
  const list = roots === undefined ? [] : Array.isArray(roots) ? roots : [roots]
  let rect: Rect | null = null

  for (const root of list) {
    const bounds = parseBounds(root.bounds)
    if (!bounds) continue
    rect = rect
      ? {
          left: Math.min(rect.left, bounds.left),
          top: Math.min(rect.top, bounds.top),
          right: Math.max(rect.right, bounds.right),
          bottom: Math.max(rect.bottom, bounds.bottom)
        }
      : bounds
  }

  return rect
}

function emptyToNull(value: string | undefined): string | null {
  const trimmed = (value ?? '').trim()
  return trimmed === '' ? null : trimmed
}

function shortClassName(value: string | undefined): string {
  const full = (value ?? '').trim()
  const lastDot = full.lastIndexOf('.')
  return lastDot === -1 ? full : full.slice(lastDot + 1)
}

function resourceIdTail(value: string | undefined): string | null {
  const full = emptyToNull(value)
  if (!full) return null
  const marker = full.indexOf('/')
  return marker === -1 ? full : full.slice(marker + 1)
}

function toBool(value: string | boolean | undefined): boolean {
  return value === true || value === 'true'
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max)
}

function round4(value: number): number {
  return Math.round(value * 10000) / 10000
}

/**
 * 픽셀 사각형을 `frame`(디스플레이 전체 크기) 기준 0..1 사각형으로 바꾼다. 먼저
 * `[0, frame]`에 clamp해서 화면을 넘어가는 변이 1을 넘지 않게 한다.
 */
function normalize(bounds: Rect, frame: DisplayFrame): NormalizedRect {
  const left = clamp(bounds.left, 0, frame.width)
  const right = clamp(bounds.right, 0, frame.width)
  const top = clamp(bounds.top, 0, frame.height)
  const bottom = clamp(bounds.bottom, 0, frame.height)

  return {
    x: round4(left / frame.width),
    y: round4(top / frame.height),
    w: round4((right - left) / frame.width),
    h: round4((bottom - top) / frame.height)
  }
}

const ROTATION_HINT = '화면 전환이나 애니메이션이 끝난 뒤 다시 불러라'

/** `<hierarchy rotation="N">`의 N을 읽는다. 없거나 0~3이 아니면 0으로 추측하지 않고 던진다. */
function parseRotation(value: unknown): 0 | 1 | 2 | 3 {
  // `rotation=""`처럼 빈 문자열이면 Number("") === 0이라 그냥 두면 0으로 오인한다.
  // 공백뿐인 값도 같은 이유로 거절한다.
  if (typeof value === 'string' && value.trim() === '') {
    throw deviceError('command_failed', 'UI 덤프에서 화면 회전을 읽지 못했다', ROTATION_HINT, {
      rotation: value
    })
  }
  const n = Number(value)
  if (!Number.isInteger(n) || n < 0 || n > 3) {
    throw deviceError('command_failed', 'UI 덤프에서 화면 회전을 읽지 못했다', ROTATION_HINT, {
      rotation: value
    })
  }
  return n as 0 | 1 | 2 | 3
}

/**
 * 조상 스택(남은 노드 중 가장 가까운 것의 index)을 넘겨받는 재귀. 이름도 없고
 * 클릭도 스크롤도 안 되는 노드는 버리지만, 그 자식은 버리지 않는다 — 버려진
 * 노드의 자식은 그 위 조상을 부모로 삼는다.
 */
function collect(
  node: RawNode | RawNode[] | undefined,
  parentIndex: number | null,
  screen: Rect | null,
  frame: DisplayFrame,
  into: UiNode[]
): void {
  if (!node) return
  if (Array.isArray(node)) {
    for (const child of node) collect(child, parentIndex, screen, frame, into)
    return
  }

  let keptIndex = parentIndex
  const bounds = parseBounds(node.bounds)

  if (bounds && bounds.right - bounds.left > 0 && bounds.bottom - bounds.top > 0) {
    const cx = (bounds.left + bounds.right) / 2
    const cy = (bounds.top + bounds.bottom) / 2
    // 중심이 화면 밖이면 탭할 수 없다.
    const onScreen = !screen || (cx >= screen.left && cx <= screen.right && cy >= screen.top && cy <= screen.bottom)

    if (onScreen) {
      const text = emptyToNull(node.text)
      const contentDesc = emptyToNull(node['content-desc'])
      const resourceId = resourceIdTail(node['resource-id'])
      const clickable = toBool(node.clickable)
      const scrollable = toBool(node.scrollable)

      // 이름도 없고 누를 수도 스크롤할 수도 없는 노드는 레이아웃 컨테이너다.
      // 에이전트가 쓸 일이 없다.
      if (text || contentDesc || resourceId || clickable || scrollable) {
        keptIndex = into.length
        into.push({
          index: keptIndex,
          parentIndex,
          text,
          contentDesc,
          resourceId,
          className: shortClassName(node.class),
          bounds: normalize(bounds, frame),
          clickable,
          enabled: toBool(node.enabled),
          focused: toBool(node.focused),
          scrollable
        })
      }
    }
  }

  collect(node.node, keptIndex, screen, frame, into)
}

/**
 * uiautomator 덤프를 요소 배열로 요약한다.
 * 원본 XML은 이 함수 밖으로 나가지 않는다 — 화면 하나가 수만 토큰이라
 * 에이전트에게 그대로 줄 수 없다.
 *
 * `natural`은 `wm size`의 자연 방향 크기다. 회전이 90°·270°면 가로·세로를 바꿔
 * 정규화 기준 `frame`으로 쓴다. 거르기(query)는 이 함수의 일이 아니다 — 여기서
 * 거르면 dense index와 ref 의미가 어긋난다.
 */
export function parseUiDump(xml: string, natural: DisplayFrame): UiDump {
  const parser = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: '' })
  const document = parser.parse(xml) as { hierarchy?: RawNode & { rotation?: string } }

  const rotation = parseRotation(document.hierarchy?.rotation)
  const frame: DisplayFrame =
    rotation === 1 || rotation === 3
      ? { width: natural.height, height: natural.width }
      : { width: natural.width, height: natural.height }

  const roots = document.hierarchy?.node
  // 루트 bounds를 못 읽으면 화면 밖 판정만 건너뛴다. 판정 기준이 없다고 해서
  // 멀쩡한 노드를 통째로 버리는 쪽이 더 나쁘다.
  const screen = screenRect(roots)

  const nodes: UiNode[] = []
  collect(roots, null, screen, frame, nodes)

  return { nodes, frame }
}
