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
  onLine(callback: (line: string) => void): void
  onClose(callback: (code: number | null) => void): void
  /**
   * 필수 멤버다 — 선택으로 두면 소비자가 등록을 잊기 쉽고, 그러면 stdout/stderr/child
   * 에러가 조용히 사라진다. 에러를 받은 뒤에는 반드시 onClose(null)이 뒤따른다.
   */
  onError(callback: (error: DeviceError) => void): void
  close(): void
}

export interface AdbClient {
  exec(serial: string | null, args: string[], opts?: ExecOpts): Promise<ExecResult>
  stream(serial: string | null, args: string[]): AdbStream
}

const DEFAULT_TIMEOUT_MS = 30_000

function withSerial(serial: string | null, args: string[]): string[] {
  return serial ? ['-s', serial, ...args] : args
}

/**
 * stderr 문자열을 타입 있는 에러로 바꾼다.
 * adb 문법을 아는 유일한 층이므로, 위층은 raw stderr를 해석하지 않는다.
 */
function classify(stderr: string, args: string[]): never {
  const text = stderr.trim()

  if (/no devices\/emulators found/i.test(text)) {
    throw deviceError('no_device', '연결된 기기가 없다', 'device_list로 확인한 뒤 device_boot로 부팅해라', {
      stderr: text
    })
  }
  if (/more than one device/i.test(text)) {
    throw deviceError('ambiguous_device', '기기가 여럿이라 대상을 정할 수 없다', 'serial을 지정하거나 device_select로 활성 기기를 정해라', {
      stderr: text
    })
  }
  if (/device .*not found|device offline/i.test(text)) {
    throw deviceError('no_device', '지정한 기기를 찾을 수 없다', 'device_list로 현재 연결된 기기를 확인해라', {
      stderr: text
    })
  }

  throw deviceError('command_failed', `adb 명령이 실패했다: ${args.join(' ')}`, '첨부된 stderr를 확인해라', {
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

        if (code !== 0) {
          try {
            classify(stderr, fullArgs)
          } catch (error) {
            reject(error)
            return
          }
        }

        resolve({ stdout: stdoutRaw.toString('utf8'), stdoutRaw, stderr, exitCode: code ?? 0 })
      }

      child.stdout.on('data', (chunk: Buffer) => stdoutChunks.push(Buffer.from(chunk)))
      child.stderr.on('data', (chunk: Buffer) => stderrChunks.push(Buffer.from(chunk)))
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

      child.on('close', (code) => {
        closeCode = code ?? 0
        tryFinish()
      })
    })
  }

  function stream(serial: string | null, args: string[]): AdbStream {
    const fullArgs = withSerial(serial, args)
    const child = spawnFn(adbPath, fullArgs)
    const lineCallbacks: Array<(line: string) => void> = []
    const closeCallbacks: Array<(code: number | null) => void> = []
    const errorCallbacks: Array<(error: DeviceError) => void> = []
    let buffer = ''
    // close()가 세우는 정지 플래그. data·close·error 핸들러는 전부 진입할 때
    // 이 값을 확인해서, close() 이후 도착하는 이벤트가 콜백을 부르지 않게 막는다.
    // SIGTERM은 비동기라 콜백 등록을 지우는 것만으로는 막을 수 없다.
    let stopped = false
    // 에러 뒤에 실제 close 이벤트가 따로 와도 onClose가 두 번 불리지 않게 막는다.
    let closeNotified = false

    function notifyClose(code: number | null): void {
      if (closeNotified) return
      closeNotified = true
      for (const callback of closeCallbacks) callback(code)
    }

    // stopped 가드는 여기 한 곳에만 둔다 — 세 error 핸들러가 전부 이 함수를 거쳐가므로
    // 핸들러마다 따로 stopped를 확인할 필요가 없다.
    function notifyError(error: DeviceError): void {
      if (stopped) return
      for (const callback of errorCallbacks) callback(error)
      // onError만 등록하고 onClose는 기다리지 않는 소비자가 있을 수 있으니, 실제
      // close 이벤트가 따로 오지 않는 경우를 대비해 여기서 끝을 알린다. 나중에
      // 진짜 close가 오면 notifyClose의 closeNotified 가드가 중복 호출을 막는다.
      notifyClose(null)
    }

    child.stdout.on('data', (chunk: Buffer) => {
      if (stopped) return
      buffer += chunk.toString('utf8')
      const parts = buffer.split('\n')
      buffer = parts.pop() ?? ''
      for (const line of parts) {
        for (const callback of lineCallbacks) callback(line)
      }
    })

    child.stdout.on('error', (error: Error) => {
      notifyError(
        deviceError('command_failed', `adb stdout 읽기에 실패했다: ${error.message}`, '첨부된 정보를 확인해라', {
          stream: 'stdout',
          args: fullArgs
        })
      )
    })

    child.stderr.on('error', (error: Error) => {
      notifyError(
        deviceError('command_failed', `adb stderr 읽기에 실패했다: ${error.message}`, '첨부된 정보를 확인해라', {
          stream: 'stderr',
          args: fullArgs
        })
      )
    })

    child.on('error', (error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') {
        notifyError(deviceError('adb_not_found', `adb를 찾을 수 없다: ${adbPath}`, 'Android SDK 설치와 platform-tools를 확인해라'))
        return
      }
      notifyError(deviceError('command_failed', `adb 실행에 실패했다: ${error.message}`, '첨부된 정보를 확인해라', { args: fullArgs }))
    })

    child.on('close', (code) => {
      if (stopped) return
      notifyClose(code)
    })

    return {
      onLine(callback) {
        lineCallbacks.push(callback)
      },
      onClose(callback) {
        closeCallbacks.push(callback)
      },
      onError(callback) {
        errorCallbacks.push(callback)
      },
      close() {
        stopped = true
        child.kill('SIGTERM')
      }
    }
  }

  return { exec, stream }
}
