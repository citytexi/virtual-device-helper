import { beforeEach, describe, expect, it, vi, type Mock } from 'vitest'
import type { ScreenSlot } from '../../shared/types/ipc'
import type { StreamManager } from './streamManager'
import { createScreenSlots, type PlaceFn } from './screenSlots'

interface FakeManager extends StreamManager {
  open: Mock<(serial: string) => Promise<void>>
  stop: Mock<() => Promise<void>>
}

function fakeManager(): FakeManager {
  return {
    open: vi.fn<(serial: string) => Promise<void>>(async () => {}),
    stop: vi.fn<() => Promise<void>>(async () => {})
  }
}

const place: PlaceFn = (serial, occupancy, reason) => {
  const id = serial.startsWith('A') ? 'a' : serial.startsWith('I') ? 'b' : null
  if (id === null) return null
  if (reason === 'connected' && occupancy.find((o) => o.slotId === id)?.serial) return null
  return id
}

function setup(overrides: { place?: PlaceFn; slotIds?: string[] } = {}) {
  const managers: Record<string, FakeManager> = {}
  const onChange = vi.fn<(screens: ScreenSlot[]) => void>()
  const slots = createScreenSlots({
    slotIds: overrides.slotIds ?? ['a', 'b'],
    place: overrides.place ?? place,
    labelOf: (serial) => `L-${serial}`,
    createManager: (id) => (managers[id] = fakeManager()),
    onChange
  })
  return { slots, managers: managers as Record<'a' | 'b', FakeManager>, onChange }
}

const slotOf = (slots: ReturnType<typeof createScreenSlots>, id: string) =>
  slots.screens().find((s) => s.id === id)

