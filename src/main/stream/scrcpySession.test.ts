import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import type { AdbClient, AdbStream, ExecResult } from '../adb/adbClient'
import { deviceError, isDeviceError } from '../../shared/types/errors'
import { createScrcpySession, DEVICE_JAR_PATH, serverArgs } from './scrcpySession'

const FIXTURE = readFileSync(join(__dirname, '__fixtures__', 'scrcpy-v4.1-first-chunks.bin'))

type SocketEvent = 'data' | 'close' | 'error'

/**
 * SessionSocket 가짜. 첫 `data` 리스너가 붙으면 준비된 청크를 매크로태스크마다 하나씩 흘린다.
 * script가 'close'면 데이터 없이 바로 닫힌다(서버가 아직 listen 전인 adb forward).
 */
class FakeSocket {
  readonly write = vi.fn()
  readonly destroy = vi.fn(() => {
    if (this.destroyed) return
    this.destroyed = true
    this.emit('close')
  })
  private readonly listeners: Record<SocketEvent, Array<(...args: any[]) => void>> = { data: [], close: [], error: [] }
  private destroyed = false
  private started = false

  constructor(private readonly script: Buffer[] | 'close' = []) {}

  on(event: SocketEvent, listener: (...args: any[]) => void): this {
    this.listeners[event].push(listener)
    if (event === 'data' && !this.started) {
      this.started = true
      this.play()
    }
    return this
  }

  /** 테스트가 스트림을 끊는 자리 */
  hangUp(): void {
    this.destroyed = true
    this.emit('close')
  }

  private emit(event: SocketEvent, ...args: unknown[]): void {
    for (const listener of [...this.listeners[event]]) listener(...args)
  }

  private play(): void {
    if (this.script === 'close') {
      setImmediate(() => this.destroy())
      return
    }
    const chunks = [...this.script]
    const next = (): void => {
      const chunk = chunks.shift()
      if (!chunk || this.destroyed) return
      this.emit('data', chunk)
      setImmediate(next)
    }
    setImmediate(next)
  }
}

function fakeServerStream() {
  const closeCallbacks: Array<(code: number | null) => void> = []
  const lineCallbacks: Array<(line: string) => void> = []
  const stream: AdbStream = {
    onLine: (cb) => lineCallbacks.push(cb),
    onData: () => {},
    onClose: (cb) => closeCallbacks.push(cb),
    onError: () => {},
    close: vi.fn()
  }
  return {
    stream,
    exit(lines: string[] = []) {
      for (const line of lines) lineCallbacks.forEach((cb) => cb(line))
      closeCallbacks.forEach((cb) => cb(1))
    }
  }
}

function ok(stdout = ''): ExecResult {
  return { stdout, stdoutRaw: Buffer.from(stdout), stderr: '', exitCode: 0 }
}

function harness(sockets: FakeSocket[], overrides: { exec?: AdbClient['exec'] } = {}) {
  const server = fakeServerStream()
  const exec = vi.fn(
    overrides.exec ??
      (async (_serial: string | null, args: string[]) => (args[0] === 'forward' && args[1] === 'tcp:0' ? ok('27183\n') : ok()))
  )
  const adb = { exec, stream: vi.fn(() => server.stream) }
  const queue = [...sockets]
  const connect = vi.fn(async () => {
    const next = queue.shift()
    if (!next) throw new Error('ECONNREFUSED')
    return next
  })
  let clock = 0
  const sleep = vi.fn(async (ms: number) => {
    clock += ms
  })
  const handlers = { onSession: vi.fn(), onPacket: vi.fn(), onEnded: vi.fn() }
  const session = createScrcpySession(
    {
      serial: 'emulator-5554',
      adb: adb as unknown as AdbClient,
      jarPath: '/repo/vendor/scrcpy/scrcpy-server.jar',
      connect,
      randomScid: () => 0x1234abcd,
      sleep,
      now: () => clock,
      connectTimeoutMs: 500
    },
    handlers
  )
  return { session, adb, exec, connect, sleep, handlers, server }
}

/** 실제 서버처럼 dummy byte를 먼저, 나머지를 나중에 보내는 비디오 소켓 */
function videoSocket(): FakeSocket {
  return new FakeSocket([FIXTURE.subarray(0, 1), FIXTURE.subarray(1)])
}

describe('serverArgs', () => {
  it('starts the pinned server with a hex scid and our options', () => {
    expect(serverArgs(0x1234abcd)).toEqual([
      'shell',
      `CLASSPATH=${DEVICE_JAR_PATH}`,
      'app_process',
      '/',
      'com.genymobile.scrcpy.Server',
      '4.1',
      'scid=1234abcd',
      'log_level=info',
      'tunnel_forward=true',
      'video=true',
      'audio=false',
      'control=true',
      'clipboard_autosync=false',
      'video_codec=h264',
      'max_size=1024'
    ])
  })
})

