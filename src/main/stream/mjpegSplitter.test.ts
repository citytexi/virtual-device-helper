import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { jpegSize } from './jpegSize'
import { createMjpegSplitter } from './mjpegSplitter'

const FIXTURES = join(__dirname, '../device/parsers/__fixtures__/ios')
const jpegStream = readFileSync(join(FIXTURES, 'stream-video-jpeg.bin'))
const pngStream = readFileSync(join(FIXTURES, 'stream-video.bin'))

function collect(opts?: { maxFrameBytes?: number }): {
  frames: Uint8Array[]
  push(chunk: Buffer): void
} {
  const frames: Uint8Array[] = []
  const splitter = createMjpegSplitter((f) => frames.push(f), opts)
  return { frames, push: (c) => splitter.push(c) }
}

function part(body: Uint8Array, headers?: string): Buffer {
  const head = headers ?? `--mjpegstream\r\nContent-Type: image/jpeg\r\nContent-Length: ${body.length}\r\n\r\n`
  return Buffer.concat([Buffer.from(head), body, Buffer.from('\r\n')])
}
const jpeg = (n: number): Uint8Array =>
  Uint8Array.from([0xff, 0xd8, ...new Array(n).fill(0x11), 0xff, 0xd9])

describe('createMjpegSplitter', () => {
  it('fixture를 한 번에 push하면 SOI~EOI 프레임이 나온다', () => {
    const c = collect()
    c.push(jpegStream)
    expect(c.frames.length).toBeGreaterThan(0) // fixture는 JPEG 파트 여러 장
    for (const f of c.frames) {
      expect([f[0], f[1]]).toEqual([0xff, 0xd8])
      expect([f[f.length - 2], f[f.length - 1]]).toEqual([0xff, 0xd9])
    }
    expect(jpegSize(c.frames[0]!)).toEqual({ width: 0x25b, height: 0x51f })
  })

  it('1바이트씩 push해도 같은 프레임이 나온다', () => {
    const whole = collect()
    whole.push(jpegStream)
    const bytes = collect()
    for (let i = 0; i < jpegStream.length; i++) bytes.push(jpegStream.subarray(i, i + 1))
    expect(bytes.frames.length).toBe(whole.frames.length)
    bytes.frames.forEach((f, i) => expect(Buffer.from(f).equals(Buffer.from(whole.frames[i]!))).toBe(true))
  })

  it('중간 청크 경계가 어디든 같은 결과다', () => {
    const whole = collect()
    whole.push(jpegStream)
    const c = collect()
    for (let i = 0; i < jpegStream.length; i += 7919) c.push(jpegStream.subarray(i, i + 7919))
    expect(c.frames.length).toBe(whole.frames.length)
  })

  it('maxFrameBytes를 넘는 프레임은 버리고 다음 프레임은 낸다', () => {
    const c = collect({ maxFrameBytes: 16 })
    c.push(Buffer.concat([part(jpeg(100)), part(jpeg(4)), part(jpeg(200))]))
    expect(c.frames.length).toBe(1)
    expect(c.frames[0]!.length).toBe(8)
  })

  it('fixture에 maxFrameBytes: 16이면 전부 버려진다', () => {
    const c = collect({ maxFrameBytes: 16 })
    c.push(jpegStream)
    expect(c.frames).toEqual([])
  })

  it('PNG 파트는 버린다', () => {
    const c = collect()
    c.push(pngStream)
    expect(c.frames).toEqual([])
  })

  it('본문 안의 FFD9나 CRLFCRLF에 속지 않고 Content-Length로 자른다', () => {
    const body = Uint8Array.from([0xff, 0xd8, 0xff, 0xd9, 0x0d, 0x0a, 0x0d, 0x0a, 0xff, 0xd9])
    const c = collect()
    c.push(part(body))
    expect(c.frames.length).toBe(1)
    expect(c.frames[0]!.length).toBe(body.length)
  })

  it('Content-Length가 없거나 틀린 파트는 버리고 다음 경계에서 다시 맞춘다', () => {
    const c = collect()
    c.push(
      Buffer.concat([
        part(jpeg(5), '--mjpegstream\r\nContent-Type: image/jpeg\r\n\r\n'),
        part(jpeg(5), '--mjpegstream\r\nContent-Type: image/jpeg\r\nContent-Length: abc\r\n\r\n'),
        part(Uint8Array.from([1, 2, 3, 4, 5])), // SOI 아님
        part(Uint8Array.from([0xff, 0xd8, 1, 2, 3])), // EOI 아님
        part(jpeg(9))
      ])
    )
    expect(c.frames.length).toBe(1)
    expect(c.frames[0]!.length).toBe(13)
  })

  it('낸 프레임은 이후 push와 메모리를 공유하지 않는다', () => {
    const c = collect()
    const a = part(jpeg(3))
    c.push(a)
    const snapshot = Buffer.from(c.frames[0]!)
    a.fill(0)
    c.push(part(jpeg(3)))
    expect(Buffer.from(c.frames[0]!).equals(snapshot)).toBe(true)
  })

  it('작은 프레임도 자기 ArrayBuffer만 차지한다 (공유 풀 뷰가 아니다)', () => {
    const c = collect()
    c.push(part(jpeg(5)))
    const f = c.frames[0]!
    expect(f.byteLength).toBe(9)
    expect(f.byteOffset).toBe(0)
    expect(f.buffer.byteLength).toBe(f.byteLength)
  })

  it('onFrame이 던져도 다음 push는 같은 프레임을 다시 내지 않고 다음 프레임을 낸다', () => {
    const got: number[] = []
    let first = true
    const splitter = createMjpegSplitter((f) => {
      if (first) {
        first = false
        throw new Error('boom')
      }
      got.push(f.length)
    })
    // 던진 push에서 남은 바이트는 버려지므로, 본문이 끝나는 지점에서 청크를 끊는다.
    const p1 = part(jpeg(5))
    expect(() => splitter.push(p1.subarray(0, p1.length - 2))).toThrow('boom')
    splitter.push(Buffer.concat([Buffer.from('\r\n'), part(jpeg(7))]))
    expect(got).toEqual([11])
  })
})