describe('createScreenSlots', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
  })

  it('칸마다 관리자를 한 번 만든다', () => {
    const createManager = vi.fn(() => fakeManager())
    createScreenSlots({ slotIds: ['a', 'b'], place, labelOf: String, createManager, onChange: vi.fn() })
    expect(createManager.mock.calls).toEqual([['a'], ['b']])
  })

  it('칸이 상한을 넘거나 id가 겹치면 던진다', () => {
    expect(() => setup({ slotIds: ['a', 'b', 'c'] })).toThrow()
    expect(() => setup({ slotIds: ['a', 'a'] })).toThrow()
  })

  it('handleConnect는 칸에 놓고, 찬 칸이면 놓지 않는다', () => {
    const { slots, onChange } = setup()
    slots.handleConnect('A1')
    expect(slots.screens()).toEqual([
      { id: 'a', epoch: 1, serial: 'A1', label: 'L-A1' },
      { id: 'b', epoch: 0, serial: null, label: '' }
    ])
    expect(onChange).toHaveBeenCalledTimes(1)
    slots.handleConnect('A2')
    expect(slotOf(slots, 'a')?.serial).toBe('A1')
    expect(onChange).toHaveBeenCalledTimes(1)
  })

  it('select·handleDisconnect는 세대를 올리고 승계는 빈 칸을 거치지 않는다', () => {
    const { slots, managers, onChange } = setup()
    slots.handleConnect('A1')
    slots.handleConnect('A2')
    onChange.mockClear()
    managers.a.stop.mockClear()

    slots.select('A2')
    expect(slotOf(slots, 'a')).toMatchObject({ serial: 'A2', epoch: 2 })
    expect(managers.a.stop).toHaveBeenCalledTimes(1)
    expect(onChange).toHaveBeenCalledTimes(1)
    slots.select('A2')
    expect(slotOf(slots, 'a')?.epoch).toBe(2)
    expect(onChange).toHaveBeenCalledTimes(1)

    slots.handleDisconnect('A2')
    expect(slotOf(slots, 'a')).toMatchObject({ serial: 'A1', epoch: 3, label: 'L-A1' })
    expect(onChange).toHaveBeenCalledTimes(2)
    expect(managers.a.stop).toHaveBeenCalledTimes(2)

    slots.handleDisconnect('A1')
    expect(slotOf(slots, 'a')).toMatchObject({ serial: null, epoch: 4, label: '' })
  })

  it('같은 serial을 다시 연결하면 세대가 또 오른다', () => {
    const { slots } = setup()
    slots.handleConnect('A1')
    slots.handleDisconnect('A1')
    slots.handleConnect('A1')
    expect(slotOf(slots, 'a')?.epoch).toBe(3)
  })

  it('select A1·A2·A1은 매번 다른 세대다', () => {
    const { slots } = setup()
    slots.handleConnect('A1')
    slots.handleConnect('A2')
    const epochs = [] as number[]
    for (const s of ['A1', 'A2', 'A1']) {
      slots.select(s)
      epochs.push(slotOf(slots, 'a')!.epoch)
    }
    expect(new Set(epochs).size).toBe(3)
  })

  it('select는 다른 칸에 보이던 기기를 승계 규칙으로 채운 뒤 옮긴다', () => {
    // 'X'는 b, 그 밖은 a. 고르면 A1은 b로 간다. connected는 찬 칸이면 놓지 않는다.
    const p: PlaceFn = (serial, occ, reason) => {
      const home = serial.startsWith('X') ? 'b' : 'a'
      if (reason === 'selected' && serial === 'A1') return 'b'
      if (reason === 'connected' && occ.find((o) => o.slotId === home)?.serial) return null
      return home
    }
    const { slots, managers, onChange } = setup({ place: p })
    slots.handleConnect('A1')
    slots.handleConnect('X1')
    slots.handleConnect('A2')
    expect(slots.screens().map((s) => s.serial)).toEqual(['A1', 'X1'])
    managers.a.stop.mockClear()
    managers.b.stop.mockClear()
    onChange.mockClear()
    slots.select('A1')
    expect(slots.screens().map((s) => s.serial)).toEqual(['A2', 'A1'])
    expect(onChange).toHaveBeenCalledTimes(1)
    expect(managers.a.stop).toHaveBeenCalledTimes(1)
    expect(managers.b.stop).toHaveBeenCalledTimes(1)
  })

  it('stop이 끝나지 않아도 onChange가 먼저 불리고 새 세대의 open이 바로 간다', () => {
    const { slots, managers, onChange } = setup()
    slots.handleConnect('A1')
    slots.handleConnect('A2')
    onChange.mockClear()
    managers.a.stop.mockImplementation(() => {
      expect(onChange).toHaveBeenCalledTimes(1) // 호출될 때 onChange는 이미 불려 있다
      return new Promise(() => {})
    })
    slots.select('A2')
    onChange.mockClear()
    slots.handleDisconnect('A2')
    expect(onChange).toHaveBeenCalledTimes(1)
    const s = slotOf(slots, 'a')!
    void slots.open({ slotId: 'a', epoch: s.epoch })
    expect(managers.a.open).toHaveBeenCalledWith('A1')
  })

  it('낡은 세대·빈 칸·모르는 칸의 open/stop은 아무것도 하지 않고 resolve한다', async () => {
    const { slots, managers } = setup()
    slots.handleConnect('A1')
    slots.handleDisconnect('A1')
    managers.a.stop.mockClear()
    await slots.open({ slotId: 'a', epoch: 1 })
    await slots.stop({ slotId: 'a', epoch: 1 })
    await slots.open({ slotId: 'a', epoch: 2 }) // 빈 칸
    await slots.stop({ slotId: 'a', epoch: 2 })
    await slots.open({ slotId: 'zz', epoch: 0 })
    await slots.stop({ slotId: 'zz', epoch: 0 })
    expect(managers.a.open).not.toHaveBeenCalled()
    expect(managers.a.stop).not.toHaveBeenCalled()
    expect(managers.b.open).not.toHaveBeenCalled()
  })

  it('맞는 세대의 open·stop은 그 칸 관리자로 간다. 실패해도 다른 칸은 건드리지 않는다', async () => {
    const { slots, managers } = setup()
    slots.handleConnect('A1')
    slots.handleConnect('I1')
    managers.a.open.mockRejectedValue(new Error('boom'))
    await expect(slots.open({ slotId: 'a', epoch: 1 })).rejects.toThrow('boom')
    expect(managers.b.open).not.toHaveBeenCalled()
    await slots.open({ slotId: 'b', epoch: 1 })
    expect(managers.b.open).toHaveBeenCalledWith('I1')
    managers.b.stop.mockClear()
    await slots.stop({ slotId: 'b', epoch: 1 })
    expect(managers.b.stop).toHaveBeenCalledTimes(1)
  })

  it('진행 중인 open 도중의 select는 칸과 세대를 바꾸고 stop을 부른다', () => {
    const { slots, managers } = setup()
    slots.handleConnect('A1')
    slots.handleConnect('A2')
    managers.a.open.mockImplementation(() => new Promise(() => {}))
    void slots.open({ slotId: 'a', epoch: 1 })
    managers.a.stop.mockClear()
    slots.select('A2')
    expect(slotOf(slots, 'a')).toMatchObject({ serial: 'A2', epoch: 2 })
    expect(managers.a.stop).toHaveBeenCalledTimes(1)
  })

  it('tagPort는 지금 놓인 기기일 때만 세대를 붙인다', () => {
    const { slots } = setup()
    slots.handleConnect('A1')
    expect(slots.tagPort('a', { serial: 'A1', sessionId: 's' })).toEqual({
      serial: 'A1',
      sessionId: 's',
      slotId: 'a',
      epoch: 1
    })
    expect(slots.tagPort('a', { serial: 'A9', sessionId: 's' })).toBeNull()
    expect(slots.tagPort('zz', { serial: 'A1', sessionId: 's' })).toBeNull()
  })

  it('stop이 reject해도 closeAll은 resolve하고 나머지 stop이 불린다', async () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {})
    const { slots, managers } = setup()
    managers.a.stop.mockRejectedValue(new Error('x'))
    await expect(slots.closeAll()).resolves.toBeUndefined()
    expect(managers.b.stop).toHaveBeenCalledTimes(1)
    expect(err).toHaveBeenCalled()
  })

  it('칸 교체 중 stop이 reject해도 console.error로 남긴다', async () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {})
    const { slots, managers } = setup()
    slots.handleConnect('A1')
    managers.a.stop.mockRejectedValue(new Error('x'))
    slots.handleDisconnect('A1')
    await Promise.resolve()
    await Promise.resolve()
    expect(err).toHaveBeenCalled()
  })

  it('place가 null이나 모르는 칸 id를 주면 놓지 않고, 모르는·붙지 않은 serial은 무시한다', () => {
    const { slots, onChange } = setup({ place: (s) => (s === 'Q' ? 'nope' : null) })
    slots.handleConnect('Z1')
    slots.handleConnect('Q')
    slots.select('Z1')
    expect(slots.screens().every((s) => s.serial === null && s.epoch === 0)).toBe(true)
    slots.select('never-connected')
    slots.handleDisconnect('never-connected')
    slots.handleConnect('Z1')
    expect(onChange).not.toHaveBeenCalled()
  })

  it('중복 handleConnect는 무시한다: 끊은 뒤 유령 후보가 남지 않는다', () => {
    const { slots, onChange } = setup()
    slots.handleConnect('A1')
    slots.handleConnect('A1')
    expect(onChange).toHaveBeenCalledTimes(1)
    slots.handleDisconnect('A1')
    expect(slotOf(slots, 'a')).toMatchObject({ serial: null, epoch: 2 })
  })

  it('붙어 있지 않은 serial의 select는 무시한다', () => {
    const { slots, onChange } = setup()
    slots.select('A1')
    expect(slotOf(slots, 'a')?.serial).toBeNull()
    expect(onChange).not.toHaveBeenCalled()
  })
})
