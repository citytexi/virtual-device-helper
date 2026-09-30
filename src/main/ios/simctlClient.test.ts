import { EventEmitter } from 'node:events'
import { Readable } from 'node:stream'
import { describe, expect, it, vi } from 'vitest'
import type { SpawnFn } from '../process/processClient'
import { createSimctlClient } from './simctlClient'

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

describe('createSimctlClient', () => {
  it('runs xcrun with simctl in front of the arguments', async () => {
    const { spawn, calls } = fakeSpawn({ stdout: '{}' })

    await createSimctlClient(spawn).exec(['list', 'devices', '-j'])

    expect(calls).toEqual([{ command: 'xcrun', args: ['simctl', 'list', 'devices', '-j'] }])
  })

  it('maps a missing xcrun to ios_tool_not_found with the Xcode hint', async () => {
    const { spawn } = fakeSpawn({ spawnError: Object.assign(new Error('spawn xcrun ENOENT'), { code: 'ENOENT' }) })

    await expect(createSimctlClient(spawn).exec(['list'])).rejects.toMatchObject({
      toolError: { kind: 'ios_tool_not_found', hint: 'Xcode를 설치하고 xcode-select -s로 개발자 디렉토리를 정해라' }
    })
  })

  it('maps "Invalid device" stderr to no_device', async () => {
    const { spawn } = fakeSpawn({ stderr: 'Invalid device: x', exitCode: 164 })

    await expect(createSimctlClient(spawn).exec(['boot', 'x'])).rejects.toMatchObject({ toolError: { kind: 'no_device' } })
  })

  it('maps other failures to command_failed with stderr and args', async () => {
    const { spawn } = fakeSpawn({ stderr: 'boom', exitCode: 1 })

    await expect(createSimctlClient(spawn).exec(['boot', 'x'])).rejects.toMatchObject({
      toolError: { kind: 'command_failed', details: { stderr: 'boom', args: ['simctl', 'boot', 'x'] } }
    })
  })
})
