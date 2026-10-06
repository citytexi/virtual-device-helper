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
import type { SessionInfo } from './streamSession'

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
})
