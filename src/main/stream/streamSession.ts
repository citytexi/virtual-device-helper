import type { DeviceError } from '../../shared/types/errors'
import type { ControlIntent, DeviceKey } from '../../shared/types/stream'
import type { VideoPacket } from './scrcpyProtocol'

/** 첫 화면 정보. renderer는 `codec`으로 디코더를, `keys`로 기기 버튼을 고른다. */
export interface SessionInfo {
  width: number
  height: number
  codec: 'h264' | 'jpeg'
  keys: DeviceKey[]
}

/**
 * 세션이 스트림 매니저로 올리는 이벤트. h264 세션은 onPacket, jpeg 세션은 onFrame만 부른다.
 */
export interface StreamSessionHandlers {
  onSession(info: SessionInfo): void
  onPacket(packet: VideoPacket): void
  /** jpeg 프레임 하나. 한 번 호출이 이미지 한 장이다. */
  onFrame(jpeg: Uint8Array): void
  /** 예기치 않은 종료. close()로 닫은 경우에는 부르지 않는다. 최대 한 번. */
  onEnded(error: DeviceError): void
}

/** 스트림 매니저가 다루는 세션. scrcpy(Android)와 AXe MJPEG(iOS)가 구현한다. */
export interface StreamSession {
  readonly serial: string
  /** 첫 session 정보를 올리면 끝난다. 실패하면 연 자원을 정리하고 던진다. */
  start(): Promise<void>
  sendControl(intent: ControlIntent): void
  close(): Promise<void>
}
