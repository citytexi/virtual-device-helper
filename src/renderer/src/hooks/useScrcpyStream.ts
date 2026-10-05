import { useCallback, useEffect, useRef, useState, type RefObject } from 'react'
import type { Outcome } from '../../../shared/types/ipc'
import type { ControlIntent, DeviceKey, SessionStatus, StreamDown, StreamPortMeta } from '../../../shared/types/stream'
import type { VideoSize } from '../stream/inputMapper'
import { createJpegRenderer, decodeJpeg, type JpegRenderer } from '../stream/jpegRenderer'
import { createStreamDecoder, type StreamDecoder } from '../stream/streamDecoder'
import { onStreamPort } from '../stream/streamPort'

export interface StreamDecoderHandlers {
  onFrame(frame: VideoFrame): void
  onError(error: Error): void
}

/** 브라우저 전역에 닿는 부분. 테스트는 이것을 통째로 넘긴다. */
export interface ScrcpyStreamDeps {
  startStream(serial: string): Promise<Outcome<void>>
  stopStream(): Promise<Outcome<void>>
  onStreamPort(callback: (meta: StreamPortMeta, port: MessagePort) => void): () => void
  createDecoder(handlers: StreamDecoderHandlers): StreamDecoder
  /** `session.codec`이 jpeg일 때 쓴다. draw는 bitmap을 그린 뒤 닫는 쪽이 아니라 받는 쪽이 닫는다. */
  createJpegRenderer(draw: (bitmap: ImageBitmap) => void): JpegRenderer
}

export interface ScrcpyStream {
  status: SessionStatus
  /** 서버가 알린 비디오 크기. 입력 좌표 변환과 오버레이가 쓴다. 첫 session meta 전에는 null이다. */
  video: VideoSize | null
  /** 이 세션이 받는 기기 키. 첫 session meta 전에는 빈 배열이다. */
  keys: DeviceKey[]
  send(intent: ControlIntent): void
  /** 스트림을 처음부터 다시 연다. 실패 화면의 "다시 연결" 버튼이 부른다. */
  reconnect(): void
}

function browserDeps(): ScrcpyStreamDeps {
  return {
    startStream: (serial) => window.api.startStream(serial),
    stopStream: () => window.api.stopStream(),
    onStreamPort: (callback) => onStreamPort(callback),
    createDecoder: (handlers) =>
      createStreamDecoder({
        createDecoder: (init) => new VideoDecoder(init),
        createChunk: (init) => new EncodedVideoChunk(init),
        onFrame: handlers.onFrame,
        onError: handlers.onError
      }),
    createJpegRenderer: (draw) => createJpegRenderer({ decode: decodeJpeg, draw })
  }
}

const CONNECTING: SessionStatus = { state: 'connecting' }
const NO_KEYS: DeviceKey[] = []

/**
 * 디코더 실패로 인한 연속 재시작 한도. main의 재시도 횟수와 맞춘다. 이 한도를 넘기면
 * connecting↔streaming을 영원히 오가는 대신 failed로 강등해 스크린샷 폴백과 "다시 연결"
 * 버튼이 뜨게 한다.
 */
const MAX_DECODER_RESTARTS = 3

/** 캔버스 크기를 맞춘다. 바뀔 때만 대입한다 — 대입은 캔버스를 지운다. */
function sizeCanvas(canvas: HTMLCanvasElement, width: number, height: number): void {
  if (canvas.width !== width) canvas.width = width
  if (canvas.height !== height) canvas.height = height
}

function drawFrame(canvas: HTMLCanvasElement | null, frame: VideoFrame, size: VideoSize | null): void {
  try {
    if (!canvas) return
    // 캔버스 크기는 session이 정한다. session 전에 온 프레임만 프레임 크기를 따른다.
    sizeCanvas(canvas, size?.width ?? frame.displayWidth, size?.height ?? frame.displayHeight)
    canvas.getContext('2d')?.drawImage(frame, 0, 0)
  } finally {
    // 닫지 않으면 디코더의 프레임 풀이 말라 디코딩이 멈춘다.
    frame.close()
  }
}

