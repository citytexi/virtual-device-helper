import type { Device, Platform } from '../../shared/types/device'
import { deviceError, isDeviceError, type DeviceError } from '../../shared/types/errors'
import { AXE_HINT, type AxeClient } from '../ios/axeClient'
import { createAxeControl } from './axeControl'
import { createAxeStreamSession } from './axeStreamSession'
import type { StreamManagerDeps } from './streamManager'
import type { StreamSession } from './streamSession'

type CreateSession = StreamManagerDeps['createSession']

/**
 * start()가 곧바로 error로 reject하는 세션. 스트림 매니저는 첫 start() 실패를 재시도 없이
 * failed로 알리므로, renderer는 기존 강등 경로대로 스크린샷을 보여 준다.
 * 나머지 멤버는 아무것도 하지 않는다.
 */
export function rejectingSession(error: DeviceError): StreamSession {
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
  /** AXe를 못 찾았으면 null이다. `createIosStreamSessionFactory`가 만든다. */
  ios: CreateSession | null
}

/**
 * 기기 `platform`으로 스트림 세션을 고르는 라우터. 분기는 이 조립 지점에만 둔다(ADR-0015).
 * 스트림 매니저는 플랫폼을 모른다. 도구가 없는 플랫폼의 기기는 그 이유로 거절하는 세션을 받는다.
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
    if (platform === 'ios') {
      if (!input.ios) return rejectingSession(deviceError('ios_tool_not_found', 'axe를 찾을 수 없다', AXE_HINT))
      return input.ios(serial, handlers)
    }
    if (!input.android) {
      return rejectingSession(
        deviceError('sdk_not_found', 'Android SDK를 찾지 못했다', 'ANDROID_HOME을 SDK 경로로 설정하고 앱을 다시 실행해라')
      )
    }
    return input.android(serial, handlers)
  }
}

export interface IosStreamSessionInput {
  axe: AxeClient
  /** 모르는 기기면 던진다(`registry.resolve(serial)`). 입력마다 다시 찾는다. */
  deviceOf(serial: string): Pick<Device, 'displayFrame' | 'inputText'>
  /** 기기별 직렬화 큐(`registry.run`). MCP 툴이 서는 줄과 같은 줄이다. */
  run<T>(serial: string, task: () => Promise<T>): Promise<T>
}

/**
 * iOS 기기의 스트림 세션 팩토리. `axe stream-video` 세션에 화면 입력(`createAxeControl`)을 잇는다.
 * 좌표 환산용 화면 크기와 문자열 입력은 그 기기의 `IosDevice`가 한다.
 */
export function createIosStreamSessionFactory(input: IosStreamSessionInput): CreateSession {
  return (udid, handlers) =>
    createAxeStreamSession(
      {
        udid,
        axe: input.axe,
        control: createAxeControl({
          udid,
          axe: input.axe,
          displayFrame: async () => input.deviceOf(udid).displayFrame(),
          // 문자열 입력은 시뮬레이터 클립보드를 거친다. MCP ui_text와 같은 기기 큐에 세워
          // 한쪽의 pbcopy와 ⌘V 사이에 다른 쪽이 끼어들지 못하게 한다. 탭·스와이프·키는 스스로는
          // 기기 큐에 서지 않는다. 다만 axeControl의 직렬 체인에서 보내지 않은 텍스트가 앞에 있으면
          // (비텍스트 입력은 텍스트를 먼저 flush한다) 그 텍스트 뒤에서 기다린다. 긴 app_install 중에
          // 글자 하나를 치고 클릭하면 클릭은 설치가 끝날 때까지 밀린다.
          inputText: (text) => input.run(udid, async () => input.deviceOf(udid).inputText(text))
        })
      },
      handlers
    )
}
