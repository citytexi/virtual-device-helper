import { execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { afterEach, describe, expect, it } from 'vitest'
import type { StreamDown, SessionPortMeta } from '../../shared/types/stream'
import { createAdbClient } from '../adb/adbClient'
import { parseDevices } from '../device/parsers/devices'
import { createAxeClient } from '../ios/axeClient'
import { locateAxe } from '../ios/locateAxe'
import { defaultLocateSdkDeps, locateSdk } from '../sdk/locateSdk'
import { createAxeStreamSession } from './axeStreamSession'
import { resolveScrcpyJar } from './scrcpyJar'
import { connectLoopback, createScrcpySession } from './scrcpySession'
import { createScreenSlots, type ScreenSlots } from './screenSlots'
import { createStreamManager, type PortLike } from './streamManager'

/** 부팅된 첫 시뮬레이터의 UDID. xcrun이 없거나 부팅된 기기가 없으면 null이다. */
function firstBootedUdid(): string | null {
  try {
    const out = execFileSync('xcrun', ['simctl', 'list', 'devices', 'booted', '-j'], { encoding: 'utf8' })
    const parsed = JSON.parse(out) as { devices: Record<string, Array<{ udid: string; state: string }>> }
    for (const list of Object.values(parsed.devices)) {
      const hit = list.find((d) => d.state === 'Booted')
      if (hit) return hit.udid
    }
  } catch {
    // xcrun 없음 등
  }
  return null
}

function whichAxe(): string | null {
  try {
    return execFileSync('which', ['axe'], { encoding: 'utf8' }).trim() || null
  } catch {
    return null
  }
}

const located = locateSdk(defaultLocateSdkDeps())
const adb = located.ok ? createAdbClient(located.paths.adb) : null
const androidSerial: string | null = located.ok
  ? (() => {
      try {
        const out = execFileSync(located.paths.adb, ['devices'], { encoding: 'utf8' })
        return parseDevices(out).find((d) => d.state === 'device')?.serial ?? null
      } catch {
        return null
      }
    })()
  : null
const udid = firstBootedUdid()
const axePath = await locateAxe({ fileExists: existsSync, which: async () => whichAxe() })
const iosSerial = axePath === null ? null : udid
const jarPath = resolveScrcpyJar({ isPackaged: false, resourcesPath: '', appPath: process.cwd() })

/** 이 테스트의 칸 배정. 칸 id의 뜻은 여기 조립 지점에만 있다. */
const SLOT_OF: Record<string, string> = {}

interface FakePort extends PortLike {
  messages: StreamDown[]
  closed: boolean
  /** 조건을 만족하는 메시지가 count개 쌓일 때까지 기다린다. 쌓이는 즉시 푼다. */
  waitFor(match: (m: StreamDown) => boolean, count: number, timeoutMs?: number): Promise<number>
  count(match: (m: StreamDown) => boolean): number
}

function fakePort(): FakePort {
  const waiters: Array<{ match: (m: StreamDown) => boolean; count: number; resolve: (at: number) => void }> = []
  let upListener: ((event: { data: unknown }) => void) | null = null
  const port: FakePort = {
    messages: [],
    closed: false,
    postMessage(message) {
      port.messages.push(message)
      // jpeg는 확인을 올려야 다음 장이 온다. 받는 대로 확인한다.
      if (message.type === 'frame') queueMicrotask(() => upListener?.({ data: { type: 'frame_ack' } }))
      for (const w of [...waiters]) {
        if (port.count(w.match) >= w.count) {
          waiters.splice(waiters.indexOf(w), 1)
          w.resolve(Date.now())
        }
      }
    },
    on(event: string, listener: unknown) {
      if (event === 'message') upListener = listener as (event: { data: unknown }) => void
    },
    start() {},
    close() {
      port.closed = true
    },
    count: (match) => port.messages.filter(match).length,
    waitFor(match, count, timeoutMs = 30_000) {
      if (port.count(match) >= count) return Promise.resolve(Date.now())
      return new Promise<number>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`메시지 ${count}개를 기다리다 시간이 지났다 (받은 것 ${port.count(match)}개)`)), timeoutMs)
        waiters.push({
          match,
          count,
          resolve: (at) => {
            clearTimeout(timer)
            resolve(at)
          }
        })
      })
    }
  }
  return port
}