/**
 * JPEG 한 장을 session 크기의 캔버스에 맞춰 그린다. 스트림이 축소(--scale)돼 와도 입력 좌표는
 * session의 width/height 기준이라 캔버스는 그 크기를 지킨다.
 */
function drawBitmap(canvas: HTMLCanvasElement | null, bitmap: ImageBitmap, size: VideoSize | null): void {
  try {
    if (!canvas) return
    const width = size?.width ?? bitmap.width
    const height = size?.height ?? bitmap.height
    sizeCanvas(canvas, width, height)
    canvas.getContext('2d')?.drawImage(bitmap, 0, 0, width, height)
  } finally {
    bitmap.close()
  }
}

/** codec마다 하나씩 쓰는 프레임 경로. 둘 중 하나만 살아 있다. */
interface FramePath {
  codec: 'h264' | 'jpeg'
  push(message: StreamDown): void
  close(): void
}

/**
 * serial의 실시간 화면을 canvasRef에 그린다. 스트림은 main이 열고, 포트는 따로 온다.
 * 같은 serial의 포트 중 가장 나중에 온 것을 쓴다 — main은 새 포트를 만들기 전에 이전 포트를
 * 닫고, IPC는 순서대로 도착하므로 가장 나중 것이 살아 있는 세션이다.
 */
