import type { Platform } from '../../shared/types/device'
import type { LogManagerDeps } from './logManager'

export interface PlatformLogDepsInput {
  /** 끊긴 기기처럼 알 수 없으면 던진다(`registry.resolve(serial).platform`). */
  platformOf(serial: string): Platform
  android: Pick<LogManagerDeps, 'createTail' | 'seedPids' | 'pidof'>
  ios: Pick<LogManagerDeps, 'createTail' | 'seedPids' | 'pidof'>
}

/**
 * 플랫폼별 로그 deps를 기기 `platform`으로 고르는 라우터. 분기는 이 조립 지점에만 둔다.
 * 기기를 못 찾으면(끊김) seed·pidof는 빈 결과이고, createTail은 Android 경로다.
 */
export function createPlatformLogDeps(input: PlatformLogDepsInput): Pick<LogManagerDeps, 'createTail' | 'seedPids' | 'pidof'> {
  function platform(serial: string): Platform | null {
    try {
      return input.platformOf(serial)
    } catch {
      return null
    }
  }
  return {
    createTail: (serial, handlers) => (platform(serial) === 'ios' ? input.ios : input.android).createTail(serial, handlers),
    seedPids: async (serial) => {
      const p = platform(serial)
      if (p === null) return ''
      return (p === 'ios' ? input.ios : input.android).seedPids(serial)
    },
    pidof: async (serial, pkg) => {
      const p = platform(serial)
      if (p === null) return []
      return (p === 'ios' ? input.ios : input.android).pidof(serial, pkg)
    }
  }
}
