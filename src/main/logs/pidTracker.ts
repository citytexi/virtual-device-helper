import type { LogLine } from '../../shared/types/device'

/** ActivityManager의 'Start proc <pid>:<프로세스명>/<uid> for ...' 줄에서 pid와 프로세스명을 뽑는다. */
const START_PROC_RE = /^Start proc (\d+):([^/\s]+)\//

/**
 * 프로세스명에서 패키지명을 뽑는다. 첫 `:` 앞부분이 패키지명이다.
 * 예: `com.android.chrome:sandboxed_process0:...` → `com.android.chrome`
 */
export function packageFromProcessName(name: string): string {
  const idx = name.indexOf(':')
  return idx === -1 ? name : name.slice(0, idx)
}

/**
 * 연결 동안의 pid→패키지 맵과 패키지→pid 기록.
 * 죽은 pid도 기록에 남긴다. 크래시 직후 로그를 pkg로 찾을 때 필요하다.
 */
export interface PidTracker {
  /** `ps -A -o PID,NAME` 출력으로 초기 맵을 채운다. */
  seed(psStdout: string): void
  /** `Start proc` 줄이면 맵을 갱신한다. 이 연결에서 처음 보는 패키지면 true. */
  observe(line: LogLine): boolean
  /** 현재 이 pid의 주인 패키지. */
  packageOf(pid: number): string | undefined
  /** 이 연결 동안 그 패키지가 가졌던 pid 전부. 죽은 pid 포함, first-seen 순서, 중복 없음. */
  pidsOf(pkg: string): number[]
  /** 알려진 패키지명 전부. 정렬됨. */
  packages(): string[]
}

/** pid 기준 현재 소유 패키지. */
type PidMap = Map<number, string>
/** 패키지 기준 지금까지 가졌던 pid 기록(first-seen 순서). */
type PackagePidHistory = Map<string, number[]>

function recordPid(history: PackagePidHistory, pkg: string, pid: number): void {
  const pids = history.get(pkg)
  if (pids === undefined) {
    history.set(pkg, [pid])
    return
  }
  if (!pids.includes(pid)) {
    pids.push(pid)
  }
}

export function createPidTracker(): PidTracker {
  const pidToPackage: PidMap = new Map()
  const packageToPids: PackagePidHistory = new Map()

  function learn(pid: number, pkg: string): void {
    pidToPackage.set(pid, pkg)
    recordPid(packageToPids, pkg, pid)
  }

  function seed(psStdout: string): void {
    const lines = psStdout.split('\n')
    // 첫 줄은 헤더(PID NAME)라 건너뛴다
    for (const raw of lines.slice(1)) {
      const trimmed = raw.trim()
      if (trimmed === '') continue
      const match = /^(\d+)\s+(\S+)$/.exec(trimmed)
      if (!match) continue
      const pid = Number(match[1])
      const name = match[2]!
      // 커널 스레드는 이름이 `[`로 시작한다. 버린다.
      if (name.startsWith('[')) continue
      learn(pid, packageFromProcessName(name))
    }
  }

  function observe(line: LogLine): boolean {
    if (line.tag !== 'ActivityManager') return false
    const match = START_PROC_RE.exec(line.message)
    if (!match) return false
    const pid = Number(match[1])
    const pkg = packageFromProcessName(match[2]!)
    const isNewPackage = !packageToPids.has(pkg)
    learn(pid, pkg)
    return isNewPackage
  }

  function packageOf(pid: number): string | undefined {
    return pidToPackage.get(pid)
  }

  function pidsOf(pkg: string): number[] {
    // 내부 기록을 그대로 넘기면 호출한 쪽이 기록을 바꿀 수 있다. 복사본을 준다.
    return [...(packageToPids.get(pkg) ?? [])]
  }

  function packages(): string[] {
    return Array.from(packageToPids.keys()).sort()
  }

  return { seed, observe, packageOf, pidsOf, packages }
}
