import { EventEmitter } from 'node:events'
import { Readable } from 'node:stream'
import { describe, expect, it, vi } from 'vitest'
import { createAdbClient, type SpawnFn } from './adbClient'

function pushableSpawn(): {
  spawn: SpawnFn
  push: (chunk: string) => void
  close: (code: number) => void
  killed: () => boolean
  emitChildError: (error: Error) => void
  emitStdoutError: (error: Error) => void
} {
  let killed = false
  const stdout = new Readable({ read() {} })
  const child = new EventEmitter() as ReturnType<SpawnFn>
  child.stdout = stdout
  child.stderr = new Readable({ read() {} })
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
    emitStdoutError: (error) => stdout.emit('error', error)
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
