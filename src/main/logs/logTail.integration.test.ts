import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { defaultLocateSdkDeps, locateSdk } from '../sdk/locateSdk'
import { parseDevices } from '../device/parsers/devices'
import { createAdbClient, type AdbClient } from '../adb/adbClient'
import { createAndroidDevice } from '../device/androidDevice'
import type { Device, LogLine } from '../../shared/types/device'
import type { TailState } from '../../shared/types/logs'
import { createLogTail } from './logTail'
import { createPidTracker } from './pidTracker'
import { parseDeviceEpoch } from './logClock'

const SETTINGS_PKG = 'com.android.settings'
const SETTINGS_COMPONENT = `${SETTINGS_PKG}/.Settings`

let adb: AdbClient
let serial: string
let device: Device

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

beforeAll(async () => {
  const located = locateSdk(defaultLocateSdkDeps())
  if (!located.ok) {
    throw new Error(`Android SDK를 찾지 못했다. 찾아본 경로: ${located.searched.join(', ')}`)
  }

  adb = createAdbClient(located.paths.adb)

  const devices = parseDevices((await adb.exec(null, ['devices', '-l'])).stdout).filter(
    (entry) => entry.state === 'device'
  )

  // adbClient.integration.test.ts와 같은 기기 선택 규칙. 물리 기기를 암묵적으로 고르지 않는다.
  const envSerial = process.env.VDH_TEST_SERIAL
  if (envSerial) {
    if (!devices.some((entry) => entry.serial === envSerial)) {
      throw new Error(
        `VDH_TEST_SERIAL=${envSerial}인데 연결된 기기 목록에 없다. 연결된 기기: ${
          devices.map((entry) => entry.serial).join(', ') || '(없음)'
        }`
      )
    }
    serial = envSerial
  } else {
    const emulators = devices.filter((entry) => entry.serial.startsWith('emulator-'))
    if (emulators.length === 0) {
      throw new Error('연결된 에뮬레이터가 없다. 에뮬레이터를 하나 띄우거나 VDH_TEST_SERIAL로 대상을 지정해라')
    }
    if (emulators.length > 1) {
      throw new Error(
        `연결된 에뮬레이터가 여럿이다: ${emulators
          .map((entry) => entry.serial)
          .join(', ')}. VDH_TEST_SERIAL로 대상을 지정해라`
      )
    }
    serial = emulators[0]?.serial as string
  }

  device = createAndroidDevice({
    serial,
    adb,
    // 스크린샷은 이 테스트에서 쓰지 않는다. electronResizeImage는 Electron 런타임이
    // 필요해 통합 테스트 프로세스에서 부를 수 없다.
    resizeImage: (png) => ({ png, width: 1, height: 1 })
  })
})

afterAll(async () => {
  // 크래시 테스트가 설정 앱을 죽여 두므로, 다음 사람·다음 테스트가 깨끗한 화면에서
  // 시작하도록 설정 앱을 다시 깔끔히 띄워 둔다.
  await adb.exec(serial, ['shell', 'am', 'start', '-n', SETTINGS_COMPONENT]).catch(() => {})
})

describe('createLogTail against a real emulator', () => {
  it('receives a line written with log -t after starting', async () => {
    const lines: Array<{ line: LogLine; at: number }> = []
    const states: TailState[] = []
    const tail = createLogTail(
      { serial, adb, isConnected: () => true },
      {
        onLine: (line, at) => lines.push({ line, at }),
        onResume: () => {},
        onState: (state) => states.push(state)
      }
    )

    await tail.start()
    try {
      const marker = `hello-${Math.random().toString(36).slice(2, 10)}`
      await adb.exec(serial, ['shell', 'log', '-t', 'VDH_M3', marker])

      // 5초 안에 onLine으로 그 메시지를 받는다.
      const deadline = Date.now() + 5_000
      let found: { line: LogLine; at: number } | undefined
      while (Date.now() < deadline) {
        found = lines.find((entry) => entry.line.message.includes(marker))
        if (found) break
        await sleep(100)
      }

      expect(found).toBeDefined()
      // 받은 at이 호스트 현재 시각과 5초 이내다.
      expect(Math.abs((found as { line: LogLine; at: number }).at - Date.now())).toBeLessThan(5_000)

      // 시계 측정이 성공했는지(폴백이 아닌지)도 따로 확인한다.
      const dateResult = await adb.exec(serial, ['shell', 'date', '+%s%3N'])
      expect(parseDeviceEpoch(dateResult.stdout)).not.toBeNull()
    } finally {
      tail.stop()
    }
  })
})

