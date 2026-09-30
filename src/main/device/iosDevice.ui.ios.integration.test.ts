import { execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createAxeClient } from '../ios/axeClient'
import { locateAxe } from '../ios/locateAxe'
import { createSimctlClient } from '../ios/simctlClient'
import { createIosDevice } from './iosDevice'
import type { Device, UiDump } from '../../shared/types/device'

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

/** 화면 비교용 지문. bounds는 스크롤로도 바뀌므로 뺀다. */
function signatureOf(dump: UiDump): string {
  return JSON.stringify(dump.nodes.map((n) => `${n.className}|${n.resourceId ?? ''}|${n.contentDesc ?? ''}|${n.text ?? ''}`))
}

const udid = firstBootedUdid()
const axePath = await locateAxe({ fileExists: existsSync, which: async () => whichAxe() })

describe.skipIf(udid === null || axePath === null)('IosDevice 입력·노드 (실제 시뮬레이터)', () => {
  let device: Device

  beforeAll(async () => {
    device = createIosDevice({
      udid: udid as string,
      simctl: createSimctlClient(),
      axe: createAxeClient(axePath as string),
      resizeImage: (png) => ({ png, width: 1, height: 1 })
    })
    // 이전 상태(검색 화면 등)를 지우고 설정 첫 화면에서 시작한다.
    await device.stop(SETTINGS)
    await device.launch(SETTINGS)
    await sleep(2_000)
  })

  afterAll(async () => {
    await device?.stop(SETTINGS).catch(() => {})
  })

  it('설정의 clickable 셀을 탭하면 화면이 바뀌고 home으로 나간다', async () => {
    const before = await device.dumpUi()
    const frame = await device.displayFrame()
    expect(frame.width).toBeGreaterThan(0)
    expect(frame.height).toBeGreaterThan(0)

    // 검색 필드는 탭해도 화면 목록이 거의 그대로라 뺀다. 화면 안쪽에 온전히 보이는 셀을 고른다.
    const cell = before.nodes.find(
      (n) =>
        n.clickable &&
        n.enabled &&
        n.className !== 'TextField' &&
        n.className !== 'SearchField' &&
        !(n.text ?? '').includes('검색') &&
        !(n.contentDesc ?? '').includes('검색') &&
        n.bounds.y > 0.15 &&
        n.bounds.y + n.bounds.h < 0.9 &&
        n.bounds.h > 0.02
    )
    expect(cell, '탭할 clickable 셀이 있어야 한다').toBeDefined()
    const { x, y, w, h } = cell!.bounds

    await device.tap((x + w / 2) * frame.width, (y + h / 2) * frame.height)
    await sleep(1_000)

    const after = await device.dumpUi()
    expect(signatureOf(after)).not.toBe(signatureOf(before))

    await expect(device.pressKey('home')).resolves.toBeUndefined()
  })
})
