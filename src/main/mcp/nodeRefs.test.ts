import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createNodeRefs, formatRef, STALE_REF_HINT } from './nodeRefs'
import type { Device, DisplayFrame, NormalizedRect, UiDump, UiNode } from '../../shared/types/device'

type FakeDevice = Device & { dumpUi: ReturnType<typeof vi.fn> }

function fakeDevice(serial: string): FakeDevice {
  return { serial, dumpUi: vi.fn() } as unknown as FakeDevice
}

let nextIndex = 0

function node(partial: Partial<UiNode> = {}): UiNode {
  return {
    index: nextIndex++,
    parentIndex: null,
    text: null,
    contentDesc: null,
    resourceId: null,
    className: 'View',
    bounds: { x: 0, y: 0, w: 0.1, h: 0.1 },
    clickable: false,
    enabled: true,
    focused: false,
    scrollable: false,
    ...partial
  }
}

function rectAt(x: number, y: number): NormalizedRect {
  return { x, y, w: 0, h: 0 }
}

function dump(nodes: UiNode[], frame: DisplayFrame = { width: 1080, height: 2400 }): UiDump {
  return { nodes, frame }
}

// 로그인 버튼. index 0으로 고정해서 "index 0" 같은 리터럴 값을 쓰는 테스트가 안정적이게 한다.
const login = node({ className: 'Button', resourceId: 'login', text: '로그인' })
const moved: NormalizedRect = { x: 0.2, y: 0.4, w: 0.6, h: 0.08 }

