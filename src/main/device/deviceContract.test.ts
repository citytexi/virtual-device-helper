import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import type { AdbClient, ExecResult } from '../adb/adbClient'
import type { SimctlClient } from '../ios/simctlClient'
import { execOk, fakeAxe } from '../ios/testing'
import { deviceError } from '../../shared/types/errors'
import type { Device } from '../../shared/types/device'
import { createAndroidDevice } from './androidDevice'
import { createIosDevice } from './iosDevice'

// 플랫폼이 달라도 mcp 층이 기대는 Device 계약은 같아야 한다(ADR-0015).
// 두 팩토리는 각 플랫폼의 채집 fixture를 물린 가짜 클라이언트로 기기를 만든다.

const FIXTURES = join(__dirname, 'parsers', '__fixtures__')
const windowDump = readFileSync(join(FIXTURES, 'window-dump-emulator.xml'), 'utf8')
const windowDisplays = readFileSync(join(FIXTURES, 'window-displays-streaming.txt'), 'utf8')
const describeUi = readFileSync(join(FIXTURES, 'ios', 'describe-ui-settings.json'), 'utf8')
const noopResize = (png: Buffer) => ({ png, width: 1, height: 1 })

function makeAndroid(): Device {
  const adb = {
    exec: vi.fn(async (_serial: string | null, args: string[]): Promise<ExecResult> => {
      const key = args.join(' ')
      let stdout = ''
      if (key === 'shell wm size') stdout = 'Physical size: 1080x2400\n'
      else if (key === 'exec-out cat /sdcard/window_dump.xml') stdout = windowDump
      else if (key === 'shell dumpsys window displays') stdout = windowDisplays
      return { stdout, stdoutRaw: Buffer.from(stdout), stderr: '', exitCode: 0 }
    }),
    stream: vi.fn()
  } as unknown as AdbClient
  return createAndroidDevice({ serial: 'emulator-5554', adb, resizeImage: noopResize, fileExists: () => false })
}

const UDID = 'UDID-1'
const SETTINGS = 'com.apple.Preferences'

function makeIos(): Device {
  const axe = fakeAxe({
    'describe-ui': execOk(describeUi),
    'tap -x 100 -y 200': execOk(),
    'button home': execOk()
  })
  // 두 번째 terminate는 실행 중이 아니라서 실패한다. stop은 그래도 성공해야 한다.
  let terminated = false
  const simctl: SimctlClient = {
    exec: vi.fn(async (args: string[]): Promise<ExecResult> => {
      if (args.join(' ') !== `terminate ${UDID} ${SETTINGS}`) throw new Error(`등록되지 않은 명령 ${args.join(' ')}`)
      if (terminated) throw deviceError('command_failed', 'simctl 명령이 실패했다', '첨부된 stderr를 확인해라', { stderr: 'found nothing to terminate' })
      terminated = true
      return execOk()
    }),
    stream: vi.fn()
  }
  return createIosDevice({ udid: UDID, simctl, axe, resizeImage: noopResize, isDirectory: () => false, fileExists: () => false })
}

const PKG: Record<string, string> = { android: 'com.android.settings', ios: SETTINGS }
const MISSING_APP: Record<string, string> = { android: '/tmp/missing.apk', ios: '/tmp/missing.app' }

describe.each([
  ['android', makeAndroid],
  ['ios', makeIos]
])('Device 계약 (%s)', (platform, make) => {
  it('dumpUi의 모든 bounds가 0..1 안에 있다', async () => {
    const dump = await make().dumpUi()
    expect(dump.nodes.length).toBeGreaterThan(0)
    for (const node of dump.nodes) {
      const { x, y, w, h } = node.bounds
      expect(x).toBeGreaterThanOrEqual(0)
      expect(y).toBeGreaterThanOrEqual(0)
      expect(w).toBeGreaterThanOrEqual(0)
      expect(h).toBeGreaterThanOrEqual(0)
      expect(x + w).toBeLessThanOrEqual(1 + 1e-9)
      expect(y + h).toBeLessThanOrEqual(1 + 1e-9)
    }
  })

  it('displayFrame은 양수 크기다', async () => {
    const frame = await make().displayFrame()
    expect(frame.width).toBeGreaterThan(0)
    expect(frame.height).toBeGreaterThan(0)
  })

  it('tap이 resolve된다', async () => {
    await expect(make().tap(100, 200)).resolves.toBeUndefined()
  })

  it("pressKey('home')이 resolve된다", async () => {
    await expect(make().pressKey('home')).resolves.toBeUndefined()
  })

  it('stop을 두 번 불러도 resolve된다', async () => {
    const device = make()
    await expect(device.stop(PKG[platform] as string)).resolves.toBeUndefined()
    await expect(device.stop(PKG[platform] as string)).resolves.toBeUndefined()
  })

  it('install에 없는 경로를 주면 app_path_invalid다', async () => {
    await expect(make().install(MISSING_APP[platform] as string)).rejects.toMatchObject({
      toolError: { kind: 'app_path_invalid' }
    })
  })
})
