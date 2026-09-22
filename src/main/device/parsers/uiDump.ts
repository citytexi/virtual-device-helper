import { XMLParser } from 'fast-xml-parser'
import type { UiNode } from '../../../shared/types/device'

export interface ParseUiDumpOpts {
  screenWidth: number
  screenHeight: number
  /** text·content-desc·resource-id에 대한 대소문자 무시 부분일치. */
  query?: string
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
export function parseUiDump(xml: string, opts: ParseUiDumpOpts): UiNode[] {
  const parser = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: '' })
  const document = parser.parse(xml) as { hierarchy?: RawNode }

  const raw: RawNode[] = []
  flatten(document.hierarchy?.node, raw)

  const query = opts.query?.toLowerCase()
  const result: UiNode[] = []

  for (const candidate of raw) {
    const match = BOUNDS.exec((candidate.bounds ?? '').trim())
    if (!match) continue

    const left = Number(match[1])
    const top = Number(match[2])
    const right = Number(match[3])
    const bottom = Number(match[4])

    // 크기가 없는 노드는 사람에게도 에이전트에게도 보이지 않는다.
    if (right - left <= 0 || bottom - top <= 0) continue

    const x = Math.round((left + right) / 2)
    const y = Math.round((top + bottom) / 2)

    // 중심이 화면 밖이면 탭할 수 없다.
    if (x < 0 || y < 0 || x > opts.screenWidth || y > opts.screenHeight) continue

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