const isSession = (m: StreamDown): boolean => m.type === 'session'
const isMedia = (m: StreamDown): boolean => m.type === 'frame' || m.type === 'packet'

interface Rig {
  slots: ScreenSlots
  /** 칸이 열어 내놓은 포트. 칸 id → 포트 목록(연 순서). */
  ports: Map<string, FakePort[]>
  /** 조정자가 포트를 받아들였는지(tagPort가 null이 아닌지)를 센 값. */
  tagged: Array<{ slotId: string; epoch: number } | null>
  cleanup(): Promise<void>
}

/** 실제 createStreamManager와 createScreenSlots를 조립한다. 포트만 가짜다. */
function assemble(devices: Array<{ serial: string; slotId: string; kind: 'android' | 'ios' }>): Rig {
  const kinds = new Map(devices.map((d) => [d.serial, d.kind]))
  for (const d of devices) SLOT_OF[d.serial] = d.slotId
  const ports = new Map<string, FakePort[]>()
  const tagged: Rig['tagged'] = []
  const axe = axePath ? createAxeClient(axePath) : null
  const control = { send() {}, close() {} }

  const slots: ScreenSlots = createScreenSlots({
    slotIds: ['a', 'b'],
    place: (serial) => SLOT_OF[serial] ?? null,
    labelOf: (serial) => serial,
    onChange: () => {},
    createManager: (slotId) =>
      createStreamManager({
        createSession: (serial, handlers) => {
          if (kinds.get(serial) === 'android') {
            return createScrcpySession({ serial, adb: adb!, jarPath, connect: connectLoopback }, handlers)
          }
          return createAxeStreamSession({ udid: serial, axe: axe!, control }, handlers)
        },
        createChannel: () => {
          const local = fakePort()
          ports.set(slotId, [...(ports.get(slotId) ?? []), local])
          return { local, remote: {} }
        },
        postPort: (meta: SessionPortMeta) => {
          const tag = slots.tagPort(slotId, meta)
          tagged.push(tag ? { slotId: tag.slotId, epoch: tag.epoch } : null)
        },
        isConnected: (serial) => kinds.has(serial)
      })
  })
  return { slots, ports, tagged, cleanup: () => slots.closeAll() }
}

let rig: Rig | null = null
afterEach(async () => {
  await rig?.cleanup()
  rig = null
})

const lastPort = (r: Rig, slotId: string): FakePort => {
  const list = r.ports.get(slotId) ?? []
  const port = list[list.length - 1]
  if (!port) throw new Error(`칸 ${slotId}에 열린 포트가 없다`)
  return port
}

/** 한 기기를 칸 a에 놓는다. 있는 기기를 고른다. */
const single = ((): { serial: string; kind: 'android' | 'ios' } | null =>
  androidSerial ? { serial: androidSerial, kind: 'android' } : iosSerial ? { serial: iosSerial, kind: 'ios' } : null)()

