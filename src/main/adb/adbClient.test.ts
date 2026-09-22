import { EventEmitter } from 'node:events'
import { Readable } from 'node:stream'
import { describe, expect, it, vi } from 'vitest'
import { DeviceError } from '../../shared/types/errors'
import { createAdbClient, type SpawnFn } from './adbClient'

interface FakeRun {
  stdout?: string | Buffer
  stderr?: string
  exitCode?: number
  spawnError?: NodeJS.ErrnoException
}

/** spawn 한 번을 흉내 낸다. 인자를 기록해 검증에 쓴다. */
function fakeSpawn(run: FakeRun): { spawn: SpawnFn; calls: string[][] } {
  const calls: string[][] = []
  const spawn: SpawnFn = (_command, args) => {
    calls.push(args)
    const child = new EventEmitter() as ReturnType<SpawnFn>
    child.stdout = Readable.from([run.stdout ?? ''])
    child.stderr = Readable.from([run.stderr ?? ''])
    child.kill = vi.fn() as never
    queueMicrotask(() => {
      if (run.spawnError) child.emit('error', run.spawnError)
      else child.emit('close', run.exitCode ?? 0)
    })
    return child
  }
  return { spawn, calls }
}

describe('adbClient.exec', () => {
  it('passes -s <serial> before the command when a serial is given', async () => {
    const { spawn, calls } = fakeSpawn({ stdout: 'ok' })
    const client = createAdbClient('/opt/sdk/platform-tools/adb', spawn)

    await client.exec('emulator-5554', ['shell', 'echo', 'hi'])

    expect(calls[0]).toEqual(['-s', 'emulator-5554', 'shell', 'echo', 'hi'])
  })

  it('omits -s when serial is null', async () => {
    const { spawn, calls } = fakeSpawn({ stdout: 'ok' })
    const client = createAdbClient('/opt/sdk/platform-tools/adb', spawn)

    await client.exec(null, ['devices', '-l'])

    expect(calls[0]).toEqual(['devices', '-l'])
  })

  it('returns stdout as both text and raw bytes', async () => {
    const { spawn } = fakeSpawn({ stdout: Buffer.from([0x89, 0x50, 0x4e, 0x47]) })
    const client = createAdbClient('/opt/sdk/platform-tools/adb', spawn)

    const result = await client.exec(null, ['exec-out', 'screencap', '-p'])

    expect(result.stdoutRaw).toEqual(Buffer.from([0x89, 0x50, 0x4e, 0x47]))
    expect(result.exitCode).toBe(0)
  })

  it('throws adb_not_found when the binary is missing', async () => {
    const enoent: NodeJS.ErrnoException = Object.assign(new Error('spawn ENOENT'), { code: 'ENOENT' })
    const { spawn } = fakeSpawn({ spawnError: enoent })
    const client = createAdbClient('/opt/sdk/platform-tools/adb', spawn)

    await expect(client.exec(null, ['devices'])).rejects.toMatchObject({
      toolError: { kind: 'adb_not_found' }
    })
  })

  it('throws no_device when adb reports no devices', async () => {
    const { spawn } = fakeSpawn({ stderr: 'error: no devices/emulators found', exitCode: 1 })
    const client = createAdbClient('/opt/sdk/platform-tools/adb', spawn)

    await expect(client.exec(null, ['shell', 'ls'])).rejects.toMatchObject({
      toolError: { kind: 'no_device' }
    })
  })

  it('throws ambiguous_device when adb reports more than one device', async () => {
    const { spawn } = fakeSpawn({ stderr: 'adb: error: more than one device/emulator', exitCode: 1 })
    const client = createAdbClient('/opt/sdk/platform-tools/adb', spawn)

    await expect(client.exec(null, ['shell', 'ls'])).rejects.toMatchObject({
      toolError: { kind: 'ambiguous_device' }
    })
  })

  it('throws command_failed with the original stderr attached', async () => {
    const { spawn } = fakeSpawn({ stderr: 'something specific went wrong', exitCode: 1 })
    const client = createAdbClient('/opt/sdk/platform-tools/adb', spawn)

    const error = await client.exec(null, ['shell', 'ls']).catch((e: unknown) => e)

    expect(error).toBeInstanceOf(DeviceError)
    expect((error as DeviceError).toolError.kind).toBe('command_failed')
    expect((error as DeviceError).toolError.details?.stderr).toBe('something specific went wrong')
  })

  it('throws device_unresponsive when the command exceeds its timeout', async () => {
    const spawn: SpawnFn = () => {
      const child = new EventEmitter() as ReturnType<SpawnFn>
      child.stdout = new Readable({ read() {} })
      child.stderr = new Readable({ read() {} })
      child.kill = vi.fn() as never
      return child
    }
    const client = createAdbClient('/opt/sdk/platform-tools/adb', spawn)

    await expect(client.exec(null, ['shell', 'sleep', '99'], { timeoutMs: 10 })).rejects.toMatchObject({
      toolError: { kind: 'device_unresponsive' }
    })
  })
})
