import { describe, expect, it, vi } from 'vitest'
import type { AvdController } from '../../device/avdController'
import type { DeviceRegistry } from '../../device/registry'
import type { Device, DeviceInfo } from '../../../shared/types/device'
import { deviceError } from '../../../shared/types/errors'
import { createToolHarness } from '../testHarness'

const info: DeviceInfo = {
  serial: 'emulator-5554',
  model: 'Pixel 7',
  apiLevel: 34,
  width: 1080,
  height: 2400
}

function fakeDevice(overrides: Partial<Device> = {}): Device {
  return {
    serial: 'emulator-5554',
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
    setActive: vi.fn(),
    clearActive: vi.fn(),
    getActive: () => 'emulator-5554',
    run: (_serial, task) => task(),
    on: () => () => {},
    ...overrides
  } as DeviceRegistry
}

function fakeAvd(overrides: Partial<AvdController> = {}): AvdController {
  return {
    list: async () => [{ name: 'Pixel_7_API_34', running: true, serial: 'emulator-5554' }],
    boot: async () => 'emulator-5554',
    shutdown: vi.fn(async () => {}),
    ...overrides
  } as AvdController
}

describe('device_list', () => {
  it('returns AVDs with their running state and the active serial', async () => {
    const harness = await createToolHarness({ registry: fakeRegistry(), avd: fakeAvd() })

    await expect(harness.call('device_list')).resolves.toEqual({
      avds: [{ name: 'Pixel_7_API_34', running: true, serial: 'emulator-5554' }],
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
      avd: fakeAvd({ boot })
    })

    await expect(harness.call('device_boot', { avd: 'Pixel_7_API_34' })).resolves.toEqual(info)
    expect(boot).toHaveBeenCalledWith('Pixel_7_API_34')

    await harness.close()
  })

  it('reports a structured error when the AVD name is unknown', async () => {
    const harness = await createToolHarness({
      registry: fakeRegistry(),
      avd: fakeAvd({
        boot: async () => {
          throw deviceError('command_failed', '그런 AVD가 없다: Nope', 'device_list로 확인해라')
        }
      })
    })

    const error = await harness.callExpectingError('device_boot', { avd: 'Nope' })
    expect(error.kind).toBe('command_failed')

    await harness.close()
  })
})

describe('device_shutdown', () => {
  it('shuts down the active device when no serial is given', async () => {
    const shutdown = vi.fn(async () => {})
    const harness = await createToolHarness({
      registry: fakeRegistry(),
      avd: fakeAvd({ shutdown })
    })

    await harness.call('device_shutdown')

    expect(shutdown).toHaveBeenCalledWith('emulator-5554')

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
      avd: fakeAvd()
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
      avd: fakeAvd()
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
      avd: fakeAvd()
    })

    const error = await harness.callExpectingError('device_select', { serial: 'emulator-9999' })
    expect(error.kind).toBe('no_device')

    await harness.close()
  })
})

describe('device_info', () => {
  it('returns model, api level and screen size', async () => {
    const harness = await createToolHarness({ registry: fakeRegistry(), avd: fakeAvd() })

    await expect(harness.call('device_info')).resolves.toEqual(info)

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
      avd: fakeAvd()
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
