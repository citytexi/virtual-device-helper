import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import type { DeviceError } from '../../shared/types/errors'
import { createVideoStreamParser, type VideoPacket } from './scrcpyProtocol'

const FIXTURE = readFileSync(join(__dirname, '__fixtures__', 'scrcpy-v4.1-first-chunks.bin'))

function collect() {
  const names: string[] = []
  const sessions: Array<[number, number]> = []
  const packets: VideoPacket[] = []
  const errors: DeviceError[] = []
  const parser = createVideoStreamParser({
    onDeviceName: (name) => names.push(name),
    onSession: (width, height) => sessions.push([width, height]),
    onPacket: (packet) => packets.push(packet),
    onError: (error) => errors.push(error)
  })
  return { parser, names, sessions, packets, errors }
}

function summary(packets: VideoPacket[]) {
  return packets.map((p) => ({ config: p.config, key: p.key, bytes: p.data.length, ptsIsNull: p.ptsUs === null }))
}

/** 기기 이름 64바이트까지의 헤더. codec id부터는 호출부가 붙인다. */
function preamble(): Buffer {
  const name = Buffer.alloc(64)
  name.write('Pixel_7')
  return Buffer.concat([Buffer.from([0]), name])
}

function sessionRecord(width: number, height: number): Buffer {
  const record = Buffer.alloc(12)
  record.writeUInt32BE(0x80000000, 0)
  record.writeInt32BE(width, 4)
  record.writeInt32BE(height, 8)
  return record
}

function frameRecord(ptsAndFlags: bigint, payload: Buffer): Buffer {
  const header = Buffer.alloc(12)
  header.writeBigUInt64BE(ptsAndFlags, 0)
  header.writeUInt32BE(payload.length, 8)
  return Buffer.concat([header, payload])
}

describe('createVideoStreamParser', () => {
  it('reads the real v4.1 capture into name, session, config and key frame', () => {
    const c = collect()

    c.parser.push(FIXTURE)

    expect(c.errors).toEqual([])
    expect(c.names).toEqual(['SM-A356N'])
    expect(c.sessions).toEqual([[472, 1024]])
    expect(summary(c.packets)).toEqual([
      { config: true, key: false, bytes: 38, ptsIsNull: true },
      { config: false, key: true, bytes: 21927, ptsIsNull: false }
    ])
    expect(typeof c.packets[1]?.ptsUs).toBe('number')
  })

  it('yields the same result when bytes arrive one at a time', () => {
    const whole = collect()
    whole.parser.push(FIXTURE)
    const split = collect()

    for (let i = 0; i < FIXTURE.length; i += 1) split.parser.push(FIXTURE.subarray(i, i + 1))

    expect(split.names).toEqual(whole.names)
    expect(split.sessions).toEqual(whole.sessions)
    expect(summary(split.packets)).toEqual(summary(whole.packets))
    expect(Buffer.from(split.packets[1]!.data).equals(Buffer.from(whole.packets[1]!.data))).toBe(true)
  })

  it('yields the same result for odd-sized chunks that cut headers and payloads', () => {
    const split = collect()

    for (let i = 0; i < FIXTURE.length; i += 7) split.parser.push(FIXTURE.subarray(i, i + 7))

    expect(split.sessions).toEqual([[472, 1024]])
    expect(summary(split.packets).map((p) => p.bytes)).toEqual([38, 21927])
  })

  it('gives every packet its own exactly-sized buffer', () => {
    const c = collect()

    c.parser.push(FIXTURE)

    // 풀 버퍼의 view면 structured clone이 풀 전체를 복사한다.
    for (const packet of c.packets) {
      expect(packet.data.byteOffset).toBe(0)
      expect(packet.data.buffer.byteLength).toBe(packet.data.length)
    }
  })

  it('reports a session meta that arrives mid-stream, as after a rotation', () => {
    const c = collect()
    const config = frameRecord(1n << 62n, Buffer.from([0, 0, 0, 1]))

    c.parser.push(Buffer.concat([FIXTURE, sessionRecord(1024, 472), config]))

    expect(c.sessions).toEqual([
      [472, 1024],
      [1024, 472]
    ])
    expect(c.packets).toHaveLength(3)
    expect(c.packets[2]?.config).toBe(true)
  })

  it('reads the pts of a delta frame and leaves key false', () => {
    const c = collect()
    const codec = Buffer.from('h264', 'latin1')

    c.parser.push(Buffer.concat([preamble(), codec, sessionRecord(10, 20), frameRecord(123456n, Buffer.from([9]))]))

    expect(c.packets).toEqual([{ config: false, key: false, ptsUs: 123456, data: new Uint8Array([9]) }])
  })

  it.each([
    [0, '비활성'],
    [1, '설정 에러']
  ])('fails when the server sends codec id %i instead of a codec', (id, text) => {
    const c = collect()
    const codec = Buffer.alloc(4)
    codec.writeUInt32BE(id, 0)

    c.parser.push(Buffer.concat([preamble(), codec]))

    expect(c.errors).toHaveLength(1)
    expect(c.errors[0]?.toolError.message).toContain(text)
  })

  it('fails on a codec other than h264', () => {
    const c = collect()

    c.parser.push(Buffer.concat([preamble(), Buffer.from('h265', 'latin1')]))

    expect(c.errors).toHaveLength(1)
    expect(c.errors[0]?.toolError.message).toContain('h265')
  })

  it('fails when the first byte is not the dummy byte', () => {
    const c = collect()

    c.parser.push(Buffer.from([7]))

    expect(c.errors).toHaveLength(1)
  })

  it('ignores everything after an error', () => {
    const onPacket = vi.fn()
    const onError = vi.fn()
    const parser = createVideoStreamParser({ onDeviceName: vi.fn(), onSession: vi.fn(), onPacket, onError })

    parser.push(Buffer.from([7]))
    parser.push(FIXTURE)

    expect(onError).toHaveBeenCalledTimes(1)
    expect(onPacket).not.toHaveBeenCalled()
  })
})
