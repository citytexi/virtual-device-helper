import { useCallback, useEffect, useRef, useState, type RefObject } from 'react'
import type { Outcome } from '../../../shared/types/ipc'
import type { ControlIntent, SessionStatus, StreamDown, StreamPortMeta } from '../../../shared/types/stream'
import type { VideoSize } from '../stream/inputMapper'
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
}

export interface ScrcpyStream {
  status: SessionStatus
  /** 서버가 알린 비디오 크기. 입력 좌표 변환과 오버레이가 쓴다. 첫 session meta 전에는 null이다. */
  video: VideoSize | null
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
      })
  }
}

const CONNECTING: SessionStatus = { state: 'connecting' }

function drawFrame(canvas: HTMLCanvasElement | null, frame: VideoFrame): void {
  try {
    if (!canvas) return
    if (canvas.width !== frame.displayWidth) canvas.width = frame.displayWidth
    if (canvas.height !== frame.displayHeight) canvas.height = frame.displayHeight
    canvas.getContext('2d')?.drawImage(frame, 0, 0)
  } finally {
    // 닫지 않으면 디코더의 프레임 풀이 말라 디코딩이 멈춘다.
    frame.close()
  }
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
  // 값을 올리면 effect가 다시 돌며 스트림을 처음부터 연다(재연결·디코더 복구).
  const [attempt, setAttempt] = useState(0)
  const portRef = useRef<MessagePort | null>(null)

  useEffect(() => {
    const d = depsRef.current as ScrcpyStreamDeps
    let active = true
    let port: MessagePort | null = null
    let decoder: StreamDecoder | null = null
    setStatus(CONNECTING)
    setVideo(null)

    function release(): void {
      portRef.current = null
      port?.close()
      port = null
      decoder?.close()
      decoder = null
    }

    function adopt(next: MessagePort): void {
      release()
      const adoptedDecoder = d.createDecoder({
        onFrame: (frame) => drawFrame(canvasRef.current, frame),
        onError: () => {
          if (active) setAttempt((n) => n + 1)
        }
      })
      port = next
      decoder = adoptedDecoder
      portRef.current = next
      next.onmessage = (event: MessageEvent) => {
        if (!active || port !== next) return
        const message = event.data as StreamDown
        if (message.type === 'status') setStatus(message.status)
        else if (message.type === 'session') setVideo({ width: message.width, height: message.height })
        else if (message.type === 'packet') adoptedDecoder.push(message)
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
      void d.stopStream()
    }
  }, [serial, attempt, canvasRef])

  const send = useCallback((intent: ControlIntent) => {
    portRef.current?.postMessage(intent)
  }, [])

  const reconnect = useCallback(() => setAttempt((n) => n + 1), [])

  return { status, video, send, reconnect }
}
