import { describe, expect, it, vi } from 'vitest'
import type { Device } from '../../shared/types/device'
import { screenSizeOf } from './screenSize'

function deviceWith(info: Device['info']): Device {
  return { serial: 'emulator-5554', info } as Device
}

describe('screenSizeOf', () => {
  it('asks the device once and reuses the answer', async () => {
    const info = vi.fn(async () => ({ serial: 'emulator-5554', model: 'x', apiLevel: 34, width: 1080, height: 2400 }))
    const device = deviceWith(info)

    await screenSizeOf(device)
    const size = await screenSizeOf(device)

    expect(size).toEqual({ width: 1080, height: 2400 })
    expect(info).toHaveBeenCalledTimes(1)
  })

  it('asks again after a failure', async () => {
    const info = vi
      .fn()
      .mockRejectedValueOnce(new Error('wm size 실패'))
      .mockResolvedValueOnce({ serial: 'emulator-5554', model: 'x', apiLevel: 34, width: 1080, height: 2400 })
    const device = deviceWith(info)

    await expect(screenSizeOf(device)).rejects.toThrow('wm size 실패')
    await expect(screenSizeOf(device)).resolves.toEqual({ width: 1080, height: 2400 })
  })

  it('keeps separate answers for separate device instances', async () => {
    const a = deviceWith(vi.fn(async () => ({ serial: 'a', model: 'x', apiLevel: 34, width: 1, height: 2 })))
    const b = deviceWith(vi.fn(async () => ({ serial: 'b', model: 'x', apiLevel: 34, width: 3, height: 4 })))

    expect(await screenSizeOf(a)).toEqual({ width: 1, height: 2 })
    expect(await screenSizeOf(b)).toEqual({ width: 3, height: 4 })
  })
})
