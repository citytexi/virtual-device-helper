import { spawn as nodeSpawn } from 'node:child_process'
import { deviceError, type DeviceError } from '../../shared/types/errors'
import {
  createProcessClient,
  STDERR_TAIL_LIMIT_BYTES,
  type ExecOpts,
  type ExecResult,
  type ProcessFailures,
  type ProcessStream,
  type SpawnFn
} from '../process/processClient'

/**
 * adb 실패의 타입 있는 표현이다. 이 층이 만들어 내보내는 값이라, 소비자가
 * 자기 콜백 인자의 이름을 붙이려고 shared/types까지 내려가지 않아도 되게 여기서 같이 낸다.
 */
export type { DeviceError }


export { STDERR_TAIL_LIMIT_BYTES }
export type { ExecOpts, ExecResult, SpawnFn }
export type AdbStream = ProcessStream

export interface AdbClient {
  exec(serial: string | null, args: string[], opts?: ExecOpts): Promise<ExecResult>
  stream(serial: string | null, args: string[]): AdbStream
}

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

function adbFailures(adbPath: string): ProcessFailures {
  return {
    notFound: () => deviceError('adb_not_found', `adb를 찾을 수 없다: ${adbPath}`, 'Android SDK 설치와 platform-tools를 확인해라'),
    spawnFailed: () => deviceError('adb_not_found', `adb를 실행할 수 없다: ${adbPath}`, 'Android SDK 설치와 platform-tools를 확인해라'),
    spawnError: (error, args) => deviceError('command_failed', `adb 실행에 실패했다: ${error.message}`, '첨부된 정보를 확인해라', { args }),
    classify,
    timedOut: (args, timeoutMs) =>
      deviceError('device_unresponsive', `adb 명령이 ${timeoutMs}ms 안에 끝나지 않았다: ${args.join(' ')}`, '기기 상태를 확인하고 필요하면 device_shutdown 후 다시 부팅해라', {
        args,
        timeoutMs
      }),
    killed: (args, signal, stderr) =>
      deviceError('command_failed', `adb 프로세스가 끝나기 전에 종료됐다: ${args.join(' ')}`, 'adb 서버와 기기 연결을 확인하고 다시 실행해라', {
        args,
        signal,
        stderr
      }),
    streamReadFailed: (stream, error, args) =>
      deviceError('command_failed', `adb ${stream} 읽기에 실패했다: ${error.message}`, '첨부된 정보를 확인해라', {
        stream,
        args
      })
  }
}

export function createAdbClient(adbPath: string, spawnFn: SpawnFn = nodeSpawn as SpawnFn): AdbClient {
  const process = createProcessClient(adbPath, adbFailures(adbPath), spawnFn)
  return {
    exec: (serial, args, opts) => process.exec(withSerial(serial, args), opts),
    stream: (serial, args) => process.stream(withSerial(serial, args))
  }
}