export function useScrcpyStream(
  serial: string,
  canvasRef: RefObject<HTMLCanvasElement | null>,
  deps?: ScrcpyStreamDeps
): ScrcpyStream {
  const depsRef = useRef<ScrcpyStreamDeps | null>(deps ?? null)
  if (!depsRef.current) depsRef.current = browserDeps()

  const [status, setStatus] = useState<SessionStatus>(CONNECTING)
  const [video, setVideo] = useState<VideoSize | null>(null)
  const [keys, setKeys] = useState<DeviceKey[]>(NO_KEYS)
  // 값을 올리면 effect가 다시 돌며 스트림을 처음부터 연다(재연결·디코더 복구).
  const [attempt, setAttempt] = useState(0)
  const portRef = useRef<MessagePort | null>(null)
  // 디코더 실패로 재시작한 연속 횟수. 프레임이 한 번이라도 그려지거나 사람이 직접
  // reconnect()를 부르면 0으로 되돌린다 — 그 시점부터는 새로 세는 게 맞다.
  const restartCountRef = useRef(0)

  useEffect(() => {
    const d = depsRef.current as ScrcpyStreamDeps
    let active = true
    let port: MessagePort | null = null
    let path: FramePath | null = null
    // 가장 나중 session의 크기. 캔버스 크기는 두 경로 모두 이것만 따른다.
    let size: VideoSize | null = null
    setStatus(CONNECTING)
    setVideo(null)
    setKeys(NO_KEYS)

    function release(): void {
      portRef.current = null
      port?.close()
      port = null
      path?.close()
      path = null
    }

    function h264Path(): FramePath {
      const decoder = d.createDecoder({
        onFrame: (frame) => {
          // 한 프레임이라도 그렸다면 그 디코더는 살아 있는 것 — 실패 카운트를 씻는다.
          restartCountRef.current = 0
          drawFrame(canvasRef.current, frame, size)
        },
        onError: (error) => {
          // 닫힌 경로(codec 전환·교체)의 늦은 에러는 지금 세션과 무관하다.
          if (!active || path?.close !== close) return
          if (restartCountRef.current >= MAX_DECODER_RESTARTS) {
            // 한도를 넘겼다 — 더 재시작하지 않고 사람이 보게 failed로 강등한다.
            setStatus({
              state: 'failed',
              error: { kind: 'command_failed', message: error.message, hint: '다시 연결해라' }
            })
            // main은 이 실패를 모른다 — 포트를 놓아 늦게 온 status가 failed를 덮어쓰지
            // 못하게 하고, main에도 세션을 그만두라고 알린다.
            release()
            d.stopStream().catch(() => {})
            return
          }
          restartCountRef.current += 1
          setAttempt((n) => n + 1)
        }
      })
      const close = (): void => decoder.close()
      return {
        codec: 'h264',
        push: (message) => {
          if (message.type === 'packet') decoder.push(message)
        },
        close
      }
    }

    function jpegPath(): FramePath {
      const renderer = d.createJpegRenderer((bitmap) => {
        restartCountRef.current = 0
        drawBitmap(canvasRef.current, bitmap, size)
      })
      return {
        codec: 'jpeg',
        push: (message) => {
          if (message.type === 'frame') renderer.push(message.data)
        },
        close: () => renderer.close()
      }
    }

    /** session이 알린 codec에 맞는 경로로 바꾼다. 같은 codec이면 그대로 둔다. */
    function useCodec(codec: 'h264' | 'jpeg'): void {
      if (path?.codec === codec) return
      path?.close()
      path = codec === 'jpeg' ? jpegPath() : h264Path()
    }

    function adopt(next: MessagePort): void {
      release()
      try {
        // session이 오기 전에는 codec을 모른다. 기존 동작대로 h264로 먼저 열고, session이
        // jpeg이면 그때 바꾼다.
        path = h264Path()
      } catch (error) {
        // createDecoder 자체가 던지면(예: 코덱 미지원) 이 포트로는 아무것도 못 한다 — 포트를
        // 닫아 흘리지 않고, main에도 세션을 그만두라 알리고, 사람이 보게 failed로 강등한다.
        next.close()
        setStatus({
          state: 'failed',
          error: {
            kind: 'command_failed',
            message: error instanceof Error ? error.message : String(error),
            hint: '다시 연결해라'
          }
        })
        d.stopStream().catch(() => {})
        return
      }
      port = next
      portRef.current = next
      next.onmessage = (event: MessageEvent) => {
        if (!active || port !== next) return
        const message = event.data as StreamDown
        if (message.type === 'status') setStatus(message.status)
        else if (message.type === 'session') {
          size = { width: message.width, height: message.height }
          setVideo(size)
          setKeys(message.keys)
          // 회전으로 크기만 바뀌면 다음 프레임 그릴 때 캔버스가 새 크기를 따른다. 지금 한 번
          // 맞춰 두면 프레임이 오기 전 입력 좌표 변환도 새 크기와 어긋나지 않는다.
          const canvas = canvasRef.current
          if (canvas) sizeCanvas(canvas, size.width, size.height)
          try {
            useCodec(message.codec)
          } catch (error) {
            setStatus({
              state: 'failed',
              error: {
                kind: 'command_failed',
                message: error instanceof Error ? error.message : String(error),
                hint: '다시 연결해라'
              }
            })
            release()
            d.stopStream().catch(() => {})
          }
        } else path?.push(message)
      }
    }

    const unsubscribe = d.onStreamPort((meta, next) => {
      if (!active || meta.serial !== serial) {
        next.close()
        return
      }
      adopt(next)
    })

    d.startStream(serial).then(
      (outcome) => {
        if (active && !outcome.ok) setStatus({ state: 'failed', error: outcome.error })
      },
      (thrown: unknown) => {
        if (!active) return
        setStatus({
          state: 'failed',
          error: {
            kind: 'command_failed',
            message: thrown instanceof Error ? thrown.message : String(thrown),
            hint: '다시 연결해라'
          }
        })
      }
    )

    return () => {
      active = false
      unsubscribe()
      release()
      // cleanup 중 실패는 보고할 곳이 없다 — unhandled rejection만 막는다.
      d.stopStream().catch(() => {})
    }
  }, [serial, attempt, canvasRef])

  const send = useCallback((intent: ControlIntent) => {
    portRef.current?.postMessage(intent)
  }, [])

  const reconnect = useCallback(() => {
    // 사람이 직접 다시 연결을 요청했다 — 지난 실패 횟수는 잊는다.
    restartCountRef.current = 0
    setAttempt((n) => n + 1)
  }, [])

  return { status, video, keys, send, reconnect }
}
