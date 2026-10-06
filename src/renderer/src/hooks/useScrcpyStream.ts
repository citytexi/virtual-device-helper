import { useCallback, useEffect, useRef, useState, type RefObject } from 'react'
import type { Outcome } from '../../../shared/types/ipc'
import type { ControlIntent, DeviceKey, SessionStatus, StreamDown, SessionPortMeta, StreamUp } from '../../../shared/types/stream'
import type { VideoSize } from '../stream/inputMapper'
import { createJpegRenderer, decodeJpeg, type JpegRenderer, type JpegRendererDeps } from '../stream/jpegRenderer'
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
  onStreamPort(callback: (meta: SessionPortMeta, port: MessagePort) => void): () => void
  createDecoder(handlers: StreamDecoderHandlers): StreamDecoder
  /** `session.codec`이 jpeg일 때 쓴다. draw는 bitmap을 닫는 책임을 진다. onError는 연속 실패로 포기할 때 한 번 불린다. */
  createJpegRenderer(handlers: Omit<JpegRendererDeps, 'decode'>): JpegRenderer
  /** jpeg 재동기 타이머용. 기본은 전역 setTimeout. */
  setTimer?: typeof setTimeout
  /** 기본은 전역 clearTimeout. */
  clearTimer?: typeof clearTimeout
}

/**
 * jpeg 세션에서 프레임이 이만큼 끊기면 확인을 한 번 더 보낸다. main이 확인을 기다리다 멈춘 경우
 * (확인이 유실됐거나 main이 재연결로 흐름 상태를 비운 경우)를 되살리는 안전망이다.
 */
export const FRAME_RESYNC_MS = 2000

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
    createJpegRenderer: (handlers) => createJpegRenderer({ decode: decodeJpeg, ...handlers })
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
    // 캔버스 크기는 session이 정한다. session 전에 온 프레임만 프레임 크기를 따른다. 크기가
    // 다른 프레임(회전 경합, --max-size)은 잘리지 않고 캔버스에 맞춰 늘어난다.
    sizeCanvas(canvas, size?.width ?? frame.displayWidth, size?.height ?? frame.displayHeight)
    canvas.getContext('2d')?.drawImage(frame, 0, 0, canvas.width, canvas.height)
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
    sizeCanvas(canvas, size?.width ?? bitmap.width, size?.height ?? bitmap.height)
    canvas.getContext('2d')?.drawImage(bitmap, 0, 0, canvas.width, canvas.height)
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
    // 가장 나중 status가 streaming인가. 재동기 타이머가 React state 대신 이것을 읽는다.
    let streaming = false
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

    /**
     * 경로의 치명적 실패. h264 디코더 에러와 JPEG 렌더러의 연속 실패가 같은 길을 탄다.
     * 닫힌 경로(codec 전환·교체)의 늦은 에러는 지금 세션과 무관하다.
     */
    function onPathError(owner: FramePath | null, error: Error): void {
      if (!active || !owner || path !== owner) return
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

    function h264Path(): FramePath {
      const decoder = d.createDecoder({
        onFrame: (frame) => {
          // 한 프레임이라도 그렸다면 그 디코더는 살아 있는 것 — 실패 카운트를 씻는다.
          restartCountRef.current = 0
          drawFrame(canvasRef.current, frame, size)
        },
        onError: (error) => onPathError(created, error)
      })
      const created: FramePath = {
        codec: 'h264',
        push: (message) => {
          if (message.type === 'packet') decoder.push(message)
        },
        close: () => decoder.close()
      }
      return created
    }

    /** 확인을 owner 포트로 보낸다. 포트가 바뀌었거나 effect가 끝났으면 보내지 않는다. */
    function sendAck(owner: MessagePort): void {
      if (!active || port !== owner) return
      owner.postMessage({ type: 'frame_ack' } satisfies StreamUp)
    }

    function jpegPath(owner: MessagePort): FramePath {
      const setTimer = d.setTimer ?? setTimeout
      const clearTimer = d.clearTimer ?? clearTimeout
      let timer: ReturnType<typeof setTimeout> | null = null
      let closed = false
      // 재동기 타이머는 이 경로가 소유한다. 프레임이 올 때마다 다시 걸고, 만료되면 streaming인
      // 동안만 확인을 보낸 뒤 항상 다시 건다.
      const arm = (): void => {
        if (closed) return
        if (timer !== null) clearTimer(timer)
        timer = setTimer(() => {
          if (closed) return
          if (streaming) sendAck(owner)
          arm()
        }, FRAME_RESYNC_MS)
      }
      const renderer = d.createJpegRenderer({
        draw: (bitmap) => {
          restartCountRef.current = 0
          drawBitmap(canvasRef.current, bitmap, size)
        },
        onError: (error) => onPathError(created, error),
        ack: () => sendAck(owner)
      })
      const created: FramePath = {
        codec: 'jpeg',
        push: (message) => {
          if (message.type !== 'frame') return
          arm()
          renderer.push(message.data)
        },
        close: () => {
          closed = true
          if (timer !== null) clearTimer(timer)
          timer = null
          renderer.close()
        }
      }
      arm()
      return created
    }

    /** 경로를 만들다 던지면(예: 코덱 미지원) 이 포트로는 아무것도 못 한다 — 포트를 닫아 흘리지
     * 않고, main에도 세션을 그만두라 알리고, 사람이 보게 failed로 강등한다. */
    function failOpen(error: unknown): void {
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

    /** session이 알린 codec에 맞는 경로로 바꾼다. 같은 codec이면 그대로 둔다. */
    function useCodec(codec: 'h264' | 'jpeg', owner: MessagePort): void {
      if (path?.codec === codec) return
      path?.close()
      path = null
      path = codec === 'jpeg' ? jpegPath(owner) : h264Path()
    }

    function adopt(next: MessagePort): void {
      release()
      // 경로는 첫 session(또는 session 전에 온 packet)에서 만든다 — codec을 모르고 미리
      // 만들면 JPEG 세션도 VideoDecoder를 만들었다 닫게 된다.
      port = next
      portRef.current = next
      streaming = false
      next.onmessage = (event: MessageEvent) => {
        if (!active || port !== next) return
        const message = event.data as StreamDown
        try {
          if (message.type === 'status') {
            streaming = message.status.state === 'streaming'
            setStatus(message.status)
          }
          else if (message.type === 'session') {
            size = { width: message.width, height: message.height }
            setVideo(size)
            setKeys(message.keys)
            // 회전으로 크기가 바뀌면 지금 한 번 맞춰 둔다. 프레임이 오기 전 입력 좌표 변환도
            // 새 크기와 어긋나지 않는다.
            const canvas = canvasRef.current
            if (canvas) sizeCanvas(canvas, size.width, size.height)
            useCodec(message.codec, next)
          } else if (message.type === 'packet') {
            // session 전에 온 packet은 기존 동작대로 h264로 받는다.
            if (!path) path = h264Path()
            path.push(message)
          } else if (message.type === 'frame') {
            if (!path) path = jpegPath(next)
            path.push(message)
          }
        } catch (error) {
          failOpen(error)
        }
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
