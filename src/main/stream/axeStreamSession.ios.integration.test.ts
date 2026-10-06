import { execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { describe, expect, it, vi } from 'vitest'
import type { DeviceError } from '../../shared/types/errors'
import { createIosDevice } from '../device/iosDevice'
import { createAxeClient } from '../ios/axeClient'
import { locateAxe } from '../ios/locateAxe'
import { createSimctlClient } from '../ios/simctlClient'
import { createAxeControl } from './axeControl'
import { createAxeStreamSession } from './axeStreamSession'
import { createStreamManager, type PortLike } from './streamManager'
import type { SessionInfo, StreamSessionHandlers } from './streamSession'
import type { StreamDown } from '../../shared/types/stream'

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

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

const udid = firstBootedUdid()
const axePath = await locateAxe({ fileExists: existsSync, which: async () => whichAxe() })

describe.skipIf(udid === null || axePath === null)('AxeStreamSession (실제 시뮬레이터)', () => {
  it('jpeg 세션을 열어 프레임을 받고 탭을 보낸다', async () => {
    const axe = createAxeClient(axePath as string)
    const device = createIosDevice({
      udid: udid as string,
      simctl: createSimctlClient(),
      axe,
      resizeImage: (png) => ({ png, width: 1, height: 1 })
    })
    const infos: SessionInfo[] = []
    let frames = 0
    const onEnded = vi.fn()
    const controlErrors: DeviceError[] = []
    // 탭이 실제로 axe까지 갔는지 본다. sendControl은 결과를 돌려주지 않는다.
    const controlCalls: string[][] = []
    const control = createAxeControl({
      udid: udid as string,
      axe: {
        exec: (target, args, opts) => {
          controlCalls.push(args)
          return axe.exec(target, args, opts)
        },
        stream: axe.stream
      },
      displayFrame: () => device.displayFrame(),
      inputText: (text) => device.inputText(text),
      onError: (error) => controlErrors.push(error)
    })
    const session = createAxeStreamSession(
      { udid: udid as string, axe, control },
      { onSession: (info) => infos.push(info), onPacket: vi.fn(), onFrame: () => (frames += 1), onEnded }
    )

    try {
      const startedAt = Date.now()
      await session.start()
      const firstFrameMs = Date.now() - startedAt
      const countedFrom = frames
      await sleep(2_000)
      const inTwoSeconds = frames - countedFrom
      console.info(`[axe stream] 첫 프레임까지 ${firstFrameMs}ms, 그 뒤 2초 동안 ${inTwoSeconds}프레임`)

      expect(frames).toBeGreaterThanOrEqual(1)
      expect(infos[0]?.codec).toBe('jpeg')
      expect(infos[0]?.width).toBeGreaterThan(0)
      expect(infos[0]?.height).toBeGreaterThan(0)

      // 화면 한가운데를 탭한다. 무엇이 눌리는지는 보지 않고, 호출이 실패 없이 끝나는지만 본다.
      const { width, height } = infos[infos.length - 1]!
      const point = { x: Math.round(width / 2), y: Math.round(height / 2), width, height }
      session.sendControl({ type: 'touch', action: 'down', point })
      session.sendControl({ type: 'touch', action: 'up', point })
      await vi.waitFor(() => expect(controlCalls.some((args) => args[0] === 'tap')).toBe(true), { timeout: 15_000 })
      // 탭 호출이 끝나기를 기다린다. 실패하면 onError로 온다.
      await sleep(1_500)
      expect(controlErrors).toEqual([])
    } finally {
      await session.close()
    }
    expect(onEnded).not.toHaveBeenCalled()
  })

  it('확인을 올려야 다음 프레임이 포트로 가고, 기다리는 동안엔 최신 한 장만 든다', async () => {
    const axe = createAxeClient(axePath as string)
    const device = createIosDevice({
      udid: udid as string,
      simctl: createSimctlClient(),
      axe,
      resizeImage: (png) => ({ png, width: 1, height: 1 })
    })
    const control = { send() {}, close() {} }

    // 세션이 올린 장을 센다. 장 수를 기다리는 promise는 waiters로 푼다.
    const offered: Uint8Array[] = []
    const offerWaiters: Array<{ count: number; resolve: () => void }> = []
    const portFrames: Uint8Array[] = []
    const portWaiters: Array<{ count: number; resolve: () => void }> = []
    const resolveWaiters = (waiters: typeof offerWaiters, n: number): void => {
      for (const w of [...waiters]) {
        if (n >= w.count) {
          waiters.splice(waiters.indexOf(w), 1)
          w.resolve()
        }
      }
    }
    const offeredAtLeast = (count: number): Promise<void> =>
      offered.length >= count ? Promise.resolve() : new Promise((resolve) => offerWaiters.push({ count, resolve }))
    const portAtLeast = (count: number): Promise<void> =>
      portFrames.length >= count ? Promise.resolve() : new Promise((resolve) => portWaiters.push({ count, resolve }))

    let ackListener: ((event: { data: unknown }) => void) | null = null
    let autoAck = false
    const sendAck = (): void => ackListener?.({ data: { type: 'frame_ack' } })
    const port: PortLike = {
      postMessage(message: StreamDown) {
        if (message.type !== 'frame') return
        portFrames.push(message.data)
        resolveWaiters(portWaiters, portFrames.length)
        if (autoAck) queueMicrotask(sendAck)
      },
      on(event: string, listener: unknown) {
        if (event === 'message') ackListener = listener as (event: { data: unknown }) => void
      },
      start() {},
      close() {}
    }

    const manager = createStreamManager({
      createSession: (serial: string, handlers: StreamSessionHandlers) =>
        createAxeStreamSession(
          { udid: serial, axe, control },
          {
            ...handlers,
            onFrame: (jpeg) => {
              offered.push(jpeg)
              resolveWaiters(offerWaiters, offered.length)
              handlers.onFrame(jpeg)
            }
          }
        ),
      createChannel: () => ({ local: port, remote: {} }),
      postPort: () => {},
      isConnected: () => true
    })

    try {
      await manager.open(udid as string)

      // 1) 확인을 올리지 않는다. 세션이 여러 장 올려도 포트로는 한 장만 간다.
      await offeredAtLeast(5)
      await portAtLeast(1)
      const offeredWhileStopped = offered.length
      const portWhileStopped = portFrames.length
      expect(portWhileStopped).toBe(1)

      // 2) 푼다. 바로 오는 장은 확인 시점에 세션이 가장 나중에 올린 장이다.
      const newest = offered[offered.length - 1]!
      sendAck()
      await portAtLeast(2)
      const released = portFrames[1]!
      const releasedIsNewest = Buffer.from(released).equals(Buffer.from(newest))
      console.info(
        `[frame ack] 확인을 멈춘 동안 세션 ${offeredWhileStopped}장 / 포트 ${portWhileStopped}장, 풀었을 때 온 장이 가장 나중 장과 같은가: ${releasedIsNewest}`
      )
      expect(releasedIsNewest).toBe(true)

      // 3) 받는 대로 확인을 올린다. 포트가 여러 장을 받는다.
      autoAck = true
      const portBefore = portFrames.length
      const startedAt = Date.now()
      sendAck()
      await portAtLeast(portBefore + 10)
      const elapsedMs = Date.now() - startedAt
      const delivered = portFrames.length - portBefore
      console.info(`[frame ack] 받는 대로 확인: 포트 ${delivered}장 / ${elapsedMs}ms (${((delivered * 1000) / elapsedMs).toFixed(1)}fps)`)
      expect(delivered).toBeGreaterThanOrEqual(10)
    } finally {
      autoAck = false
      await manager.stop()
    }
  })
})
