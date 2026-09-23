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

  if (devices.length === 0) {
    throw new Error('에뮬레이터를 하나 띄운 뒤 다시 실행해라')
  }

  serial = devices[0]?.serial as string
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
    const lines: string[] = []
    const stream = adb.stream(serial, ['logcat', '-v', 'threadtime'])
    stream.onLine((line) => lines.push(line))

    await new Promise((resolve) => setTimeout(resolve, 3_000))
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
})
