import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import type { AdbClient, SpawnFn } from '../adb/adbClient'
import { deviceError } from '../../shared/types/errors'
import type { AvdEntry } from '../../shared/types/device'
import { parseDevices } from './parsers/devices'

const execFileAsync = promisify(execFile)

const DEFAULT_BOOT_TIMEOUT_MS = 180_000
const POLL_INTERVAL_MS = 2_000

export interface AvdControllerDeps {
  adb: AdbClient
  emulatorPath: string
  spawn: SpawnFn
  /** 기본값은 `emulator -list-avds` 실행. 테스트에서 주입한다. */
  listAvdNames?: () => Promise<string[]>
  sleep?: (ms: number) => Promise<void>
  now?: () => number
}

export interface AvdController {
  list(): Promise<AvdEntry[]>
  /** 부팅 완료까지 기다리고 새로 뜬 기기의 serial을 돌려준다. */
  boot(name: string, timeoutMs?: number): Promise<string>
  shutdown(serial: string): Promise<void>
}

export function createAvdController(deps: AvdControllerDeps): AvdController {
  const {
    adb,
    emulatorPath,
    spawn,
    sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms)),
    now = () => Date.now()
  } = deps

  const listAvdNames =
    deps.listAvdNames ??
    (async () => {
      const { stdout } = await execFileAsync(emulatorPath, ['-list-avds'])
      return stdout
        .split('\n')
        .map((line) => line.trim())
        .filter((line) => line.length > 0)
    })

  /** 실행 중인 기기의 serial과 그 기기가 띄운 AVD 이름을 잇는다. */
  async function runningAvdBySerial(): Promise<Map<string, string>> {
    const devices = parseDevices((await adb.exec(null, ['devices'])).stdout)
    const mapping = new Map<string, string>()

    for (const entry of devices) {
      if (entry.state !== 'device') continue
      try {
        const stdout = (await adb.exec(entry.serial, ['emu', 'avd', 'name'])).stdout
        const name = stdout.split('\n')[0]?.trim()
        if (name) mapping.set(entry.serial, name)
      } catch {
        // 에뮬레이터가 아닌 기기이거나 콘솔이 아직 안 뜬 경우다. 목록에서 빠질 뿐이다.
      }
    }

    return mapping
  }

  async function list(): Promise<AvdEntry[]> {
    const [names, running] = await Promise.all([listAvdNames(), runningAvdBySerial()])

    return names.map((name) => {
      const found = [...running.entries()].find(([, avdName]) => avdName === name)
      return { name, running: found !== undefined, serial: found?.[0] ?? null }
    })
  }

  async function boot(name: string, timeoutMs = DEFAULT_BOOT_TIMEOUT_MS): Promise<string> {
    const names = await listAvdNames()
    if (!names.includes(name)) {
      throw deviceError('command_failed', `그런 AVD가 없다: ${name}`, 'device_list로 사용할 수 있는 AVD 이름을 확인해라', {
        available: names
      })
    }

    // spawn하기 전에 붙어 있는 기기를 스냅샷으로 남긴다. 요청한 이름의 AVD가 이미
    // 떠 있으면 그 serial은 스냅샷에 들어가고, 폴링에서는 이 스냅샷에 없는
    // serial만 "방금 부팅된 기기"로 인정한다 — 그렇지 않으면 이미 떠 있던 인스턴스를
    // 이번 spawn이 성공한 것처럼 돌려주게 된다.
    const before = await runningAvdBySerial()

    const child = spawn(emulatorPath, ['-avd', name])
    // 에뮬레이터는 부팅 중 stdout/stderr에 상당한 로그(그래픽 백엔드·가속 경고 등)를
    // 낸다. 아무도 읽지 않으면 OS 파이프 버퍼가 차서 자식이 write에서 멈추고, 정상적으로
    // 부팅 중인 에뮬레이터가 device_unresponsive로 오분류된다. 내용은 필요 없으니 그냥 버린다.
    child.stdout.on('data', () => {})
    child.stderr.on('data', () => {})
    child.unref?.()

    const deadline = now() + timeoutMs

    while (now() < deadline) {
      await sleep(POLL_INTERVAL_MS)

      const running = await runningAvdBySerial()
      const found = [...running.entries()].find(([serial, avdName]) => avdName === name && !before.has(serial))
      if (!found) continue

      const serial = found[0]
      let booted: string
      try {
        booted = (await adb.exec(serial, ['shell', 'getprop', 'sys.boot_completed'])).stdout.trim()
      } catch {
        // 부팅 도중에는 기기가 offline 등 중간 상태를 거치며 adb 명령이 일시적으로
        // 실패할 수 있다. 이 한 번의 실패를 boot() 전체의 실패로 올리지 않는다 —
        // "아직 부팅 안 됨"으로 보고 다음 폴링에서 다시 확인한다.
        continue
      }
      if (booted === '1') return serial
    }

    throw deviceError('device_unresponsive', `${name}이 ${timeoutMs}ms 안에 부팅되지 않았다`, '에뮬레이터 창을 직접 확인하고, 필요하면 device_shutdown 후 다시 시도해라', {
      avd: name,
      timeoutMs
    })
  }

  async function shutdown(serial: string): Promise<void> {
    await adb.exec(serial, ['emu', 'kill'])
  }

  return { list, boot, shutdown }
}
