export interface LocateAxeDeps {
  fileExists(path: string): boolean
  /** `PATH`에서 axe를 찾는다. 없으면 null. */
  which(): Promise<string | null>
}

/**
 * 패키징된 앱은 셸 `PATH`를 받지 못하므로 Homebrew 기본 경로 두 곳을 먼저 보고, 그다음 `PATH`를 본다.
 * Apple Silicon(`/opt/homebrew`)이 Intel(`/usr/local`)보다 앞이다.
 */
const KNOWN_PATHS = ['/opt/homebrew/bin/axe', '/usr/local/bin/axe']

export async function locateAxe(deps: LocateAxeDeps): Promise<string | null> {
  for (const path of KNOWN_PATHS) {
    if (deps.fileExists(path)) return path
  }
  return deps.which()
}
