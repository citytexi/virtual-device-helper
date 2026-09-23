import { randomInt } from 'node:crypto'
import { createConnection } from 'node:net'
import type { AdbClient, AdbStream } from '../adb/adbClient'
import { deviceError, isDeviceError, type DeviceError } from '../../shared/types/errors'
import type { ControlIntent } from '../../shared/types/stream'
import { createVideoStreamParser, serializeControl, type VideoPacket } from './scrcpyProtocol'
import { SCRCPY_SERVER_VERSION } from './scrcpyJar'

export const DEVICE_JAR_PATH = '/data/local/tmp/scrcpy-server.jar'
/** 비디오 긴 변의 상한. 에이전트를 지켜보는 용도에는 이 정도로 충분하고 패킷이 작아진다. */
export const MAX_VIDEO_SIZE = 1024
const DEFAULT_CONNECT_TIMEOUT_MS = 10_000
const CONNECT_RETRY_MS = 100
const SERVER_OUTPUT_TAIL_LINES = 20

/** net.Socket에서 이 세션이 쓰는 부분. 테스트는 이 모양만 흉내 낸 가짜를 쓴다. */
export interface SessionSocket {
  on(event: 'data', listener: (chunk: Buffer) => void): unknown
  on(event: 'close', listener: () => void): unknown
  on(event: 'error', listener: (error: Error) => void): unknown
  write(data: Uint8Array): unknown
  destroy(): void
}

export type ConnectFn = (port: number) => Promise<SessionSocket>

/** 루프백 TCP 연결. adb forward가 이 포트를 기기의 abstract 소켓으로 잇는다. */
export const connectLoopback: ConnectFn = (port) =>
  new Promise((resolve, reject) => {
    const socket = createConnection({ host: '127.0.0.1', port })
    socket.once('connect', () => resolve(socket))
    socket.once('error', reject)
  })

export interface SessionHandlers {
  onSession(width: number, height: number): void
  onPacket(packet: VideoPacket): void
  /** 예기치 않은 종료. close()로 닫은 경우에는 부르지 않는다. 최대 한 번. */
  onEnded(error: DeviceError): void
}

export interface ScrcpySession {
  readonly serial: string
  /** 비디오·control 소켓이 붙고 첫 session meta를 받으면 끝난다. 실패하면 연 자원을 정리하고 던진다. */
  start(): Promise<void>
  sendControl(intent: ControlIntent): void
  close(): Promise<void>
}

export interface ScrcpySessionDeps {
  serial: string
  adb: AdbClient
  /** 호스트의 scrcpy-server.jar 경로. resolveScrcpyJar의 결과다. */
  jarPath: string
  connect: ConnectFn
  randomScid?: () => number
  sleep?: (ms: number) => Promise<void>
  now?: () => number
  connectTimeoutMs?: number
}

function scidHex(scid: number): string {
  return scid.toString(16).padStart(8, '0')
}

/**
 * 서버 실행 인자. 첫 값은 서버 버전과 정확히 같아야 하고, scid는 16진수로 읽힌다
 * (v4.1 Options.parse). 소켓 이름은 서버가 `scrcpy_<scid 8자리>`로 만든다.
 */
export function serverArgs(scid: number): string[] {
  return [
    'shell',
    `CLASSPATH=${DEVICE_JAR_PATH}`,
    'app_process',
    '/',
    'com.genymobile.scrcpy.Server',
    SCRCPY_SERVER_VERSION,
    `scid=${scidHex(scid)}`,
    'log_level=info',
    'tunnel_forward=true',
    'video=true',
    'audio=false',
    'control=true',
    // 기기 클립보드가 바뀔 때마다 control 소켓으로 메시지가 오지 않게 끈다. 클립보드 동기화는 범위 밖이다.
    'clipboard_autosync=false',
    'video_codec=h264',
    `max_size=${MAX_VIDEO_SIZE}`
  ]
}

function toDeviceError(thrown: unknown): DeviceError {
  if (isDeviceError(thrown)) return thrown
  return deviceError('command_failed', thrown instanceof Error ? thrown.message : String(thrown), '다시 연결해라')
}

/** 첫 청크를 기다린다. 데이터 없이 닫히면 null이다. */
function firstChunk(socket: SessionSocket): Promise<Buffer | null> {
  return new Promise((resolve) => {
    let settled = false
    const finish = (value: Buffer | null): void => {
      if (settled) return
      settled = true
      resolve(value)
    }
    socket.on('data', (chunk) => finish(chunk))
    socket.on('close', () => finish(null))
    socket.on('error', () => finish(null))
  })
}

/**
 * promise를 ms 뒤 실시간 타이머와 경쟁시킨다. adb forward가 연결은 받았지만 서버가 그
 * 이후로 아무 것도 보내지 않는 경우, promise 쪽만으로는 영영 끝나지 않는다. 이 타이머는
 * 항상 `setTimeout`의 실제 시간을 쓴다 — 세션의 `now`/`sleep`은 테스트가 조작하는 가짜
 * 시계라 재시도 사이 간격에는 맞지만, "얼마나 오래 응답이 없었는지"를 실제로 재는 이
 * 용도에는 쓸 수 없다.
 */
