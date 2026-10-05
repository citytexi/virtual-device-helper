import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { defaultLocateSdkDeps, locateSdk } from '../sdk/locateSdk'
import { parseDevices } from '../device/parsers/devices'
import { createAdbClient, type AdbClient } from '../adb/adbClient'
import { trackDevices } from '../adb/trackDevices'
import { createAndroidDevice } from '../device/androidDevice'
import { createDeviceRegistry, type DeviceRegistry } from '../device/registry'
import type { VirtualDeviceCatalog } from '../device/virtualDeviceCatalog'
import { createToolHarness, type ToolHarness } from '../mcp/testHarness'
import type { LogDown, LogEntry } from '../../shared/types/logs'
import { createPidof, createSeedPids } from './adbLogDeps'
import { createLogManager, type LogManager, type LogPortLike } from './logManager'
import { createLogTail } from './logTail'

/**
 * `index.ts`가 조립하는 실제 조각(adb 클라이언트, `trackDevices` 기반 registry, 실제
 * `createLogTail`을 쓰는 `createLogManager`, `adbLogDeps.ts`의 `seedPids`·`pidof`)을 그대로
 * 묶고, MCP 툴 층은 `createToolHarness`로 인메모리 전송 위에 띄운다. HTTP 전송과 앱 창만 빠진
 * `log_read({ package })` 경로다. `src/main/mcp/` 밖에 두는 이유는 `layering.test.ts`가 그
 * 아래에서 logs·adb import를 막기 때문이다.
 */

const SETTINGS_PKG = 'com.android.settings'
const SETTINGS_COMPONENT = `${SETTINGS_PKG}/.Settings`
const START_PROC_SETTINGS = /^Start proc \d+:com\.android\.settings\//

let adb: AdbClient
let serial: string
let registry: DeviceRegistry
let logs: LogManager
let harness: ToolHarness
/** 열어 둔 로그 포트로 받은 줄 전부. tail이 Start proc 줄을 봤는지 확인하는 데 쓴다. */
const received: LogEntry[] = []

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

async function waitFor(check: () => boolean | Promise<boolean>, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    if (await check()) return true
    if (Date.now() > deadline) return false
    await sleep(200)
  }
}

/** renderer 대신 메시지를 모으는 로그 포트. */
function collectingPort(): LogPortLike {
  return {
    postMessage(message: LogDown) {
      if (message.type === 'snapshot' || message.type === 'batch') received.push(...message.entries)
    },
    on: () => undefined,
    start: () => {},
    close: () => {}
  }
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
    if (emulators.length !== 1) {
      throw new Error(
        `대상 에뮬레이터를 하나로 정할 수 없다(${emulators.map((entry) => entry.serial).join(', ') || '없음'}). ` +
          'VDH_TEST_SERIAL로 대상을 지정해라'
      )
    }
    serial = emulators[0]?.serial as string
  }

  // index.ts와 같은 조립. 다만 추적은 대상 serial만 통과시킨다 — 다른 기기(물리 기기 등)에
  // logcat tail을 띄우지 않기 위해서다.
  registry = createDeviceRegistry({
    track: (onChange, onFailure) =>
      trackDevices(
        adb,
        (changed, connected) => {
          if (changed === serial) onChange(changed, connected, 'android')
        },
        (failure) => onFailure('android', failure)
      ),
    createDevice: (target) =>
      createAndroidDevice({
        serial: target,
        adb,
        // 스크린샷은 쓰지 않는다. electronResizeImage는 Electron 런타임이 필요하다.
        resizeImage: (png) => ({ png, width: 1, height: 1 })
      })
  })
  logs = createLogManager({
    createTail: (target, handlers) =>
      createLogTail({ serial: target, adb, isConnected: () => registry.serials().includes(target) }, handlers),
    seedPids: createSeedPids(adb),
    pidof: createPidof(adb),
    createChannel: () => ({ local: collectingPort(), remote: null }),
    postPort: () => {}
  })
  // bootstrap.ts처럼 registry.start()보다 먼저 구독한다.
  registry.on((event) => {
    if (event.type === 'device_connected') logs.handleConnect(event.serial)
    if (event.type === 'device_disconnected') logs.handleDisconnect(event.serial)
  })

  const catalog = { list: async () => [], boot: async () => serial, shutdown: async () => {} } as VirtualDeviceCatalog
  harness = await createToolHarness({ registry, catalog, pidHistory: (target, pkg) => logs.pidHistory(target, pkg) })

  registry.start()
  if (!(await waitFor(() => registry.serials().includes(serial), 10_000))) {
    throw new Error(`registry가 ${serial} 연결을 알리지 않았다`)
  }
  logs.open(serial)
})

afterAll(async () => {
  logs?.stopAll()
  registry?.stop()
  await harness?.close()
  // 크래시로 죽인 설정 앱을 다시 띄워 다음 사람·다음 테스트가 설정 홈 화면에서 시작하게 한다.
  if (adb && serial) {
    await adb.exec(serial, ['shell', 'am', 'start', '-n', SETTINGS_COMPONENT]).catch(() => {})
  }
})

describe('log_read({ package }) through the real log manager and MCP tool', () => {
  it('returns the crash stack of a package whose process has already died', async () => {
    // 새 프로세스로 띄워야 ActivityManager의 Start proc 줄이 tail로 들어온다.
    // tail이 스트림을 붙일 시간을 조금 준 뒤 띄운다.
    await sleep(1_000)
    await adb.exec(serial, ['shell', 'am', 'force-stop', SETTINGS_PKG])
    await adb.exec(serial, ['shell', 'am', 'start', '-n', SETTINGS_COMPONENT])

    // 포트로 받은 줄에 Start proc이 있으면 tracker가 그 pid를 배운 뒤다(onLine이 observe 뒤 append).
    const learned = await waitFor(
      () => received.some((entry) => entry.tag === 'ActivityManager' && START_PROC_SETTINGS.test(entry.message)),
      15_000
    )
    expect(learned).toBe(true)
    expect((await logs.pidHistory(serial, SETTINGS_PKG)).length).toBeGreaterThan(0)

    // 막 뜬 프로세스에 바로 crash를 보내면 신호가 씹히는 경우가 있다(logTail.integration.test.ts 참고).
    await sleep(1_500)
    await adb.exec(serial, ['shell', 'am', 'crash', SETTINGS_PKG])

    const pidof = createPidof(adb)
    const dead = await waitFor(async () => (await pidof(serial, SETTINGS_PKG)).length === 0, 20_000)
    expect(dead).toBe(true)

    // 크래시 스택 줄이 logcat 버퍼에 도착할 시간을 준다.
    await sleep(1_000)

    const payload = (await harness.call('log_read', { package: SETTINGS_PKG, serial, limit: 200 })) as {
      lines: string[]
    }
    const hasCrashStack = payload.lines.some(
      (line) => line.includes('FATAL EXCEPTION') || / AndroidRuntime\(\d+\): /.test(line)
    )
    expect(hasCrashStack).toBe(true)
  })
})
