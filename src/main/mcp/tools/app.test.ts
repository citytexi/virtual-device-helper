import { describe, expect, it, vi } from 'vitest'
import type { AvdController } from '../../device/avdController'
import type { DeviceRegistry } from '../../device/registry'
import type { Device } from '../../../shared/types/device'
import { deviceError } from '../../../shared/types/errors'
import { createToolHarness } from '../testHarness'

function harnessFor(device: Partial<Device>) {
  const full = { serial: 'emulator-5554', ...device } as Device
  const registry = {
    start: vi.fn(),
    stop: vi.fn(),
    serials: () => ['emulator-5554'],
    resolve: () => full,
    setActive: vi.fn(),
    clearActive: vi.fn(),
    getActive: () => 'emulator-5554',
    run: (_serial: string, task: () => Promise<unknown>) => task(),
    on: () => () => {}
  } as unknown as DeviceRegistry

  const avd = {
    list: async () => [],
    boot: async () => 'emulator-5554',
    shutdown: async () => {}
  } as AvdController

  return createToolHarness({ registry, avd })
}

describe('app_install', () => {
  it('returns the package name of the installed apk', async () => {
    const harness = await harnessFor({ install: async () => 'com.example.app' })

    await expect(harness.call('app_install', { apkPath: '/tmp/app.apk' })).resolves.toEqual({
      pkg: 'com.example.app'
    })

    await harness.close()
  })

  it('passes reinstall through to the device', async () => {
    const install = vi.fn(async () => 'com.example.app')
    const harness = await harnessFor({ install })

    await harness.call('app_install', { apkPath: '/tmp/app.apk', reinstall: true })

    expect(install).toHaveBeenCalledWith('/tmp/app.apk', { reinstall: true })

    await harness.close()
  })

  it('reports apk_path_invalid as a structured error', async () => {
    const harness = await harnessFor({
      install: async () => {
        throw deviceError('apk_path_invalid', '파일이 없다', '경로를 확인해라')
      }
    })

    const error = await harness.callExpectingError('app_install', { apkPath: '/tmp/missing.apk' })
    expect(error.kind).toBe('apk_path_invalid')

    await harness.close()
  })

  it('returns null rather than an empty string when the package name cannot be determined', async () => {
    const harness = await harnessFor({ install: async () => null })

    await expect(
      harness.call('app_install', { apkPath: '/tmp/app.apk', reinstall: true })
    ).resolves.toEqual({ pkg: null })

    await harness.close()
  })
})

describe('app_launch', () => {
  it('launches without an activity', async () => {
    const launch = vi.fn(async () => {})
    const harness = await harnessFor({ launch })

    await harness.call('app_launch', { pkg: 'com.example.app' })

    expect(launch).toHaveBeenCalledWith('com.example.app', undefined)

    await harness.close()
  })

  it('passes an explicit activity through', async () => {
    const launch = vi.fn(async () => {})
    const harness = await harnessFor({ launch })

    await harness.call('app_launch', { pkg: 'com.example.app', activity: '.MainActivity' })

    expect(launch).toHaveBeenCalledWith('com.example.app', '.MainActivity')

    await harness.close()
  })

  it('reports package_not_found as a structured error', async () => {
    const harness = await harnessFor({
      launch: async () => {
        throw deviceError('package_not_found', '설치돼 있지 않다', 'app_install로 설치해라')
      }
    })

    const error = await harness.callExpectingError('app_launch', { pkg: 'com.example.missing' })
    expect(error.kind).toBe('package_not_found')
    expect(error.hint).toContain('app_install')

    await harness.close()
  })
})

describe('app lifecycle tools', () => {
  it('uninstalls a package', async () => {
    const uninstall = vi.fn(async () => {})
    const harness = await harnessFor({ uninstall })

    await harness.call('app_uninstall', { pkg: 'com.example.app' })

    expect(uninstall).toHaveBeenCalledWith('com.example.app')

    await harness.close()
  })

  it('force-stops a package', async () => {
    const stop = vi.fn(async () => {})
    const harness = await harnessFor({ stop })

    await harness.call('app_stop', { pkg: 'com.example.app' })

    expect(stop).toHaveBeenCalledWith('com.example.app')

    await harness.close()
  })

  it('clears app data', async () => {
    const clearData = vi.fn(async () => {})
    const harness = await harnessFor({ clearData })

    await harness.call('app_clear_data', { pkg: 'com.example.app' })

    expect(clearData).toHaveBeenCalledWith('com.example.app')

    await harness.close()
  })

  it('grants a permission', async () => {
    const grantPermission = vi.fn(async () => {})
    const harness = await harnessFor({ grantPermission })

    await harness.call('app_grant_permission', {
      pkg: 'com.example.app',
      permission: 'android.permission.CAMERA'
    })

    expect(grantPermission).toHaveBeenCalledWith('com.example.app', 'android.permission.CAMERA')

    await harness.close()
  })
})
