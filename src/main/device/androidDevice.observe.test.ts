import { describe, expect, it, vi } from 'vitest'
import type { AdbClient, ExecResult } from '../adb/adbClient'
import { createAndroidDevice, DEFAULT_LOG_LIMIT, MAX_LOG_LIMIT } from './androidDevice'

/** args 배열을 공백으로 이어 붙인 문자열을 키로 응답을 고른다. */
function fakeAdb(responses: Record<string, string | Buffer>): { adb: AdbClient; calls: string[][] } {
  const calls: string[][] = []
  const adb = {
    exec: vi.fn(async (_serial: string | null, args: string[]): Promise<ExecResult> => {
      calls.push(args)
      const key = Object.keys(responses).find((candidate) => args.join(' ').includes(candidate))
      const value = key ? responses[key] : ''
      const raw = Buffer.isBuffer(value) ? value : Buffer.from(value ?? '', 'utf8')
      return { stdout: raw.toString('utf8'), stdoutRaw: raw, stderr: '', exitCode: 0 }
    }),
    stream: vi.fn()
  } as unknown as AdbClient
  return { adb, calls }
}

const noopResize = (png: Buffer) => ({ png, width: 1080, height: 2400 })

describe('AndroidDevice.info', () => {
  it('reads model, api level and screen size', async () => {
    const { adb } = fakeAdb({
      'ro.product.model': 'Pixel 7\n',
      'ro.build.version.sdk': '34\n',
      'wm size': 'Physical size: 1080x2400\n'
    })
    const device = createAndroidDevice({ serial: 'emulator-5554', adb, resizeImage: noopResize })

    await expect(device.info()).resolves.toEqual({
      serial: 'emulator-5554',
      model: 'Pixel 7',
      apiLevel: 34,
      width: 1080,
      height: 2400
    })
  })

  it('prefers the override size when one is set', async () => {
    const { adb } = fakeAdb({
      'ro.product.model': 'Pixel 7\n',
      'ro.build.version.sdk': '34\n',
      'wm size': 'Physical size: 1080x2400\nOverride size: 540x1200\n'
    })
    const device = createAndroidDevice({ serial: 'emulator-5554', adb, resizeImage: noopResize })

    const info = await device.info()

    expect(info.width).toBe(540)
    expect(info.height).toBe(1200)
  })
})

describe('AndroidDevice.screenshot', () => {
  it('captures raw PNG bytes with exec-out so they are not mangled', async () => {
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d])
    const { adb, calls } = fakeAdb({ screencap: png, 'wm size': 'Physical size: 1080x2400\n' })
    const device = createAndroidDevice({ serial: 'emulator-5554', adb, resizeImage: noopResize })

    const shot = await device.screenshot()

    expect(calls.some((args) => args[0] === 'exec-out' && args.includes('screencap'))).toBe(true)
    expect(shot.base64).toBe(png.toString('base64'))
  })

  it('shrinks to the default long edge when no scale is given', async () => {
    const resize = vi.fn((png: Buffer, maxLongEdge: number) => ({ png, width: maxLongEdge, height: maxLongEdge }))
    const { adb } = fakeAdb({ screencap: Buffer.from([1]), 'wm size': 'Physical size: 1080x2400\n' })
    const device = createAndroidDevice({ serial: 'emulator-5554', adb, resizeImage: resize })

    await device.screenshot()

    expect(resize).toHaveBeenCalledWith(expect.any(Buffer), 720)
  })

  it('scales relative to the device long edge when scale is given', async () => {
    const resize = vi.fn((png: Buffer, maxLongEdge: number) => ({ png, width: maxLongEdge, height: maxLongEdge }))
    const { adb } = fakeAdb({ screencap: Buffer.from([1]), 'wm size': 'Physical size: 1080x2400\n' })
    const device = createAndroidDevice({ serial: 'emulator-5554', adb, resizeImage: resize })

    await device.screenshot({ scale: 0.5 })

    expect(resize).toHaveBeenCalledWith(expect.any(Buffer), 1200)
  })

  it('rejects a scale outside (0, 1]', async () => {
    const { adb } = fakeAdb({ screencap: Buffer.from([1]), 'wm size': 'Physical size: 1080x2400\n' })
    const device = createAndroidDevice({ serial: 'emulator-5554', adb, resizeImage: noopResize })

    await expect(device.screenshot({ scale: 2 })).rejects.toMatchObject({
      toolError: { kind: 'command_failed' }
    })
  })
})

