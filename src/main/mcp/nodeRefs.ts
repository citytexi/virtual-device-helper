import type { Device, DisplayFrame, UiDump, UiNode } from '../../shared/types/device'
import { deviceError, type DeviceError } from '../../shared/types/errors'
import { centerOf, type NormalizedPoint } from './coordinates'

/** `ui_find`가 낸 ref가 더는 못 쓰게 됐을 때 공통으로 쓰는 hint. */
export const STALE_REF_HINT = '`ui_find`를 다시 불러 새 ref를 받아라'

/** ref 형식: `g<세대>:<index>`. 세대·index 모두 음이 아닌 정수여야 한다. */
const REF_PATTERN = /^g(\d+):(\d+)$/

export interface NodeRefs {
  /** 덤프를 스냅샷으로 저장하고 세대를 붙인다. */
  remember(device: Device, dump: UiDump): number
  /** ref를 새 덤프 기준 노드로 푼다. 실패하면 stale_ref DeviceError를 던진다. */
  resolve(device: Device, ref: string): Promise<{ node: UiNode; frame: DisplayFrame }>
}

interface Snapshot {
  generation: number
  dump: UiDump
}

// 세대 번호는 프로세스 전역 단조 카운터다. createNodeRefs로 여러 인스턴스를 만들어도
// 모두 이 카운터를 공유한다 — 같은 세대 번호가 두 스냅샷에 붙는 일이 없게 한다.
let globalGeneration = 0

/** ref 문자열을 만든다. */
export function formatRef(generation: number, index: number): string {
  return `g${generation}:${index}`
}

function parseRef(ref: string): { generation: number; index: number } | null {
  const match = REF_PATTERN.exec(ref)
  if (!match) return null
  return { generation: Number(match[1]), index: Number(match[2]) }
}

/**
 * 노드 하나의 "자기 자신" 지문 부분: className·resourceId·contentDesc·text.
 * className이 EditText로 끝나면 text를 뺀다 — 입력하면 바뀌는 값이고, 빈 필드는
 * hint를 text로 내기도 해서 지문에 넣으면 타이핑만으로 ref가 죽는다.
 */
function ownFingerprint(node: UiNode): string {
  const includeText = !node.className.endsWith('EditText')
  const text = includeText ? (node.text ?? '') : ''
  return `${node.className}|${node.resourceId ?? ''}|${node.contentDesc ?? ''}|${text}`
}

function indexByNodeIndex(dump: UiDump): Map<number, UiNode> {
  const map = new Map<number, UiNode>()
  for (const n of dump.nodes) map.set(n.index, n)
  return map
}

/**
 * 노드 지문: 자기 자신 부분 뒤에 parentIndex를 따라 올라가며 모은 조상들의
 * className·resourceId를 붙인다. 조상의 text는 넣지 않는다.
 */
function fingerprintOf(node: UiNode, byIndex: Map<number, UiNode>): string {
  const parts = [ownFingerprint(node)]
  let parentIndex = node.parentIndex
  while (parentIndex !== null) {
    const parent = byIndex.get(parentIndex)
    if (!parent) break
    parts.push(`${parent.className}|${parent.resourceId ?? ''}`)
    parentIndex = parent.parentIndex
  }
  return parts.join('/')
}

function distance(a: NormalizedPoint, b: NormalizedPoint): number {
  return Math.hypot(a.x - b.x, a.y - b.y)
}

function staleRef(message: string, ref: string): DeviceError {
  return deviceError('stale_ref', message, STALE_REF_HINT, { ref })
}

export function createNodeRefs(opts?: { keep?: number }): NodeRefs {
  const keep = opts?.keep ?? 8
  const snapshotsByDevice = new WeakMap<Device, Snapshot[]>()

  function remember(device: Device, dump: UiDump): number {
    const generation = ++globalGeneration
    const list = snapshotsByDevice.get(device) ?? []
    list.push({ generation, dump })
    while (list.length > keep) list.shift()
    snapshotsByDevice.set(device, list)
    return generation
  }

  async function resolve(device: Device, ref: string): Promise<{ node: UiNode; frame: DisplayFrame }> {
    const parsed = parseRef(ref)
    if (!parsed) {
      throw staleRef(`ref 형식이 올바르지 않다: "${ref}"`, ref)
    }

    const snapshots = snapshotsByDevice.get(device)
    const snapshot = snapshots?.find((s) => s.generation === parsed.generation)
    if (!snapshot) {
      throw staleRef(`세대 ${parsed.generation}는 이 기기에서 유효하지 않다`, ref)
    }

    const oldNode = snapshot.dump.nodes.find((n) => n.index === parsed.index)
    if (!oldNode) {
      throw staleRef(`index ${parsed.index}는 세대 ${parsed.generation} 스냅샷에 없다`, ref)
    }

    // 재검증 덤프. 새 세대를 만들지 않는다.
    const newDump = await device.dumpUi()

    const oldByIndex = indexByNodeIndex(snapshot.dump)
    const newByIndex = indexByNodeIndex(newDump)
    const fingerprint = fingerprintOf(oldNode, oldByIndex)

    const oldCandidates = snapshot.dump.nodes.filter((n) => fingerprintOf(n, oldByIndex) === fingerprint)
    const newCandidates = newDump.nodes.filter((n) => fingerprintOf(n, newByIndex) === fingerprint)

    if (newCandidates.length === 0) {
      throw staleRef('지문이 같은 노드가 새 화면에 없다', ref)
    }

    if (newCandidates.length === 1) {
      return { node: newCandidates[0] as UiNode, frame: newDump.frame }
    }

    // 여럿이면 개수가 같고, 옛 순번으로 고른 노드가 옛 bounds에 가장 가까운 노드와 같을 때만 받아들인다.
    if (oldCandidates.length !== newCandidates.length) {
      throw staleRef('같은 지문 노드의 개수가 바뀌었다', ref)
    }

    const ordinal = oldCandidates.findIndex((n) => n.index === oldNode.index)
    const ordinalPick = newCandidates[ordinal]
    if (!ordinalPick) {
      throw staleRef('옛 순번에 해당하는 새 노드가 없다', ref)
    }

    const oldCenter = centerOf(oldNode.bounds)
    const nearest = newCandidates.reduce((closest, candidate) =>
      distance(centerOf(candidate.bounds), oldCenter) < distance(centerOf(closest.bounds), oldCenter) ? candidate : closest
    )

    if (ordinalPick !== nearest) {
      throw staleRef('순번으로 고른 노드와 가장 가까운 노드가 다르다', ref)
    }

    return { node: ordinalPick, frame: newDump.frame }
  }

  return { remember, resolve }
}

/**
 * MCP 세션마다 McpServer가 새로 생기므로 스냅샷은 이 모듈 기본 인스턴스에 둔다.
 * 이 인스턴스는 모든 MCP 세션이 공유한다 — 한 기기에 두 에이전트가 번갈아
 * `ui_find`를 부르면 서로의 ref를 8세대 창 밖으로 밀어낼 수 있다. 이 경우도
 * resolve는 stale_ref로 안전하게 실패한다.
 */
export const nodeRefs: NodeRefs = createNodeRefs()
