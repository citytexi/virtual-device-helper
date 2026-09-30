import { EventEmitter } from 'node:events'
import { Readable } from 'node:stream'
import { describe, expect, it, vi } from 'vitest'
import type { SpawnFn } from '../process/processClient'
import { createAxeClient } from './axeClient'

interface FakeRun {
  stdout?: string
  stderr?: string
  exitCode?: number
  spawnError?: NodeJS.ErrnoException
}

function fakeSpawn(run: FakeRun): { spawn: SpawnFn; calls: Array<{ command: string; args: string[] }> } {
  const calls: Array<{ command: string; args: string[] }> = []
  const spawn: SpawnFn = (command, args) => {
    calls.push({ command, args })
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

describe('createAxeClient', () => {
  it('appends --udid after the arguments and runs the given axe path', async () => {
    const { spawn, calls } = fakeSpawn({})

    await createAxeClient('/opt/homebrew/bin/axe', spawn).exec('U', ['tap', '-x', '1'])

    expect(calls).toEqual([{ command: '/opt/homebrew/bin/axe', args: ['tap', '-x', '1', '--udid', 'U'] }])
  })

  it('maps a missing binary to ios_tool_not_found with the install hint', async () => {
    const err = Object.assign(new Error('nope'), { code: 'ENOENT' })
    const { spawn } = fakeSpawn({ spawnError: err })

    await expect(createAxeClient('/x/axe', spawn).exec('U', ['list-simulators'])).rejects.toMatchObject({
      toolError: { kind: 'ios_tool_not_found', hint: 'brew install cameroncooke/axe/axe로 설치하고 앱을 다시 켜라' }
    })
  })

  it('maps a non-zero exit to command_failed with stderr and args', async () => {
    const { spawn } = fakeSpawn({ stderr: 'boom\n', exitCode: 1 })

    await expect(createAxeClient('/x/axe', spawn).exec('U', ['tap'])).rejects.toMatchObject({
      toolError: { kind: 'command_failed', details: { stderr: 'boom', args: ['tap', '--udid', 'U'] } }
    })
  })

  it('appends --udid to stream arguments too', async () => {
    const { spawn, calls } = fakeSpawn({})
    const stream = createAxeClient('/x/axe', spawn).stream('U', ['stream-video'])
    stream.onError(() => {})
    await new Promise<void>((resolve) => stream.onClose(() => resolve()))

    expect(calls[0]!.args).toEqual(['stream-video', '--udid', 'U'])
  })
})