function withRealDeadline<T>(promise: Promise<T>, ms: number, onTimeout: () => DeviceError): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    let settled = false
    const timer = setTimeout(() => {
      if (settled) return
      settled = true
      reject(onTimeout())
    }, Math.max(0, ms))

    promise.then(
      (value) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        resolve(value)
      },
      (error: unknown) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        reject(error)
      }
    )
  })
}

export function createScrcpySession(deps: ScrcpySessionDeps, handlers: SessionHandlers): ScrcpySession {
  const { serial, adb, jarPath, connect } = deps
  const randomScid = deps.randomScid ?? (() => randomInt(0, 0x7fffffff))
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)))
  const now = deps.now ?? (() => Date.now())
  const connectTimeoutMs = deps.connectTimeoutMs ?? DEFAULT_CONNECT_TIMEOUT_MS

  let port: number | null = null
  let server: AdbStream | null = null
  let video: SessionSocket | null = null
  let control: SessionSocket | null = null
  let started = false
  let closed = false
  let ended = false
  let serverExited = false
  let serverStderr = ''
  const serverOutput: string[] = []

  function outputTail(): string {
    const parts = [serverOutput.join('\n'), serverStderr].filter((part) => part.length > 0)
    return parts.join('\n')
  }

  function end(error: DeviceError): void {
    if (!started || closed || ended) return
    ended = true
    handlers.onEnded(error)
  }

  /** start() 도중 close()가 불려서 그만둘 때 던지는 에러. 지금까지 연 자원은 catch에서 cleanup()이 치운다. */
  function closedWhileStarting(): DeviceError {
    return deviceError('command_failed', '세션이 시작 중에 닫혔다', '다시 연결해라', { serial })
  }

  function videoUnresponsiveError(): DeviceError {
    return deviceError('device_unresponsive', `scrcpy 서버가 ${connectTimeoutMs}ms 안에 비디오 소켓을 열지 않았다`, '기기가 완전히 부팅됐는지 확인하고 다시 연결해라', {
      serial,
      output: outputTail()
    })
  }

  function sessionMetaUnresponsiveError(): DeviceError {
    return deviceError('device_unresponsive', `scrcpy 서버가 ${connectTimeoutMs}ms 안에 session 정보를 보내지 않았다`, '기기가 완전히 부팅됐는지 확인하고 다시 연결해라', {
      serial,
      output: outputTail()
    })
  }

  async function cleanup(): Promise<void> {
    const sockets = [video, control]
    video = null
    control = null
    for (const socket of sockets) {
      try {
        socket?.destroy()
      } catch {
        // 이미 닫힌 소켓이다. 나머지 정리를 계속한다.
      }
    }

    server?.close()
    server = null

    if (port !== null) {
      const forwarded = port
      port = null
      try {
        await adb.exec(serial, ['forward', '--remove', `tcp:${forwarded}`])
      } catch {
        // 기기가 사라졌으면 forward도 이미 없다.
      }
    }
  }

  async function connectVideo(forwardedPort: number, deadline: number): Promise<{ socket: SessionSocket; first: Buffer }> {
    for (;;) {
      if (closed) throw closedWhileStarting()
      if (serverExited) {
        throw deviceError('command_failed', 'scrcpy 서버가 연결을 받기 전에 끝났다', '서버 출력을 확인하고 다시 연결해라', {
          serial,
          output: outputTail()
        })
      }

      let socket: SessionSocket | null = null
      try {
        socket = await connect(forwardedPort)
      } catch {
        socket = null
      }

      if (socket) {
        const opened = socket
        // adb forward는 서버가 listen하기 전에도 연결을 받은 뒤 곧바로 닫는다.
        // 서버가 받은 연결만 dummy byte를 보내므로 첫 바이트가 곧 성공 신호다.
        // 연결만 되고 그 뒤로 데이터도, close도, error도 안 오는 상대라면 firstChunk
        // 혼자서는 영영 안 끝나므로, 남은 기한만큼 실시간 타이머로 묶는다.
        let first: Buffer | null
        try {
          first = await withRealDeadline(firstChunk(opened), deadline - now(), videoUnresponsiveError)
        } catch (thrown) {
          opened.destroy()
          throw thrown
        }
        if (first) return { socket: opened, first }
        opened.destroy()
      }

      if (serverExited) continue
      if (now() >= deadline) throw videoUnresponsiveError()
      await sleep(CONNECT_RETRY_MS)
    }
  }

  async function start(): Promise<void> {
    let resolveReady: () => void = () => {}
    let rejectReady: (error: DeviceError) => void = () => {}
    const ready = new Promise<void>((resolve, reject) => {
      resolveReady = resolve
      rejectReady = reject
    })
    // 기다리기 전에 거부될 수 있다. 처리됨으로 표시만 하고 아래에서 await로 다시 받는다.
    ready.catch(() => {})

    try {
      await adb.exec(serial, ['push', jarPath, DEVICE_JAR_PATH])
      if (closed) throw closedWhileStarting()

      const scid = randomScid()
      const forwarded = await adb.exec(serial, ['forward', 'tcp:0', `localabstract:scrcpy_${scidHex(scid)}`])
      const parsedPort = Number.parseInt(forwarded.stdout.trim(), 10)
      if (!Number.isInteger(parsedPort) || parsedPort <= 0) {
        throw deviceError('command_failed', 'adb forward가 로컬 포트를 돌려주지 않았다', 'adb 버전을 확인해라', {
          stdout: forwarded.stdout
        })
      }
      port = parsedPort
      if (closed) throw closedWhileStarting()

      const serverStream = adb.stream(serial, serverArgs(scid))
      server = serverStream
      serverStream.onLine((line) => {
        serverOutput.push(line)
        if (serverOutput.length > SERVER_OUTPUT_TAIL_LINES) serverOutput.shift()
      })
      // stderr는 onLine에 안 실린다 — adbClient의 stream()은 stdout만 줄 단위로 흘리고,
      // stderr는 실패했을 때 onError가 주는 DeviceError.details.stderr로만 온다. scrcpy의
      // 버전 불일치·ClassNotFoundException 같은 치명적 메시지는 서버가 stderr(Ln.e/Ln.w)로
      // 찍으므로, 여기서 받아 두지 않으면 실패 사유가 출력 꼬리에서 통째로 빠진다.
      serverStream.onError((error) => {
        const stderr = error.toolError.details?.stderr
        if (typeof stderr === 'string' && stderr.trim().length > 0) serverStderr = stderr
      })
      // onError 뒤에는 onClose가 반드시 온다. 종료 처리는 onClose 한곳에서 한다.
      serverStream.onClose(() => {
        serverExited = true
        const error = deviceError('command_failed', 'scrcpy 서버가 끝났다', '다시 연결해라', { serial, output: outputTail() })
        rejectReady(error)
        end(error)
      })

      const deadline = now() + connectTimeoutMs
      const { socket, first } = await connectVideo(parsedPort, deadline)
      // closed 검사보다 대입이 먼저다 — port와 같은 순서다. connectVideo가 소켓을 들고 돌아온
      // 시점에는 이미 실제로 연결이 됐으므로, closed였다고 그냥 던지면 이 소켓은 어디에도
      // 저장되지 않은 채 cleanup()의 [video, control] 목록 밖에 남아 새는 채로 끝난다.
      video = socket
      if (closed) throw closedWhileStarting()
      const parser = createVideoStreamParser({
        onDeviceName: () => {},
        onSession: (width, height) => {
          handlers.onSession(width, height)
          resolveReady()
        },
        onPacket: (packet) => handlers.onPacket(packet),
        onError: (error) => {
          rejectReady(error)
          end(error)
        }
      })
      socket.on('data', (chunk) => parser.push(chunk))
      socket.on('error', () => {})
      socket.on('close', () => {
        const error = deviceError('command_failed', '비디오 스트림이 끊겼다', '다시 연결해라', { serial, output: outputTail() })
        rejectReady(error)
        end(error)
      })
      parser.push(first)

      // 서버는 비디오 연결을 받은 뒤 같은 소켓 이름으로 control 연결을 기다린다.
      const controlSocket = await connect(parsedPort)
      // 여기도 마찬가지로 대입이 먼저다 — 이미 연결된 control 소켓을 cleanup()이 찾을 수 있어야 한다.
      control = controlSocket
      if (closed) throw closedWhileStarting()
      // control 소켓으로 오는 기기 메시지는 쓰지 않지만 읽어야 버퍼가 차지 않는다.
      controlSocket.on('data', () => {})
      controlSocket.on('error', () => {})
      controlSocket.on('close', () => {
        const error = deviceError('command_failed', 'control 연결이 끊겼다', '다시 연결해라', { serial })
        rejectReady(error)
        end(error)
      })

      // 기기 이름·codec·첫 session meta는 control 연결까지 받은 뒤에 온다(DesktopConnection.open).
      // 비디오·control 둘 다 붙었는데 그 뒤로 서버가 아무 것도 안 보내는 경우까지 같은
      // 기한으로 묶는다 — 안 그러면 이 대기만 무한정 늘어진다.
      await withRealDeadline(ready, deadline - now(), sessionMetaUnresponsiveError)
      if (closed) throw closedWhileStarting()
      started = true
    } catch (thrown) {
      await cleanup()
      throw toDeviceError(thrown)
    }
  }

  return {
    serial,
    start,
    sendControl(intent) {
      if (!control || closed) return
      let bytes: Uint8Array
      try {
        bytes = serializeControl(intent)
      } catch {
        // streamManager가 먼저 걸러야 하는 값이다. 여기까지 와도 연결을 깨지 않고 버린다.
        return
      }
      control.write(bytes)
    },
    async close() {
      if (closed) return
      closed = true
      await cleanup()
    }
  }
}
