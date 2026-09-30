import { describe, expect, it, vi } from 'vitest'
import type { VirtualDeviceCatalog } from '../../device/virtualDeviceCatalog'
import type { DeviceRegistry } from '../../device/registry'
import type { Device, DeviceInfo } from '../../../shared/types/device'
import { deviceError } from '../../../shared/types/errors'
import { createToolHarness } from '../testHarness'

const info: DeviceInfo = {
  serial: 'emulator-5554',
  platform: 'android',
  model: 'Pixel 7',
  osVersion: '14 (API 34)',
  width: 1080,
  height: 2400
}

function fakeDevice(overrides: Partial<Device> = {}): Device {
  return {
    serial: 'emulator-5554',
    platform: 'android',
    info: async () => info,
    ...overrides
  } as Device
}

function fakeRegistry(overrides: Partial<DeviceRegistry> = {}): DeviceRegistry {
  return {
    start: vi.fn(),
    stop: vi.fn(),
    serials: () => ['emulator-5554'],
    resolve: () => fakeDevice(),
    waitFor: async () => fakeDevice(),
    setActive: vi.fn(),
    clearActive: vi.fn(),
    getActive: () => 'emulator-5554',
    run: (_serial, task) => task(),
    on: () => () => {},
    ...overrides
  } as DeviceRegistry
}

function fakeCatalog(overrides: Partial<VirtualDeviceCatalog> = {}): VirtualDeviceCatalog {
  return {
    list: async () => [
      { platform: 'android', id: 'Pixel_7_API_34', name: 'Pixel_7_API_34', running: true, serial: 'emulator-5554', osVersion: null }
    ],
    boot: async () => 'emulator-5554',
    shutdown: vi.fn(async () => {}),
    ...overrides
  } as VirtualDeviceCatalog
}

describe('device_list', () => {
  it('returns AVDs with their running state and the active serial', async () => {
    const harness = await createToolHarness({ registry: fakeRegistry(), catalog: fakeCatalog() })

    await expect(harness.call('device_list')).resolves.toEqual({
      virtualDevices: [
        { platform: 'android', id: 'Pixel_7_API_34', name: 'Pixel_7_API_34', running: true, serial: 'emulator-5554', osVersion: null }
      ],
      connected: ['emulator-5554'],
      active: 'emulator-5554'
    })

    await harness.close()
  })
})

describe('device_boot', () => {
  it('boots the named AVD and returns the resulting device info', async () => {
    const boot = vi.fn(async () => 'emulator-5554')
    const harness = await createToolHarness({
      registry: fakeRegistry(),
      catalog: fakeCatalog({ boot })
    })

    await expect(harness.call('device_boot', { id: 'Pixel_7_API_34' })).resolves.toEqual(info)
    expect(boot).toHaveBeenCalledWith('Pixel_7_API_34')

    await harness.close()
  })

  it('waits for the booted serial to register instead of resolving it right away', async () => {
    // simctl 폴링이 아직 못 본 기기를 resolve하면 no_device가 난다. waitFor로 기다려야 한다.
    const resolve = vi.fn(() => {
      throw deviceError('no_device', '그런 기기가 없다: UDID-1', 'device_list로 확인해라')
    })
    const waitFor = vi.fn(async (serial: string) => fakeDevice({ serial }))
    const harness = await createToolHarness({
      registry: fakeRegistry({ resolve, waitFor }),
      catalog: fakeCatalog({ boot: async () => 'UDID-1' })
    })

    await expect(harness.call('device_boot', { id: 'UDID-1' })).resolves.toEqual(info)
    expect(waitFor).toHaveBeenCalledWith('UDID-1', expect.any(Number))
    expect(resolve).not.toHaveBeenCalled()

    await harness.close()
  })

  it('reports device_unresponsive when the booted device never registers', async () => {
    const harness = await createToolHarness({
      registry: fakeRegistry({
        waitFor: async () => {
          throw deviceError('device_unresponsive', '부팅한 기기가 나타나지 않았다', 'device_list로 확인해라')
        }
      }),
      catalog: fakeCatalog({ boot: async () => 'UDID-1' })
    })

    const error = await harness.callExpectingError('device_boot', { id: 'UDID-1' })
    expect(error.kind).toBe('device_unresponsive')

    await harness.close()
  })

  it('reports a structured error when the AVD name is unknown', async () => {
    const harness = await createToolHarness({
      registry: fakeRegistry(),
      catalog: fakeCatalog({
        boot: async () => {
          throw deviceError('command_failed', '그런 AVD가 없다: Nope', 'device_list로 확인해라')
        }
      })
    })

    const error = await harness.callExpectingError('device_boot', { id: 'Nope' })
    expect(error.kind).toBe('command_failed')

    await harness.close()
  })
})

