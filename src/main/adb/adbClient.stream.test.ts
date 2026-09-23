import { EventEmitter } from 'node:events'
import { Readable } from 'node:stream'
import { describe, expect, it, vi } from 'vitest'
import type { DeviceError } from '../../shared/types/errors'
import { STDERR_TAIL_LIMIT_BYTES, createAdbClient, type SpawnFn } from './adbClient'

function pushableSpawn(): {
  spawn: SpawnFn
  push: (chunk: string) => void
  close: (code: number) => void
  killed: () => boolean
  emitChildError: (error: Error) => void
  emitStdoutError: (error: Error) => void
  pushStderr: (chunk: string) => void
} {
  let killed = false
  const stdout = new Readable({ read() {} })
  const stderr = new Readable({ read() {} })
  const child = new EventEmitter() as ReturnType<SpawnFn>
  child.stdout = stdout
  child.stderr = stderr
  child.kill = vi.fn(() => {
    killed = true
    return true
  }) as never

  return {
    spawn: () => child,
    push: (chunk) => stdout.push(chunk),
    close: (code) => child.emit('close', code),
    killed: () => killed,
    emitChildError: (error) => child.emit('error', error),
    emitStdoutError: (error) => stdout.emit('error', error),
    pushStderr: (chunk) => stderr.push(chunk)
  }
}

describe('adbClient.stream', () => {
  it('emits one callback per complete line', async () => {
    const fake = pushableSpawn()
    const client = createAdbClient('/opt/sdk/platform-tools/adb', fake.spawn)
    const lines: string[] = []

    const stream = client.stream(null, ['track-devices'])
    stream.onLine((line) => lines.push(line))

    fake.push('first\nsecond\n')
    await vi.waitFor(() => expect(lines).toEqual(['first', 'second']))

    stream.close()
  })

  it('holds a partial line until its newline arrives', async () => {
    const fake = pushableSpawn()
    const client = createAdbClient('/opt/sdk/platform-tools/adb', fake.spawn)
    const lines: string[] = []

    const stream = client.stream(null, ['logcat'])
    stream.onLine((line) => lines.push(line))

    fake.push('half')
    await new Promise((r) => setTimeout(r, 5))
    expect(lines).toEqual([])

    fake.push('-line\n')
    await vi.waitFor(() => expect(lines).toEqual(['half-line']))

    stream.close()
  })

  it('reports the exit code on close', async () => {
    const fake = pushableSpawn()
    const client = createAdbClient('/opt/sdk/platform-tools/adb', fake.spawn)
    let closedWith: number | null | undefined

    const stream = client.stream(null, ['track-devices'])
    stream.onClose((code) => {
      closedWith = code
    })

    fake.close(0)
    await vi.waitFor(() => expect(closedWith).toBe(0))
  })

  it('kills the child process when closed', () => {
    const fake = pushableSpawn()
    const client = createAdbClient('/opt/sdk/platform-tools/adb', fake.spawn)

    client.stream(null, ['logcat']).close()

    expect(fake.killed()).toBe(true)
  })

  it('reports adb_not_found through onError when spawn fails with ENOENT', async () => {
    const fake = pushableSpawn()
    const client = createAdbClient('/opt/sdk/platform-tools/adb', fake.spawn)
    const errors: unknown[] = []

    const stream = client.stream(null, ['track-devices'])
    stream.onError((error) => errors.push(error))

    const enoent: NodeJS.ErrnoException = Object.assign(new Error('spawn ENOENT'), { code: 'ENOENT' })
    fake.emitChildError(enoent)

    await vi.waitFor(() => expect(errors).toHaveLength(1))
    expect(errors[0]).toMatchObject({ toolError: { kind: 'adb_not_found' } })
  })

  it('reports command_failed through onError when stdout errors, and still closes so consumers do not hang', async () => {
    const fake = pushableSpawn()
    const client = createAdbClient('/opt/sdk/platform-tools/adb', fake.spawn)
    const errors: unknown[] = []
    let closeCalls = 0
    let closedWith: number | null | undefined

    const stream = client.stream(null, ['logcat'])
    stream.onError((error) => errors.push(error))
    stream.onClose((code) => {
      closeCalls++
      closedWith = code
    })

    fake.emitStdoutError(new Error('EPIPE'))

    await vi.waitFor(() => expect(errors).toHaveLength(1))
    expect(errors[0]).toMatchObject({ toolError: { kind: 'command_failed' } })

    await vi.waitFor(() => expect(closeCalls).toBe(1))
    expect(closedWith).toBeNull()

    // 실제 close 이벤트가 나중에 와도 onClose가 중복 호출되지 않아야 한다.
    fake.close(1)
    await new Promise((r) => setTimeout(r, 5))
    expect(closeCalls).toBe(1)
  })

  it('does not deliver a second error after close has already been reported', async () => {
    // M1-1 carry-over 1: stdout error가 notifyClose(null)까지 먼저 끝내 놓은
    // 뒤에, 실제 close 이벤트가 비정상 종료 코드로 뒤따라오면 deliverError가
    // 한 번 더 불려서 "에러 뒤에는 반드시 onClose가 뒤따른다"는 onError의
    // 계약을 깬다(error → close → error). closeNotified 가드로 이걸 막는다.
    const fake = pushableSpawn()
    const client = createAdbClient('/opt/sdk/platform-tools/adb', fake.spawn)
    const errors: unknown[] = []
    const closes: Array<number | null> = []

    const stream = client.stream(null, ['logcat'])
    stream.onError((error) => errors.push(error))
    stream.onClose((code) => closes.push(code))

    fake.emitStdoutError(new Error('EPIPE'))
    await vi.waitFor(() => expect(errors).toHaveLength(1))
    await vi.waitFor(() => expect(closes).toHaveLength(1))

    // 실제 close가 비정상 종료 코드로 뒤따라온다. stderr에는 분류 가능한
    // 실패 문구까지 실어서, 고쳐지지 않았다면 두 번째 에러가 나가게 만든다.
    fake.pushStderr('error: no devices/emulators found\n')
    fake.close(1)
    await new Promise((r) => setTimeout(r, 5))

    expect(errors).toHaveLength(1)
    expect(closes).toHaveLength(1)
  })

  it('does not call onLine for data received after close', async () => {
    const fake = pushableSpawn()
    const client = createAdbClient('/opt/sdk/platform-tools/adb', fake.spawn)
    const lines: string[] = []

    const stream = client.stream(null, ['logcat'])
    stream.onLine((line) => lines.push(line))

    stream.close()
    fake.push('late-line\n')
    await new Promise((r) => setTimeout(r, 5))

    expect(lines).toEqual([])
  })

  it('does not call onClose for a close event received after close', async () => {
    const fake = pushableSpawn()
    const client = createAdbClient('/opt/sdk/platform-tools/adb', fake.spawn)
    let closeCalls = 0

    const stream = client.stream(null, ['track-devices'])
    stream.onClose(() => {
      closeCalls++
    })

    stream.close()
    fake.close(0)
    await new Promise((r) => setTimeout(r, 5))

    expect(closeCalls).toBe(0)
  })
})

