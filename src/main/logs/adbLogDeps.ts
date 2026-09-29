import type { AdbClient } from '../adb/adbClient'
import { isAndroidPackageName } from '../../shared/packageName'
import type { LogManagerDeps } from './logManager'

/**
 * `logManager`의 `seedPids`·`pidof`를 실제 adb로 채운다. `index.ts`와 통합 테스트가 같은
 * 함수를 써서, 앱에서 도는 배선과 테스트가 검증하는 배선이 갈라지지 않게 한다.
 */

/** `ps -A -o PID,NAME` 출력. reject는 `logManager`가 seed 없음으로 처리한다. */
export function createSeedPids(adb: Pick<AdbClient, 'exec'>): LogManagerDeps['seedPids'] {
  return async (serial) => {
    const result = await adb.exec(serial, ['shell', 'ps', '-A', '-o', 'PID,NAME'])
    return result.stdout
  }
}

/**
 * 지금 떠 있는 그 패키지의 pid. 안 떠 있거나 실패하면 빈 배열이다.
 *
 * `adb shell`은 인자를 이어 붙여 기기 셸이 다시 파싱하므로, 패키지명 형식이 아닌 값은
 * adb에 넘기지 않고 빈 배열로 끝낸다. `log_read`의 입력 스키마가 먼저 막지만, 다른 경로로
 * 들어와도 기기 셸에 닿지 않게 여기서 한 번 더 막는다.
 */
export function createPidof(adb: Pick<AdbClient, 'exec'>): LogManagerDeps['pidof'] {
  return async (serial, pkg) => {
    if (!isAndroidPackageName(pkg)) return []
    try {
      const result = await adb.exec(serial, ['shell', 'pidof', pkg])
      return result.stdout
        .split(/\s+/)
        .map((token) => Number(token))
        .filter((pid) => Number.isInteger(pid) && pid > 0)
    } catch {
      // 대상 패키지가 안 떠 있으면 pidof는 exit 1이고 exec은 이를 reject한다.
      return []
    }
  }
}
