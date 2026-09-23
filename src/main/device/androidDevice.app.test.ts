import { describe, expect, it, vi } from 'vitest'
import type { AdbClient, ExecResult } from '../adb/adbClient'
import { DeviceError, deviceError } from '../../shared/types/errors'
import { createAndroidDevice } from './androidDevice'

function fakeAdb(responses: Record<string, string> = {}): { adb: AdbClient; calls: string[][] } {
  const calls: string[][] = []
  const adb = {
    exec: vi.fn(async (_serial: string | null, args: string[]): Promise<ExecResult> => {
      calls.push(args)
      const key = Object.keys(responses).find((candidate) => args.join(' ').includes(candidate))
      const text = key ? (responses[key] as string) : ''
      return { stdout: text, stdoutRaw: Buffer.from(text), stderr: '', exitCode: 0 }
    }),
    stream: vi.fn()
  } as unknown as AdbClient
  return { adb, calls }
}

const noopResize = (png: Buffer) => ({ png, width: 1, height: 1 })

function makeDevice(adb: AdbClient, fileExists = () => true) {
  return createAndroidDevice({ serial: 'emulator-5554', adb, resizeImage: noopResize, fileExists })
}

describe('AndroidDevice.install', () => {
  it('rejects a path that does not exist', async () => {
    const { adb } = fakeAdb()
    const device = makeDevice(adb, () => false)

    await expect(device.install('/tmp/missing.apk')).rejects.toMatchObject({
      toolError: { kind: 'apk_path_invalid' }
    })
  })

  it('rejects a path that is not an apk', async () => {
    const { adb } = fakeAdb()
    const device = makeDevice(adb)

    await expect(device.install('/tmp/app.zip')).rejects.toMatchObject({
      toolError: { kind: 'apk_path_invalid' }
    })
  })

  it('passes -r when reinstall is requested', async () => {
    const { adb, calls } = fakeAdb({ 'pm list packages': 'package:com.example\n' })
    const device = makeDevice(adb)

    await device.install('/tmp/app.apk', { reinstall: true })

    const installCall = calls.find((args) => args[0] === 'install')
    expect(installCall).toContain('-r')
  })

  it('returns the package name of the freshly installed apk', async () => {
    const before = 'package:com.android.settings\n'
    const after = 'package:com.android.settings\npackage:com.example.app\n'
    let listCount = 0
    const adb = {
      exec: vi.fn(async (_serial: string | null, args: string[]): Promise<ExecResult> => {
        const text = args.join(' ').includes('pm list packages')
          ? (listCount++ === 0 ? before : after)
          : ''
        return { stdout: text, stdoutRaw: Buffer.from(text), stderr: '', exitCode: 0 }
      }),
      stream: vi.fn()
    } as unknown as AdbClient
    const device = makeDevice(adb)

    await expect(device.install('/tmp/app.apk')).resolves.toBe('com.example.app')
  })

  it('returns null rather than an empty string when a reinstall leaves the package list unchanged', async () => {
    // 에이전트의 rebuild 루프에서는 이 경로가 정상 경로다: 늘 reinstall: true이고
    // 패키지는 이미 깔려 있다. 빈 문자열을 돌려주면 그대로 app_launch로 흘러가
    // package_not_found가 된다. 모르는 값은 이 브랜치의 나머지와 같이 null로 말한다.
    const { adb } = fakeAdb({ 'pm list packages': 'package:com.example.app\n' })
    const device = makeDevice(adb)

    await expect(device.install('/tmp/app.apk', { reinstall: true })).resolves.toBeNull()
  })

  it('gives a specific message and an app_uninstall recovery hint for a signature mismatch (R6)', async () => {
    // 실제 실기기 통합 테스트에서 관찰된 stderr 그대로다: 다른 서명 키로 설치된
    // 패키지 위에 덮어쓰려 할 때 adb가 이 문구를 낸다.
    const stderr =
      'adb: failed to install /tmp/app.apk: Failure [INSTALL_FAILED_UPDATE_INCOMPATIBLE: Existing package com.teamyg.parfait signatures do not match newer version; ignoring!]'
    const adb = {
      exec: vi.fn(async (_serial: string | null, args: string[]): Promise<ExecResult> => {
        if (args[0] === 'install') {
          throw deviceError('command_failed', `adb 명령이 실패했다: ${args.join(' ')}`, '첨부된 stderr를 확인해라', {
            stderr,
            args
          })
        }
        return { stdout: '', stdoutRaw: Buffer.alloc(0), stderr: '', exitCode: 0 }
      }),
      stream: vi.fn()
    } as unknown as AdbClient
    const device = makeDevice(adb)

    const error = await device.install('/tmp/app.apk').catch((e: unknown) => e)

    expect(error).toBeInstanceOf(DeviceError)
    const toolError = (error as DeviceError).toolError
    expect(toolError.kind).toBe('command_failed')
    expect(toolError.message).toContain('com.teamyg.parfait')
    expect(toolError.hint).toContain('app_uninstall')
    expect(toolError.hint).toContain('app_install')
    expect(toolError.details?.reason).toBe('INSTALL_FAILED_UPDATE_INCOMPATIBLE')
    expect(toolError.details?.stderr).toBe(stderr)
  })

  it('gives the same recovery hint for a version downgrade conflict (R6)', async () => {
    const stderr =
      'adb: failed to install /tmp/app.apk: Failure [INSTALL_FAILED_VERSION_DOWNGRADE: Downgrade detected: Package com.example.app new version code 3 is lower than current 5]'
    const adb = {
      exec: vi.fn(async (_serial: string | null, args: string[]): Promise<ExecResult> => {
        if (args[0] === 'install') {
          throw deviceError('command_failed', `adb 명령이 실패했다: ${args.join(' ')}`, '첨부된 stderr를 확인해라', {
            stderr,
            args
          })
        }
        return { stdout: '', stdoutRaw: Buffer.alloc(0), stderr: '', exitCode: 0 }
      }),
      stream: vi.fn()
    } as unknown as AdbClient
    const device = makeDevice(adb)

    const error = await device.install('/tmp/app.apk').catch((e: unknown) => e)

    expect(error).toBeInstanceOf(DeviceError)
    const toolError = (error as DeviceError).toolError
    expect(toolError.kind).toBe('command_failed')
    expect(toolError.message).toContain('com.example.app')
    expect(toolError.hint).toContain('app_uninstall')
    expect(toolError.details?.reason).toBe('INSTALL_FAILED_VERSION_DOWNGRADE')
    expect(toolError.details?.stderr).toBe(stderr)
  })
})

