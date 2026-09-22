import { spawn as nodeSpawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { deviceError, type DeviceError } from '../../shared/types/errors'

export type SpawnFn = (command: string, args: string[]) => ChildProcessWithoutNullStreams

export interface ExecOpts {
  /** 기본 30초. 화면 캡처처럼 오래 걸리는 명령은 호출부가 늘린다. */
  timeoutMs?: number
}

export interface ExecResult {
  stdout: string
  stdoutRaw: Buffer
  stderr: string
  exitCode: number
}

export interface AdbStream {
  /**
   * 줄 단위로 끊어 준다. logcat처럼 줄이 곧 단위인 출력에 쓴다.
   * 프로세스가 끝날 때 개행 없이 남은 마지막 조각도 한 번 흘려보낸다.
   */
  onLine(callback: (line: string) => void): void
  /**
   * stdout 바이트를 가공 없이 그대로 준다. `track-devices`처럼 길이 접두사로
   * 프레이밍된 출력은 줄 단위 API로 표현할 수 없어서 이 채널이 필요하다.
   * onLine과 동시에 켜 둘 수 있고, 같은 바이트가 양쪽으로 모두 간다.
   */
  onData(callback: (chunk: Buffer) => void): void
  onClose(callback: (code: number | null) => void): void
  /**
   * 필수 멤버다 — 선택으로 두면 소비자가 등록을 잊기 쉽고, 그러면 stdout/stderr/child
   * 에러가 조용히 사라진다. 에러를 받은 뒤에는 반드시 onClose가 뒤따른다.
   */
  onError(callback: (error: DeviceError) => void): void
  close(): void
}

export interface AdbClient {
  exec(serial: string | null, args: string[], opts?: ExecOpts): Promise<ExecResult>
  stream(serial: string | null, args: string[]): AdbStream
}

const DEFAULT_TIMEOUT_MS = 30_000

/**
 * stream이 붙잡아 두는 stderr의 상한이다. 장시간 도는 logcat이 경고를 쏟아내도
 * 메모리가 늘지 않게 꼬리만 남긴다. 실패 원인은 거의 항상 마지막 몇 줄에 있다.
 */
export const STDERR_TAIL_LIMIT_BYTES = 8 * 1024

function withSerial(serial: string | null, args: string[]): string[] {
  return serial ? ['-s', serial, ...args] : args
}

/**
 * stderr 문자열을 타입 있는 에러로 바꾼다.
 * adb 문법을 아는 유일한 층이므로, 위층은 raw stderr를 해석하지 않는다.
 * exec과 stream이 같은 함수를 거치기 때문에 같은 adb 실패는 어느 경로로 와도
 * 같은 ToolErrorKind로 분류된다.
 */
function classify(stderr: string, args: string[]): DeviceError {
  const text = stderr.trim()

  if (/no devices\/emulators found/i.test(text)) {
    return deviceError('no_device', '연결된 기기가 없다', 'device_list로 확인한 뒤 device_boot로 부팅해라', {
      stderr: text
    })
  }
  if (/more than one device/i.test(text)) {
    return deviceError('ambiguous_device', '기기가 여럿이라 대상을 정할 수 없다', 'serial을 지정하거나 device_select로 활성 기기를 정해라', {
      stderr: text
    })
  }
  if (/device .*not found|device offline/i.test(text)) {
    return deviceError('no_device', '지정한 기기를 찾을 수 없다', 'device_list로 현재 연결된 기기를 확인해라', {
      stderr: text
    })
  }

  return deviceError('command_failed', `adb 명령이 실패했다: ${args.join(' ')}`, '첨부된 stderr를 확인해라', {
    stderr: text,
    args
  })
}

export function createAdbClient(adbPath: string, spawnFn: SpawnFn = nodeSpawn as SpawnFn): AdbClient {
  function exec(serial: string | null, args: string[], opts: ExecOpts = {}): Promise<ExecResult> {
    const fullArgs = withSerial(serial, args)
    const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS

    return new Promise<ExecResult>((resolve, reject) => {
      let child: ChildProcessWithoutNullStreams
      try {
        child = spawnFn(adbPath, fullArgs)
      } catch {
        reject(deviceError('adb_not_found', `adb를 실행할 수 없다: ${adbPath}`, 'Android SDK 설치와 platform-tools를 확인해라'))
        return
      }

      const stdoutChunks: Buffer[] = []
      const stderrChunks: Buffer[] = []
      let settled = false

      // 실제 child_process에서도 'close'가 stdout/stderr가 끝나기 전에 온다는
      // 보장은 없다. 세 신호(close, stdout end, stderr end)가 모두 도착한
      // 뒤에야 결과를 확정한다 — 그렇지 않으면 마지막 데이터 청크를 놓친 채
      // 빈 stdout/stderr로 resolve/reject 해버릴 수 있다.
      let closeCode: number | null | undefined
      let closeSignal: NodeJS.Signals | null = null
      let stdoutEnded = false
      let stderrEnded = false

      const timer = setTimeout(() => {
        if (settled) return
        settled = true
        child.kill('SIGKILL')
        reject(
          deviceError('device_unresponsive', `adb 명령이 ${timeoutMs}ms 안에 끝나지 않았다: ${fullArgs.join(' ')}`, '기기 상태를 확인하고 필요하면 device_shutdown 후 다시 부팅해라', {
            args: fullArgs,
            timeoutMs
          })
        )
      }, timeoutMs)

      function tryFinish(): void {
        if (settled) return
        if (closeCode === undefined || !stdoutEnded || !stderrEnded) return
        settled = true
        clearTimeout(timer)

        const stdoutRaw = Buffer.concat(stdoutChunks)
        const stderr = Buffer.concat(stderrChunks).toString('utf8')
        const code = closeCode

        // 종료 코드가 없다는 것은 프로세스가 스스로 끝나지 않고 밖에서 죽었다는
        // 뜻이다. 이때 stdout은 도중에 잘려 있다. 예전처럼 0으로 메워 성공으로
        // 돌려주면 잘린 스크린샷 PNG 같은 것이 정상 결과인 척 위층으로 올라간다.
        if (code === null) {
          reject(
            deviceError('command_failed', `adb 프로세스가 끝나기 전에 종료됐다: ${fullArgs.join(' ')}`, 'adb 서버와 기기 연결을 확인하고 다시 실행해라', {
              args: fullArgs,
              signal: closeSignal,
              stderr: stderr.trim()
            })
          )
          return
        }

        if (code !== 0) {
          reject(classify(stderr, fullArgs))
          return
        }

        resolve({ stdout: stdoutRaw.toString('utf8'), stdoutRaw, stderr, exitCode: code })
      }

      // Readable에 'error' 리스너가 없으면 EventEmitter가 그 에러를 그대로 던지고,
      // 여기는 Electron main 프로세스라 잡히지 않은 예외 하나에 앱이 통째로 죽는다.
      // 게다가 error로 끝난 스트림은 'end'를 내지 않아 tryFinish가 영영 성립하지
      // 않으므로, 리스너가 없으면 타임아웃까지 기다렸다가 엉뚱하게
      // device_unresponsive로 보고된다.
      function failFromStream(streamName: 'stdout' | 'stderr', error: Error): void {
        if (settled) return
        settled = true
        clearTimeout(timer)
        reject(
          deviceError('command_failed', `adb ${streamName} 읽기에 실패했다: ${error.message}`, '첨부된 정보를 확인해라', {
            stream: streamName,
            args: fullArgs
          })
        )
      }

      child.stdout.on('data', (chunk: Buffer) => stdoutChunks.push(Buffer.from(chunk)))
      child.stderr.on('data', (chunk: Buffer) => stderrChunks.push(Buffer.from(chunk)))
      child.stdout.on('error', (error: Error) => failFromStream('stdout', error))
      child.stderr.on('error', (error: Error) => failFromStream('stderr', error))
      child.stdout.on('end', () => {
        stdoutEnded = true
        tryFinish()
      })
      child.stderr.on('end', () => {
        stderrEnded = true
        tryFinish()
      })

      child.on('error', (error: NodeJS.ErrnoException) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        if (error.code === 'ENOENT') {
          reject(deviceError('adb_not_found', `adb를 찾을 수 없다: ${adbPath}`, 'Android SDK 설치와 platform-tools를 확인해라'))
          return
        }
        reject(deviceError('command_failed', `adb 실행에 실패했다: ${error.message}`, '첨부된 정보를 확인해라', { args: fullArgs }))
      })

      child.on('close', (code: number | null, signal: NodeJS.Signals | null) => {
        closeCode = code
        closeSignal = signal
        tryFinish()
      })
    })
  }

  function stream(serial: string | null, args: string[]): AdbStream {
    const fullArgs = withSerial(serial, args)
    const lineCallbacks: Array<(line: string) => void> = []
    const dataCallbacks: Array<(chunk: Buffer) => void> = []
    const closeCallbacks: Array<(code: number | null) => void> = []
    const errorCallbacks: Array<(error: DeviceError) => void> = []
    let buffer = ''
    // close()가 세우는 정지 플래그. data·close·error 핸들러는 전부 진입할 때
    // 이 값을 확인해서, close() 이후 도착하는 이벤트가 콜백을 부르지 않게 막는다.
    // SIGTERM은 비동기라 콜백 등록을 지우는 것만으로는 막을 수 없다.
    let stopped = false
    // 에러 뒤에 실제 close 이벤트가 따로 와도 onClose가 두 번 불리지 않게 막는다.
    let closeNotified = false

    // 개행으로 끝나지 않고 끝난 마지막 조각을 한 번 흘려보낸다. 여러 번 불려도
    // 버퍼를 비우고 나가므로 같은 줄이 두 번 나가지 않는다.
    function flushTrailingLine(): void {
      if (stopped || buffer.length === 0) return
      const line = buffer
      buffer = ''
      for (const callback of lineCallbacks) callback(line)
    }

    function notifyClose(code: number | null): void {
      if (closeNotified) return
      closeNotified = true
      flushTrailingLine()
      for (const callback of closeCallbacks) callback(code)
    }

    // stopped 가드는 여기 한 곳에만 둔다 — 모든 에러 경로가 이 함수를 거쳐가므로
    // 경로마다 따로 stopped를 확인할 필요가 없다.
    function deliverError(error: DeviceError): void {
      if (stopped) return
      for (const callback of errorCallbacks) callback(error)
    }

    function notifyError(error: DeviceError): void {
      if (stopped) return
      deliverError(error)
      // onError만 등록하고 onClose는 기다리지 않는 소비자가 있을 수 있으니, 실제
      // close 이벤트가 따로 오지 않는 경우를 대비해 여기서 끝을 알린다. 나중에
      // 진짜 close가 오면 notifyClose의 closeNotified 가드가 중복 호출을 막는다.
      notifyClose(null)
    }

    let child: ChildProcessWithoutNullStreams | null = null
    try {
      child = spawnFn(adbPath, fullArgs)
    } catch {
      // exec은 동기 throw를 adb_not_found로 바꾸는데 stream만 날것의 Error를
      // 밖으로 흘리면, 같은 실패가 경로에 따라 다른 타입으로 보인다.
      // 소비자가 onError를 등록할 틈을 주려고 한 틱 미룬다.
      queueMicrotask(() =>
        notifyError(deviceError('adb_not_found', `adb를 실행할 수 없다: ${adbPath}`, 'Android SDK 설치와 platform-tools를 확인해라'))
      )
    }

    if (child) {
      const boundChild = child
      // stderr는 두 가지 이유로 반드시 읽어야 한다. 읽지 않으면 파이프 버퍼가
      // 차서 자식이 write에서 멈추고 스트림이 아무 신호 없이 굳는다. 그리고
      // 실패 원인이 여기에만 있어서, 읽지 않으면 소비자에게 종료 코드 말고는
      // 줄 것이 없다.
      const stderrTail: Buffer[] = []
      let stderrTailBytes = 0

      function appendStderrTail(chunk: Buffer): void {
        stderrTail.push(Buffer.from(chunk))
        stderrTailBytes += chunk.length
        if (stderrTailBytes <= STDERR_TAIL_LIMIT_BYTES) return
        const merged = Buffer.concat(stderrTail, stderrTailBytes)
        const tail = Buffer.from(merged.subarray(merged.length - STDERR_TAIL_LIMIT_BYTES))
        stderrTail.length = 0
        stderrTail.push(tail)
        stderrTailBytes = tail.length
      }

      boundChild.stdout.on('data', (chunk: Buffer) => {
        if (stopped) return
        const copy = Buffer.from(chunk)
        for (const callback of dataCallbacks) callback(copy)

        buffer += copy.toString('utf8')
        const parts = buffer.split('\n')
        buffer = parts.pop() ?? ''
        for (const line of parts) {
          for (const callback of lineCallbacks) callback(line)
        }
      })

      boundChild.stderr.on('data', (chunk: Buffer) => {
        if (stopped) return
        appendStderrTail(chunk)
      })

      boundChild.stdout.on('error', (error: Error) => {
        notifyError(
          deviceError('command_failed', `adb stdout 읽기에 실패했다: ${error.message}`, '첨부된 정보를 확인해라', {
            stream: 'stdout',
            args: fullArgs
          })
        )
      })

      boundChild.stderr.on('error', (error: Error) => {
        notifyError(
          deviceError('command_failed', `adb stderr 읽기에 실패했다: ${error.message}`, '첨부된 정보를 확인해라', {
            stream: 'stderr',
            args: fullArgs
          })
        )
      })

      boundChild.on('error', (error: NodeJS.ErrnoException) => {
        if (error.code === 'ENOENT') {
          notifyError(deviceError('adb_not_found', `adb를 찾을 수 없다: ${adbPath}`, 'Android SDK 설치와 platform-tools를 확인해라'))
          return
        }
        notifyError(deviceError('command_failed', `adb 실행에 실패했다: ${error.message}`, '첨부된 정보를 확인해라', { args: fullArgs }))
      })

      boundChild.on('close', (code: number | null) => {
        if (stopped) return
        flushTrailingLine()
        if (typeof code === 'number' && code !== 0) {
          deliverError(classify(Buffer.concat(stderrTail).toString('utf8'), fullArgs))
        }
        notifyClose(code)
      })
    }

    return {
      onLine(callback) {
        lineCallbacks.push(callback)
      },
      onData(callback) {
        dataCallbacks.push(callback)
      },
      onClose(callback) {
        closeCallbacks.push(callback)
      },
      onError(callback) {
        errorCallbacks.push(callback)
      },
      close() {
        stopped = true
        child?.kill('SIGTERM')
      }
    }
  }

  return { exec, stream }
}
