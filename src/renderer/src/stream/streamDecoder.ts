import { codecFromConfig } from './h264'

/**
 * decodeQueueSize가 이 값을 넘으면 다음 키프레임까지 delta를 버린다. 에이전트를 지켜보는
 * 용도라 밀린 프레임을 다 그리는 것보다 최신 화면으로 건너뛰는 편이 낫다. 실제 값은
 * 스펙의 열린 질문대로 에뮬레이터에서 지연을 보며 조정한다.
 */
export const DEFAULT_MAX_DECODE_QUEUE = 3

/** VideoDecoder에서 쓰는 부분. 테스트는 가짜를 넘긴다(jsdom에는 WebCodecs가 없다). */
export interface DecoderLike {
  configure(config: VideoDecoderConfig): void
  decode(chunk: EncodedVideoChunk): void
  close(): void
  readonly decodeQueueSize: number
  readonly state: CodecState
}

export interface PacketInput {
  config: boolean
  key: boolean
  ptsUs: number | null
  data: Uint8Array
}

export interface StreamDecoderDeps {
  createDecoder(init: VideoDecoderInit): DecoderLike
  createChunk(init: EncodedVideoChunkInit): EncodedVideoChunk
  /** 받은 쪽이 그린 뒤 frame.close()를 부른다. */
  onFrame(frame: VideoFrame): void
  /** 복구할 수 없는 실패. 한 번만 부른다. 이후 입력은 무시한다. */
  onError(error: Error): void
  maxQueue?: number
}

export interface StreamDecoder {
  push(packet: PacketInput): void
  close(): void
}

function concat(a: Uint8Array, b: Uint8Array): Uint8Array {
  const joined = new Uint8Array(a.length + b.length)
  joined.set(a, 0)
  joined.set(b, a.length)
  return joined
}

export function createStreamDecoder(deps: StreamDecoderDeps): StreamDecoder {
  const maxQueue = deps.maxQueue ?? DEFAULT_MAX_DECODE_QUEUE
  let failed = false
  let closed = false
  let config: Uint8Array | null = null
  let needKey = true

  function fail(thrown: unknown): void {
    if (failed || closed) return
    failed = true
    deps.onError(thrown instanceof Error ? thrown : new Error(String(thrown)))
  }

  const decoder = deps.createDecoder({
    output: (frame) => {
      if (closed) {
        frame.close()
        return
      }
      deps.onFrame(frame)
    },
    error: (error) => fail(error)
  })

  return {
    push(packet) {
      if (failed || closed) return
      try {
        if (packet.config) {
          const codec = codecFromConfig(packet.data)
          if (!codec) {
            fail(new Error('config 패킷에서 SPS를 찾지 못했다'))
            return
          }
          // 회전하면 SPS가 바뀐다. 매번 다시 configure하고 새 키프레임부터 그린다.
          decoder.configure({ codec, optimizeForLatency: true })
          config = packet.data
          needKey = true
          return
        }

        if (!config) return
        if (!packet.key) {
          if (needKey) return
          if (decoder.decodeQueueSize > maxQueue) {
            needKey = true
            return
          }
        }

        // SPS/PPS는 config 패킷에만 있다. 키프레임마다 앞에 붙여 두면 delta를 버린 뒤에도
        // 그 키프레임 하나로 다시 그릴 수 있다(M1 스파이크에서 확인한 방식).
        const data = packet.key ? concat(config, packet.data) : packet.data
        decoder.decode(deps.createChunk({ type: packet.key ? 'key' : 'delta', timestamp: packet.ptsUs ?? 0, data }))
        if (packet.key) needKey = false
      } catch (thrown) {
        fail(thrown)
      }
    },

    close() {
      if (closed) return
      closed = true
      try {
        if (decoder.state !== 'closed') decoder.close()
      } catch {
        // 이미 에러로 닫힌 디코더다.
      }
    }
  }
}
