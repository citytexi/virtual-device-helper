import type { DisplayFrame, UiDump, UiNode } from '../../../shared/types/device'
import { deviceError } from '../../../shared/types/errors'
import { centerOnScreen, emptyToNull, isMeaningful, normalize, type Rect } from './uiDump'

/** `axe describe-ui` 노드 하나. 없는 값은 null이고 키 순서는 일정하지 않다. */
interface AxeNode {
  type?: string | null
  AXLabel?: string | null
  AXValue?: string | null
  AXUniqueId?: string | null
  enabled?: boolean | null
  frame?: { x?: unknown; y?: unknown; width?: unknown; height?: unknown } | null
  children?: AxeNode[] | null
}

const CLICKABLE_TYPES = new Set(['Button', 'Link', 'Cell', 'Switch', 'TextField', 'SecureTextField', 'TextView'])
const SCROLLABLE_TYPES = new Set(['ScrollView', 'Table', 'CollectionView'])
const EDITABLE_TYPES = new Set(['TextField', 'SecureTextField', 'TextView'])

function parseFailure(): Error {
  return deviceError('command_failed', 'describe-ui 출력을 읽지 못했다', '시뮬레이터가 부팅됐는지 확인하고 다시 불러라')
}

/** 숫자 `frame`(point)을 사각형으로 읽는다. `AXFrame` 문자열은 파싱하지 않는다. */
function toRect(frame: AxeNode['frame']): Rect | null {
  if (!frame) return null
  const { x, y, width, height } = frame
  if (typeof x !== 'number' || typeof y !== 'number' || typeof width !== 'number' || typeof height !== 'number') return null
  if (![x, y, width, height].every(Number.isFinite)) return null
  return { left: x, top: y, right: x + width, bottom: y + height }
}

/** 최상위 배열의 첫 요소가 루트 Application이다. 크기를 못 읽으면 던진다. */
function parseRoot(json: string): { root: AxeNode; rect: Rect } {
  let parsed: unknown
  try {
    parsed = JSON.parse(json)
  } catch {
    throw parseFailure()
  }
  const root = Array.isArray(parsed) ? (parsed[0] as AxeNode | undefined) : undefined
  const rect = root && typeof root === 'object' ? toRect(root.frame) : null
  if (!root || !rect || rect.right - rect.left <= 0 || rect.bottom - rect.top <= 0) throw parseFailure()
  return { root, rect }
}

function toFrame(rect: Rect): DisplayFrame {
  return { width: rect.right - rect.left, height: rect.bottom - rect.top }
}

/**
 * 조상 index를 넘겨받는 재귀. `uiDump.ts`의 `collect`와 같은 규칙이다 — 버려진
 * 노드의 자식은 남은 가장 가까운 조상에 붙는다.
 */
function collect(node: AxeNode, parentIndex: number | null, screen: Rect, frame: DisplayFrame, into: UiNode[]): void {
  let keptIndex = parentIndex
  const bounds = toRect(node.frame)

  if (bounds && bounds.right - bounds.left > 0 && bounds.bottom - bounds.top > 0 && centerOnScreen(bounds, screen)) {
    const type = node.type ?? ''
    const label = emptyToNull(node.AXLabel ?? undefined)
    const value = emptyToNull(node.AXValue ?? undefined)
    const text = type === 'StaticText' ? label : value
    const resourceId = emptyToNull(node.AXUniqueId ?? undefined)
    const clickable = CLICKABLE_TYPES.has(type)
    const scrollable = SCROLLABLE_TYPES.has(type)

    if (isMeaningful([text, label, resourceId], clickable, scrollable)) {
      keptIndex = into.length
      into.push({
        index: keptIndex,
        parentIndex,
        text,
        contentDesc: label,
        resourceId,
        className: type,
        bounds: normalize(bounds, frame),
        clickable,
        enabled: node.enabled !== false,
        focused: false,
        scrollable,
        editable: EDITABLE_TYPES.has(type)
      })
    }
  }

  for (const child of node.children ?? []) collect(child, keptIndex, screen, frame, into)
}

/**
 * `axe describe-ui` JSON을 요소 배열로 요약한다. 최상위는 배열이고 첫 요소가
 * 루트 Application이다. `frame`(정규화 기준)은 그 루트의 크기(point)다.
 */
export function parseAxeUi(json: string): UiDump {
  const { root, rect } = parseRoot(json)
  const frame = toFrame(rect)
  const nodes: UiNode[] = []
  // 루트 Application은 화면 자체라 노드로 올리지 않는다. 자식부터 모은다.
  for (const child of root.children ?? []) collect(child, null, rect, frame, nodes)
  return { nodes, frame }
}

/** 화면 크기(point)만 필요할 때. `parseAxeUi`와 같은 루트 규칙이다. */
export function parseAxeFrame(json: string): DisplayFrame {
  return toFrame(parseRoot(json).rect)
}
