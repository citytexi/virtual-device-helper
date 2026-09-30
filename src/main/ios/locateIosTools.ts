import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import type { ExecFileFn } from '../device/avdController'

const execFileAsync = promisify(execFile)

/**
 * 도구 확인 한 번에 기다리는 최대 시간. 첫 CoreSimulatorService 기동·라이선스 대기·멎은
 * CoreSimulator에서 `xcrun simctl help`가 돌아오지 않으면, 창을 띄우기 전에 앱이 멈춘다.
 */
export const IOS_TOOLS_TIMEOUT_MS = 10_000

export type IosToolsResult = { ok: true; developerDir: string } | { ok: false; reason: string }

export interface LocateIosToolsDeps {
  platform: NodeJS.Platform
  execFile: ExecFileFn
  /** 기본값은 IOS_TOOLS_TIMEOUT_MS. 테스트에서 주입한다. */
  timeoutMs?: number
}

export function defaultLocateIosToolsDeps(): LocateIosToolsDeps {
  // 셸 없이 execFile로 부른다. 제한 시간이 지나면 프로세스를 SIGKILL로 죽인다.
  return {
    platform: process.platform,
    execFile: (command, args) => execFileAsync(command, args, { timeout: IOS_TOOLS_TIMEOUT_MS, killSignal: 'SIGKILL' }),
    timeoutMs: IOS_TOOLS_TIMEOUT_MS
  }
}

const TIMED_OUT = Symbol('timed out')

/** execFile이 제한 시간으로 죽인 프로세스의 에러이거나, 이 모듈의 대기 시간이 지났을 때. */
function isTimeout(thrown: unknown): boolean {
  if (thrown === TIMED_OUT) return true
  return typeof thrown === 'object' && thrown !== null && (thrown as { killed?: unknown }).killed === true
}

/** 주입된 execFile이 제한 시간을 지키지 않아도 여기서 끊는다. */
async function withTimeout<T>(task: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(TIMED_OUT), ms)
  })
  try {
    return await Promise.race([task, timeout])
  } finally {
    clearTimeout(timer)
  }
}

/**
 * iOS 시뮬레이터 스택을 조립할 수 있는지 본다. macOS에서 `xcode-select -p`로 개발자 디렉토리를
 * 얻고, `xcrun simctl help`가 성공해야 준비된 것으로 본다. Xcode 없는 Mac에서 추적을 시작해
 * tracking_failed를 내는 대신 조립 단계에서 iOS를 빼기 위해서다.
 */
export async function locateIosTools(deps: LocateIosToolsDeps): Promise<IosToolsResult> {
  if (deps.platform !== 'darwin') return { ok: false, reason: 'macOS에서만 iOS 시뮬레이터를 쓸 수 있다' }
  const timeoutMs = deps.timeoutMs ?? IOS_TOOLS_TIMEOUT_MS

  let developerDir: string
  try {
    developerDir = (await withTimeout(deps.execFile('xcode-select', ['-p']), timeoutMs)).stdout.trim()
  } catch {
    return { ok: false, reason: 'Xcode 개발자 디렉토리를 찾지 못했다' }
  }
  if (developerDir === '') return { ok: false, reason: 'Xcode 개발자 디렉토리를 찾지 못했다' }

  try {
    await withTimeout(deps.execFile('xcrun', ['simctl', 'help']), timeoutMs)
  } catch (thrown) {
    return { ok: false, reason: isTimeout(thrown) ? 'xcrun simctl이 응답하지 않는다' : 'xcrun simctl을 실행할 수 없다' }
  }
  return { ok: true, developerDir }
}
