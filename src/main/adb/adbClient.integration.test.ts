import { beforeAll, describe, expect, it } from 'vitest'
import { defaultLocateSdkDeps, locateSdk } from '../sdk/locateSdk'
import { parseDevices } from '../device/parsers/devices'
import { parseLogcat } from '../device/parsers/logcat'
import { parseUiDump } from '../device/parsers/uiDump'
import { createAdbClient, type AdbClient } from './adbClient'

let adb: AdbClient
let serial: string

beforeAll(async () => {
  const located = locateSdk(defaultLocateSdkDeps())
  if (!located.ok) {
    throw new Error(
      `Android SDK를 찾지 못했다. 찾아본 경로: ${located.searched.join(', ')}`
    )
  }

  adb = createAdbClient(located.paths.adb)

  const devices = parseDevices((await adb.exec(null, ['devices', '-l'])).stdout).filter(
    (entry) => entry.state === 'device'
  )

  // 여러 기기가 붙어 있을 때 devices[0]을 그냥 집으면 실기기를 실수로 건드릴 수
  // 있다. VDH_TEST_SERIAL이 있으면 그걸 쓰되 실제로 연결돼 있는지 확인하고,
  // 없으면 연결된 emulator-* 기기가 정확히 하나일 때만 그걸 쓴다. 물리 기기는
  // 암묵적으로 고르지 않는다.
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
})

describe('adbClient against a real emulator', () => {
  it('runs a shell command and returns its output', async () => {
    const result = await adb.exec(serial, ['shell', 'echo', 'hello'])

    expect(result.stdout.trim()).toBe('hello')
    expect(result.exitCode).toBe(0)
  })

  it('reports no_device for a serial that does not exist', async () => {
    await expect(adb.exec('emulator-9999', ['shell', 'echo', 'hi'])).rejects.toMatchObject({
      toolError: { kind: 'no_device' }
    })
  })

  it('captures PNG bytes through exec-out without mangling them', async () => {
    const result = await adb.exec(serial, ['exec-out', 'screencap', '-p'], { timeoutMs: 60_000 })

    // PNG 시그니처.
    expect(result.stdoutRaw.subarray(0, 4)).toEqual(Buffer.from([0x89, 0x50, 0x4e, 0x47]))
  })

  it('streams lines from a long-running command', async () => {
    // 고정 3초 대기는 조용한 에뮬레이터에서 로그가 하나도 안 쌓이면 흔들린다.
    // 첫 줄이 오거나 15초가 지나면 멈춘다 — 로그가 쏟아지는 경우 3초보다 훨씬
    // 빨리 끝나고, 조용한 경우에도 실패 전에 최대 15초는 기다려 준다.
    const lines: string[] = []
    const stream = adb.stream(serial, ['logcat', '-v', 'threadtime'])

    await new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, 15_000)
      stream.onLine((line) => {
        lines.push(line)
        clearTimeout(timer)
        resolve()
      })
    })
    stream.close()

    expect(lines.length).toBeGreaterThan(0)
  })
})

describe('parsers against real output', () => {
  it('parses the real device list', async () => {
    const entries = parseDevices((await adb.exec(null, ['devices', '-l'])).stdout)

    expect(entries.some((entry) => entry.serial === serial)).toBe(true)
  })

  it('parses a real uiautomator dump into tappable nodes', async () => {
    await adb.exec(serial, ['shell', 'uiautomator', 'dump', '/sdcard/window_dump.xml'])
    const xml = (await adb.exec(serial, ['exec-out', 'cat', '/sdcard/window_dump.xml'])).stdout

    // parseUiDump는 opts.screenWidth/Height를 받지 않는다 — 화면 사각형은 덤프
    // 자신의 루트 bounds에서 뽑는다(uiDump.ts screenRect 참고). 브리프가 예시로
    // 든 서명은 그 결정 이전 버전이라 여기서 현재 시그니처(query만 받음)에 맞춘다.
    const nodes = parseUiDump(xml)

    expect(nodes.length).toBeGreaterThan(0)
    // 요약이 원본보다 확실히 작아야 한다. 이게 ui_find의 존재 이유다.
    expect(JSON.stringify(nodes).length).toBeLessThan(xml.length)
  })

  it('parses real logcat output', async () => {
    const stdout = (await adb.exec(serial, ['logcat', '-d', '-v', 'threadtime', '-t', '200'])).stdout
    const lines = parseLogcat(stdout)

    expect(lines.length).toBeGreaterThan(0)
    expect(lines.every((line) => line.tag.length > 0)).toBe(true)
  })

  // R9: androidDevice.launch가 monkey 대신 쓰는 resolve-activity가 실기기에서 실제로
  // 컴포넌트를 돌려주는지 읽기 전용으로 확인한다. 아무것도 실행하지 않는다.
  it('resolves a launcher component for a system package with resolve-activity', async () => {
    const stdout = (
      await adb.exec(serial, [
        'shell',
        'cmd',
        'package',
        'resolve-activity',
        '--brief',
        '-c',
        'android.intent.category.LAUNCHER',
        'com.android.settings'
      ])
    ).stdout

    expect(stdout).toContain('com.android.settings/')
  })
})
