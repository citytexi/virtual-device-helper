export interface AdbDeviceEntry {
  serial: string
  /** device | offline | unauthorized | 그 밖에 adb가 뱉는 값. 그대로 보존한다. */
  state: string
  /** `model:` 키가 있으면 그 값. -l 없이 부르면 null. */
  model: string | null
}

const HEADER = 'List of devices attached'

/**
 * `adb devices -l`의 출력을 파싱한다.
 * 데몬 시작 안내(`* daemon ...`)와 빈 줄은 버린다.
 */
export function parseDevices(stdout: string): AdbDeviceEntry[] {
  const entries: AdbDeviceEntry[] = []

  for (const rawLine of stdout.split('\n')) {
    const line = rawLine.trim()
    if (!line) continue
    if (line === HEADER) continue
    if (line.startsWith('*')) continue

    const [serial, state, ...rest] = line.split(/\s+/)
    if (!serial || !state) continue

    const modelToken = rest.find((token) => token.startsWith('model:'))
    entries.push({
      serial,
      state,
      model: modelToken ? modelToken.slice('model:'.length) : null
    })
  }

  return entries
}
