import { describe, expect, it, vi } from 'vitest'
import { createStreamDecoder, type DecoderLike } from './streamDecoder'

const CONFIG = Uint8Array.from([0, 0, 0, 1, 0x67, 0x64, 0x00, 0x20, 0, 0, 0, 1, 0x68, 0xee])
const OTHER_CONFIG = Uint8Array.from([0, 0, 0, 1, 0x67, 0x42, 0xc0, 0x1f])

function harness(opts: { maxQueue?: number } = {}) {
  let init: VideoDecoderInit | null = null
  const decoder = {
    configure: vi.fn(),
    decode: vi.fn(),
    close: vi.fn(),
    decodeQueueSize: 0,
    state: 'configured' as CodecState
  }
  const onFrame = vi.fn()
  const onError = vi.fn()
  const stream = createStreamDecoder({
    createDecoder: (i) => {
      init = i
      return decoder as DecoderLike
    },
    // 가짜 chunk는 init을 그대로 담는다. 테스트는 type·timestamp·data만 본다.
    createChunk: (i) => i as unknown as EncodedVideoChunk,
    onFrame,
    onError,
    maxQueue: opts.maxQueue
  })
  const decoded = () => decoder.decode.mock.calls.map((call) => call[0] as EncodedVideoChunkInit)
  return { stream, decoder, onFrame, onError, decoded, init: () => init as unknown as VideoDecoderInit }
}

const key = (bytes: number[], ptsUs = 0) => ({ config: false, key: true, ptsUs, data: Uint8Array.from(bytes) })
const delta = (bytes: number[], ptsUs = 0) => ({ config: false, key: false, ptsUs, data: Uint8Array.from(bytes) })
const config = (data: Uint8Array) => ({ config: true, key: false, ptsUs: null, data })

describe('createStreamDecoder', () => {
  it('configures from the config packet and decodes config plus key frame as one key chunk', () => {
    const h = harness()

    h.stream.push(config(CONFIG))
    h.stream.push(key([9, 9], 1000))

    expect(h.decoder.configure).toHaveBeenCalledWith({ codec: 'avc1.640020', optimizeForLatency: true })
    expect(h.decoded()).toEqual([{ type: 'key', timestamp: 1000, data: Uint8Array.from([...CONFIG, 9, 9]) }])
  })

  it('decodes delta frames after the key frame', () => {
    const h = harness()
    h.stream.push(config(CONFIG))
    h.stream.push(key([1]))

    h.stream.push(delta([2], 2000))

    expect(h.decoded()[1]).toEqual({ type: 'delta', timestamp: 2000, data: Uint8Array.from([2]) })
  })

  it('drops delta frames that arrive before the first key frame', () => {
    const h = harness()
    h.stream.push(config(CONFIG))

    h.stream.push(delta([2]))

    expect(h.decoded()).toEqual([])
  })

  it('ignores media before any config packet', () => {
    const h = harness()

    h.stream.push(key([1]))

    expect(h.decoder.decode).not.toHaveBeenCalled()
  })

  it('drops deltas while the queue is backed up and resumes at the next key frame', () => {
    const h = harness({ maxQueue: 2 })
    h.stream.push(config(CONFIG))
    h.stream.push(key([1]))

    h.decoder.decodeQueueSize = 5
    h.stream.push(delta([2]))
    h.decoder.decodeQueueSize = 0
    h.stream.push(delta([3]))
    h.stream.push(key([4]))
    h.stream.push(delta([5]))

    expect(h.decoded().map((c) => (c.data as Uint8Array).at(-1))).toEqual([1, 4, 5])
  })

  it('reconfigures when a new config arrives and waits for its key frame', () => {
    const h = harness()
    h.stream.push(config(CONFIG))
    h.stream.push(key([1]))

    h.stream.push(config(OTHER_CONFIG))
    h.stream.push(delta([2]))
    h.stream.push(key([3]))

    expect(h.decoder.configure).toHaveBeenLastCalledWith({ codec: 'avc1.42c01f', optimizeForLatency: true })
    expect(h.decoded()).toHaveLength(2)
    expect(h.decoded()[1]?.data).toEqual(Uint8Array.from([...OTHER_CONFIG, 3]))
  })

  it('reports a config packet without an SPS once and then stops', () => {
    const h = harness()

    h.stream.push(config(Uint8Array.from([0, 0, 0, 1, 0x68])))
    h.stream.push(config(CONFIG))

    expect(h.onError).toHaveBeenCalledTimes(1)
    expect(h.decoder.configure).not.toHaveBeenCalled()
  })

  it('reports a decoder error once', () => {
    const h = harness()

    h.init().error(new DOMException('bad', 'EncodingError'))
    h.init().error(new DOMException('again', 'EncodingError'))

    expect(h.onError).toHaveBeenCalledTimes(1)
  })

  it('reports a decode call that throws', () => {
    const h = harness()
    h.decoder.decode.mockImplementation(() => {
      throw new Error('closed codec')
    })
    h.stream.push(config(CONFIG))

    h.stream.push(key([1]))

    expect(h.onError).toHaveBeenCalledTimes(1)
  })

  it('passes frames on, and closes frames that arrive after close', () => {
    const h = harness()
    const frame = { close: vi.fn() } as unknown as VideoFrame
    h.init().output(frame)
    expect(h.onFrame).toHaveBeenCalledWith(frame)

    h.stream.close()
    const late = { close: vi.fn() } as unknown as VideoFrame
    h.init().output(late)

    expect(h.onFrame).toHaveBeenCalledTimes(1)
    expect((late as unknown as { close: ReturnType<typeof vi.fn> }).close).toHaveBeenCalled()
    expect(h.decoder.close).toHaveBeenCalled()
  })

  it('closes frames that arrive after a failure', () => {
    const h = harness()
    h.decoder.decode.mockImplementation(() => {
      throw new Error('closed codec')
    })
    h.stream.push(config(CONFIG))
    h.stream.push(key([1]))

    const frame = { close: vi.fn() } as unknown as VideoFrame
    h.init().output(frame)

    expect(h.onFrame).not.toHaveBeenCalled()
    expect((frame as unknown as { close: ReturnType<typeof vi.fn> }).close).toHaveBeenCalled()
  })
})
