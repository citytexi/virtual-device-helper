import { deviceError } from '../../../shared/types/errors'

export interface SimulatorEntry {
  udid: string
  name: string
  /** simctl이 주는 상태 문자열 그대로. Shutdown · Booting · Booted · Shutting Down 등. */
  state: string
  /** 런타임 식별자. `com.apple.CoreSimulator.SimRuntime.iOS-26-0`. */
  runtime: string
  /** 런타임 키에서 뽑은 사람이 읽는 버전. `26.0`. */
  osVersion: string
}

const IOS_RUNTIME = /\.SimRuntime\.iOS-(\d+(?:-\d+)*)$/

interface RawDevice {
  udid?: unknown
  name?: unknown
  state?: unknown
  isAvailable?: unknown
}

/**
 * `xcrun simctl list devices -j` 출력을 iOS 시뮬레이터 목록으로 바꾼다.
 * 이름은 런타임마다 겹치므로(같은 iPhone 17 Pro가 여러 OS에 있다) 식별은 udid로만 한다.
 */
export function parseSimctlDevices(json: string): SimulatorEntry[] {
  let parsed: { devices?: Record<string, RawDevice[]> }
  try {
    parsed = JSON.parse(json)
  } catch {
    throw deviceError('command_failed', 'simctl 출력을 읽을 수 없다', 'xcrun simctl list devices -j를 직접 실행해 출력을 확인해라')
  }

  const entries: SimulatorEntry[] = []
  for (const [runtime, devices] of Object.entries(parsed.devices ?? {})) {
    const match = IOS_RUNTIME.exec(runtime)
    if (!match) continue
    const osVersion = (match[1] as string).replace(/-/g, '.')

    for (const device of devices) {
      if (device.isAvailable === false) continue
      if (typeof device.udid !== 'string' || typeof device.name !== 'string' || typeof device.state !== 'string') continue
      entries.push({ udid: device.udid, name: device.name, state: device.state, runtime, osVersion })
    }
  }
  return entries
}
