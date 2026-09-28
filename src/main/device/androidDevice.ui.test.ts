import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import type { AdbClient, ExecResult } from '../adb/adbClient'
import { createAndroidDevice, parseDisplayRotation } from './androidDevice'

/** args 배열을 넘겨 응답을 고를 수 있게 한다. 생략하면 지금처럼 빈 stdout을 준다. */
function fakeAdb(respond?: (args: string[]) => string): { adb: AdbClient; calls: string[][] } {
  const calls: string[][] = []
  const adb = {
    exec: vi.fn(async (_serial: string | null, args: string[]): Promise<ExecResult> => {
      calls.push(args)
      const stdout = respond?.(args) ?? ''
      return { stdout, stdoutRaw: Buffer.from(stdout, 'utf8'), stderr: '', exitCode: 0 }
    }),
    stream: vi.fn()
  } as unknown as AdbClient
  return { adb, calls }
}

function makeDevice(adb: AdbClient) {
  return createAndroidDevice({
    serial: 'emulator-5554',
    adb,
    resizeImage: (png) => ({ png, width: 1, height: 1 })
  })
}

describe('AndroidDevice.tap', () => {
  it('sends input tap with integer coordinates', async () => {
    const { adb, calls } = fakeAdb()

    await makeDevice(adb).tap(540, 930)

    expect(calls[0]).toEqual(['shell', 'input', 'tap', '540', '930'])
  })

  it('rounds fractional coordinates rather than passing them through', async () => {
    const { adb, calls } = fakeAdb()

    await makeDevice(adb).tap(540.6, 930.2)

    expect(calls[0]).toEqual(['shell', 'input', 'tap', '541', '930'])
  })
})

describe('AndroidDevice.swipe', () => {
  it('sends input swipe with duration last', async () => {
    const { adb, calls } = fakeAdb()

    await makeDevice(adb).swipe(100, 200, 100, 800, 300)

    expect(calls[0]).toEqual(['shell', 'input', 'swipe', '100', '200', '100', '800', '300'])
  })

  it('rejects a non-positive duration', async () => {
    const { adb } = fakeAdb()

    await expect(makeDevice(adb).swipe(1, 2, 3, 4, 0)).rejects.toMatchObject({
      toolError: { kind: 'command_failed' }
    })
  })
})

describe('AndroidDevice.inputText', () => {
  it('escapes spaces so the shell does not split the text', async () => {
    const { adb, calls } = fakeAdb()

    await makeDevice(adb).inputText('hello world')

    expect(calls[0]).toEqual(['shell', 'input', 'text', 'hello%sworld'])
  })

  it('escapes shell metacharacters that would otherwise be interpreted', async () => {
    const { adb, calls } = fakeAdb()

    await makeDevice(adb).inputText('a&b$c')

    expect(calls[0]?.[3]).toBe('a\\&b\\$c')
  })

  it('escapes the mksh expansion characters that would otherwise rewrite the text', async () => {
    // 기기 셸은 mksh다. ~는 틸드 확장, {a,b}는 중괄호 확장, 단어 첫머리의 #은
    // 주석 시작이라 뒤가 통째로 사라진다. 셋 다 조용히 다른 글자를 타이핑하게 만든다.
    const { adb, calls } = fakeAdb()
    const device = makeDevice(adb)

    await device.inputText('#tag')
    expect(calls[0]?.[3]).toBe('\\#tag')

    await device.inputText('~/home')
    expect(calls[1]?.[3]).toBe('\\~/home')

    await device.inputText('{a,b}')
    expect(calls[2]?.[3]).toBe('\\{a,b\\}')
  })

  it('rejects text it cannot send safely instead of sending something wrong', async () => {
    const { adb } = fakeAdb()

    await expect(makeDevice(adb).inputText('안녕')).rejects.toMatchObject({
      toolError: { kind: 'command_failed' }
    })
  })

  it('rejects text containing % because the device decodes %s back to a space', async () => {
    const { adb } = fakeAdb()

    await expect(makeDevice(adb).inputText('a%sb')).rejects.toMatchObject({
      toolError: { kind: 'command_failed' }
    })
  })
})

