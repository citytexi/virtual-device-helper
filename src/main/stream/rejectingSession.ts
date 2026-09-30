import type { Platform } from '../../shared/types/device'
import { deviceError, isDeviceError, unsupported, type DeviceError } from '../../shared/types/errors'
import type { StreamManagerDeps } from './streamManager'

type CreateSession = StreamManagerDeps['createSession']

/**
 * start()가 곧바로 error로 reject하는 세션. 스트림 매니저는 첫 start() 실패를 재시도 없이
 * failed로 알리므로, renderer는 기존 강등 경로대로 스크린샷을 보여 준다.
 * 나머지 멤버는 아무것도 하지 않는다. `StreamSession` 인터페이스로 올리는 일은 M4-3이다.
 */
export function rejectingSession(error: DeviceError): ReturnType<CreateSession> {
  return {
    // 매니저는 세션의 serial을 읽지 않는다. 이 세션은 어느 기기에도 붙지 않는다.
    serial: '',
    start: () => Promise.reject(error),
    sendControl: () => {},
    close: async () => {}
  }
}

export interface PlatformStreamSessionInput {
  /** 모르는 기기면 던진다(`registry.resolve(serial).platform`). */
  platformOf(serial: string): Platform
  /** Android SDK가 없으면 null이다. */
  android: CreateSession | null
}

/**
 * 기기 `platform`으로 스트림 세션을 고르는 라우터. 분기는 이 조립 지점에만 둔다(ADR-0015).
 * M4-1에서 iOS는 스트림을 열지 않고 unsupported로 거절한다. 실제 스트림은 M4-3이다.
 */
export function createPlatformStreamSession(input: PlatformStreamSessionInput): CreateSession {
  return (serial, handlers) => {
    let platform: Platform
    try {
      platform = input.platformOf(serial)
    } catch (thrown) {
      return rejectingSession(
        isDeviceError(thrown)
          ? thrown
          : deviceError('no_device', `기기를 찾지 못했다: ${serial}`, '기기 목록을 확인해라')
      )
    }
    if (platform === 'ios') return rejectingSession(unsupported('ios', '실시간 화면', 'M4-3에서 지원한다'))
    if (!input.android) {
      return rejectingSession(
        deviceError('sdk_not_found', 'Android SDK를 찾지 못했다', 'ANDROID_HOME을 SDK 경로로 설정하고 앱을 다시 실행해라')
      )
    }
    return input.android(serial, handlers)
  }
}
