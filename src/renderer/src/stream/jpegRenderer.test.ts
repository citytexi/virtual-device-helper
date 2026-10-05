import { describe, expect, it, vi } from 'vitest'
import { createJpegRenderer } from './jpegRenderer'

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
    const renderer = createJpegRenderer({ decode, draw })

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
    const renderer = createJpegRenderer({ decode: () => d.promise, draw })

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
    const renderer = createJpegRenderer({ decode, draw: vi.fn() })

    renderer.close()
    renderer.push(new Uint8Array([1]))

    expect(decode).not.toHaveBeenCalled()
  })

  it('decode가 실패하면 그 장만 버리고 남은 프레임을 이어서 처리한다', async () => {
    const first = deferred<ImageBitmap>()
    const decode = vi.fn((jpeg: Uint8Array) => (jpeg[0] === 1 ? first.promise : Promise.resolve(bitmap('ok'))))
    const draw = vi.fn()
    const renderer = createJpegRenderer({ decode, draw })

    renderer.push(new Uint8Array([1]))
    renderer.push(new Uint8Array([2]))
    first.reject(new Error('깨진 JPEG'))
    await flush()

    expect(draw).toHaveBeenCalledTimes(1)
  })
})
