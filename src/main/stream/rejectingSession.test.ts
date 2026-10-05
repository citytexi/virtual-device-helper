import { describe, expect, it, vi } from 'vitest'
import { deviceError, unsupported } from '../../shared/types/errors'
import type { StreamDown } from '../../shared/types/stream'
import type { StreamSession, StreamSessionHandlers } from './streamSession'
import { createPlatformStreamSession, rejectingSession } from './rejectingSession'
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

  it('iOS 기기는 M4-3 전까지 unsupported로 거절하는 세션을 받는다', async () => {
    const android = vi.fn(() => androidSession)
    const create = createPlatformStreamSession({ platformOf: () => 'ios', android })

    const session = create('SIM-UDID', handlers)

    await expect(session.start()).rejects.toMatchObject({
      toolError: { kind: 'unsupported', details: { platform: 'ios', action: '실시간 화면' } }
    })
    expect(android).not.toHaveBeenCalled()
  })

  it('Android 기기는 android 세션 팩토리로 간다', () => {
    const android = vi.fn(() => androidSession)
    const create = createPlatformStreamSession({ platformOf: () => 'android', android })

    expect(create('emulator-5554', handlers)).toBe(androidSession)
    expect(android).toHaveBeenCalledWith('emulator-5554', handlers)
  })

  it('Android SDK가 없으면 Android 기기는 sdk_not_found로 거절한다', async () => {
    const create = createPlatformStreamSession({ platformOf: () => 'android', android: null })

    await expect(create('emulator-5554', handlers).start()).rejects.toMatchObject({ toolError: { kind: 'sdk_not_found' } })
  })

  it('기기를 모르면 resolve의 에러로 거절한다', async () => {
    const gone = deviceError('no_device', 'gone', 'x')
    const create = createPlatformStreamSession({
      platformOf: () => {
        throw gone
      },
      android: vi.fn(() => androidSession)
    })

    await expect(create('x', handlers).start()).rejects.toBe(gone)
  })
})