describe('adbClient.stream — raw 청크와 stderr 분류', () => {
  it('delivers raw stdout chunks through onData', async () => {
    const fake = pushableSpawn()
    const client = createAdbClient('/opt/sdk/platform-tools/adb', fake.spawn)
    const chunks: Buffer[] = []

    const stream = client.stream(null, ['track-devices'])
    stream.onData((chunk) => chunks.push(chunk))

    fake.push('0013RFCXC00V8AZ\tdevice\n')
    await vi.waitFor(() => expect(chunks).toHaveLength(1))
    expect(Buffer.concat(chunks).toString('utf8')).toBe('0013RFCXC00V8AZ\tdevice\n')

    stream.close()
  })

  it('feeds onData and onLine from the same stream at once', async () => {
    const fake = pushableSpawn()
    const client = createAdbClient('/opt/sdk/platform-tools/adb', fake.spawn)
    const chunks: Buffer[] = []
    const lines: string[] = []

    const stream = client.stream(null, ['logcat'])
    stream.onData((chunk) => chunks.push(chunk))
    stream.onLine((line) => lines.push(line))

    fake.push('one\ntwo\n')
    await vi.waitFor(() => expect(lines).toEqual(['one', 'two']))
    expect(Buffer.concat(chunks).toString('utf8')).toBe('one\ntwo\n')

    stream.close()
  })

  it('does not call onData for data received after close', async () => {
    const fake = pushableSpawn()
    const client = createAdbClient('/opt/sdk/platform-tools/adb', fake.spawn)
    const chunks: Buffer[] = []

    const stream = client.stream(null, ['track-devices'])
    stream.onData((chunk) => chunks.push(chunk))

    stream.close()
    fake.push('late')
    await new Promise((r) => setTimeout(r, 5))

    expect(chunks).toEqual([])
  })

  it('flushes a trailing line without a newline before reporting close', async () => {
    const fake = pushableSpawn()
    const client = createAdbClient('/opt/sdk/platform-tools/adb', fake.spawn)
    const events: string[] = []

    const stream = client.stream(null, ['logcat'])
    stream.onLine((line) => events.push(`line:${line}`))
    stream.onClose((code) => events.push(`close:${code}`))

    fake.push('last-line-without-newline')
    await new Promise((r) => setTimeout(r, 5))
    fake.close(0)

    await vi.waitFor(() => expect(events).toEqual(['line:last-line-without-newline', 'close:0']))
  })

  it('classifies stderr through the same path as exec on a non-zero close, before onClose', async () => {
    const fake = pushableSpawn()
    const client = createAdbClient('/opt/sdk/platform-tools/adb', fake.spawn)
    const events: string[] = []

    const stream = client.stream('emulator-5554', ['logcat'])
    stream.onError((error) => events.push(`error:${error.toolError.kind}`))
    stream.onClose((code) => events.push(`close:${code}`))

    fake.pushStderr('error: no devices/emulators found\n')
    await new Promise((r) => setTimeout(r, 5))
    fake.close(1)

    await vi.waitFor(() => expect(events).toEqual(['error:no_device', 'close:1']))
  })

  it('reports command_failed with the raw stderr attached when adb fails for an unknown reason', async () => {
    const fake = pushableSpawn()
    const client = createAdbClient('/opt/sdk/platform-tools/adb', fake.spawn)
    const errors: DeviceError[] = []

    const stream = client.stream(null, ['logcat'])
    stream.onError((error) => errors.push(error))

    fake.pushStderr('something specific went wrong\n')
    await new Promise((r) => setTimeout(r, 5))
    fake.close(1)

    await vi.waitFor(() => expect(errors).toHaveLength(1))
    expect(errors[0]?.toolError.kind).toBe('command_failed')
    expect(errors[0]?.toolError.details?.stderr).toBe('something specific went wrong')
  })

  it('does not report an error when the stream closes cleanly with stderr noise', async () => {
    const fake = pushableSpawn()
    const client = createAdbClient('/opt/sdk/platform-tools/adb', fake.spawn)
    const errors: DeviceError[] = []
    const closes: Array<number | null> = []

    const stream = client.stream(null, ['logcat'])
    stream.onError((error) => errors.push(error))
    stream.onClose((code) => closes.push(code))

    fake.pushStderr('adb: warning: something harmless\n')
    await new Promise((r) => setTimeout(r, 5))
    fake.close(0)

    await vi.waitFor(() => expect(closes).toEqual([0]))
    expect(errors).toEqual([])
  })

  it('keeps only the tail of stderr so a chatty stream cannot grow without bound', async () => {
    const fake = pushableSpawn()
    const client = createAdbClient('/opt/sdk/platform-tools/adb', fake.spawn)
    const errors: DeviceError[] = []

    const stream = client.stream(null, ['logcat'])
    stream.onError((error) => errors.push(error))

    for (let i = 0; i < 40; i++) fake.pushStderr('x'.repeat(1024))
    fake.pushStderr('TAIL-MARKER')
    await new Promise((r) => setTimeout(r, 5))
    fake.close(1)

    await vi.waitFor(() => expect(errors).toHaveLength(1))
    const captured = errors[0]?.toolError.details?.stderr as string
    expect(captured.endsWith('TAIL-MARKER')).toBe(true)
    expect(captured.length).toBeLessThanOrEqual(STDERR_TAIL_LIMIT_BYTES)
  })

  it('reports adb_not_found through onError when spawnFn throws synchronously', async () => {
    const throwingSpawn: SpawnFn = () => {
      throw new Error('spawn failed')
    }
    const client = createAdbClient('/opt/sdk/platform-tools/adb', throwingSpawn)
    const errors: DeviceError[] = []
    const closes: Array<number | null> = []

    const stream = client.stream(null, ['track-devices'])
    stream.onError((error) => errors.push(error))
    stream.onClose((code) => closes.push(code))

    await vi.waitFor(() => expect(errors).toHaveLength(1))
    expect(errors[0]?.toolError.kind).toBe('adb_not_found')
    expect(closes).toEqual([null])

    stream.close()
  })
})
