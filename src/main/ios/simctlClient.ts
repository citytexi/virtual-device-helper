import { deviceError, type DeviceError } from '../../shared/types/errors'
import {
  createProcessClient,
  type ExecOpts,
  type ExecResult,
  type ProcessFailures,
  type ProcessStream,
  type SpawnFn
} from '../process/processClient'

/** `args`는 `simctl` 다음부터다. 예: `['list', 'devices', '-j']`. */
export interface SimctlClient {
  exec(args: string[], opts?: ExecOpts): Promise<ExecResult>
  stream(args: string[]): ProcessStream
}

const XCODE_HINT = 'Xcode를 설치하고 xcode-select -s로 개발자 디렉토리를 정해라'

/** simctl stderr를 타입 있는 에러로 바꾼다. simctl 문법은 이 층만 안다. */
function classify(stderr: string, args: string[]): DeviceError {
  const text = stderr.trim()
  if (/Invalid device/i.test(text)) {
    return deviceError('no_device', '지정한 시뮬레이터를 찾을 수 없다', 'device_list로 시뮬레이터 UDID를 확인해라', { stderr: text })
  }
  return deviceError('command_failed', `simctl 명령이 실패했다: ${args.join(' ')}`, '첨부된 stderr를 확인해라', { stderr: text, args })
}

const simctlFailures: ProcessFailures = {
  notFound: () => deviceError('ios_tool_not_found', 'xcrun을 찾을 수 없다', XCODE_HINT),
  spawnFailed: () => deviceError('ios_tool_not_found', 'xcrun을 실행할 수 없다', XCODE_HINT),
  spawnError: (error, args) => deviceError('command_failed', `simctl 실행에 실패했다: ${error.message}`, '첨부된 정보를 확인해라', { args }),
  classify,
  timedOut: (args, timeoutMs) =>
    deviceError('device_unresponsive', `simctl 명령이 ${timeoutMs}ms 안에 끝나지 않았다: ${args.join(' ')}`, '시뮬레이터 상태를 확인하고 필요하면 device_shutdown 후 다시 부팅해라', {
      args,
      timeoutMs
    }),
  killed: (args, signal, stderr) =>
    deviceError('command_failed', `simctl 프로세스가 끝나기 전에 종료됐다: ${args.join(' ')}`, '시뮬레이터 상태를 확인하고 다시 실행해라', {
      args,
      signal,
      stderr
    }),
  streamReadFailed: (stream, error, args) =>
    deviceError('command_failed', `simctl ${stream} 읽기에 실패했다: ${error.message}`, '첨부된 정보를 확인해라', { stream, args })
}

/** 셸 없이 `xcrun simctl ...`을 spawn한다. */
export function createSimctlClient(spawnFn?: SpawnFn): SimctlClient {
  const process = createProcessClient('xcrun', simctlFailures, spawnFn)
  return {
    exec: (args, opts) => process.exec(['simctl', ...args], opts),
    stream: (args) => process.stream(['simctl', ...args])
  }
}
