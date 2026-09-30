/**
 * `simctl spawn <udid> launchctl list` 출력에서 실행 중인 앱을 뽑는다.
 * 탭 구분 `pid  status  label`이고, 앱은 `UIKitApplication:<bundle id>[...]` 라벨이다.
 * pid가 `-`인 줄(떠 있지 않은 서비스)과 앱이 아닌 라벨은 버린다.
 */
export function parseLaunchctlList(stdout: string): Array<{ pid: number; bundleId: string }> {
  const apps: Array<{ pid: number; bundleId: string }> = []

  for (const line of stdout.split('\n')) {
    const columns = line.split('\t')
    if (columns.length < 3) continue

    const pid = columns[0]!.trim()
    if (!/^\d+$/.test(pid)) continue

    const match = /^UIKitApplication:([^[\s]+)/.exec(columns[2]!.trim())
    if (!match) continue

    apps.push({ pid: Number(pid), bundleId: match[1] as string })
  }

  return apps
}
