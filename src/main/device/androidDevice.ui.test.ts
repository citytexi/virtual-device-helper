import { describe, expect, it, vi } from 'vitest'
import type { AdbClient, ExecResult } from '../adb/adbClient'
import { createAndroidDevice } from './androidDevice'

function fakeAdb(): { adb: AdbClient; calls: string[][] } {
  const calls: string[][] = []
  const adb = {
    exec: vi.fn(async (_serial: string | null, args: string[]): Promise<ExecResult> => {
      calls.push(args)
      return { stdout: '', stdoutRaw: Buffer.alloc(0), stderr: '', exitCode: 0 }
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
