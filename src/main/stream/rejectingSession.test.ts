import { describe, expect, it, vi } from 'vitest'
import { deviceError, unsupported } from '../../shared/types/errors'
import type { StreamDown } from '../../shared/types/stream'
import type { DisplayFrame } from '../../shared/types/device'
import { execOk, fakeAxe } from '../ios/testing'
import type { ProcessStream } from '../process/processClient'
import { STREAM_ARGS } from './axeStreamSession'
import type { StreamSession, StreamSessionHandlers } from './streamSession'
import { createIosStreamSessionFactory, createPlatformStreamSession, rejectingSession } from './rejectingSession'
import { createStreamManager, type PortLike } from './streamManager'

class FakePort implements PortLike {
  readonly sent: StreamDown[] = []
  readonly start = vi.fn()
  readonly close = vi.fn()
  postMessage(message: StreamDown): void {
    this.sent.push(message)
  }
  on(): void {}
}

const handlers = {} as StreamSessionHandlers

describe('rejectingSession', () => {
  it('start()는 받은 에러로 reject하고 나머지는 아무것도 하지 않는다', async () => {
    const error = unsupported('ios', '실시간 화면', 'M4-3에서 지원한다')
    const session = rejectingSession(error)

    await expect(session.start()).rejects.toBe(error)
    expect(() => session.sendControl({ type: 'text', text: 'a' })).not.toThrow()
    await expect(session.close()).resolves.toBeUndefined()
  })

  it('스트림 매니저에 넣으면 재시도 없이 첫 상태가 failed이고 kind가 unsupported다', async () => {
    const port = new FakePort()
    const sleep = vi.fn(async () => {})
    const manager = createStreamManager({
      createSession: () => rejectingSession(unsupported('ios', '실시간 화면', 'M4-3에서 지원한다')),
      createChannel: () => ({ local: port, remote: {} }),
      postPort: () => {},
      isConnected: () => true,
      sleep
    })

    await manager.open('SIM-UDID')

    const statuses = port.sent.flatMap((m) => (m.type === 'status' ? [m.status] : []))
    const afterConnecting = statuses.filter((s) => s.state !== 'connecting')
    expect(afterConnecting[0]?.state).toBe('failed')
    expect(statuses.some((s) => s.state === 'reconnecting')).toBe(false)
    const failed = afterConnecting[0]
    if (failed?.state === 'failed') expect(failed.error.kind).toBe('unsupported')
    expect(sleep).not.toHaveBeenCalled()
  })
})

describe('createPlatformStreamSession', () => {
  const androidSession = { serial: 'emulator-5554' } as StreamSession

  it('iOS 기기는 ios 세션 팩토리로 간다', () => {
    const iosSession = { serial: 'SIM-UDID' } as StreamSession
    const android = vi.fn(() => androidSession)
    const ios = vi.fn(() => iosSession)
    const create = createPlatformStreamSession({ platformOf: () => 'ios', android, ios })

    expect(create('SIM-UDID', handlers)).toBe(iosSession)
    expect(ios).toHaveBeenCalledWith('SIM-UDID', handlers)
    expect(android).not.toHaveBeenCalled()
  })

  it('AXe가 없으면 iOS 기기는 ios_tool_not_found로 거절한다', async () => {
    const android = vi.fn(() => androidSession)
    const create = createPlatformStreamSession({ platformOf: () => 'ios', android, ios: null })

    await expect(create('SIM-UDID', handlers).start()).rejects.toMatchObject({
      toolError: { kind: 'ios_tool_not_found', hint: expect.stringContaining('brew install') }
    })
    expect(android).not.toHaveBeenCalled()
  })

  it('Android 기기는 android 세션 팩토리로 간다', () => {
    const android = vi.fn(() => androidSession)
    const create = createPlatformStreamSession({ platformOf: () => 'android', android, ios: null })

    expect(create('emulator-5554', handlers)).toBe(androidSession)
    expect(android).toHaveBeenCalledWith('emulator-5554', handlers)
  })

  it('Android SDK가 없으면 Android 기기는 sdk_not_found로 거절한다', async () => {
    const create = createPlatformStreamSession({ platformOf: () => 'android', android: null, ios: vi.fn() })

    await expect(create('emulator-5554', handlers).start()).rejects.toMatchObject({ toolError: { kind: 'sdk_not_found' } })
  })

  it('기기를 모르면 resolve의 에러로 거절한다', async () => {
    const gone = deviceError('no_device', 'gone', 'x')
    const create = createPlatformStreamSession({
      platformOf: () => {
        throw gone
      },
      android: vi.fn(() => androidSession),
      ios: null
    })

    await expect(create('x', handlers).start()).rejects.toBe(gone)
  })
})

/** 프레임 하나를 multipart 조각으로 싼다. SOF0에 크기를 적은 최소 JPEG다. */
function mjpegPart(width: number, height: number): Buffer {
  const jpeg = Buffer.from([
    0xff, 0xd8, 0xff, 0xc0, 0x00, 0x11, 0x08, height >> 8, height & 0xff, width >> 8, width & 0xff, 0x03, 0x01, 0x22, 0x00, 0x02, 0x11,
    0x01, 0x03, 0x11, 0x01, 0xff, 0xd9
  ])
  return Buffer.concat([
    Buffer.from(`--mjpegstream\r\nContent-Type: image/jpeg\r\nContent-Length: ${jpeg.length}\r\n\r\n`),
    jpeg,
    Buffer.from('\r\n')
  ])
}

