import { deviceError, type DeviceError } from '../../shared/types/errors'
import type { ControlIntent } from '../../shared/types/stream'
import type { AxeClient } from '../ios/axeClient'
import type { ProcessStream } from '../process/processClient'
import { IOS_KEYS } from './iosKeys'
import { jpegSize } from './jpegSize'
import { createMjpegSplitter } from './mjpegSplitter'
import type { StreamSession, StreamSessionHandlers } from './streamSession'

/**
 * `axe stream-video` 시작 인자. `--udid`는 AxeClient.stream이 붙인다.
 * 스파이크 결과로 값을 바꿀 수 있게 여기 한 곳에만 둔다.
 */
export const STREAM_ARGS = ['stream-video', '--format', 'mjpeg', '--fps', '30', '--scale', '0.5', '--quality', '70']

const DEFAULT_FIRST_FRAME_TIMEOUT_MS = 10_000

export interface AxeStreamSessionDeps {
  udid: string
  axe: AxeClient
  /** 화면 입력. 이 세션은 현재 비디오 크기와 함께 넘기기만 한다. */
  control: { send(intent: ControlIntent, video: { width: number; height: number }): void; close(): void }
  /** 기본 10000. 이 시간 안에 첫 프레임이 없으면 device_unresponsive다. */
  firstFrameTimeoutMs?: number
  setTimer?: typeof setTimeout
  clearTimer?: typeof clearTimeout
}

/** axe stream-video의 MJPEG stdout을 JPEG 프레임으로 잘라 StreamSession으로 올린다. */
export function createAxeStreamSession(deps: AxeStreamSessionDeps, handlers: StreamSessionHandlers): StreamSession {
  const setTimer = deps.setTimer ?? setTimeout
  const clearTimer = deps.clearTimer ?? clearTimeout
  const timeoutMs = deps.firstFrameTimeoutMs ?? DEFAULT_FIRST_FRAME_TIMEOUT_MS

  let stream: ProcessStream | null = null
  let size: { width: number; height: number } | null = null
  let started = false
  let closed = false
  let ended = false
  // 스트림이 에러를 알린 뒤 close가 따라온다. 그 에러를 종료 원인으로 쓴다.
  let streamError: DeviceError | null = null
  let failStart: ((error: DeviceError) => void) | null = null

  function onFrame(jpeg: Uint8Array, resolveStart: () => void): void {
    if (closed) return
    const dim = jpegSize(jpeg)
    // 크기를 못 읽는 프레임은 버린다. 크기를 모르면 입력 좌표를 만들 수 없다.
    if (!dim) return
    if (!size || size.width !== dim.width || size.height !== dim.height) {
      size = dim
      handlers.onSession({ ...dim, codec: 'jpeg', keys: IOS_KEYS })
    }
    if (!started) {
      started = true
      resolveStart()
    }
    handlers.onFrame(jpeg)
  }

  function onStreamClosed(): void {
    if (closed || ended) return
    const error =
      streamError ?? deviceError('device_unresponsive', 'axe stream-video가 끝났다', '기기 상태를 확인하고 다시 연결해라')
    if (!started) {
      failStart?.(error)
      return
    }
    ended = true
    handlers.onEnded(error)
  }

  return {
    serial: deps.udid,

    start() {
      return new Promise<void>((resolve, reject) => {
        let settled = false
        const timer = setTimer(() => {
          fail(
            deviceError(
              'device_unresponsive',
              `axe stream-video가 ${timeoutMs}ms 안에 첫 프레임을 주지 않았다`,
              '시뮬레이터가 부팅됐는지 확인해라'
            )
          )
        }, timeoutMs)

        function fail(error: DeviceError): void {
          if (settled) return
          settled = true
          clearTimer(timer)
          stream?.close()
          reject(error)
        }
        failStart = fail

        const splitter = createMjpegSplitter((jpeg) =>
          onFrame(jpeg, () => {
            settled = true
            clearTimer(timer)
            resolve()
          })
        )
        stream = deps.axe.stream(deps.udid, STREAM_ARGS)
        stream.onData((chunk) => splitter.push(chunk))
        stream.onError((error) => {
          streamError = error
        })
        stream.onClose(onStreamClosed)
      })
    },

    sendControl(intent) {
      if (!size || closed) return
      deps.control.send(intent, size)
    },

    async close() {
      if (closed) return
      closed = true
      stream?.close()
      deps.control.close()
    }
  }
}
