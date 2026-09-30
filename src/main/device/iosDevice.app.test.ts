import { describe, expect, it, vi } from 'vitest'
import { fakeSimctl, execOk } from '../ios/testing'
import { createIosDevice, type IosDeviceDeps } from './iosDevice'
import { deviceError } from '../../shared/types/errors'

const UDID = 'UDID-1'
const noopResize = (png: Buffer) => ({ png, width: 1, height: 1 })

function make(handlers: Parameters<typeof fakeSimctl>[0], extra: Partial<IosDeviceDeps> = {}) {
  const simctl = fakeSimctl(handlers)
  const device = createIosDevice({ udid: UDID, simctl, resizeImage: noopResize, ...extra })
  return { simctl, device }
}

describe('IosDevice.install', () => {
  it('reads the bundle id from Info.plist and installs without trailing slash', async () => {
    const readBundleId = vi.fn(async () => 'com.example.My')
    const { simctl, device } = make(
      { [`install ${UDID} /x/My.app`]: execOk() },
      { readBundleId, fileExists: () => true, isDirectory: () => true }
    )

    await expect(device.install('/x/My.app/')).resolves.toBe('com.example.My')
    expect(readBundleId).toHaveBeenCalledWith('/x/My.app/Info.plist')
    expect(simctl.calls).toEqual([['install', UDID, '/x/My.app']])
  })

  it('rejects .apk paths and missing directories with app_path_invalid', async () => {
    const { device } = make({}, { fileExists: () => false, isDirectory: () => false })
    await expect(device.install('/x/app.apk')).rejects.toMatchObject({ toolError: { kind: 'app_path_invalid' } })
    await expect(device.install('/x/My.app')).rejects.toMatchObject({ toolError: { kind: 'app_path_invalid' } })
  })

  it('rejects an app without Info.plist', async () => {
    const { device } = make({}, { fileExists: () => false, isDirectory: () => true })
    await expect(device.install('/x/My.app')).rejects.toMatchObject({ toolError: { kind: 'app_path_invalid' } })
  })
})

describe('IosDevice lifecycle', () => {
  it('stop rethrows a non-DeviceError', async () => {
    const { device } = make({ [`terminate ${UDID} com.x`]: new Error('boom') })
    await expect(device.stop('com.x')).rejects.toThrow('boom')
  })

  it('launch with an activity is unsupported for ios', async () => {
    const { device } = make({})
    await expect(device.launch('com.x', '.Main')).rejects.toMatchObject({
      toolError: { kind: 'unsupported', details: { platform: 'ios' } }
    })
  })

  it('launch maps a not-installed bundle to package_not_found', async () => {
    const failure = deviceError('command_failed', 'x', 'y', { stderr: 'The operation couldn’t be completed. found nothing to launch' })
    const { device } = make({ [`launch ${UDID} com.x`]: failure })
    await expect(device.launch('com.x')).rejects.toMatchObject({ toolError: { kind: 'package_not_found' } })
  })

  it('launch passes other failures through', async () => {
    const failure = deviceError('command_failed', 'x', 'y', { stderr: 'boom' })
    const { device } = make({ [`launch ${UDID} com.x`]: failure })
    await expect(device.launch('com.x')).rejects.toMatchObject({ toolError: { kind: 'command_failed' } })
  })

  it('clearData terminates, resolves the data container, then empties it in order', async () => {
    const order: string[] = []
    const emptyDirectory = vi.fn(async (path: string) => {
      order.push(`empty:${path}`)
    })
    const { simctl, device } = make(
      {
        [`terminate ${UDID} com.x`]: execOk(),
        [`get_app_container ${UDID} com.x data`]: execOk('/sim/data/Containers/Data/Application/ABC\n')
      },
      { emptyDirectory }
    )

    await device.clearData('com.x')

    expect(simctl.calls.map((call) => call[0])).toEqual(['terminate', 'get_app_container'])
    expect(emptyDirectory).toHaveBeenCalledWith('/sim/data/Containers/Data/Application/ABC')
    expect(order).toEqual(['empty:/sim/data/Containers/Data/Application/ABC'])
  })

  it('clearData maps get_app_container failure to package_not_found', async () => {
    const { device } = make({
      [`terminate ${UDID} com.x`]: execOk(),
      [`get_app_container ${UDID} com.x data`]: deviceError('command_failed', 'x', 'y', { stderr: 'No such app' })
    })
    await expect(device.clearData('com.x')).rejects.toMatchObject({ toolError: { kind: 'package_not_found' } })
  })

  it.each([
    ['relative path', 'data/Containers/Data/Application/ABC'],
    ['root', '/'],
    ['multi-line', '/a/data/Containers/Data/Application/A\n/b'],
    ['unrelated absolute path', '/Users/me/Documents']
  ])('clearData refuses a suspicious container path (%s) without emptying', async (_name, stdout) => {
    const emptyDirectory = vi.fn(async () => {})
    const { device } = make(
      { [`terminate ${UDID} com.x`]: execOk(), [`get_app_container ${UDID} com.x data`]: execOk(`${stdout}\n`) },
      { emptyDirectory }
    )
    await expect(device.clearData('com.x')).rejects.toMatchObject({ toolError: { kind: 'command_failed' } })
    expect(emptyDirectory).not.toHaveBeenCalled()
  })

  it('clearData rethrows non-command_failed errors from get_app_container', async () => {
    const { device } = make({
      [`terminate ${UDID} com.x`]: execOk(),
      [`get_app_container ${UDID} com.x data`]: deviceError('no_device', 'x', 'y')
    })
    await expect(device.clearData('com.x')).rejects.toMatchObject({ toolError: { kind: 'no_device' } })
  })

  it('stop rethrows ios_tool_not_found but swallows command_failed', async () => {
    const missing = make({ [`terminate ${UDID} com.x`]: deviceError('ios_tool_not_found', 'x', 'y') })
    await expect(missing.device.stop('com.x')).rejects.toMatchObject({ toolError: { kind: 'ios_tool_not_found' } })
    const notRunning = make({ [`terminate ${UDID} com.x`]: deviceError('command_failed', 'x', 'y') })
    await expect(notRunning.device.stop('com.x')).resolves.toBeUndefined()
  })

  it('grantPermission calls simctl privacy', async () => {
    const { simctl, device } = make({ [`privacy ${UDID} grant photos com.x`]: execOk() })
    await device.grantPermission('com.x', 'photos')
    expect(simctl.calls).toEqual([['privacy', UDID, 'grant', 'photos', 'com.x']])
  })
})
