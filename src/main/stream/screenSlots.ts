import { MAX_SCREEN_SLOTS } from '../../shared/limits'
import type { ScreenSlot, SlotRef } from '../../shared/types/ipc'
import type { SessionPortMeta, StreamPortMeta } from '../../shared/types/stream'
import type { StreamManager } from './streamManager'

/** 칸에 기기를 놓게 된 까닭. */
export type PlaceReason = 'connected' | 'selected' | 'vacated'

/** 지금 각 칸에 놓인 기기. 칸 목록 순서대로다. */
export type Occupancy = ReadonlyArray<{ slotId: string; serial: string | null }>

/**
 * serial을 놓을 칸의 id. 놓지 않으려면 null.
 * - connected: 기기가 붙었다. 보통 빈 칸일 때만 칸을 준다.
 * - selected: 사람이나 MCP가 골랐다. 반드시 칸을 준다(이전 기기는 내려간다).
 * - vacated: 어느 칸이 비었다. 그 칸으로 갈 기기면 그 칸의 id를 준다.
 * 조정자는 이 함수 밖에서 칸 id의 뜻을 읽지 않는다.
 */
export type PlaceFn = (serial: string, occupancy: Occupancy, reason: PlaceReason) => string | null

export interface ScreenSlotsDeps {
  slotIds: string[] // 순서가 곧 화면 순서
  place: PlaceFn
  /** 칸에 놓인 기기를 사람이 읽는 이름. 조립 지점이 정한다. */
  labelOf(serial: string): string
  createManager(slotId: string): StreamManager
  onChange(screens: ScreenSlot[]): void
}

export interface ScreenSlots {
  handleConnect(serial: string): void
  handleDisconnect(serial: string): void
  /** 골랐다. place(…, 'selected')가 준 칸에 놓는다. */
  select(serial: string): void
  /** 칸과 세대가 지금과 같을 때만 그 칸의 관리자로 연다. 낡은 요청은 조용히 무시한다. */
  open(ref: SlotRef): Promise<void>
  stop(ref: SlotRef): Promise<void>
  /**
   * 관리자가 내놓은 포트에 칸과 세대를 붙인다. 그 칸에 지금 놓인 기기가 meta.serial이 아니면 null —
   * 호출자는 그 포트를 닫는다.
   */
  tagPort(slotId: string, meta: SessionPortMeta): StreamPortMeta | null
  screens(): ScreenSlot[]
  closeAll(): Promise<void>
}

interface Slot extends ScreenSlot {
  manager: StreamManager
}

export function createScreenSlots(deps: ScreenSlotsDeps): ScreenSlots {
  if (deps.slotIds.length > MAX_SCREEN_SLOTS) {
    throw new Error(`화면 칸은 ${MAX_SCREEN_SLOTS}개를 넘을 수 없다`)
  }
  if (new Set(deps.slotIds).size !== deps.slotIds.length) {
    throw new Error('화면 칸 id가 겹친다')
  }

  const slots: Slot[] = deps.slotIds.map((id) => ({
    id,
    epoch: 0,
    serial: null,
    label: '',
    manager: deps.createManager(id)
  }))
  /** 붙어 있는 기기. 연결 순서다. */
  const connected: string[] = []

  const find = (id: string): Slot | undefined => slots.find((s) => s.id === id)
  const slotShowing = (serial: string): Slot | undefined => slots.find((s) => s.serial === serial)
  const occupancy = (): Occupancy => slots.map((s) => ({ slotId: s.id, serial: s.serial }))
  const snapshot = (): ScreenSlot[] =>
    slots.map(({ id, epoch, serial, label }) => ({ id, epoch, serial, label }))

  function logStopFailure(error: unknown): void {
    console.error('화면 칸의 스트림을 닫지 못했다', error)
  }

  /** 칸의 기기를 바꾸는 유일한 길. 상태와 onChange가 먼저고 stop은 그 뒤에 기다리지 않고 부른다. */
  function commit(changes: Array<{ slot: Slot; serial: string | null }>): void {
    for (const { slot, serial } of changes) {
      slot.serial = serial
      slot.label = serial === null ? '' : deps.labelOf(serial)
      slot.epoch += 1
    }
    if (changes.length === 0) return
    deps.onChange(snapshot())
    for (const { slot } of changes) {
      void slot.manager.stop().catch(logStopFailure)
    }
  }

  /**
   * 비는 칸을 채울 기기. 붙어 있지만 어느 칸에도 없는 기기를 연결 순서대로 보고, place가 그 칸을 주는
   * 첫 기기를 고른다. 없으면 null(비운다). occ는 변화가 끝난 뒤의 배치다.
   */
  function successorFor(slot: Slot, occ: Occupancy): string | null {
    const shown = new Set(occ.map((o) => o.serial))
    for (const serial of connected) {
      if (shown.has(serial)) continue
      if (deps.place(serial, occ, 'vacated') === slot.id) return serial
    }
    return null
  }

  return {
    handleConnect(serial) {
      if (connected.includes(serial)) return
      connected.push(serial)
      const target = find(deps.place(serial, occupancy(), 'connected') ?? '')
      if (target) commit([{ slot: target, serial }])
    },

    handleDisconnect(serial) {
      const index = connected.indexOf(serial)
      if (index === -1) return
      connected.splice(index, 1)
      const vacated = slotShowing(serial)
      if (!vacated) return
      const occ = occupancy().map((o) => (o.slotId === vacated.id ? { ...o, serial: null } : o))
      commit([{ slot: vacated, serial: successorFor(vacated, occ) }])
    },

    select(serial) {
      if (!connected.includes(serial)) return
      const target = find(deps.place(serial, occupancy(), 'selected') ?? '')
      if (!target || target.serial === serial) return
      const changes: Array<{ slot: Slot; serial: string | null }> = []
      const from = slotShowing(serial)
      if (from) {
        // 옮겨 갈 기기는 새 칸에 있고 떠난 칸은 비어 있다고 보고 승계를 묻는다.
        const occ = occupancy().map((o) =>
          o.slotId === from.id ? { ...o, serial: null } : o.slotId === target.id ? { ...o, serial } : o
        )
        changes.push({ slot: from, serial: successorFor(from, occ) })
      }
      changes.push({ slot: target, serial })
      commit(changes)
    },

    async open(ref) {
      const slot = find(ref.slotId)
      if (!slot || slot.epoch !== ref.epoch || slot.serial === null) return
      await slot.manager.open(slot.serial)
    },

    async stop(ref) {
      const slot = find(ref.slotId)
      if (!slot || slot.epoch !== ref.epoch || slot.serial === null) return
      await slot.manager.stop()
    },

    tagPort(slotId, meta) {
      const slot = find(slotId)
      if (!slot || slot.serial !== meta.serial) return null
      return { ...meta, slotId, epoch: slot.epoch }
    },

    screens: snapshot,

    async closeAll() {
      const results = await Promise.allSettled(slots.map((s) => s.manager.stop()))
      for (const r of results) {
        if (r.status === 'rejected') logStopFailure(r.reason)
      }
    }
  }
}
