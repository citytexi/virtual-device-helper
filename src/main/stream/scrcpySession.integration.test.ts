import { beforeAll, describe, expect, it, vi } from 'vitest'
import { createAdbClient, type AdbClient } from '../adb/adbClient'
import { parseDevices } from '../device/parsers/devices'
import { defaultLocateSdkDeps, locateSdk } from '../sdk/locateSdk'
import { resolveScrcpyJar } from './scrcpyJar'
import { connectLoopback, createScrcpySession } from './scrcpySession'
import type { VideoPacket } from './scrcpyProtocol'

let adb: AdbClient
let serial: string
const jarPath = resolveScrcpyJar({ isPackaged: false, resourcesPath: '', appPath: process.cwd() })

async function topActivity(): Promise<string> {
  const { stdout } = await adb.exec(serial, ['shell', 'dumpsys', 'activity', 'activities'])
  return stdout.split('\n').find((line) => /topResumedActivity|mResumedActivity/.test(line)) ?? ''
}

beforeAll(async () => {
  const located = locateSdk(defaultLocateSdkDeps())
  if (!located.ok) throw new Error(`Android SDK를 찾지 못했다: ${located.searched.join(', ')}`)
  adb = createAdbClient(located.paths.adb)
  const devices = parseDevices((await adb.exec(null, ['devices'])).stdout).filter((d) => d.state === 'device')
  if (devices.length === 0) throw new Error('실행 중인 기기가 없다. 에뮬레이터를 먼저 띄워라')
  serial = devices[0]!.serial
})

describe('scrcpy session on a real device', () => {
  it('streams a key frame, injects HOME and leaves no forward behind', async () => {
    const packets: VideoPacket[] = []
    const sessions: Array<[number, number]> = []
    const onEnded = vi.fn()
    const session = createScrcpySession(
      { serial, adb, jarPath, connect: connectLoopback },
      { onSession: (w, h) => sessions.push([w, h]), onPacket: (p) => packets.push(p), onEnded }
    )

    // 중간에 실패해도 forward·기기 서버가 남지 않게 close를 보장한다. close는 여러 번 불러도 된다.
    try {
      await session.start()
      await vi.waitFor(() => expect(packets.some((p) => p.key)).toBe(true), { timeout: 15_000 })
      expect(packets[0]?.config).toBe(true)
      expect(Math.max(...(sessions[0] ?? [0]))).toBeLessThanOrEqual(1024)

      await adb.exec(serial, ['shell', 'am', 'start', '-a', 'android.settings.SETTINGS'])
      await vi.waitFor(async () => expect(await topActivity()).toMatch(/settings/i), { timeout: 10_000 })

      session.sendControl({ type: 'key', key: 'home' })
      await vi.waitFor(async () => expect(await topActivity()).toMatch(/launcher/i), { timeout: 10_000 })
    } finally {
      await session.close()
    }
    const { stdout } = await adb.exec(null, ['forward', '--list'])
    expect(stdout).not.toMatch(/localabstract:scrcpy_/)
    expect(onEnded).not.toHaveBeenCalled()
  })
})
