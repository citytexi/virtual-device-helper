import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { fakeSimctl, execOk } from '../ios/testing'
import { createIosDevice } from './iosDevice'
import { parseSimctlDevices } from './parsers/simctlDevices'

const listJson = readFileSync(join(__dirname, 'parsers', '__fixtures__', 'ios', 'simctl-list-devices.json'), 'utf8')
const entry = parseSimctlDevices(listJson)[0]!

/** IHDR만 있는 최소 PNG 헤더. 크기 읽기 검증용이다. */
function pngHeader(width: number, height: number): Buffer {
  const buffer = Buffer.alloc(24)
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(buffer)
  buffer.write('IHDR', 12, 'ascii')
  buffer.writeUInt32BE(width, 16)
  buffer.writeUInt32BE(height, 20)
  return buffer
}

const noopResize = (png: Buffer) => ({ png, width: 1, height: 1 })

describe('IosDevice.info', () => {
  it('reports name, osVersion and screenshot size', async () => {
    const simctl = fakeSimctl({ 'list devices -j': execOk(listJson) })
    const device = createIosDevice({
      udid: entry.udid,
      simctl,
      resizeImage: noopResize,
      readFile: async () => pngHeader(1206, 2622),
      removeFile: async () => {}
    })
    // 스크린샷 명령은 임시 경로가 매번 달라 키를 모른다. 접두어로 받는 핸들러를 덧씌운다.
    const exec = simctl.exec as ReturnType<typeof vi.fn>
    const base = exec.getMockImplementation() as (args: string[]) => Promise<unknown>
    exec.mockImplementation(async (args: string[]) => (args[2] === 'screenshot' ? execOk() : base(args)))

    await expect(device.info()).resolves.toEqual({
      serial: entry.udid,
      platform: 'ios',
      model: entry.name,
      osVersion: entry.osVersion,
      width: 1206,
      height: 2622
    })
    expect(device.platform).toBe('ios')
  })
})

describe('IosDevice.screenshot', () => {
  it('rejects scale 0 with command_failed', async () => {
    const device = createIosDevice({ udid: 'U', simctl: fakeSimctl({}), resizeImage: noopResize })
    await expect(device.screenshot({ scale: 0 })).rejects.toMatchObject({ toolError: { kind: 'command_failed' } })
  })

  it('writes to a temp file (not "-"), reads it, removes it, and resizes', async () => {
    const simctl = fakeSimctl({})
    const exec = simctl.exec as ReturnType<typeof vi.fn>
    exec.mockImplementation(async (args: string[]) => {
      simctl.calls.push(args)
      return execOk()
    })
    const removeFile = vi.fn(async () => {})
    const resize = vi.fn((png: Buffer, maxLongEdge: number) => ({ png, width: maxLongEdge, height: 1 }))
    const device = createIosDevice({
      udid: 'U',
      simctl,
      resizeImage: resize,
      readFile: async () => pngHeader(1000, 2000),
      removeFile
    })

    const result = await device.screenshot({ scale: 0.5 })

    const args = simctl.calls[0]!
    expect(args.slice(0, 4)).toEqual(['io', 'U', 'screenshot', '--type=png'])
    expect(args[4]).not.toBe('-')
    expect(removeFile).toHaveBeenCalledWith(args[4])
    expect(resize).toHaveBeenCalledWith(expect.any(Buffer), 1000)
    expect(result.width).toBe(1000)
  })
})

describe('IosDevice M4-2 actions', () => {
  it('tap is unsupported', async () => {
    const device = createIosDevice({ udid: 'U', simctl: fakeSimctl({}), resizeImage: noopResize })
    await expect(device.tap(0, 0)).rejects.toMatchObject({ toolError: { kind: 'unsupported' } })
  })

  it('log methods are unsupported until Task 7', async () => {
    const device = createIosDevice({ udid: 'U', simctl: fakeSimctl({}), resizeImage: noopResize })
    await expect(device.readLogs()).rejects.toMatchObject({ toolError: { kind: 'unsupported' } })
    await expect(device.clearLogs()).rejects.toMatchObject({ toolError: { kind: 'unsupported' } })
  })
})