describe('nodeRefs', () => {
  let deviceA: FakeDevice
  let deviceB: FakeDevice

  beforeEach(() => {
    deviceA = fakeDevice('emulator-5554')
    deviceB = fakeDevice('emulator-5556')
  })

  it('numbers generations globally across devices', () => {
    const refs = createNodeRefs()
    const a = refs.remember(deviceA, dump([login]))
    const b = refs.remember(deviceB, dump([login]))
    expect(b).toBe(a + 1)
  })

  it('resolves to the fresh bounds of the same node', async () => {
    const refs = createNodeRefs()
    const gen = refs.remember(deviceA, dump([login]))
    deviceA.dumpUi.mockResolvedValueOnce(dump([{ ...login, bounds: moved }]))
    const { node } = await refs.resolve(deviceA, formatRef(gen, login.index))
    expect(node.bounds).toEqual(moved)
  })

  it('rejects a ref taken from another device', async () => {
    const refs = createNodeRefs()
    const gen = refs.remember(deviceA, dump([login]))
    await expect(refs.resolve(deviceB, formatRef(gen, 0))).rejects.toMatchObject({
      toolError: { kind: 'stale_ref', hint: STALE_REF_HINT }
    })
    expect(deviceB.dumpUi).not.toHaveBeenCalled()
  })

  it('rejects a ref taken before the device reconnected', async () => {
    const refs = createNodeRefs()
    const gen = refs.remember(deviceA, dump([login]))
    const deviceA2 = fakeDevice(deviceA.serial)
    await expect(refs.resolve(deviceA2, formatRef(gen, login.index))).rejects.toMatchObject({
      toolError: { kind: 'stale_ref', hint: STALE_REF_HINT }
    })
    expect(deviceA2.dumpUi).not.toHaveBeenCalled()
  })

  it('forgets generations older than keep', async () => {
    const refs = createNodeRefs({ keep: 2 })
    const gen1 = refs.remember(deviceA, dump([login]))
    refs.remember(deviceA, dump([login]))
    refs.remember(deviceA, dump([login]))
    await expect(refs.resolve(deviceA, formatRef(gen1, login.index))).rejects.toMatchObject({
      toolError: { kind: 'stale_ref', hint: STALE_REF_HINT }
    })
    expect(deviceA.dumpUi).not.toHaveBeenCalled()
  })

  it('defaults keep to 8 generations: the 9th remember evicts the 1st, the 8th-oldest still resolves', async () => {
    const refs = createNodeRefs()
    const gen1 = refs.remember(deviceA, dump([login])) // 1번째 remember
    let gen8 = gen1
    for (let i = 0; i < 7; i++) {
      gen8 = refs.remember(deviceA, dump([login])) // 2~8번째 remember
    }
    // gen1..gen8 8세대가 쌓였다. gen8은 8번째(최신)다.
    refs.remember(deviceA, dump([login])) // 9번째 remember, gen1을 창 밖으로 민다

    await expect(refs.resolve(deviceA, formatRef(gen1, login.index))).rejects.toMatchObject({
      toolError: { kind: 'stale_ref', hint: STALE_REF_HINT }
    })

    deviceA.dumpUi.mockResolvedValueOnce(dump([login]))
    await expect(refs.resolve(deviceA, formatRef(gen8, login.index))).resolves.toBeTruthy()
  })

  it('rejects a malformed ref without dumping', async () => {
    const refs = createNodeRefs()
    refs.remember(deviceA, dump([login]))
    for (const bad of ['login', 'g1', 'gX:1']) {
      await expect(refs.resolve(deviceA, bad)).rejects.toMatchObject({
        toolError: { kind: 'stale_ref', hint: STALE_REF_HINT }
      })
    }
    expect(deviceA.dumpUi).not.toHaveBeenCalled()
  })

  it('rejects when the fingerprint is gone', async () => {
    const refs = createNodeRefs()
    const gen = refs.remember(deviceA, dump([login]))
    deviceA.dumpUi.mockResolvedValueOnce(dump([]))
    await expect(refs.resolve(deviceA, formatRef(gen, login.index))).rejects.toMatchObject({
      toolError: { kind: 'stale_ref', hint: STALE_REF_HINT }
    })
  })

  it('ignores text on EditText so a typed field still resolves', async () => {
    const refs = createNodeRefs()
    const field = node({ className: 'EditText', resourceId: 'email', text: '이메일' })
    const gen = refs.remember(deviceA, dump([field]))
    deviceA.dumpUi.mockResolvedValueOnce(dump([{ ...field, text: 'a@b.c' }]))
    await expect(refs.resolve(deviceA, formatRef(gen, field.index))).resolves.toBeTruthy()
  })

  it('treats changed text on a non-EditText node as a different node', async () => {
    const refs = createNodeRefs()
    const label = node({ className: 'TextView', resourceId: 'title', text: '환영합니다' })
    const gen = refs.remember(deviceA, dump([label]))
    deviceA.dumpUi.mockResolvedValueOnce(dump([{ ...label, text: '안녕하세요' }]))
    await expect(refs.resolve(deviceA, formatRef(gen, label.index))).rejects.toMatchObject({
      toolError: { kind: 'stale_ref', hint: STALE_REF_HINT }
    })
  })

  it('includes the ancestor chain in the fingerprint', async () => {
    const refs = createNodeRefs()
    const parentA = node({ className: 'LinearLayout', resourceId: 'cardA' })
    const button = node({ parentIndex: parentA.index, className: 'Button', resourceId: 'action', text: '확인' })
    const gen = refs.remember(deviceA, dump([parentA, button]))

    const parentB = node({ index: parentA.index, className: 'LinearLayout', resourceId: 'cardB' })
    const movedButton = node({ index: button.index, parentIndex: parentA.index, className: 'Button', resourceId: 'action', text: '확인' })
    deviceA.dumpUi.mockResolvedValueOnce(dump([parentB, movedButton]))

    await expect(refs.resolve(deviceA, formatRef(gen, button.index))).rejects.toMatchObject({
      toolError: { kind: 'stale_ref', hint: STALE_REF_HINT }
    })
  })

  it('picks the same ordinal among duplicates when count and nearest agree', async () => {
    const refs = createNodeRefs()
    const icons = [0.1, 0.3, 0.5].map((y) => node({ className: 'ImageView', resourceId: 'icon', bounds: rectAt(0.5, y) }))
    const gen = refs.remember(deviceA, dump(icons))
    const target = icons[1] as (typeof icons)[number]

    const movedIcons = icons.map((icon) => ({ ...icon, bounds: rectAt(0.5, icon.bounds.y + 0.01) }))
    deviceA.dumpUi.mockResolvedValueOnce(dump(movedIcons))

    const { node: resolved } = await refs.resolve(deviceA, formatRef(gen, target.index))
    expect(resolved.bounds).toEqual(rectAt(0.5, 0.31))
  })

  it('rejects duplicates when their count changed', async () => {
    const refs = createNodeRefs()
    const icons = [0.1, 0.3, 0.5].map((y) => node({ className: 'ImageView', resourceId: 'icon', bounds: rectAt(0.5, y) }))
    const gen = refs.remember(deviceA, dump(icons))
    const target = icons[1] as (typeof icons)[number]

    const moreIcons = [0.1, 0.3, 0.5, 0.7].map((y) => node({ className: 'ImageView', resourceId: 'icon', bounds: rectAt(0.5, y) }))
    deviceA.dumpUi.mockResolvedValueOnce(dump(moreIcons))

    await expect(refs.resolve(deviceA, formatRef(gen, target.index))).rejects.toMatchObject({
      toolError: { kind: 'stale_ref', hint: STALE_REF_HINT }
    })
  })

  it('rejects duplicates when the ordinal pick is not the nearest to the old bounds', async () => {
    const refs = createNodeRefs()
    const icons = [0.1, 0.3, 0.5].map((y) => node({ className: 'ImageView', resourceId: 'icon', bounds: rectAt(0.5, y) }))
    const gen = refs.remember(deviceA, dump(icons))
    const target = icons[1] as (typeof icons)[number] // y = 0.3

    // 한 행 높이(0.2)만큼 스크롤. 옛 세 번째(y=0.5)가 옛 두 번째 자리(y=0.3)로 온다.
    const scrolled = icons.map((icon) => ({ ...icon, bounds: rectAt(0.5, icon.bounds.y - 0.2) }))
    deviceA.dumpUi.mockResolvedValueOnce(dump(scrolled))

    await expect(refs.resolve(deviceA, formatRef(gen, target.index))).rejects.toMatchObject({
      toolError: { kind: 'stale_ref', hint: STALE_REF_HINT }
    })
  })

  it('does not create a generation when revalidating', async () => {
    const refs = createNodeRefs()
    const gen = refs.remember(deviceA, dump([login]))
    deviceA.dumpUi.mockResolvedValueOnce(dump([login]))
    await refs.resolve(deviceA, formatRef(gen, 0))
    expect(refs.remember(deviceA, dump([login]))).toBe(gen + 1)
  })
})
