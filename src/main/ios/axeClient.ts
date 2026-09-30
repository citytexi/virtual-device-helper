import { deviceError } from '../../shared/types/errors'
import {
  createProcessClient,
  type ExecOpts,
  type ExecResult,
  type ProcessFailures,
  type ProcessStream,
  type SpawnFn
} from '../process/processClient'

/** `args`는 `axe` 다음부터다. 모든 호출 끝에 `--udid <udid>`가 붙는다. */
export interface AxeClient {
  exec(udid: string, args: string[], opts?: ExecOpts): Promise<ExecResult>
  stream(udid: string, args: string[]): ProcessStream
}

export const AXE_HINT = 'brew install cameroncooke/axe/axe로 설치하고 앱을 다시 켜라'

const axeFailures: ProcessFailures = {
  notFound: () => deviceError('ios_tool_not_found', 'axe를 찾을 수 없다', AXE_HINT),
  spawnFailed: () => deviceError('ios_tool_not_found', 'axe를 실행할 수 없다', AXE_HINT),
  spawnError: (error, args) => deviceError('command_failed', `axe 실행에 실패했다: ${error.message}`, '첨부된 정보를 확인해라', { args }),
  classify: (stderr, args) =>
    deviceError('command_failed', `axe 명령이 실패했다: ${args.join(' ')}`, '첨부된 stderr를 확인해라', { stderr: stderr.trim(), args }),
  timedOut: (args, timeoutMs) =>
    deviceError('device_unresponsive', `axe 명령이 ${timeoutMs}ms 안에 끝나지 않았다: ${args.join(' ')}`, '시뮬레이터 상태를 확인하고 다시 실행해라', {
      args,
      timeoutMs
    }),
  killed: (args, signal, stderr) =>
    deviceError('command_failed', `axe 프로세스가 끝나기 전에 종료됐다: ${args.join(' ')}`, '시뮬레이터 상태를 확인하고 다시 실행해라', {
      args,
      signal,
      stderr
    }),
  streamReadFailed: (stream, error, args) =>
    deviceError('command_failed', `axe ${stream} 읽기에 실패했다: ${error.message}`, '첨부된 정보를 확인해라', { stream, args })
}

/** 셸 없이 `axe ...`를 spawn한다. axe 문법과 `--udid` 규약은 이 층만 안다. */
export function createAxeClient(axePath: string, spawnFn?: SpawnFn): AxeClient {
  const process = createProcessClient(axePath, axeFailures, spawnFn)
  return {
    exec: (udid, args, opts) => process.exec([...args, '--udid', udid], opts),
    stream: (udid, args) => process.stream([...args, '--udid', udid])
  }
}
