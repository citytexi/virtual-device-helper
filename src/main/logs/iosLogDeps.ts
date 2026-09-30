import type { SimctlClient } from '../ios/simctlClient'
import { parseLaunchctlList } from '../device/parsers/launchctl'
import type { LogManagerDeps } from './logManager'

/**
 * `logManager`의 `seedPids`·`pidof`를 simctl로 채운다. 앱 목록의 출처는
 * `simctl spawn <udid> launchctl list`다.
 */

const LAUNCHCTL_ARGS = (udid: string): string[] => ['spawn', udid, 'launchctl', 'list']

/** `pidTracker.seed`가 읽는 `PID NAME` 헤더 + `<pid> <bundleId>` 줄. reject는 `logManager`가 seed 없음으로 처리한다. */
export function createIosSeedPids(simctl: Pick<SimctlClient, 'exec'>): LogManagerDeps['seedPids'] {
  return async (udid) => {
    const result = await simctl.exec(LAUNCHCTL_ARGS(udid))
    const rows = parseLaunchctlList(result.stdout).map((app) => `${app.pid} ${app.bundleId}`)
    return ['PID NAME', ...rows].join('\n')
  }
}

/** 지금 떠 있는 그 bundle id의 pid. 안 떠 있거나 실패하면 빈 배열이다. */
export function createIosPidof(simctl: Pick<SimctlClient, 'exec'>): LogManagerDeps['pidof'] {
  return async (udid, bundleId) => {
    try {
      const result = await simctl.exec(LAUNCHCTL_ARGS(udid))
      return parseLaunchctlList(result.stdout)
        .filter((app) => app.bundleId === bundleId)
        .map((app) => app.pid)
    } catch {
      return []
    }
  }
}
