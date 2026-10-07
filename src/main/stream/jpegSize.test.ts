import { describe, expect, it } from 'vitest'
import { jpegSize } from './jpegSize'

/** SOI + SOF0(높이 0x025b, 너비 0x051f) + EOI. */
function sof(marker: number, height: number, width: number): Uint8Array {
  return Uint8Array.from([
    0xff, 0xd8,
    0xff, 0xe0, 0x00, 0x04, 0x00, 0x00, // APPn 세그먼트는 건너뛴다
    0xff, marker, 0x00, 0x0b, 0x08, height >> 8, height & 0xff, width >> 8, width & 0xff, 0x01, 0x01,
    0xff, 0xd9
  ])
}

describe('jpegSize', () => {
  it('SOF0/SOF1/SOF2의 크기를 읽는다', () => {
    for (const m of [0xc0, 0xc1, 0xc2]) {
      expect(jpegSize(sof(m, 0x25b, 0x51f))).toEqual({ width: 0x51f, height: 0x25b })
    }
  })

  it('잘린 JPEG는 null이다', () => {
    expect(jpegSize(sof(0xc0, 10, 20).subarray(0, 14))).toBeNull()
    expect(jpegSize(Uint8Array.from([0xff, 0xd8]))).toBeNull()
    expect(jpegSize(new Uint8Array(0))).toBeNull()
  })

  it('SOI가 아니면 null이다', () => {
    expect(jpegSize(Uint8Array.from([0x89, 0x50, 0x4e, 0x47]))).toBeNull()
  })
})
