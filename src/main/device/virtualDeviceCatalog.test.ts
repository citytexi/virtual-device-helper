import { describe, expect, it, vi } from 'vitest'
import type { Platform, VirtualDeviceEntry } from '../../shared/types/device'
import { createVirtualDeviceCatalog, type VirtualDeviceSource } from './virtualDeviceCatalog'

function entry(platform: Platform, id: string): VirtualDeviceEntry {
  return { platform, id, name: id, running: false, serial: null, osVersion: null }
}

function fakeSource(platform: Platform, entries: VirtualDeviceEntry[], overrides: Partial<VirtualDeviceSource> = {}): VirtualDeviceSource {
  return {
    platform,
    list: async () => entries,
    boot: vi.fn(async () => `${platform}-serial`),
    shutdown: vi.fn(async () => {}),
    ...overrides
  }
}

describe('createVirtualDeviceCatalog', () => {
  it('concatenates source lists in source order', async () => {
    const catalog = createVirtualDeviceCatalog([
      fakeSource('android', [entry('android', 'Pixel')]),
      fakeSource('ios', [entry('ios', 'udid-1'), entry('ios', 'udid-2')])
    ])

    expect((await catalog.list()).map((e) => e.id)).toEqual(['Pixel', 'udid-1', 'udid-2'])
  })

  it('drops only the source that rejects and logs it', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const catalog = createVirtualDeviceCatalog([
      fakeSource('android', [], {
        list: async () => {
          throw new Error('boom')
        }
      }),
      fakeSource('ios', [entry('ios', 'udid-1')])
    ])

    expect((await catalog.list()).map((e) => e.id)).toEqual(['udid-1'])
    expect(errorSpy).toHaveBeenCalled()
    errorSpy.mockRestore()
  })

  it('routes boot(id) to the source that owns the id', async () => {
    const android = fakeSource('android', [entry('android', 'Pixel')])
    const ios = fakeSource('ios', [entry('ios', 'udid-1'), entry('ios', 'udid-2')])
    const catalog = createVirtualDeviceCatalog([android, ios])

    await expect(catalog.boot('udid-2')).resolves.toBe('ios-serial')
    expect(ios.boot).toHaveBeenCalledWith('udid-2')
    expect(android.boot).not.toHaveBeenCalled()
  })

  it('rejects an unknown id with command_failed and the available ids', async () => {
    const catalog = createVirtualDeviceCatalog([fakeSource('android', [entry('android', 'Pixel')])])

    await expect(catalog.boot('nope')).rejects.toMatchObject({
      toolError: {
        kind: 'command_failed',
        message: '그런 가상 기기가 없다: nope',
        hint: 'device_list로 id를 확인해라',
        details: { available: ['Pixel'], failedPlatforms: [] }
      }
    })
  })

  it('reports the platforms whose list failed when the id is not found', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const catalog = createVirtualDeviceCatalog([
      fakeSource('android', [entry('android', 'Pixel')]),
      fakeSource('ios', [], {
        list: async () => {
          throw new Error('boom')
        }
      })
    ])

    await expect(catalog.boot('udid-1')).rejects.toMatchObject({
      toolError: {
        kind: 'command_failed',
        message: '그런 가상 기기가 없다: udid-1',
        hint: 'device_list로 id를 확인해라. ios 가상 기기 목록을 읽지 못해 그쪽 기기는 확인하지 못했다',
        details: { available: ['Pixel'], failedPlatforms: ['ios'] }
      }
    })
    errorSpy.mockRestore()
  })

  it('still boots an id owned by a healthy source when another source failed', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const ios = fakeSource('ios', [entry('ios', 'udid-1')])
    const catalog = createVirtualDeviceCatalog([
      fakeSource('android', [], {
        list: async () => {
          throw new Error('boom')
        }
      }),
      ios
    ])

    await expect(catalog.boot('udid-1')).resolves.toBe('ios-serial')
    errorSpy.mockRestore()
  })

  it('routes shutdown by platform', async () => {
    const android = fakeSource('android', [])
    const ios = fakeSource('ios', [])
    const catalog = createVirtualDeviceCatalog([android, ios])

    await catalog.shutdown('udid-1', 'ios')
    expect(ios.shutdown).toHaveBeenCalledWith('udid-1')
    expect(android.shutdown).not.toHaveBeenCalled()
  })
})