describe('createScrcpySession', () => {
  it('pushes the jar, forwards a free port, starts the server and connects video then control', async () => {
    const h = harness([videoSocket(), new FakeSocket()])

    await h.session.start()

    expect(h.exec.mock.calls.map((call) => call[1])).toEqual([
      ['push', '/repo/vendor/scrcpy/scrcpy-server.jar', DEVICE_JAR_PATH],
      ['forward', 'tcp:0', 'localabstract:scrcpy_1234abcd']
    ])
    expect(h.adb.stream).toHaveBeenCalledWith('emulator-5554', serverArgs(0x1234abcd))
    expect(h.connect.mock.calls).toEqual([[27183], [27183]])
    expect(h.handlers.onSession).toHaveBeenCalledWith(472, 1024)
  })

  it('relays packets that arrive after start', async () => {
    const h = harness([videoSocket(), new FakeSocket()])

    await h.session.start()
    await vi.waitFor(() => expect(h.handlers.onPacket).toHaveBeenCalledTimes(2))

    expect(h.handlers.onPacket.mock.calls[1]?.[0]).toMatchObject({ key: true })
  })

  it('reconnects when adb accepts the connection but closes it before the server listens', async () => {
    const h = harness([new FakeSocket('close'), videoSocket(), new FakeSocket()])

    await h.session.start()

    expect(h.connect).toHaveBeenCalledTimes(3)
    expect(h.sleep).toHaveBeenCalledWith(100)
  })

  it('fails as unresponsive after the deadline and cleans up', async () => {
    const closing = Array.from({ length: 20 }, () => new FakeSocket('close'))
    const h = harness(closing)

    const error = await h.session.start().catch((thrown: unknown) => thrown)

    expect(isDeviceError(error) && error.toolError.kind).toBe('device_unresponsive')
    expect(h.server.stream.close).toHaveBeenCalled()
    expect(h.exec).toHaveBeenLastCalledWith('emulator-5554', ['forward', '--remove', 'tcp:27183'])
  })

  it('fails at once with the server output when the server exits before listening', async () => {
    const h = harness([])
    h.connect.mockImplementation(async () => {
      h.server.exit(['[server] ERROR: The server version (4.1) does not match the client (4.0)'])
      throw new Error('ECONNREFUSED')
    })

    const error = await h.session.start().catch((thrown: unknown) => thrown)

    expect(isDeviceError(error)).toBe(true)
    expect(JSON.stringify(isDeviceError(error) && error.toolError.details)).toContain('does not match')
    expect(h.connect).toHaveBeenCalledTimes(1)
  })

  it('fails start when the server reports a disabled stream instead of a codec', async () => {
    const disabled = Buffer.concat([Buffer.from([0]), Buffer.alloc(64), Buffer.alloc(4)])
    const h = harness([new FakeSocket([disabled.subarray(0, 1), disabled.subarray(1)]), new FakeSocket()])

    const error = await h.session.start().catch((thrown: unknown) => thrown)

    expect(isDeviceError(error) && error.toolError.message).toContain('비활성')
    expect(h.handlers.onEnded).not.toHaveBeenCalled()
  })

  it('fails start when a setup step fails and removes nothing it did not create', async () => {
    const h = harness([], {
      exec: async (_serial, args) => {
        if (args[0] === 'push') throw deviceError('command_failed', 'push 실패', 'x')
        return ok()
      }
    })

    await expect(h.session.start()).rejects.toThrow('push 실패')

    expect(h.exec).toHaveBeenCalledTimes(1)
    expect(h.adb.stream).not.toHaveBeenCalled()
  })

  it('reports an unexpected end exactly once', async () => {
    const video = videoSocket()
    const control = new FakeSocket()
    const h = harness([video, control])
    await h.session.start()

    video.hangUp()
    control.hangUp()
    h.server.exit()

    expect(h.handlers.onEnded).toHaveBeenCalledTimes(1)
  })

  it('closes sockets, stops the server and removes the forward without reporting an end', async () => {
    const video = videoSocket()
    const control = new FakeSocket()
    const h = harness([video, control])
    await h.session.start()

    await h.session.close()

    expect(video.destroy).toHaveBeenCalled()
    expect(control.destroy).toHaveBeenCalled()
    expect(h.server.stream.close).toHaveBeenCalled()
    expect(h.exec).toHaveBeenLastCalledWith('emulator-5554', ['forward', '--remove', 'tcp:27183'])
    expect(h.handlers.onEnded).not.toHaveBeenCalled()
  })

  it('keeps cleaning up when removing the forward fails', async () => {
    const h = harness([videoSocket(), new FakeSocket()])
    await h.session.start()
    h.exec.mockImplementation(async () => {
      throw deviceError('no_device', 'gone', 'x')
    })

    await expect(h.session.close()).resolves.toBeUndefined()
  })

  it('writes serialized control messages to the control socket', async () => {
    const control = new FakeSocket()
    const h = harness([videoSocket(), control])
    await h.session.start()

    h.session.sendControl({ type: 'key', key: 'back' })

    expect(control.write).toHaveBeenCalledTimes(1)
    expect(Buffer.from(control.write.mock.calls[0]?.[0] as Uint8Array).toString('hex').slice(0, 12)).toBe('000000000004')
  })

  it('drops a control message it cannot serialize instead of throwing', async () => {
    const control = new FakeSocket()
    const h = harness([videoSocket(), control])
    await h.session.start()

    expect(() => h.session.sendControl({ type: 'text', text: 'a'.repeat(301) })).not.toThrow()
    expect(control.write).not.toHaveBeenCalled()
  })
})
