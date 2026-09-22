import { EventEmitter } from 'node:events'
import { Readable } from 'node:stream'
import { describe, expect, it, vi } from 'vitest'
import type { AdbClient, ExecResult, SpawnFn } from '../adb/adbClient'
import { createAvdController } from './avdController'

function result(stdout: string): ExecResult {
  return { stdout, stdoutRaw: Buffer.from(stdout), stderr: '', exitCode: 0 }
}

function fakeSpawn(): { spawn: SpawnFn; started: string[][] } {
  const started: string[][] = []
  const spawn: SpawnFn = (_command, args) => {
    started.push(args)
    const child = new EventEmitter() as ReturnType<SpawnFn>
    child.stdout = new Readable({ read() {} })
    child.stderr = new Readable({ read() {} })
    child.unref = vi.fn() as never
    child.kill = vi.fn() as never
    return child
  }
  return { spawn, started }
}

describe('AvdController.list', () => {
  it('marks an AVD as running when its name matches a live emulator', async () => {
    const adb = {
      exec: vi.fn(async (serial: string | null, args: string[]) => {
        if (args.includes('devices')) return result('List of devices attached\nemulator-5554  device\n')
        if (serial === 'emulator-5554' && args.includes('avd')) return result('Pixel_7_API_34\nOK\n')
        return result('')
      }),
      stream: vi.fn()
    } as unknown as AdbClient
    const { spawn } = fakeSpawn()

    const controller = createAvdController({
      adb,
      emulatorPath: '/opt/sdk/emulator/emulator',
      spawn,
      listAvdNames: async () => ['Pixel_7_API_34', 'Pixel_Tablet']
    })

    await expect(controller.list()).resolves.toEqual([
      { name: 'Pixel_7_API_34', running: true, serial: 'emulator-5554' },
      { name: 'Pixel_Tablet', running: false, serial: null }
    ])
  })

  it('reports every AVD as stopped when nothing is attached', async () => {
    const adb = {
      exec: vi.fn(async () => result('List of devices attached\n')),
      stream: vi.fn()
    } as unknown as AdbClient
    const { spawn } = fakeSpawn()

    const controller = createAvdController({
      adb,
      emulatorPath: '/opt/sdk/emulator/emulator',
      spawn,
      listAvdNames: async () => ['Pixel_7_API_34']
    })

    await expect(controller.list()).resolves.toEqual([
      { name: 'Pixel_7_API_34', running: false, serial: null }
    ])
  })
})

describe('AvdController.boot', () => {
  it('rejects an AVD name that does not exist', async () => {
    const adb = { exec: vi.fn(async () => result('')), stream: vi.fn() } as unknown as AdbClient
    const { spawn } = fakeSpawn()

    const controller = createAvdController({
      adb,
      emulatorPath: '/opt/sdk/emulator/emulator',
      spawn,
      listAvdNames: async () => ['Pixel_7_API_34']
    })

    await expect(controller.boot('Nope')).rejects.toMatchObject({
      toolError: { kind: 'command_failed' }
    })
  })

  it('spawns the emulator with -avd and waits until boot completes', async () => {
    let bootChecks = 0
    const adb = {
      exec: vi.fn(async (serial: string | null, args: string[]) => {
        const joined = args.join(' ')
        if (joined.includes('devices')) return result('List of devices attached\nemulator-5554  device\n')
        if (joined.includes('sys.boot_completed')) {
          bootChecks += 1
          return result(bootChecks >= 2 ? '1\n' : '\n')
        }
        if (serial === 'emulator-5554' && joined.includes('avd')) return result('Pixel_7_API_34\nOK\n')
        return result('')
      }),
      stream: vi.fn()
    } as unknown as AdbClient
    const { spawn, started } = fakeSpawn()

    const controller = createAvdController({
      adb,
      emulatorPath: '/opt/sdk/emulator/emulator',
      spawn,
      listAvdNames: async () => ['Pixel_7_API_34'],
      sleep: async () => {}
    })

    await expect(controller.boot('Pixel_7_API_34')).resolves.toBe('emulator-5554')
    expect(started[0]).toEqual(['-avd', 'Pixel_7_API_34'])
    expect(bootChecks).toBeGreaterThanOrEqual(2)
  })

  it('gives up with device_unresponsive when boot never completes', async () => {
    const adb = {
      exec: vi.fn(async (_serial: string | null, args: string[]) => {
        const joined = args.join(' ')
        if (joined.includes('devices')) return result('List of devices attached\nemulator-5554  device\n')
        if (joined.includes('avd')) return result('Pixel_7_API_34\nOK\n')
        return result('\n')
      }),
      stream: vi.fn()
    } as unknown as AdbClient
    const { spawn } = fakeSpawn()

    let now = 0
    const controller = createAvdController({
      adb,
      emulatorPath: '/opt/sdk/emulator/emulator',
      spawn,
      listAvdNames: async () => ['Pixel_7_API_34'],
      sleep: async () => {
        now += 5_000
      },
      now: () => now
    })

    await expect(controller.boot('Pixel_7_API_34', 20_000)).rejects.toMatchObject({
      toolError: { kind: 'device_unresponsive' }
    })
  })
})

describe('AvdController.shutdown', () => {
  it('sends emu kill to the given serial', async () => {
    const calls: Array<{ serial: string | null; args: string[] }> = []
    const adb = {
      exec: vi.fn(async (serial: string | null, args: string[]) => {
        calls.push({ serial, args })
        return result('')
      }),
      stream: vi.fn()
    } as unknown as AdbClient
    const { spawn } = fakeSpawn()

    const controller = createAvdController({
      adb,
      emulatorPath: '/opt/sdk/emulator/emulator',
      spawn,
      listAvdNames: async () => []
    })

    await controller.shutdown('emulator-5554')

    expect(calls[0]).toEqual({ serial: 'emulator-5554', args: ['emu', 'kill'] })
  })
})