describe.skipIf(single === null)('화면 칸 (기기 하나)', () => {
  it('그 칸을 열면 포트가 session과 프레임을 받는다', async () => {
    const { serial, kind } = single!
    rig = assemble([{ serial, slotId: 'a', kind }])
    rig.slots.handleConnect(serial)
    const [slot] = rig.slots.screens()
    expect(slot).toMatchObject({ id: 'a', serial, epoch: 1 })

    await rig.slots.open({ slotId: 'a', epoch: slot!.epoch })
    const port = lastPort(rig, 'a')
    await port.waitFor(isSession, 1, 30_000)
    await port.waitFor(isMedia, 1, 30_000)
    expect(rig.tagged).toEqual([{ slotId: 'a', epoch: 1 }])
    expect(port.messages.find(isSession)).toMatchObject({ type: 'session', codec: kind === 'android' ? 'h264' : 'jpeg' })
  })

  it('낡은 세대의 open은 아무 포트도 내놓지 않는다', async () => {
    const { serial, kind } = single!
    rig = assemble([{ serial, slotId: 'a', kind }])
    rig.slots.handleConnect(serial) // epoch 1
    await rig.slots.open({ slotId: 'a', epoch: 0 })
    await rig.slots.open({ slotId: 'a', epoch: 2 })
    expect(rig.ports.get('a') ?? []).toEqual([])
    expect(rig.tagged).toEqual([])
  })
})

describe.skipIf(androidSerial === null || iosSerial === null)('화면 칸 (Android와 iOS 둘)', () => {
  const both = (): Rig => {
    const r = assemble([
      { serial: androidSerial!, slotId: 'a', kind: 'android' },
      { serial: iosSerial!, slotId: 'b', kind: 'ios' }
    ])
    r.slots.handleConnect(androidSerial!)
    r.slots.handleConnect(iosSerial!)
    return r
  }

  /** Android는 화면이 바뀔 때만 패킷이 오므로, 재는 동안 화면을 계속 흔든다. */
  function shakeAndroid(): () => void {
    let stop = false
    void (async () => {
      let i = 0
      while (!stop) {
        i += 1
        const y = i % 2 === 0 ? 1600 : 800
        await adb!.exec(androidSerial!, ['shell', 'input', 'swipe', '540', String(y), '540', String(2400 - y), '80']).catch(() => {})
      }
    })()
    return () => {
      stop = true
    }
  }

  it('두 칸을 함께 열면 둘 다 받고, 한 칸을 stop해도 다른 칸은 계속 받는다', async () => {
    rig = both()
    const [a, b] = rig.slots.screens()
    expect([a!.serial, b!.serial]).toEqual([androidSerial, iosSerial])

    await Promise.all([rig.slots.open({ slotId: 'a', epoch: a!.epoch }), rig.slots.open({ slotId: 'b', epoch: b!.epoch })])
    const portA = lastPort(rig, 'a')
    const portB = lastPort(rig, 'b')
    const stopShaking = shakeAndroid()
    try {
      await Promise.all([portA.waitFor(isMedia, 3, 30_000), portB.waitFor(isMedia, 3, 30_000)])
      expect(portA.messages.find(isSession)).toMatchObject({ codec: 'h264' })
      expect(portB.messages.find(isSession)).toMatchObject({ codec: 'jpeg' })

      // fps: 각 칸이 같은 시점부터 N장을 받는 데 걸린 시간.
      const N = 20
      const startA = portA.count(isMedia)
      const startB = portB.count(isMedia)
      const t0 = Date.now()
      const [endA, endB] = await Promise.all([
        portA.waitFor(isMedia, startA + N, 60_000),
        portB.waitFor(isMedia, startB + N, 60_000)
      ])
      console.info(
        `[화면 칸 둘] Android(h264 packet) ${N}개 ${endA - t0}ms (${((N * 1000) / (endA - t0)).toFixed(1)}/s, 화면을 흔드는 동안), ` +
          `iOS(jpeg frame) ${N}장 ${endB - t0}ms (${((N * 1000) / (endB - t0)).toFixed(1)}fps)`
      )

      // 한 칸을 stop한다. 다른 칸은 계속 온다.
      await rig.slots.stop({ slotId: 'a', epoch: a!.epoch })
      expect(portA.closed).toBe(true)
      const before = portB.count(isMedia)
      await portB.waitFor(isMedia, before + 5, 30_000)
      expect(portB.closed).toBe(false)
    } finally {
      stopShaking()
    }
  })
})
