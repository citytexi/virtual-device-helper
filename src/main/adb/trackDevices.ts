import type { AdbClient } from './adbClient'

export type DeviceChange = (serial: string, connected: boolean) => void

/**
 * `adb track-devices`를 붙잡고 기기 연결·해제를 알린다.
 * 폴링 대신 쓰는 이유는 부팅 완료 시점을 늦지 않게 잡기 위해서다.
 * 같은 상태가 반복되면 알리지 않는다.
 */
export function trackDevices(client: AdbClient, onChange: DeviceChange): () => void {
  const stream = client.stream(null, ['track-devices'])
  const lastState = new Map<string, boolean>()

  stream.onLine((line) => {
    const trimmed = line.trim()
    if (!trimmed) return

    const [serial, state] = trimmed.split(/\s+/)
    if (!serial || !state) return

    const connected = state === 'device'
    if (lastState.get(serial) === connected) return

    lastState.set(serial, connected)
    onChange(serial, connected)
  })

  return () => stream.close()
}