function fakeStream(): ProcessStream & { emit(chunk: Buffer): void; close: ReturnType<typeof vi.fn> } {
  let onData: (chunk: Buffer) => void = () => {}
  return {
    onData: (listener: (chunk: Buffer) => void) => {
      onData = listener
    },
    onLine: () => {},
    onError: () => {},
    onClose: () => {},
    close: vi.fn(),
    emit: (chunk: Buffer) => onData(chunk)
  } as unknown as ProcessStream & { emit(chunk: Buffer): void; close: ReturnType<typeof vi.fn> }
}

describe('createIosStreamSessionFactory', () => {
  const frame: DisplayFrame = { width: 400, height: 800 }

  function setup() {
    const stream = fakeStream()
    const axe = fakeAxe({ 'tap -x 100 -y 200': execOk() })
    vi.mocked(axe.stream).mockReturnValue(stream)
    const device = { displayFrame: vi.fn(async () => frame), inputText: vi.fn(async () => {}) }
    const deviceOf = vi.fn(() => device)
    const ran: string[] = []
    // registry.run과 같은 모양: 기기마다 한 줄.
    let queue: Promise<unknown> = Promise.resolve()
    function run<T>(serial: string, task: () => Promise<T>): Promise<T> {
      ran.push(serial)
      const next = queue.then(task, task)
      queue = next.catch(() => undefined)
      return next
    }
    const sessionHandlers = { onSession: vi.fn(), onPacket: vi.fn(), onFrame: vi.fn(), onEnded: vi.fn() }
    const session = createIosStreamSessionFactory({ axe, deviceOf, run })('SIM-UDID', sessionHandlers)
    return { session, stream, axe, device, deviceOf, run, ran, sessionHandlers }
  }

  it('axe stream-video로 jpeg 세션을 연다', async () => {
    const { session, stream, axe, sessionHandlers } = setup()

    const started = session.start()
    stream.emit(mjpegPart(200, 400))
    await started

    expect(session.serial).toBe('SIM-UDID')
    expect(axe.stream).toHaveBeenCalledWith('SIM-UDID', STREAM_ARGS)
    expect(sessionHandlers.onSession).toHaveBeenCalledWith(expect.objectContaining({ width: 200, height: 400, codec: 'jpeg' }))
  })

  it('탭은 기기의 displayFrame으로 좌표를 바꿔 axe로 보낸다', async () => {
    const { session, stream, axe, device, deviceOf } = setup()
    const started = session.start()
    stream.emit(mjpegPart(200, 400))
    await started

    const point = { x: 50, y: 100, width: 200, height: 400 }
    session.sendControl({ type: 'touch', action: 'down', point })
    session.sendControl({ type: 'touch', action: 'up', point })

    await vi.waitFor(() => expect(axe.calls).toEqual([{ args: ['tap', '-x', '100', '-y', '200'] }]))
    expect(deviceOf).toHaveBeenCalledWith('SIM-UDID')
    expect(device.displayFrame).toHaveBeenCalledTimes(1)
  })

  it('text는 기기의 inputText로 가고 기기 큐에 선다', async () => {
    const { session, stream, axe, device, ran } = setup()
    const started = session.start()
    stream.emit(mjpegPart(200, 400))
    await started

    session.sendControl({ type: 'text', text: '한글 abc' })

    await vi.waitFor(() => expect(device.inputText).toHaveBeenCalledWith('한글 abc'))
    expect(ran).toEqual(['SIM-UDID'])
    expect(axe.calls).toEqual([])
  })

  it('기기 큐에서 앞선 작업이 끝나기 전에는 text를 넣지 않는다', async () => {
    const { session, stream, device, run } = setup()
    const started = session.start()
    stream.emit(mjpegPart(200, 400))
    await started
    // MCP ui_text 같은 앞선 작업이 클립보드를 쓰는 중이다.
    let release: () => void = () => {}
    const earlier = run('SIM-UDID', () => new Promise<void>((resolve) => (release = resolve)))

    session.sendControl({ type: 'text', text: 'a' })
    await new Promise((resolve) => setTimeout(resolve, 10))
    expect(device.inputText).not.toHaveBeenCalled()

    release()
    await earlier
    await vi.waitFor(() => expect(device.inputText).toHaveBeenCalledWith('a'))
  })

  it('기기가 사라졌으면 입력 실패를 삼키고 세션은 살아 있다', async () => {
    const { session, stream, deviceOf, sessionHandlers } = setup()
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})
    deviceOf.mockImplementation(() => {
      throw deviceError('no_device', 'gone', 'x')
    })
    const started = session.start()
    stream.emit(mjpegPart(200, 400))
    await started

    session.sendControl({ type: 'text', text: 'a' })

    await vi.waitFor(() => expect(consoleError).toHaveBeenCalled())
    expect(sessionHandlers.onEnded).not.toHaveBeenCalled()
    consoleError.mockRestore()
  })
})
