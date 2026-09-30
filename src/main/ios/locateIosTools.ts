import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import type { ExecFileFn } from '../device/avdController'

const execFileAsync = promisify(execFile)

export type IosToolsResult = { ok: true; developerDir: string } | { ok: false; reason: string }

export interface LocateIosToolsDeps {
  platform: NodeJS.Platform
  execFile: ExecFileFn
}

export function defaultLocateIosToolsDeps(): LocateIosToolsDeps {
  // 셸 없이 execFile로 부른다.
  return { platform: process.platform, execFile: (command, args) => execFileAsync(command, args) }
}

/**
 * iOS 시뮬레이터 스택을 조립할 수 있는지 본다. macOS에서 `xcode-select -p`로 개발자 디렉토리를
 * 얻고, `xcrun simctl help`가 성공해야 준비된 것으로 본다. Xcode 없는 Mac에서 추적을 시작해
 * tracking_failed를 내는 대신 조립 단계에서 iOS를 빼기 위해서다.
 */
export async function locateIosTools(deps: LocateIosToolsDeps): Promise<IosToolsResult> {
  if (deps.platform !== 'darwin') return { ok: false, reason: 'macOS에서만 iOS 시뮬레이터를 쓸 수 있다' }

  let developerDir: string
  try {
    developerDir = (await deps.execFile('xcode-select', ['-p'])).stdout.trim()
  } catch {
    return { ok: false, reason: 'Xcode 개발자 디렉토리를 찾지 못했다' }
  }
  if (developerDir === '') return { ok: false, reason: 'Xcode 개발자 디렉토리를 찾지 못했다' }

  try {
    await deps.execFile('xcrun', ['simctl', 'help'])
  } catch {
    return { ok: false, reason: 'xcrun simctl을 실행할 수 없다' }
  }
  return { ok: true, developerDir }
}
