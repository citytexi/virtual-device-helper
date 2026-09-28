import { beforeAll, describe, expect, it } from 'vitest'
import { defaultLocateSdkDeps, locateSdk } from '../sdk/locateSdk'
import { parseDevices } from './parsers/devices'
import { createAdbClient, type AdbClient } from '../adb/adbClient'
import { createAndroidDevice } from './androidDevice'
import { createNodeRefs, formatRef } from '../mcp/nodeRefs'
import { centerOf, toPixel } from '../mcp/coordinates'
import type { Device, UiDump } from '../../shared/types/device'

const SETTINGS_PKG = 'com.android.settings'
const SETTINGS_COMPONENT = `${SETTINGS_PKG}/.Settings`

let adb: AdbClient
let serial: string
let device: Device

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/**
 * uiautomator dump는 화면 전환 애니메이션 중이면 "could not get idle state."로
 * 실패한다. 애니메이션이 끝날 때까지 잠깐씩 쉬며 다시 시도한다.
 */
async function dumpUiSettled(target: Device, timeoutMs = 8_000): Promise<UiDump> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    try {
      return await target.dumpUi()
    } catch (error) {
      if (Date.now() > deadline) throw error
      await sleep(300)
    }
  }
}

/** 노드 하나를 화면 비교에 쓸 만큼만 요약한다. bounds는 스크롤로도 바뀌므로 뺀다. */
function signatureOf(dump: UiDump): string {
  return JSON.stringify(dump.nodes.map((n) => `${n.className}|${n.resourceId ?? ''}|${n.contentDesc ?? ''}|${n.text ?? ''}`))
}

/**
 * 검색창(`search_action_bar`)은 목록 맨 위의 클릭 가능한 노드지만 탭해도 화면 전환이
 * 뚜렷하지 않고, 이전에 탭해 둔 검색 상태가 화면 복원으로 남아 있을 수도 있다. 실제
 * 설정 카테고리로 내려가는 목록 항목을 고른다.
 */
function findNavigableListItem(dump: UiDump) {
  return dump.nodes.find(
    (n) => n.clickable && n.enabled && !(n.resourceId ?? '').toLowerCase().includes('search')
  )
}

async function launchSettingsMain(): Promise<void> {
  // 홈으로 먼저 보낸 뒤 설정을 force-stop하고 다시 띄운다. 설정 액티비티는 검색 화면처럼
  // 이전에 남긴 UI 상태를 시스템이 복원할 수 있어(테스트로 확인함), force-stop과 재시작만으로는
  // 항상 메인 목록으로 돌아온다고 보장할 수 없다. 홈을 먼저 앞에 두면 설정을 뒤로가기로
  // 나갔을 때도 항상 홈 런처로 떨어진다.
  await adb.exec(serial, ['shell', 'am', 'start', '-a', 'android.intent.action.MAIN', '-c', 'android.intent.category.HOME'])
  await adb.exec(serial, ['shell', 'am', 'force-stop', SETTINGS_PKG])
  await adb.exec(serial, ['shell', 'am', 'start', '-n', SETTINGS_COMPONENT])
  await dumpUiSettled(device)
}

beforeAll(async () => {
  const located = locateSdk(defaultLocateSdkDeps())
  if (!located.ok) {
    throw new Error(`Android SDK를 찾지 못했다. 찾아본 경로: ${located.searched.join(', ')}`)
  }

  adb = createAdbClient(located.paths.adb)

  const devices = parseDevices((await adb.exec(null, ['devices', '-l'])).stdout).filter(
    (entry) => entry.state === 'device'
  )

  // adbClient.integration.test.ts와 같은 기기 선택 규칙. 물리 기기를 암묵적으로 고르지 않는다.
  const envSerial = process.env.VDH_TEST_SERIAL
  if (envSerial) {
    if (!devices.some((entry) => entry.serial === envSerial)) {
      throw new Error(
        `VDH_TEST_SERIAL=${envSerial}인데 연결된 기기 목록에 없다. 연결된 기기: ${
          devices.map((entry) => entry.serial).join(', ') || '(없음)'
        }`
      )
    }
    serial = envSerial
  } else {
    const emulators = devices.filter((entry) => entry.serial.startsWith('emulator-'))
    if (emulators.length === 0) {
      throw new Error('연결된 에뮬레이터가 없다. 에뮬레이터를 하나 띄우거나 VDH_TEST_SERIAL로 대상을 지정해라')
    }
    if (emulators.length > 1) {
      throw new Error(
        `연결된 에뮬레이터가 여럿이다: ${emulators
          .map((entry) => entry.serial)
          .join(', ')}. VDH_TEST_SERIAL로 대상을 지정해라`
      )
    }
    serial = emulators[0]?.serial as string
  }

  device = createAndroidDevice({
    serial,
    adb,
    // 스크린샷은 이 테스트에서 쓰지 않는다. electronResizeImage는 Electron 런타임이
    // 필요해 통합 테스트 프로세스에서 부를 수 없다.
    resizeImage: (png) => ({ png, width: 1, height: 1 })
  })
})

describe('node ref + real device', () => {
  it('taps a node by ref on a real device', async () => {
    await launchSettingsMain()
    const nodeRefs = createNodeRefs()

    const dump1 = await dumpUiSettled(device)
    const generation = nodeRefs.remember(device, dump1)
    const target = findNavigableListItem(dump1)
    if (!target) throw new Error('설정 메인 화면에서 이동 가능한 목록 항목을 찾지 못했다')
    const ref = formatRef(generation, target.index)

    // 동작 직전 재검증: resolve가 새 덤프에서 같은 지문의 노드를 찾아 새 bounds를 준다.
    const resolved = await nodeRefs.resolve(device, ref)
    const pixel = toPixel(centerOf(resolved.node.bounds), resolved.frame)
    await device.tap(pixel.x, pixel.y)

    const dump2 = await dumpUiSettled(device)

    // 탭 뒤 화면이 바뀌었다: 두 번째 덤프의 노드 지문 목록이 첫 번째와 다르다.
    expect(signatureOf(dump2)).not.toBe(signatureOf(dump1))
  })

  it('returns stale_ref for a ref taken before the screen changed', async () => {
    await launchSettingsMain()
    const nodeRefs = createNodeRefs()

    const dump1 = await dumpUiSettled(device)
    const generation = nodeRefs.remember(device, dump1)
    const target = findNavigableListItem(dump1)
    if (!target) throw new Error('설정 메인 화면에서 이동 가능한 목록 항목을 찾지 못했다')
    const ref = formatRef(generation, target.index)

    // 다른 화면으로 나간다(홈 런처). 설정 화면의 어떤 지문도 새 화면에 없다고 보장된다.
    await device.pressKey('back')
    await sleep(500)

    await expect(nodeRefs.resolve(device, ref)).rejects.toMatchObject({
      toolError: { kind: 'stale_ref' }
    })
  })
})