describe('device_shutdown', () => {
  it('shuts down the active device when no serial is given', async () => {
    const shutdown = vi.fn(async () => {})
    const harness = await createToolHarness({
      registry: fakeRegistry(),
      catalog: fakeCatalog({ shutdown })
    })

    await harness.call('device_shutdown')

    expect(shutdown).toHaveBeenCalledWith('emulator-5554', 'android')

    await harness.close()
  })

  it('reports no_device when nothing is attached', async () => {
    const harness = await createToolHarness({
      registry: fakeRegistry({
        getActive: () => null,
        serials: () => [],
        resolve: () => {
          throw deviceError('no_device', '연결된 기기가 없다', 'device_boot로 부팅해라')
        }
      }),
      catalog: fakeCatalog()
    })

    const error = await harness.callExpectingError('device_shutdown')
    expect(error.kind).toBe('no_device')

    await harness.close()
  })
})

describe('device_select', () => {
  it('sets the active device', async () => {
    const setActive = vi.fn()
    const harness = await createToolHarness({
      registry: fakeRegistry({ setActive }),
      catalog: fakeCatalog()
    })

    await expect(harness.call('device_select', { serial: 'emulator-5554' })).resolves.toEqual({
      active: 'emulator-5554'
    })
    expect(setActive).toHaveBeenCalledWith('emulator-5554')

    await harness.close()
  })

  it('reports no_device for an unknown serial', async () => {
    const harness = await createToolHarness({
      registry: fakeRegistry({
        setActive: () => {
          throw deviceError('no_device', '그런 기기가 없다', 'device_list로 확인해라', {
            candidates: ['emulator-5554']
          })
        }
      }),
      catalog: fakeCatalog()
    })

    const error = await harness.callExpectingError('device_select', { serial: 'emulator-9999' })
    expect(error.kind).toBe('no_device')

    await harness.close()
  })
})

describe('device_info', () => {
  it('returns model, api level and screen size', async () => {
    const harness = await createToolHarness({ registry: fakeRegistry(), catalog: fakeCatalog() })

    await expect(harness.call('device_info')).resolves.toEqual(info)

    await harness.close()
  })

  it('records the resolved serial', async () => {
    const harness = await createToolHarness({ registry: fakeRegistry(), catalog: fakeCatalog() })

    await harness.call('device_info')

    expect(harness.records[0]?.serial).toBe('emulator-5554')

    await harness.close()
  })

  it('reports ambiguous_device with candidates when more than one device is attached', async () => {
    const harness = await createToolHarness({
      registry: fakeRegistry({
        resolve: () => {
          throw deviceError('ambiguous_device', '기기가 여럿이다', 'serial을 지정해라', {
            candidates: ['emulator-5554', 'emulator-5556']
          })
        }
      }),
      catalog: fakeCatalog()
    })

    const error = (await harness.callExpectingError('device_info')) as {
      kind: string
      details?: { candidates?: string[] }
    }
    expect(error.kind).toBe('ambiguous_device')
    expect(error.details?.candidates).toEqual(['emulator-5554', 'emulator-5556'])

    await harness.close()
  })
})
