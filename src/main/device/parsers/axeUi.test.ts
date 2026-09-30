import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { parseAxeFrame, parseAxeUi } from './axeUi'

const raw = readFileSync(join(__dirname, '__fixtures__', 'ios', 'describe-ui-settings.json'), 'utf8')

interface AxNode {
  type: string
  frame: { x: number; y: number; width: number; height: number }
  children?: AxNode[]
  [key: string]: unknown
}

function fixture(): AxNode[] {
  return JSON.parse(raw) as AxNode[]
}

describe('parseAxeUi (describe-ui-settings.json)', () => {
  const dump = parseAxeUi(raw)

  it('frame은 루트 Application의 크기(point)다', () => {
    expect(dump.frame).toEqual({ width: 402, height: 874 })
    expect(parseAxeFrame(raw)).toEqual({ width: 402, height: 874 })
  })

  it('셀 하나가 clickable과 0..1 bounds로 나온다', () => {
    const general = dump.nodes.find((n) => n.resourceId === 'com.apple.settings.general')
    expect(general).toBeDefined()
    expect(general).toMatchObject({
      className: 'Button',
      contentDesc: '일반',
      text: null,
      clickable: true,
      enabled: true,
      focused: false,
      scrollable: false,
      editable: false
    })
    expect(general!.bounds).toEqual({
      x: Math.round((16 / 402) * 10000) / 10000,
      y: Math.round((380.66666666666663 / 874) * 10000) / 10000,
      w: Math.round((370 / 402) * 10000) / 10000,
      h: Math.round((52.33333333333333 / 874) * 10000) / 10000
    })
    for (const value of Object.values(general!.bounds)) {
      expect(value).toBeGreaterThanOrEqual(0)
      expect(value).toBeLessThanOrEqual(1)
    }
  })

  it('StaticText는 text를 AXLabel에서 읽는다', () => {
    const title = dump.nodes.find((n) => n.className === 'StaticText' && n.text === 'Apple 계정')
    expect(title).toBeDefined()
    expect(title!.contentDesc).toBe('Apple 계정')
  })

  it('모든 노드의 parentIndex는 자기보다 작은 index거나 null이고 index는 dense하다', () => {
    expect(dump.nodes.length).toBeGreaterThan(0)
    dump.nodes.forEach((node, i) => {
      expect(node.index).toBe(i)
      if (node.parentIndex !== null) expect(node.parentIndex).toBeLessThan(node.index)
    })
  })

  it('TextField는 editable이고 AXValue를 text로 둔다', () => {
    const field = dump.nodes.find((n) => n.className === 'TextField')
    expect(field).toMatchObject({ editable: true, text: '검색', contentDesc: null })
  })

  it('이름도 동작도 없는 Group은 버린다', () => {
    expect(dump.nodes.some((n) => n.className === 'Group' && !n.text && !n.contentDesc && !n.resourceId && !n.clickable && !n.scrollable)).toBe(false)
  })

  it('루트 자식이 빈 배열이면 nodes는 []다', () => {
    const tree = fixture()
    tree[0]!.children = []
    expect(parseAxeUi(JSON.stringify(tree))).toEqual({ nodes: [], frame: { width: 402, height: 874 } })
  })

  it('중심이 frame 밖인 노드는 빠진다', () => {
    const tree = fixture()
    const offscreen: AxNode = {
      type: 'Button',
      AXLabel: '화면 밖',
      AXUniqueId: 'offscreen',
      AXValue: null,
      enabled: true,
      frame: { x: 16, y: 900, width: 100, height: 40 }
    }
    tree[0]!.children = [...(tree[0]!.children ?? []), offscreen]
    const withExtra = parseAxeUi(JSON.stringify(tree))
    expect(withExtra.nodes.some((n) => n.resourceId === 'offscreen')).toBe(false)
    expect(withExtra.nodes).toEqual(dump.nodes)
  })

  it('버려진 노드의 자식은 가장 가까운 남은 조상에 붙는다', () => {
    const tree: AxNode[] = [
      {
        type: 'Application',
        frame: { x: 0, y: 0, width: 100, height: 200 },
        children: [
          {
            type: 'Group',
            frame: { x: 0, y: 0, width: 100, height: 200 },
            children: [{ type: 'Button', AXLabel: '확인', frame: { x: 0, y: 0, width: 50, height: 50 } }]
          }
        ]
      }
    ]
    const result = parseAxeUi(JSON.stringify(tree))
    expect(result.nodes).toHaveLength(1)
    expect(result.nodes[0]).toMatchObject({ index: 0, parentIndex: null, contentDesc: '확인' })
  })
})

describe('parseAxeUi 오류', () => {
  it.each(['not json', '[]', '{}', '[{"type":"Group"}]'])('%s는 command_failed다', (input) => {
    expect(() => parseAxeUi(input)).toThrowError(
      expect.objectContaining({ toolError: expect.objectContaining({ kind: 'command_failed', message: 'describe-ui 출력을 읽지 못했다' }) })
    )
    expect(() => parseAxeFrame(input)).toThrowError(expect.objectContaining({ toolError: expect.objectContaining({ kind: 'command_failed' }) }))
  })
})
