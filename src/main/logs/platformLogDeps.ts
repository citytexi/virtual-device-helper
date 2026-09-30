import type { Platform } from '../../shared/types/device'
import type { LogManagerDeps } from './logManager'

export interface PlatformLogDepsInput {
  /** 끊긴 기기처럼 알 수 없으면 던진다(`registry.resolve(serial).platform`). */
  platformOf(serial: string): Platform
  /** Android SDK가 없으면 null이다. 그때는 Android 기기도 없으므로 아무것도 하지 않는다. */
  android: Pick<LogManagerDeps, 'createTail' | 'seedPids' | 'pidof'> | null
  ios: Pick<LogManagerDeps, 'createTail' | 'seedPids' | 'pidof'>
}

type PlatformDeps = Pick<LogManagerDeps, 'createTail' | 'seedPids' | 'pidof'>

/** Android SDK가 없을 때 android 자리에 서는 deps. tail은 시작해도 아무 줄도 내지 않는다. */
const ABSENT: PlatformDeps = {
  createTail: () => ({ start: async () => {}, stop: () => {} }),
  seedPids: async () => '',
  pidof: async () => []
}

/**
 * 플랫폼별 로그 deps를 기기 `platform`으로 고르는 라우터. 분기는 이 조립 지점에만 둔다.
 * 기기를 못 찾으면(끊김) seed·pidof는 빈 결과이고, createTail은 Android 경로다.
 */
export function createPlatformLogDeps(input: PlatformLogDepsInput): PlatformDeps {
  const android = input.android ?? ABSENT
  function platform(serial: string): Platform | null {
    try {
      return input.platformOf(serial)
    } catch {
      return null
    }
  }
  return {
    createTail: (serial, handlers) => (platform(serial) === 'ios' ? input.ios : android).createTail(serial, handlers),
    seedPids: async (serial) => {
      const p = platform(serial)
      if (p === null) return ''
      return (p === 'ios' ? input.ios : android).seedPids(serial)
    },
    pidof: async (serial, pkg) => {
      const p = platform(serial)
      if (p === null) return []
      return (p === 'ios' ? input.ios : android).pidof(serial, pkg)
    }
  }
}
