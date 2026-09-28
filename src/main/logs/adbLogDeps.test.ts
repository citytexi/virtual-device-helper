import { describe, expect, it, vi } from 'vitest'
import type { AdbClient, ExecResult } from '../adb/adbClient'
import { createPidof, createSeedPids } from './adbLogDeps'

function result(stdout: string): ExecResult {
  return { stdout, stdoutRaw: Buffer.from(stdout), stderr: '', exitCode: 0 }
}

describe('createPidof', () => {
  it('parses the pids pidof prints', async () => {
    const exec = vi.fn(async () => result('4321 4400\n'))
    const pidof = createPidof({ exec } as unknown as Pick<AdbClient, 'exec'>)

    expect(await pidof('emulator-5554', 'com.android.settings')).toEqual([4321, 4400])
    expect(exec).toHaveBeenCalledWith('emulator-5554', ['shell', 'pidof', 'com.android.settings'])
  })

  it('returns [] when pidof exits non-zero (package not running)', async () => {
    const exec = vi.fn(async () => {
      throw new Error('exit 1')
    })
    const pidof = createPidof({ exec } as unknown as Pick<AdbClient, 'exec'>)

    expect(await pidof('emulator-5554', 'com.android.settings')).toEqual([])
  })

  it('never sends a non-package name to the device shell', async () => {
    // 스키마를 우회해 들어와도 기기 셸이 다시 파싱할 문자열은 adb까지 가지 않는다.
    const exec = vi.fn(async () => result('1\n'))
    const pidof = createPidof({ exec } as unknown as Pick<AdbClient, 'exec'>)

    expect(await pidof('emulator-5554', 'x; reboot')).toEqual([])
    expect(exec).not.toHaveBeenCalled()
  })
})

describe('createSeedPids', () => {
  it('runs ps -A -o PID,NAME and returns stdout', async () => {
    const exec = vi.fn(async () => result('PID NAME\n1 init\n'))
    const seedPids = createSeedPids({ exec } as unknown as Pick<AdbClient, 'exec'>)

    expect(await seedPids('emulator-5554')).toBe('PID NAME\n1 init\n')
    expect(exec).toHaveBeenCalledWith('emulator-5554', ['shell', 'ps', '-A', '-o', 'PID,NAME'])
  })
})
