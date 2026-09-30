import { DeviceError } from '../../shared/types/errors'
import type { TrackFailure } from '../adb/trackDevices'
import { parseSimctlDevices } from '../device/parsers/simctlDevices'
import type { SimctlClient } from './simctlClient'

/** simctl에는 adb track-devices 같은 푸시가 없어서 폴링한다. */
export const SIMULATOR_POLL_INTERVAL_MS = 2000
/** 연속으로 이만큼 실패하면 추적이 죽었다고 알린다. */
export const SIMULATOR_MAX_FAILURES = 3

export interface TrackSimulatorsOpts {
  intervalMs?: number
  maxFailures?: number
  setTimer?: (callback: () => void, ms: number) => unknown
  clearTimer?: (handle: unknown) => void
}

/**
 * 부팅된 시뮬레이터를 폴링해 연결·해제를 알린다. `Booting`은 아직 연결이 아니다 —
 * 부팅 도중에 기기가 등록되면 위층이 준비 안 된 기기에 명령을 보낸다.
 * 반환 함수는 폴링을 멈춘다.
 */
export function trackSimulators(
  simctl: SimctlClient,
  onChange: (serial: string, connected: boolean) => void,
  onFailure: (failure: TrackFailure) => void,
  opts: TrackSimulatorsOpts = {}
): () => void {
  const {
    intervalMs = SIMULATOR_POLL_INTERVAL_MS,
    maxFailures = SIMULATOR_MAX_FAILURES,
    setTimer = (callback, ms) => setTimeout(callback, ms),
    clearTimer = (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>)
  } = opts

  let connected = new Set<string>()
  let failures = 0
  let stopped = false
  let timer: unknown = null

  function schedule(): void {
    if (stopped) return
    timer = setTimer(() => void poll(), intervalMs)
  }

  async function poll(): Promise<void> {
    let booted: Set<string>
    try {
      const result = await simctl.exec(['list', 'devices', 'booted', '-j'])
      booted = new Set(
        parseSimctlDevices(result.stdout)
          .filter((entry) => entry.state === 'Booted')
          .map((entry) => entry.udid)
      )
    } catch (thrown) {
      if (stopped) return
      failures += 1
      if (failures >= maxFailures) {
        stopped = true
        onFailure({ error: thrown instanceof DeviceError ? thrown : null, exitCode: null })
        return
      }
      schedule()
      return
    }
    if (stopped) return

    failures = 0
    const previous = connected
    connected = booted
    try {
      for (const udid of booted) if (!previous.has(udid)) notify(udid, true)
      for (const udid of previous) if (!booted.has(udid)) notify(udid, false)
    } finally {
      // 구독자가 던져도 폴링은 이어 간다. 여기서 멈추면 기기 목록이 조용히 얼어붙는다.
      schedule()
    }
  }

  /** 구독자 하나의 실패가 나머지 알림과 다음 폴링을 막지 않게 가둔다. */
  function notify(udid: string, isConnected: boolean): void {
    try {
      onChange(udid, isConnected)
    } catch (error) {
      console.error('시뮬레이터 연결 변경을 알리다 실패했다', udid, error)
    }
  }

  void poll()

  return () => {
    stopped = true
    if (timer !== null) clearTimer(timer)
    timer = null
  }
}
