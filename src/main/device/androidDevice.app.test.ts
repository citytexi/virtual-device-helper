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

  it('hints at app_launch, not the non-existent app_list tool, when the installed package name cannot be determined (R9)', async () => {
    const before = 'package:com.android.settings\n'
    const after = 'package:com.android.settings\npackage:com.example.a\npackage:com.example.b\n'
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

    const error = await device.install('/tmp/app.apk').catch((e: unknown) => e)

    expect(error).toBeInstanceOf(DeviceError)
    const toolError = (error as DeviceError).toolError
    expect(toolError.kind).toBe('command_failed')
    expect(toolError.hint).not.toContain('app_list')
    expect(toolError.hint).toContain('app_launch')
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
  it('resolves the launcher activity and starts it with am start when no activity is given (R9)', async () => {
    // 실기기(API 36, emulator-5554)에서 받은 실제 출력이다. monkey는 이 기기에서
    // exit 251로 죽어서 더 이상 쓰지 않는다.
    const { adb, calls } = fakeAdb({
      'pm list packages': 'package:com.teamyg.parfait\n',
      'resolve-activity': 'priority=0 preferredOrder=0 match=0x108000 specificIndex=-1 isDefault=false\ncom.teamyg.parfait/.MainActivity'
    })
    const device = makeDevice(adb)

    await device.launch('com.teamyg.parfait')

    expect(calls.some((args) => args.includes('monkey'))).toBe(false)
    const resolve = calls.find((args) => args.includes('resolve-activity'))
    expect(resolve).toContain('com.teamyg.parfait')
    const start = calls.find((args) => args.includes('am') && args.includes('start'))
    // 원격 셸이 인자를 이어 붙여 다시 해석하므로 컴포넌트는 작은따옴표로 감싸 보낸다.
    expect(start).toContain("'com.teamyg.parfait/.MainActivity'")
  })

  it('throws a Korean command_failed with a hint to pass activity when the package has no launcher activity (R9)', async () => {
    // 실기기에서 런처 액티비티가 없는 패키지에 resolve-activity를 돌리면 이렇게 나온다.
    const { adb } = fakeAdb({
      'pm list packages': 'package:com.example.does.not.exist\n',
      'resolve-activity': 'No activity found'
    })
    const device = makeDevice(adb)

    const error = await device.launch('com.example.does.not.exist').catch((e: unknown) => e)

    expect(error).toBeInstanceOf(DeviceError)
    const toolError = (error as DeviceError).toolError
    expect(toolError.kind).toBe('command_failed')
    expect(toolError.message).toMatch(/런처|launcher/i)
    expect(toolError.hint).toContain('activity')
    expect(toolError.hint).toContain('app_launch')
  })

  it('throws command_failed with the am start Error line when the launcher component does not exist (R9)', async () => {
    // 실기기에서 관찰된 stderr: exit 1, "Error type 3" 다음 줄에 활동 클래스가 없다는
    // 메시지가 온다. adbClient의 classify()가 이 stderr를 command_failed의
    // details.stderr에 담아 던진다.
    const stderr =
      'Error type 3\nError: Activity class {com.teamyg.parfait/com.teamyg.parfait.Nope} does not exist.'
    const adb = {
      exec: vi.fn(async (_serial: string | null, args: string[]): Promise<ExecResult> => {
        if (args.join(' ').includes('resolve-activity')) {
          return {
            stdout: 'com.teamyg.parfait/.Nope',
            stdoutRaw: Buffer.alloc(0),
            stderr: '',
            exitCode: 0
          }
        }
        if (args.includes('am') && args.includes('start')) {
          throw deviceError('command_failed', `adb 명령이 실패했다: ${args.join(' ')}`, '첨부된 stderr를 확인해라', {
            stderr,
            args
          })
        }
        const text = args.join(' ').includes('pm list packages') ? 'package:com.teamyg.parfait\n' : ''
        return { stdout: text, stdoutRaw: Buffer.from(text), stderr: '', exitCode: 0 }
      }),
      stream: vi.fn()
    } as unknown as AdbClient
    const device = makeDevice(adb)

    const error = await device.launch('com.teamyg.parfait').catch((e: unknown) => e)

    expect(error).toBeInstanceOf(DeviceError)
    const toolError = (error as DeviceError).toolError
    expect(toolError.kind).toBe('command_failed')
    expect(toolError.message).toContain('Error: Activity class {com.teamyg.parfait/com.teamyg.parfait.Nope} does not exist.')
    expect(toolError.hint).toContain('activity')
    // non-zero exit 경로다. 원인은 adbClient가 담아 준 stderr에 있고, output 필드는 쓰지 않는다.
    expect(toolError.details?.stderr).toContain('does not exist')
    expect(toolError.details?.output).toBeUndefined()
  })

  it('applies the same am start Error handling to the explicit-activity branch (R9)', async () => {
    const stderr =
      'Error type 3\nError: Activity class {com.teamyg.parfait/com.teamyg.parfait.Nope} does not exist.'
    const adb = {
      exec: vi.fn(async (_serial: string | null, args: string[]): Promise<ExecResult> => {
        if (args.includes('am') && args.includes('start')) {
          throw deviceError('command_failed', `adb 명령이 실패했다: ${args.join(' ')}`, '첨부된 stderr를 확인해라', {
            stderr,
            args
          })
        }
        const text = args.join(' ').includes('pm list packages') ? 'package:com.teamyg.parfait\n' : ''
        return { stdout: text, stdoutRaw: Buffer.from(text), stderr: '', exitCode: 0 }
      }),
      stream: vi.fn()
    } as unknown as AdbClient
    const device = makeDevice(adb)

    const error = await device.launch('com.teamyg.parfait', '.Nope').catch((e: unknown) => e)

    expect(error).toBeInstanceOf(DeviceError)
    const toolError = (error as DeviceError).toolError
    expect(toolError.kind).toBe('command_failed')
    expect(toolError.message).toContain('Error: Activity class {com.teamyg.parfait/com.teamyg.parfait.Nope} does not exist.')
  })

  it('treats a resolver line that is not under the package as no launcher activity (ResolverActivity)', async () => {
    // 런처 액티비티를 하나로 정하지 못하면 resolve-activity가 시스템의 선택 화면
    // (ResolverActivity)을 돌려줄 수 있다. 그 컴포넌트는 이 패키지가 아니므로 실행하지 않는다.
    const { adb, calls } = fakeAdb({
      'pm list packages': 'package:com.example.app\n',
      'resolve-activity': 'priority=0 preferredOrder=0 match=0x0 specificIndex=-1 isDefault=false\nandroid/com.android.internal.app.ResolverActivity'
    })
    const device = makeDevice(adb)

    const error = await device.launch('com.example.app').catch((e: unknown) => e)

    expect(error).toBeInstanceOf(DeviceError)
    const toolError = (error as DeviceError).toolError
    expect(toolError.kind).toBe('command_failed')
    expect(toolError.message).toMatch(/런처|launcher/i)
    expect(toolError.hint).toContain('activity')
    expect(toolError.hint).toContain('app_launch')
    expect(calls.some((args) => args.includes('am') && args.includes('start'))).toBe(false)
  })

  it('fails with the Error line when am start exits 0 but prints an Error line on stdout (defensive)', async () => {
    // 이 모양(exit 0 + stdout의 Error 줄)은 실기기에서 관찰한 것이 아니다. am start가
    // 종료 코드 없이 실패를 말하는 경우를 대비한 방어 경로다.
    const stdout =
      'Starting: Intent { cmp=com.example.app/.Missing }\nError: Activity not started, unable to resolve Intent { cmp=com.example.app/.Missing }'
    const { adb } = fakeAdb({ 'pm list packages': 'package:com.example.app\n', 'am start': stdout })
    const device = makeDevice(adb)

    const error = await device.launch('com.example.app', '.Missing').catch((e: unknown) => e)

    expect(error).toBeInstanceOf(DeviceError)
    const toolError = (error as DeviceError).toolError
    expect(toolError.kind).toBe('command_failed')
    expect(toolError.message).toContain('Error: Activity not started')
    expect(toolError.details?.output).toContain('unable to resolve Intent')
    expect(toolError.details?.stderr).toBeUndefined()
  })

  it('keeps a $ in a nested class name intact by single-quoting the component for the remote shell', async () => {
    const { adb, calls } = fakeAdb({ 'pm list packages': 'package:com.example.app\n' })
    const device = makeDevice(adb)

    await device.launch('com.example.app', '.Outer$Inner')

    const start = calls.find((args) => args.includes('am') && args.includes('start'))
    expect(start).toEqual(['shell', 'am', 'start', '-n', "'com.example.app/.Outer$Inner'"])
  })

  it('rejects an activity with shell metacharacters before running am start', async () => {
    const { adb, calls } = fakeAdb({ 'pm list packages': 'package:com.example.app\n' })
    const device = makeDevice(adb)

    const error = await device.launch('com.example.app', '.Main;reboot').catch((e: unknown) => e)

    expect(error).toBeInstanceOf(DeviceError)
    const toolError = (error as DeviceError).toolError
    expect(toolError.kind).toBe('command_failed')
    expect(toolError.hint).toContain('activity')
    expect(calls.some((args) => args.includes('am') && args.includes('start'))).toBe(false)
  })

  it('rejects a resolved launcher component with shell metacharacters before running am start', async () => {
    const { adb, calls } = fakeAdb({
      'pm list packages': 'package:com.example.app\n',
      'resolve-activity': 'com.example.app/.Main;reboot'
    })
    const device = makeDevice(adb)

    const error = await device.launch('com.example.app').catch((e: unknown) => e)

    expect(error).toBeInstanceOf(DeviceError)
    expect((error as DeviceError).toolError.kind).toBe('command_failed')
    expect(calls.some((args) => args.includes('am') && args.includes('start'))).toBe(false)
  })

  it('uses am start with an explicit component when an activity is given', async () => {
    const { adb, calls } = fakeAdb({ 'pm list packages': 'package:com.example.app\n' })
    const device = makeDevice(adb)

    await device.launch('com.example.app', '.MainActivity')

    const start = calls.find((args) => args.includes('am'))
    expect(start).toContain("'com.example.app/.MainActivity'")
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
