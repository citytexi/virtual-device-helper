import { EventEmitter } from 'node:events'
import { Readable } from 'node:stream'
import { describe, expect, it, vi } from 'vitest'
import { deviceError } from '../../shared/types/errors'
import { createProcessClient, type ProcessFailures, type SpawnFn } from './processClient'

interface FakeRun {
  stdout?: string
  stderr?: string
  exitCode?: number
  spawnError?: NodeJS.ErrnoException
  hang?: boolean
}

function fakeSpawn(run: FakeRun): SpawnFn {
  return () => {
    const child = new EventEmitter() as ReturnType<SpawnFn>
    child.stdout = Readable.from([run.stdout ?? ''])
    child.stderr = Readable.from([run.stderr ?? ''])
    child.kill = vi.fn() as never
    if (!run.hang) {
      queueMicrotask(() => {
        if (run.spawnError) child.emit('error', run.spawnError)
        else child.emit('close', run.exitCode ?? 0)
      })
    }
    return child
  }
}

const failures: ProcessFailures = {
  notFound: () => deviceError('adb_not_found', 'INJECTED not found', 'h'),
  spawnFailed: () => deviceError('adb_not_found', 'INJECTED spawn failed', 'h'),
  spawnError: (error) => deviceError('command_failed', `INJECTED spawn error ${error.message}`, 'h'),
  classify: (stderr, args) => deviceError('command_failed', `INJECTED classify ${stderr.trim()} ${args.join(' ')}`, 'h'),
  timedOut: (args, timeoutMs) => deviceError('device_unresponsive', `INJECTED timeout ${timeoutMs} ${args.join(' ')}`, 'h'),
  killed: () => deviceError('command_failed', 'INJECTED killed', 'h'),
  streamReadFailed: (stream) => deviceError('command_failed', `INJECTED read ${stream}`, 'h')
}

describe('processClient.exec failures injection', () => {
  it('rejects with failures.classify on non-zero exit', async () => {
    const client = createProcessClient('tool', failures, fakeSpawn({ stderr: 'boom', exitCode: 1 }))
    await expect(client.exec(['a', 'b'])).rejects.toMatchObject({ message: 'INJECTED classify boom a b' })
  })

  it('rejects with failures.notFound on ENOENT spawn error', async () => {
    const err = Object.assign(new Error('nope'), { code: 'ENOENT' })
    const client = createProcessClient('tool', failures, fakeSpawn({ spawnError: err }))
    await expect(client.exec(['a'])).rejects.toMatchObject({ message: 'INJECTED not found' })
  })

  it('rejects with failures.timedOut on timeout', async () => {
    const client = createProcessClient('tool', failures, fakeSpawn({ hang: true }))
    await expect(client.exec(['a'], { timeoutMs: 10 })).rejects.toMatchObject({ message: 'INJECTED timeout 10 a' })
  })
})
