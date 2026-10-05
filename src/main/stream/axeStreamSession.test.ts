import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { deviceError, isDeviceError, type DeviceError } from '../../shared/types/errors'
import type { ControlIntent } from '../../shared/types/stream'
import type { AxeClient } from '../ios/axeClient'
import type { ProcessStream } from '../process/processClient'
import { createAxeStreamSession, STREAM_ARGS } from './axeStreamSession'
import { IOS_KEYS } from './iosKeys'
import { createMjpegSplitter } from './mjpegSplitter'
import type { SessionInfo } from './streamSession'

const fixture = readFileSync(join(__dirname, '../device/parsers/__fixtures__/ios/stream-video-jpeg.bin'))

/** fixture에서 JPEG 프레임 둘을 뽑는다. */
const frames: Uint8Array[] = []
createMjpegSplitter((f) => frames.push(f)).push(fixture)

/** SOF 세그먼트의 크기 바이트를 바꾼 복사본을 파트로 감싼다. */
function resizedPart(jpeg: Uint8Array, width: number, height: number): Buffer {
  const copy = Buffer.from(jpeg)
  let i = 2
  while (i + 4 <= copy.length) {
    const marker = copy[i + 1]!
    if (marker === 0xc0 || marker === 0xc1 || marker === 0xc2) {
      copy.writeUInt16BE(height, i + 5)
      copy.writeUInt16BE(width, i + 7)
      break
    }
    i += 2 + copy.readUInt16BE(i + 2)
  }
  return part(copy)
}
function part(body: Uint8Array): Buffer {
  const head = `--mjpegstream\r\nContent-Type: image/jpeg\r\nContent-Length: ${body.length}\r\n\r\n`
  return Buffer.concat([Buffer.from(head), body, Buffer.from('\r\n')])
}

function fakeStream() {
  let data: (c: Buffer) => void = () => {}
  let close: (code: number | null) => void = () => {}
  let error: (e: DeviceError) => void = () => {}
  const stream: ProcessStream = {
    onLine: () => {},
    onData: (cb) => (data = cb),
    onClose: (cb) => (close = cb),
    onError: (cb) => (error = cb),
    close: vi.fn()
  }
  return { stream, push: (c: Buffer) => data(c), end: (code: number | null = 0) => close(code), fail: (e: DeviceError) => error(e) }
}

function setup(opts: { firstFrameTimeoutMs?: number; setTimer?: typeof setTimeout; clearTimer?: typeof clearTimeout } = {}) {
  const fs = fakeStream()
  const axe = { exec: vi.fn(), stream: vi.fn(() => fs.stream) } as unknown as AxeClient
  const control = { send: vi.fn(), close: vi.fn() }
  const infos: SessionInfo[] = []
  const got: Uint8Array[] = []
  const ended: DeviceError[] = []
  const session = createAxeStreamSession(
    { udid: 'U1', axe, control, ...opts },
    { onSession: (i) => infos.push(i), onPacket: () => {}, onFrame: (f) => got.push(f), onEnded: (e) => ended.push(e) }
  )
  return { fs, axe, control, infos, got, ended, session }
}

describe('createAxeStreamSession', () => {
  it('STREAM_ARGS로 stream을 열고, 첫 프레임에서 jpeg onSession과 함께 start가 resolve한다', async () => {
    const t = setup()
    const started = t.session.start()
    expect(t.axe.stream).toHaveBeenCalledWith('U1', STREAM_ARGS)
    t.fs.push(fixture)
    await started
    expect(t.infos).toEqual([{ width: 0x25b, height: 0x51f, codec: 'jpeg', keys: IOS_KEYS }])
    expect(t.got.length).toBe(frames.length)
  })

  it('첫 프레임 없이 타이머가 다 되면 스트림을 닫고 device_unresponsive로 reject한다', async () => {
    vi.useFakeTimers()
    try {
      const t = setup({ firstFrameTimeoutMs: 500 })
      const started = t.session.start()
      const assertion = expect(started).rejects.toMatchObject({ toolError: { kind: 'device_unresponsive' } })
      await vi.advanceTimersByTimeAsync(500)
      await assertion
      expect(t.fs.stream.close).toHaveBeenCalled()
    } finally {
      vi.useRealTimers()
    }
  })

  it('첫 프레임 전에 스트림이 에러로 끝나면 그 에러로 reject한다', async () => {
    const t = setup()
    const started = t.session.start()
    const err = deviceError('command_failed', 'axe 실패', '확인해라')
    t.fs.fail(err)
    t.fs.end(1)
    await expect(started).rejects.toBe(err)
  })

  it('크기가 다른 JPEG가 오면 onSession이 다시 불린다', async () => {
    const t = setup()
    const started = t.session.start()
    t.fs.push(part(frames[0]!))
    await started
    t.fs.push(part(frames[0]!))
    expect(t.infos.length).toBe(1)
    t.fs.push(resizedPart(frames[1]!, 300, 600))
    expect(t.infos.length).toBe(2)
    expect(t.infos[1]).toMatchObject({ width: 300, height: 600, codec: 'jpeg' })
    expect(t.got.length).toBe(3)
  })

  it('시작 뒤 스트림이 끝나면 onEnded를 한 번 부른다', async () => {
    const t = setup()
    const started = t.session.start()
    t.fs.push(part(frames[0]!))
    await started
    t.fs.end(1)
    t.fs.end(1)
    expect(t.ended.length).toBe(1)
    expect(isDeviceError(t.ended[0])).toBe(true)
  })

  it('close()로 닫으면 onEnded를 부르지 않고 control도 닫는다', async () => {
    const t = setup()
    const started = t.session.start()
    t.fs.push(part(frames[0]!))
    await started
    await t.session.close()
    t.fs.end(0)
    expect(t.ended).toEqual([])
    expect(t.fs.stream.close).toHaveBeenCalled()
    expect(t.control.close).toHaveBeenCalled()
  })

  it('sendControl은 현재 크기와 함께 control.send로 넘긴다', async () => {
    const t = setup()
    const started = t.session.start()
    t.fs.push(part(frames[0]!))
    await started
    const intent: ControlIntent = { type: 'key', key: 'home' }
    t.session.sendControl(intent)
    expect(t.control.send).toHaveBeenCalledWith(intent, { width: 0x25b, height: 0x51f })
    t.fs.push(resizedPart(frames[1]!, 300, 600))
    t.session.sendControl(intent)
    expect(t.control.send).toHaveBeenLastCalledWith(intent, { width: 300, height: 600 })
  })
})