describe('AndroidDevice app commands', () => {
  it('uses monkey to launch when no activity is given', async () => {
    const { adb, calls } = fakeAdb({ 'pm list packages': 'package:com.example.app\n' })
    const device = makeDevice(adb)

    await device.launch('com.example.app')

    expect(calls.some((args) => args.includes('monkey') && args.includes('com.example.app'))).toBe(true)
  })

  it('uses am start with an explicit component when an activity is given', async () => {
    const { adb, calls } = fakeAdb({ 'pm list packages': 'package:com.example.app\n' })
    const device = makeDevice(adb)

    await device.launch('com.example.app', '.MainActivity')

    const start = calls.find((args) => args.includes('am'))
    expect(start).toContain('com.example.app/.MainActivity')
  })

  it('force-stops with am force-stop', async () => {
    const { adb, calls } = fakeAdb()
    const device = makeDevice(adb)

    await device.stop('com.example.app')

    expect(calls.some((args) => args.includes('force-stop'))).toBe(true)
  })

  it('clears data with pm clear', async () => {
    const { adb, calls } = fakeAdb({ 'pm list packages': 'package:com.example.app\n' })
    const device = makeDevice(adb)

    await device.clearData('com.example.app')

    expect(calls.some((args) => args.includes('clear'))).toBe(true)
  })

  it('grants a permission with pm grant', async () => {
    const { adb, calls } = fakeAdb({ 'pm list packages': 'package:com.example.app\n' })
    const device = makeDevice(adb)

    await device.grantPermission('com.example.app', 'android.permission.CAMERA')

    const grant = calls.find((args) => args.includes('grant'))
    expect(grant).toContain('android.permission.CAMERA')
  })

  it('reports package_not_found when uninstalling something that is not installed', async () => {
    const { adb } = fakeAdb({ 'pm list packages': '' })
    const device = makeDevice(adb)

    await expect(device.uninstall('com.example.missing')).rejects.toMatchObject({
      toolError: { kind: 'package_not_found' }
    })
  })
})