describe('AndroidDevice.pressKey', () => {
  it('maps names to Android keycodes', async () => {
    const { adb, calls } = fakeAdb()
    const device = makeDevice(adb)

    await device.pressKey('back')
    await device.pressKey('home')
    await device.pressKey('enter')
    await device.pressKey('tab')

    expect(calls.map((args) => args[3])).toEqual([
      'KEYCODE_BACK',
      'KEYCODE_HOME',
      'KEYCODE_ENTER',
      'KEYCODE_TAB'
    ])
  })
})

// 스트리밍 중(emulator-5554, scrcpy 가상 디스플레이 연결) dumpsys window displays 픽스처.
// 0이 아닌 mDisplayId 블록이 mDisplayId=0보다 먼저 나온다.
const streaming = readFileSync(
  join(__dirname, 'parsers', '__fixtures__', 'window-displays-streaming.txt'),
  'utf8'
)

describe('parseDisplayRotation', () => {
  it('reads the default display rotation even when a virtual display comes first', () => {
    expect(parseDisplayRotation(streaming)).toBe(0)
    expect(
      parseDisplayRotation(streaming.replace(/(Display: mDisplayId=0[\s\S]*?)ROTATION_0/, '$1ROTATION_90'))
    ).toBe(1)
  })

  it('accepts the (organized) suffix on the default display line', () => {
    expect(
      parseDisplayRotation('Display: mDisplayId=0 (organized)\n winConfig={ mDisplayRotation=ROTATION_270 }')
    ).toBe(3)
  })

  it('throws command_failed when the default display has no rotation', () => {
    expect(() => parseDisplayRotation('Display: mDisplayId=2\n mDisplayRotation=ROTATION_0')).toThrow(
      expect.objectContaining({ toolError: expect.objectContaining({ kind: 'command_failed' }) })
    )
  })
})

describe('AndroidDevice.displayFrame', () => {
  it('swaps axes for a 90 degree rotation', async () => {
    const rotated90 = streaming.replace(/(Display: mDisplayId=0[\s\S]*?)ROTATION_0/, '$1ROTATION_90')
    const { adb } = fakeAdb((args) => {
      const key = args.join(' ')
      if (key === 'shell wm size') return 'Physical size: 1080x2400\n'
      if (key === 'shell dumpsys window displays') return rotated90
      return ''
    })
    const device = makeDevice(adb)

    await expect(device.displayFrame()).resolves.toEqual({ width: 2400, height: 1080 })
  })

  it('asks wm size once per device instance across dumpUi and displayFrame', async () => {
    const dumpXml = `<?xml version="1.0"?><hierarchy rotation="0"><node index="0" text="로그인" resource-id="com.example:id/login" class="android.widget.Button" content-desc="" clickable="true" enabled="true" focused="false" scrollable="false" bounds="[80,860][1000,1000]" /></hierarchy>`
    const { adb, calls } = fakeAdb((args) => {
      const key = args.join(' ')
      if (key === 'shell wm size') return 'Physical size: 1080x2400\n'
      if (key.startsWith('exec-out cat')) return dumpXml
      if (key === 'shell dumpsys window displays') return streaming
      return ''
    })
    const device = makeDevice(adb)

    await device.dumpUi()
    await device.displayFrame()
    await device.displayFrame()

    expect(calls.filter((c) => c.join(' ') === 'shell wm size')).toHaveLength(1)
  })

  it('does not cache a failed wm size', async () => {
    // 첫 호출 실패 → 두 번째 호출이 wm size를 다시 부른다.
    let wmSizeCalls = 0
    const { adb } = fakeAdb((args) => {
      if (args.join(' ') === 'shell wm size') {
        wmSizeCalls += 1
        return wmSizeCalls === 1 ? '' : 'Physical size: 1080x2400\n'
      }
      return ''
    })
    const device = makeDevice(adb)

    await expect(device.info()).rejects.toMatchObject({ toolError: { kind: 'command_failed' } })
    await expect(device.info()).resolves.toMatchObject({ width: 1080, height: 2400 })
  })
})
