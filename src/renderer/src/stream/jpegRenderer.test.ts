import { describe, expect, it, vi } from 'vitest'
import { createJpegRenderer, MAX_CONSECUTIVE_FAILURES } from './jpegRenderer'

function bitmap(name: string): ImageBitmap {
  return { name, close: vi.fn() } as unknown as ImageBitmap
}

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: Error) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0))

describe('createJpegRenderer', () => {
  it('느린 decode 중 온 프레임은 최신 한 장만 남기고 첫 장과 마지막 장만 그린다', async () => {
    const pending = new Map<number, ReturnType<typeof deferred<ImageBitmap>>>()
    const decode = vi.fn((jpeg: Uint8Array) => {
      const d = deferred<ImageBitmap>()
      pending.set(jpeg[0] as number, d)
      return d.promise
    })
    const draw = vi.fn()
    const renderer = createJpegRenderer({ decode, draw, onError: vi.fn(), ack: vi.fn() })

    renderer.push(new Uint8Array([1]))
    renderer.push(new Uint8Array([2]))
    renderer.push(new Uint8Array([3]))
    expect(decode).toHaveBeenCalledTimes(1)

    const first = bitmap('first')
    pending.get(1)?.resolve(first)
    await flush()
    expect(draw).toHaveBeenCalledWith(first)
    expect(decode).toHaveBeenCalledTimes(2)
    expect(decode.mock.calls[1]?.[0]).toEqual(new Uint8Array([3]))

    const last = bitmap('last')
    pending.get(3)?.resolve(last)
    await flush()
    expect(draw.mock.calls.map((c) => c[0])).toEqual([first, last])
    expect(decode).toHaveBeenCalledTimes(2)
  })

  it('close() 뒤에 끝난 decode는 그리지 않고 bitmap을 닫는다', async () => {
    const d = deferred<ImageBitmap>()
    const draw = vi.fn()
    const renderer = createJpegRenderer({ decode: () => d.promise, draw, onError: vi.fn(), ack: vi.fn() })

    renderer.push(new Uint8Array([1]))
    renderer.close()
    const late = bitmap('late')
    d.resolve(late)
    await flush()

    expect(draw).not.toHaveBeenCalled()
    expect(late.close).toHaveBeenCalled()
  })

  it('close() 뒤 push는 무시한다', () => {
    const decode = vi.fn(async () => bitmap('x'))
    const renderer = createJpegRenderer({ decode, draw: vi.fn(), onError: vi.fn(), ack: vi.fn() })

    renderer.close()
    renderer.push(new Uint8Array([1]))

    expect(decode).not.toHaveBeenCalled()
  })

  it('decode가 실패하면 그 장만 버리고 남은 프레임을 이어서 처리한다', async () => {
    const first = deferred<ImageBitmap>()
    const decode = vi.fn((jpeg: Uint8Array) => (jpeg[0] === 1 ? first.promise : Promise.resolve(bitmap('ok'))))
    const draw = vi.fn()
    const renderer = createJpegRenderer({ decode, draw, onError: vi.fn(), ack: vi.fn() })

    renderer.push(new Uint8Array([1]))
    renderer.push(new Uint8Array([2]))
    first.reject(new Error('깨진 JPEG'))
    await flush()

    expect(draw).toHaveBeenCalledTimes(1)
  })

  describe('연속 실패', () => {
    /** 프레임을 한 장씩 기다려 가며 넣는다. decode 결과는 frames의 순서대로 정해진다. */
    async function feed(outcomes: Array<'ok' | 'fail' | 'drawThrows'>) {
      const bitmaps: ImageBitmap[] = []
      let i = 0
      const decode = vi.fn(async () => {
        const outcome = outcomes[i++]
        if (outcome === 'fail') throw new Error('깨진 JPEG')
        const b = bitmap(`b${i}`)
        bitmaps.push(b)
        return b
      })
      let drawIndex = 0
      const draw = vi.fn(() => {
        drawIndex += 1
        if (outcomes[drawIndex - 1] === 'drawThrows') throw new Error('draw 실패')
      })
      const onError = vi.fn()
      const ack = vi.fn()
      const renderer = createJpegRenderer({ decode, draw, onError, ack })
      return { renderer, decode, draw, onError, ack, bitmaps }
    }

    async function pushAll(renderer: { push(j: Uint8Array): void }, count: number) {
      for (let n = 0; n < count; n++) {
        renderer.push(new Uint8Array([n]))
        await flush()
      }
    }

    it('실패한 decode의 bitmap은 그리지 않고 다음 프레임은 처리한다', async () => {
      const f = await feed(['fail', 'ok'])
      await pushAll(f.renderer, 2)
      expect(f.draw).toHaveBeenCalledTimes(1)
      expect(f.onError).not.toHaveBeenCalled()
    })

    it('연속 10번 실패하면 onError를 한 번 부르고 그 뒤로는 아무것도 그리지 않는다', async () => {
      const f = await feed([...Array(MAX_CONSECUTIVE_FAILURES).fill('fail'), 'ok', 'ok'])
      await pushAll(f.renderer, MAX_CONSECUTIVE_FAILURES + 2)
      expect(f.onError).toHaveBeenCalledTimes(1)
      expect(f.onError.mock.calls[0]?.[0]).toBeInstanceOf(Error)
      expect(f.draw).not.toHaveBeenCalled()
    })

    it('중간에 성공이 끼면 연속 횟수가 처음부터 다시 센다', async () => {
      const failures = Array(MAX_CONSECUTIVE_FAILURES - 1).fill('fail')
      const f = await feed([...failures, 'ok', ...failures, 'ok'])
      await pushAll(f.renderer, failures.length * 2 + 2)
      expect(f.onError).not.toHaveBeenCalled()
      expect(f.draw).toHaveBeenCalledTimes(2)
    })

    it('draw가 던져도 같은 방식으로 세고 bitmap은 닫는다', async () => {
      const f = await feed(Array(MAX_CONSECUTIVE_FAILURES).fill('drawThrows'))
      await pushAll(f.renderer, MAX_CONSECUTIVE_FAILURES)
      expect(f.onError).toHaveBeenCalledTimes(1)
      for (const b of f.bitmaps) expect(b.close).toHaveBeenCalled()
    })
  })

  describe('확인(ack)', () => {
    it('한 장을 그리면 ack를 한 번 부른다', async () => {
      const ack = vi.fn()
      const draw = vi.fn()
      const renderer = createJpegRenderer({ decode: async () => bitmap('a'), draw, onError: vi.fn(), ack })

      renderer.push(new Uint8Array([1]))
      await flush()

      expect(draw).toHaveBeenCalledTimes(1)
      expect(ack).toHaveBeenCalledTimes(1)
    })

    it('느린 decode 중 셋을 push하면 ack는 세 번이고 draw는 두 번이며 덮인 장의 ack는 push 안에서 동기로 나간다', async () => {
      const pending = new Map<number, ReturnType<typeof deferred<ImageBitmap>>>()
      const decode = vi.fn((jpeg: Uint8Array) => {
        const d = deferred<ImageBitmap>()
        pending.set(jpeg[0] as number, d)
        return d.promise
      })
      const draw = vi.fn()
      const ack = vi.fn()
      const renderer = createJpegRenderer({ decode, draw, onError: vi.fn(), ack })

      renderer.push(new Uint8Array([1]))
      renderer.push(new Uint8Array([2]))
      expect(ack).not.toHaveBeenCalled()
      renderer.push(new Uint8Array([3]))
      expect(ack).toHaveBeenCalledTimes(1)

      pending.get(1)?.resolve(bitmap('1'))
      await flush()
      expect(ack).toHaveBeenCalledTimes(2)
      pending.get(3)?.resolve(bitmap('3'))
      await flush()

      expect(draw).toHaveBeenCalledTimes(2)
      expect(ack).toHaveBeenCalledTimes(3)
    })

    it('decode가 reject하면 그 장에 ack를 한 번 부르고 draw는 없다', async () => {
      const ack = vi.fn()
      const draw = vi.fn()
      const renderer = createJpegRenderer({
        decode: () => Promise.reject(new Error('깨진 JPEG')),
        draw,
        onError: vi.fn(),
        ack
      })

      renderer.push(new Uint8Array([1]))
      await flush()

      expect(draw).not.toHaveBeenCalled()
      expect(ack).toHaveBeenCalledTimes(1)
    })

    it('draw가 던져도 ack를 한 번 부른다', async () => {
      const ack = vi.fn()
      const renderer = createJpegRenderer({
        decode: async () => bitmap('a'),
        draw: () => {
          throw new Error('draw 실패')
        },
        onError: vi.fn(),
        ack
      })

      renderer.push(new Uint8Array([1]))
      await flush()

      expect(ack).toHaveBeenCalledTimes(1)
    })

    it('ack가 던져도 실패 횟수가 늘지 않는다', async () => {
      const onError = vi.fn()
      const draw = vi.fn()
      const ack = vi.fn(() => {
        throw new Error('ack 실패')
      })
      const renderer = createJpegRenderer({ decode: async () => bitmap('ok'), draw, onError, ack })

      // ack 실패가 프레임 실패로 세어진다면 한도에서 포기해 이후 장은 그려지지 않는다.
      const frames = MAX_CONSECUTIVE_FAILURES * 2
      for (let n = 0; n < frames; n++) {
        renderer.push(new Uint8Array([n]))
        await flush()
      }

      expect(onError).not.toHaveBeenCalled()
      expect(draw).toHaveBeenCalledTimes(frames)
    })

    it('연속 실패 한도에 닿은 장과 그 뒤의 push에는 ack가 없고 onError는 한 번이다', async () => {
      const ack = vi.fn()
      const onError = vi.fn()
      const renderer = createJpegRenderer({
        decode: () => Promise.reject(new Error('깨진 JPEG')),
        draw: vi.fn(),
        onError,
        ack
      })

      for (let n = 0; n < MAX_CONSECUTIVE_FAILURES + 2; n++) {
        renderer.push(new Uint8Array([n]))
        await flush()
      }

      expect(onError).toHaveBeenCalledTimes(1)
      expect(ack).toHaveBeenCalledTimes(MAX_CONSECUTIVE_FAILURES - 1)
    })

    it('close() 뒤에 resolve된 decode에는 ack가 없다', async () => {
      const d = deferred<ImageBitmap>()
      const ack = vi.fn()
      const renderer = createJpegRenderer({ decode: () => d.promise, draw: vi.fn(), onError: vi.fn(), ack })

      renderer.push(new Uint8Array([1]))
      renderer.close()
      d.resolve(bitmap('late'))
      await flush()

      expect(ack).not.toHaveBeenCalled()
    })

    it('close() 뒤에 reject된 decode에는 ack가 없다', async () => {
      const d = deferred<ImageBitmap>()
      const ack = vi.fn()
      const renderer = createJpegRenderer({ decode: () => d.promise, draw: vi.fn(), onError: vi.fn(), ack })

      renderer.push(new Uint8Array([1]))
      renderer.close()
      d.reject(new Error('늦은 실패'))
      await flush()

      expect(ack).not.toHaveBeenCalled()
    })

    it('close()가 버린 latest와 닫힌 뒤의 push에는 ack가 없다', async () => {
      const d = deferred<ImageBitmap>()
      const ack = vi.fn()
      const renderer = createJpegRenderer({ decode: () => d.promise, draw: vi.fn(), onError: vi.fn(), ack })

      renderer.push(new Uint8Array([1]))
      renderer.push(new Uint8Array([2]))
      renderer.close()
      renderer.push(new Uint8Array([3]))
      d.resolve(bitmap('late'))
      await flush()

      expect(ack).not.toHaveBeenCalled()
    })
  })
})
