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

/**
 * 자식 프로세스를 테스트가 직접 조종할 수 있게 만든 spawn이다.
 * 위의 fakeSpawn과 달리 close·stream 에러 시점을 테스트가 정한다.
 */
function controllableSpawn(): {
  spawn: SpawnFn
  stdout: Readable
  stderr: Readable
  close: (code: number | null, signal?: NodeJS.Signals | null) => void
  emitStdoutError: (error: Error) => void
  emitStderrError: (error: Error) => void
  killCalls: Array<NodeJS.Signals | undefined>
} {
  const stdout = new Readable({ read() {} })
  const stderr = new Readable({ read() {} })
  const child = new EventEmitter() as ReturnType<SpawnFn>
  const killCalls: Array<NodeJS.Signals | undefined> = []
  child.stdout = stdout
  child.stderr = stderr
  child.kill = ((signal?: NodeJS.Signals) => {
    killCalls.push(signal)
    return true
  }) as never

  return {
    spawn: () => child,
    stdout,
    stderr,
    close: (code, signal = null) => child.emit('close', code, signal),
    emitStdoutError: (error) => stdout.emit('error', error),
    emitStderrError: (error) => stderr.emit('error', error),
    killCalls
  }
}

describe('adbClient.exec — 스트림 에러와 시그널 종료', () => {
  it('rejects with command_failed when stdout emits an error instead of leaving it uncaught', async () => {
    const fake = controllableSpawn()
    const client = createAdbClient('/opt/sdk/platform-tools/adb', fake.spawn)

    const pending = client.exec(null, ['logcat', '-d'])
    fake.emitStdoutError(new Error('EPIPE'))

    await expect(pending).rejects.toMatchObject({ toolError: { kind: 'command_failed' } })
  })

  it('kills the child process when a stream error fails the command', async () => {
    // M1-1 carry-over 2: failFromStream은 지금 reject만 하고 자식을 죽이지
    // 않는다. main은 오래 도는 Electron 프로세스라 이런 adb 자식이 좀비로
    // 쌓인다. 타임아웃 경로가 이미 하는 child.kill('SIGKILL')을 여기서도 해야 한다.
    const fake = controllableSpawn()
    const client = createAdbClient('/opt/sdk/platform-tools/adb', fake.spawn)

    const pending = client.exec(null, ['logcat', '-d'])
    fake.emitStdoutError(new Error('EPIPE'))

    await pending.catch(() => undefined)

    expect(fake.killCalls).toEqual(['SIGKILL'])
  })

  it('rejects with command_failed when stderr emits an error instead of leaving it uncaught', async () => {
    const fake = controllableSpawn()
    const client = createAdbClient('/opt/sdk/platform-tools/adb', fake.spawn)

    const pending = client.exec(null, ['shell', 'ls'])
    fake.emitStderrError(new Error('EPIPE'))

    await expect(pending).rejects.toMatchObject({ toolError: { kind: 'command_failed' } })
  })

  it('rejects instead of reporting success when the process is killed by a signal', async () => {
    const fake = controllableSpawn()
    const client = createAdbClient('/opt/sdk/platform-tools/adb', fake.spawn)

    const pending = client.exec(null, ['exec-out', 'screencap', '-p'])
    fake.stdout.push(Buffer.from([0x89, 0x50]))
    fake.stdout.push(null)
    fake.stderr.push(null)
    fake.close(null, 'SIGKILL')

    const error = await pending.catch((e: unknown) => e)

    expect(error).toBeInstanceOf(DeviceError)
    expect((error as DeviceError).toolError.kind).toBe('command_failed')
    expect((error as DeviceError).toolError.details?.signal).toBe('SIGKILL')
  })

  it('still reports device_unresponsive when the timeout kill produces a signal close', async () => {
    const fake = controllableSpawn()
    const client = createAdbClient('/opt/sdk/platform-tools/adb', fake.spawn)

    const pending = client.exec(null, ['shell', 'sleep', '99'], { timeoutMs: 10 })
    // 타임아웃이 SIGKILL을 보낸 뒤 실제 close(null, 'SIGKILL')이 도착하는 상황을 만든다.
    setTimeout(() => fake.close(null, 'SIGKILL'), 30)

    await expect(pending).rejects.toMatchObject({ toolError: { kind: 'device_unresponsive' } })
  })
})
