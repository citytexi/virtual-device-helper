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

  it('close()가 start() 도중 불리면 타이머 진행 없이 바로 reject하고 타이머를 지운다', async () => {
    const clearTimer = vi.fn() as unknown as typeof clearTimeout
    const t = setup({ clearTimer, setTimer: (() => 7) as unknown as typeof setTimeout })
    const started = t.session.start()
    const assertion = expect(started).rejects.toMatchObject({ toolError: { kind: 'command_failed' } })
    await t.session.close()
    await assertion
    expect(clearTimer).toHaveBeenCalledWith(7)
    expect(t.fs.stream.close).toHaveBeenCalledTimes(1)
  })

  it('close() 뒤의 start()는 axe.stream을 열지 않는다', async () => {
    const t = setup()
    await t.session.close()
    await expect(t.session.start()).rejects.toMatchObject({ toolError: { kind: 'command_failed' } })
    expect(t.axe.stream).not.toHaveBeenCalled()
  })

  it('첫 프레임 뒤와 실패 뒤에 타이머를 지운다', async () => {
    const clearTimer = vi.fn() as unknown as typeof clearTimeout
    const ok = setup({ clearTimer, setTimer: (() => 1) as unknown as typeof setTimeout })
    const p = ok.session.start()
    ok.fs.push(part(frames[0]!))
    await p
    expect(clearTimer).toHaveBeenCalledWith(1)

    const clear2 = vi.fn() as unknown as typeof clearTimeout
    const bad = setup({ clearTimer: clear2, setTimer: (() => 2) as unknown as typeof setTimeout })
    const q = bad.session.start()
    bad.fs.fail(deviceError('command_failed', 'x', 'y'))
    bad.fs.end(1)
    await expect(q).rejects.toBeDefined()
    expect(clear2).toHaveBeenCalledWith(2)
  })

  it('close()를 두 번 불러도 stream.close와 control.close는 한 번씩이다', async () => {
    const t = setup()
    const started = t.session.start()
    t.fs.push(part(frames[0]!))
    await started
    await t.session.close()
    await t.session.close()
    expect(t.fs.stream.close).toHaveBeenCalledTimes(1)
    expect(t.control.close).toHaveBeenCalledTimes(1)
  })

  it('첫 프레임과 크기 변경에서 onSession이 onFrame보다 먼저다', async () => {
    const events: string[] = []
    const fs = fakeStream()
    const axe = { exec: vi.fn(), stream: vi.fn(() => fs.stream) } as unknown as AxeClient
    const session = createAxeStreamSession(
      { udid: 'U1', axe, control: { send: vi.fn(), close: vi.fn() } },
      { onSession: () => events.push('session'), onPacket: () => {}, onFrame: () => events.push('frame'), onEnded: () => {} }
    )
    const started = session.start()
    fs.push(part(frames[0]!))
    await started
    fs.push(resizedPart(frames[1]!, 300, 600))
    expect(events).toEqual(['session', 'frame', 'session', 'frame'])
  })

  it('크기를 못 읽는 프레임은 버린다', async () => {
    const t = setup()
    void t.session.start().catch(() => {})
    // SOI/EOI만 있고 SOF가 없는 프레임
    t.fs.push(part(Uint8Array.from([0xff, 0xd8, 0xff, 0xd9])))
    expect(t.got).toEqual([])
    expect(t.infos).toEqual([])
    await t.session.close()
  })

  it('stderr를 담은 stream 에러가 start() reject로 전해진다', async () => {
    const t = setup()
    const started = t.session.start()
    const err = deviceError('command_failed', 'axe 실패', '확인해라', { stderr: 'No such device' })
    t.fs.fail(err)
    t.fs.end(1)
    await expect(started).rejects.toMatchObject({ toolError: { details: { stderr: 'No such device' } } })
  })

  it('첫 session 정보 전의 sendControl은 아무 일도 하지 않는다', () => {
    const t = setup()
    void t.session.start().catch(() => {})
    t.session.sendControl({ type: 'key', key: 'home' })
    expect(t.control.send).not.toHaveBeenCalled()
  })
})