describe('log_read({ package }) 경로 재현 (MCP 클라이언트 없이)', () => {
  it('captures a crash stack for a package after its process has died', async () => {
    const tracker = createPidTracker()

    // ps -A -o PID,NAME로 먼저 seed한다 — 재기동 전 상태라 새 pid를 잡아 주진 않지만
    // 브리프가 요구하는 순서다.
    const psResult = await adb.exec(serial, ['shell', 'ps', '-A', '-o', 'PID,NAME'])
    tracker.seed(psResult.stdout)

    const tail = createLogTail(
      { serial, adb, isConnected: () => true },
      {
        onLine: (line) => {
          tracker.observe(line)
        },
        onResume: () => {},
        onState: () => {}
      }
    )

    await tail.start()
    try {
      // 설정 앱을 새 프로세스로 재기동해야 ActivityManager의 'Start proc' 줄이 나오고
      // tracker가 새 pid를 배운다.
      await adb.exec(serial, ['shell', 'am', 'force-stop', SETTINGS_PKG])
      await adb.exec(serial, ['shell', 'am', 'start', '-n', SETTINGS_COMPONENT])

      // tracker가 새 pid를 배울 때까지 기다린다(bounded).
      const learnDeadline = Date.now() + 10_000
      while (Date.now() < learnDeadline && tracker.pidsOf(SETTINGS_PKG).length === 0) {
        await sleep(200)
      }
      expect(tracker.pidsOf(SETTINGS_PKG).length).toBeGreaterThan(0)

      // 프로세스가 attach를 끝내고 안정되기 전에 crash를 보내면 신호가 씹히고 앱이
      // 그대로 살아남는 경우가 실기기에서 확인됐다 — 막 뜬 프로세스에 바로 crash를
      // 보내지 않도록 짧게 자리를 잡을 시간을 준다.
      await sleep(1_500)

      await adb.exec(serial, ['shell', 'am', 'crash', SETTINGS_PKG])

      // pidof가 빈 값이 될 때까지 기다린다(bounded) — 프로세스가 실제로 죽었는지 확인한다.
      const deadDeadline = Date.now() + 10_000
      let pidofStdout = ''
      for (;;) {
        try {
          pidofStdout = (await adb.exec(serial, ['shell', 'pidof', SETTINGS_PKG])).stdout.trim()
        } catch {
          // 대상이 안 떠 있으면 pidof는 exit 1로 reject한다 — 빈 값으로 본다.
          pidofStdout = ''
        }
        if (pidofStdout === '' || Date.now() > deadDeadline) break
        await sleep(300)
      }
      expect(pidofStdout).toBe('')

      // 크래시 스택 줄이 logcat 버퍼에 도착할 시간을 약간 준다.
      await sleep(1_000)

      const fromPidof = pidofStdout === '' ? [] : pidofStdout.split(/\s+/).map(Number)
      const pids = Array.from(new Set([...tracker.pidsOf(SETTINGS_PKG), ...fromPidof]))

      const result = await device.readLogs({ pids })
      const hasCrashStack = result.lines.some(
        (line) => line.message.includes('FATAL EXCEPTION') || line.tag === 'AndroidRuntime'
      )
      expect(hasCrashStack).toBe(true)
    } finally {
      tail.stop()
    }
  })
})
