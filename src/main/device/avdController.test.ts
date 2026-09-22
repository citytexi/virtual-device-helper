import { EventEmitter } from 'node:events'
import { Readable } from 'node:stream'
import { describe, expect, it, vi } from 'vitest'
import type { AdbClient, ExecResult, SpawnFn } from '../adb/adbClient'
import { createAvdController } from './avdController'

function result(stdout: string): ExecResult {
  return { stdout, stdoutRaw: Buffer.from(stdout), stderr: '', exitCode: 0 }
}

function fakeSpawn(): { spawn: SpawnFn; started: string[][]; children: ReturnType<SpawnFn>[] } {
  const started: string[][] = []
  const children: ReturnType<SpawnFn>[] = []
  const spawn: SpawnFn = (_command, args) => {
    started.push(args)
    const child = new EventEmitter() as ReturnType<SpawnFn>
    child.stdout = new Readable({ read() {} })
    child.stderr = new Readable({ read() {} })
    child.unref = vi.fn() as never
    child.kill = vi.fn() as never
    children.push(child)
    return child
  }
  return { spawn, started, children }
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
    // 'devices'의 첫 호출은 spawn 전 스냅샷이다. 거기서 emulator-5554가 이미 잡히면
    // boot()는 그걸 "기존에 떠 있던 기기"로 걸러내므로, 새로 부팅된 기기로 인정받으려면
    // spawn 이후(두 번째 호출부터)에만 나타나야 한다.
    let devicesCalls = 0
    let bootChecks = 0
    const adb = {
      exec: vi.fn(async (serial: string | null, args: string[]) => {
        const joined = args.join(' ')
        if (joined.includes('devices')) {
          devicesCalls += 1
          return devicesCalls === 1
            ? result('List of devices attached\n')
            : result('List of devices attached\nemulator-5554  device\n')
        }
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
    // spawn 전 스냅샷은 비어 있어야 한다. 거기서 같은 이름의 AVD가 잡히면 그것은
    // "이미 실행 중"이라는 다른 실패이고, 이 테스트가 보려는 것은 새로 띄운
    // 에뮬레이터가 끝내 sys.boot_completed를 1로 만들지 못하는 경우다.
    let devicesCalls = 0
    const adb = {
      exec: vi.fn(async (_serial: string | null, args: string[]) => {
        const joined = args.join(' ')
        if (joined.includes('devices')) {
          devicesCalls += 1
          return devicesCalls === 1
            ? result('List of devices attached\n')
            : result('List of devices attached\nemulator-5554  device\n')
        }
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

  it('drains the spawned emulator child stdout and stderr so a chatty process cannot block on write', async () => {
    // 'devices'의 첫 호출은 spawn하기 전 스냅샷이다. 거기서부터 emulator-5554가
    // 잡히면 boot()가 그 serial을 "이미 떠 있던 기기"로 걸러내 버려서 끝내 새
    // serial을 못 찾고 무한정 폴링하게 된다. 그래서 spawn 이후(두 번째 호출부터)에만
    // emulator-5554가 나타나도록 해서, 이 테스트는 오직 드레인 여부만 검증한다.
    let devicesCalls = 0
    const adb = {
      exec: vi.fn(async (_serial: string | null, args: string[]) => {
        const joined = args.join(' ')
        if (joined.includes('devices')) {
          devicesCalls += 1
          return devicesCalls === 1
            ? result('List of devices attached\n')
            : result('List of devices attached\nemulator-5554  device\n')
        }
        if (joined.includes('sys.boot_completed')) return result('1\n')
        if (joined.includes('avd')) return result('Pixel_7_API_34\nOK\n')
        return result('')
      }),
      stream: vi.fn()
    } as unknown as AdbClient
    const { spawn, children } = fakeSpawn()

    const controller = createAvdController({
      adb,
      emulatorPath: '/opt/sdk/emulator/emulator',
      spawn,
      listAvdNames: async () => ['Pixel_7_API_34'],
      sleep: async () => {}
    })

    await controller.boot('Pixel_7_API_34')

    const [child] = children
    if (!child) throw new Error('spawn이 자식 프로세스를 만들지 않았다')
    expect(child.stdout.listenerCount('data')).toBeGreaterThan(0)
    expect(child.stderr.listenerCount('data')).toBeGreaterThan(0)
  })

  it('fails immediately when the requested AVD is already running instead of waiting out the timeout', async () => {
    // emulator-5554는 boot()를 부르기 전부터 같은 이름의 AVD를 띄우고 있다. 실제 emulator
    // 바이너리는 같은 AVD의 두 번째 인스턴스를 거부하므로 새 serial은 끝내 나타나지 않고,
    // 예전 구현은 180초를 다 쓰고 device_unresponsive로 끝났다. "네가 부른 AVD는 이미 떠
    // 있다"와 "에뮬레이터가 끝내 안 떴다"는 다른 사실이고, 앞의 것은 스냅샷만 보면 안다.
    const adb = {
      exec: vi.fn(async (serial: string | null, args: string[]) => {
        const joined = args.join(' ')
        if (joined.includes('devices')) return result('List of devices attached\nemulator-5554  device\n')
        if (joined.includes('sys.boot_completed')) return result('1\n')
        if (serial === 'emulator-5554' && joined.includes('avd')) return result('Pixel_7_API_34\nOK\n')
        return result('')
      }),
      stream: vi.fn()
    } as unknown as AdbClient
    const { spawn, started } = fakeSpawn()

    let sleeps = 0
    let now = 0
    const controller = createAvdController({
      adb,
      emulatorPath: '/opt/sdk/emulator/emulator',
      spawn,
      listAvdNames: async () => ['Pixel_7_API_34'],
      sleep: async () => {
        sleeps += 1
        now += 5_000
      },
      now: () => now
    })

    const error = await controller.boot('Pixel_7_API_34', 20_000).catch((thrown) => thrown)

    expect(error).toMatchObject({ toolError: { kind: 'command_failed' } })
    expect(error.toolError.details).toMatchObject({ serial: 'emulator-5554' })
    expect(started).toEqual([])
    expect(sleeps).toBe(0)
  })

  it('treats a transient getprop failure during boot as "not booted yet", not a boot failure', async () => {
    // 위 테스트와 같은 이유로, spawn 전 스냅샷에는 emulator-5554가 없어야 한다.
    let devicesCalls = 0
    let bootChecks = 0
    const adb = {
      exec: vi.fn(async (serial: string | null, args: string[]) => {
        const joined = args.join(' ')
        if (joined.includes('devices')) {
          devicesCalls += 1
          return devicesCalls === 1
            ? result('List of devices attached\n')
            : result('List of devices attached\nemulator-5554  device\n')
        }
        if (joined.includes('sys.boot_completed')) {
          bootChecks += 1
          if (bootChecks === 1) throw new Error('device offline')
          return result(bootChecks >= 3 ? '1\n' : '\n')
        }
        if (serial === 'emulator-5554' && joined.includes('avd')) return result('Pixel_7_API_34\nOK\n')
        return result('')
      }),
      stream: vi.fn()
    } as unknown as AdbClient
    const { spawn } = fakeSpawn()

    const controller = createAvdController({
      adb,
      emulatorPath: '/opt/sdk/emulator/emulator',
      spawn,
      listAvdNames: async () => ['Pixel_7_API_34'],
      sleep: async () => {}
    })

    await expect(controller.boot('Pixel_7_API_34')).resolves.toBe('emulator-5554')
    expect(bootChecks).toBeGreaterThanOrEqual(3)
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

describe('AvdController default listAvdNames', () => {
  function adbWithNoDevices(): AdbClient {
    return {
      exec: vi.fn(async () => result('List of devices attached\n')),
      stream: vi.fn()
    } as unknown as AdbClient
  }

  it('reads the AVD names from the emulator binary, ignoring blank lines', async () => {
    const controller = createAvdController({
      adb: adbWithNoDevices(),
      emulatorPath: '/opt/sdk/emulator/emulator',
      spawn: fakeSpawn().spawn,
      execFile: async () => ({ stdout: 'Pixel_7_API_34\n\nPixel_Tablet\n' })
    })

    await expect(controller.list()).resolves.toEqual([
      { name: 'Pixel_7_API_34', running: false, serial: null },
      { name: 'Pixel_Tablet', running: false, serial: null }
    ])
  })

  it('reports sdk_not_found when the emulator binary is missing instead of leaking ENOENT', async () => {
    // 이 브랜치에서 위층으로 타입 없는 실패가 새는 유일한 경로였다. M1-3의 device_list는
    // raw Error를 구조화된 툴 에러로 바꿀 방법이 없다.
    const controller = createAvdController({
      adb: adbWithNoDevices(),
      emulatorPath: '/opt/sdk/emulator/emulator',
      spawn: fakeSpawn().spawn,
      execFile: async () => {
        throw Object.assign(new Error('spawn /opt/sdk/emulator/emulator ENOENT'), { code: 'ENOENT' })
      }
    })

    await expect(controller.list()).rejects.toMatchObject({
      toolError: { kind: 'sdk_not_found' }
    })
  })

  it('turns any other emulator failure into a typed command_failed', async () => {
    const controller = createAvdController({
      adb: adbWithNoDevices(),
      emulatorPath: '/opt/sdk/emulator/emulator',
      spawn: fakeSpawn().spawn,
      execFile: async () => {
        throw new Error('emulator: ERROR: unknown option')
      }
    })

    await expect(controller.boot('Pixel_7_API_34')).rejects.toMatchObject({
      toolError: { kind: 'command_failed' }
    })
  })
})