describe('AndroidDevice.readLogs', () => {
  const logs = Array.from({ length: 5 }, (_, i) => `09-22 11:06:2${i}.000  1 2 I Tag${i}: message ${i}`).join('\n')

  it('applies the default limit when none is given', async () => {
    const { adb } = fakeAdb({ logcat: logs })
    const device = createAndroidDevice({ serial: 'emulator-5554', adb, resizeImage: noopResize })

    const result = await device.readLogs()

    expect(result.lines.length).toBeLessThanOrEqual(DEFAULT_LOG_LIMIT)
    expect(result.truncated).toBe(false)
    expect(result.droppedCount).toBe(0)
  })

  it('keeps the newest lines and reports how many it dropped', async () => {
    const { adb } = fakeAdb({ logcat: logs })
    const device = createAndroidDevice({ serial: 'emulator-5554', adb, resizeImage: noopResize })

    const result = await device.readLogs({ limit: 2 })

    expect(result.lines.map((line) => line.tag)).toEqual(['Tag3', 'Tag4'])
    expect(result.truncated).toBe(true)
    expect(result.droppedCount).toBe(3)
  })

  it('clamps a limit above the hard maximum instead of honouring it', async () => {
    const { adb } = fakeAdb({ logcat: logs })
    const device = createAndroidDevice({ serial: 'emulator-5554', adb, resizeImage: noopResize })

    const result = await device.readLogs({ limit: MAX_LOG_LIMIT + 5000 })

    expect(result.lines.length).toBeLessThanOrEqual(MAX_LOG_LIMIT)
  })

  it('filters on tag and message, case-insensitively', async () => {
    const { adb } = fakeAdb({ logcat: logs })
    const device = createAndroidDevice({ serial: 'emulator-5554', adb, resizeImage: noopResize })

    const result = await device.readLogs({ filter: 'TAG2' })

    expect(result.lines.map((line) => line.tag)).toEqual(['Tag2'])
  })

  it('passes -v threadtime and -d so the parser format is fixed', async () => {
    const { adb, calls } = fakeAdb({ logcat: logs })
    const device = createAndroidDevice({ serial: 'emulator-5554', adb, resizeImage: noopResize })

    await device.readLogs()

    const logcatCall = calls.find((args) => args.includes('logcat'))
    expect(logcatCall).toContain('-d')
    expect(logcatCall).toContain('threadtime')
  })
})

describe('AndroidDevice.dumpUi', () => {
  it('returns summarised nodes, never the raw XML', async () => {
    const xml = `<?xml version="1.0"?><hierarchy rotation="0"><node index="0" text="로그인" resource-id="com.example:id/login" class="android.widget.Button" content-desc="" clickable="true" bounds="[80,860][1000,1000]" /></hierarchy>`
    const { adb } = fakeAdb({ 'window_dump.xml': xml, 'wm size': 'Physical size: 1080x2400\n' })
    const device = createAndroidDevice({ serial: 'emulator-5554', adb, resizeImage: noopResize })

    const nodes = await device.dumpUi()

    expect(nodes).toEqual([
      {
        index: 0,
        text: '로그인',
        contentDesc: null,
        resourceId: 'login',
        className: 'Button',
        x: 540,
        y: 930,
        clickable: true
      }
    ])
  })
})
