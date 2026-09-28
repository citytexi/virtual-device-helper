import { describe, expect, it } from 'vitest'
import { codecFromConfig } from './h264'

/** 실제 v4.1 서버가 보낸 config 패킷(M1 스파이크 fixture의 93번째 바이트부터 38바이트): SPS + PPS */
const REAL_CONFIG = Uint8Array.from(
  '0000000167640020acb40f0103cbcd4040405004c4b4023c346000f142aa0000000168ee0d8b'.match(/../g)!.map((b) => parseInt(b, 16))
)

describe('codecFromConfig', () => {
  it('builds the avc1 string from the SPS of a real config packet', () => {
    expect(codecFromConfig(REAL_CONFIG)).toBe('avc1.640020')
  })

  it('reads a 3-byte start code too', () => {
    expect(codecFromConfig(Uint8Array.from([0, 0, 1, 0x67, 0x42, 0xc0, 0x1f, 0xff]))).toBe('avc1.42c01f')
  })

  it('returns null when there is no SPS', () => {
    expect(codecFromConfig(Uint8Array.from([0, 0, 0, 1, 0x68, 0xee, 0x0d, 0x8b]))).toBeNull()
  })

  it('returns null when the SPS is cut short', () => {
    expect(codecFromConfig(Uint8Array.from([0, 0, 0, 1, 0x67, 0x64]))).toBeNull()
  })
})
