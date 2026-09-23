import { XMLParser } from 'fast-xml-parser'
import type { UiNode } from '../../../shared/types/device'

export interface ParseUiDumpOpts {
  /** text·content-desc·resource-id에 대한 대소문자 무시 부분일치. */
  query?: string
}

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
 * `wm size`를 쓰지 않는 이유는 그 값이 회전과 무관하게 자연 방향 크기를 말하기
 * 때문이다. 가로 화면에서는 덤프의 x가 자연 방향 너비를 훌쩍 넘어서, 그 값으로
 * 화면 밖 판정을 하면 거의 모든 노드가 조용히 사라진다. 덤프 자신이 답을 들고 있다.
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

function flatten(node: RawNode | RawNode[] | undefined, into: RawNode[]): void {
  if (!node) return
  if (Array.isArray(node)) {
    for (const child of node) flatten(child, into)
    return
  }
  into.push(node)
  flatten(node.node, into)
}

/**
 * uiautomator 덤프를 요소 배열로 요약한다.
 * 원본 XML은 이 함수 밖으로 나가지 않는다 — 화면 하나가 수만 토큰이라
 * 에이전트에게 그대로 줄 수 없다.
 */
export function parseUiDump(xml: string, opts: ParseUiDumpOpts = {}): UiNode[] {
  const parser = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: '' })
  const document = parser.parse(xml) as { hierarchy?: RawNode }

  const roots = document.hierarchy?.node
  // 루트 bounds를 못 읽으면 화면 밖 판정만 건너뛴다. 판정 기준이 없다고 해서
  // 멀쩡한 노드를 통째로 버리는 쪽이 더 나쁘다.
  const screen = screenRect(roots)

  const raw: RawNode[] = []
  flatten(roots, raw)

  const query = opts.query?.toLowerCase()
  const result: UiNode[] = []

  for (const candidate of raw) {
    const bounds = parseBounds(candidate.bounds)
    if (!bounds) continue

    // 크기가 없는 노드는 사람에게도 에이전트에게도 보이지 않는다.
    if (bounds.right - bounds.left <= 0 || bounds.bottom - bounds.top <= 0) continue

    const x = Math.round((bounds.left + bounds.right) / 2)
    const y = Math.round((bounds.top + bounds.bottom) / 2)

    // 중심이 화면 밖이면 탭할 수 없다.
    if (screen && (x < screen.left || x > screen.right || y < screen.top || y > screen.bottom)) {
      continue
    }

    const text = emptyToNull(candidate.text)
    const contentDesc = emptyToNull(candidate['content-desc'])
    const resourceId = resourceIdTail(candidate['resource-id'])
    const clickable = candidate.clickable === true || candidate.clickable === 'true'

    // 이름도 없고 누를 수도 없는 노드는 레이아웃 컨테이너다. 에이전트가 쓸 일이 없다.
    if (!text && !contentDesc && !resourceId && !clickable) continue

    if (query) {
      const haystack = `${text ?? ''}\n${contentDesc ?? ''}\n${resourceId ?? ''}`.toLowerCase()
      if (!haystack.includes(query)) continue
    }

    result.push({
      index: result.length,
      text,
      contentDesc,
      resourceId,
      className: shortClassName(candidate.class),
      x,
      y,
      clickable
    })
  }

  return result
}
