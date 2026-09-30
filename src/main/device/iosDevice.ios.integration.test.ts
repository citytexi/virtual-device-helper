import { execFileSync } from 'node:child_process'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createSimctlClient } from '../ios/simctlClient'
import { createIosDevice } from './iosDevice'
import { DEFAULT_MAX_LONG_EDGE } from './androidDevice'
import type { Device } from '../../shared/types/device'

const SETTINGS = 'com.apple.Preferences'

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

/** PNG 헤더(IHDR)에서 크기를 읽는다. 디코드 가능한 PNG인지의 최소 확인이다. */
function pngSize(png: Buffer): { width: number; height: number } {
  const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
  expect(png.subarray(0, 8).equals(signature)).toBe(true)
  return { width: png.readUInt32BE(16), height: png.readUInt32BE(20) }
}

function pad(n: number, w = 2): string {
  return String(n).padStart(w, '0')
}

/** LogLine.timestamp와 같은 `MM-DD HH:mm:ss.SSS` 로컬 형식. */
function localStamp(d: Date): string {
  return `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}.${pad(d.getMilliseconds(), 3)}`
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

const udid = firstBootedUdid()

describe.skipIf(udid === null)('IosDevice (실제 시뮬레이터)', () => {
  let device: Device

  beforeAll(() => {
    device = createIosDevice({
      udid: udid as string,
      simctl: createSimctlClient(),
      axe: null,
      // 스크린샷 축소는 Electron nativeImage가 필요하다. 크기만 헤더에서 읽어 비율로 돌려주는 대역이다.
      resizeImage: (png, maxLongEdge) => {
        const { width, height } = pngSize(png)
        const longEdge = Math.max(width, height)
        if (longEdge <= maxLongEdge) return { png, width, height }
        const ratio = maxLongEdge / longEdge
        return { png, width: Math.round(width * ratio), height: Math.round(height * ratio) }
      }
    })
  })

  afterAll(async () => {
    await device?.stop(SETTINGS).catch(() => {})
  })

  it('info().platform이 ios다', async () => {
    const info = await device.info()
    expect(info.platform).toBe('ios')
  })

  it('설정 앱을 띄우고 로그를 한 줄 이상 읽는다', async () => {
    await device.launch(SETTINGS)
    await sleep(1_000)
    const result = await device.readLogs({ limit: 50 })
    expect(result.lines.length).toBeGreaterThan(0)
  })

  it('스크린샷이 PNG로 디코드되고 긴 변이 기본 상한 이하다', async () => {
    const shot = await device.screenshot()
    const raw = Buffer.from(shot.base64, 'base64')
    const size = pngSize(raw)
    expect(size.width).toBeGreaterThan(0)
    expect(Math.max(shot.width, shot.height)).toBeLessThanOrEqual(DEFAULT_MAX_LONG_EDGE)
  })

  it('stop을 두 번 연속 불러도 성공한다', async () => {
    await device.launch(SETTINGS)
    await device.stop(SETTINGS)
    await expect(device.stop(SETTINGS)).resolves.toBeUndefined()
  })

  it('clearLogs 직후 readLogs에 그 이전 timestamp가 없다', async () => {
    await device.launch(SETTINGS)
    await sleep(1_000)
    const before = await device.readLogs({ limit: 50 })
    expect(before.lines.length).toBeGreaterThan(0)

    const clearedAt = new Date()
    await device.clearLogs()
    await device.stop(SETTINGS)
    await device.launch(SETTINGS)
    await sleep(1_000)

    const after = await device.readLogs({ limit: 500 })
    const floor = localStamp(clearedAt)
    expect(after.lines.filter((line) => line.timestamp < floor)).toEqual([])
  })

  it('설치돼 있지 않은 번들 ID를 launch하면 package_not_found로 거절한다', async () => {
    await expect(device.launch('com.example.definitely.not.installed')).rejects.toMatchObject({
      toolError: { kind: 'package_not_found' }
    })
  })

  it('NSPredicate 특수문자(%, ", \\)가 든 filter도 거절되지 않는다', async () => {
    await expect(device.readLogs({ filter: '100%', limit: 5 })).resolves.toBeDefined()
    await expect(device.readLogs({ filter: 'a"b\\c', limit: 5 })).resolves.toBeDefined()
  })
})
