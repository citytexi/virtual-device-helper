import { EventEmitter } from 'node:events'
import { Readable } from 'node:stream'
import { describe, expect, it, vi } from 'vitest'
import { createAdbClient, type SpawnFn } from './adbClient'

function pushableSpawn(): { spawn: SpawnFn; push: (chunk: string) => void; close: (code: number) => void; killed: () => boolean } {
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
    killed: () => killed
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
})
