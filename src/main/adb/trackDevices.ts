import type { AdbClient, DeviceError } from './adbClient'

export type DeviceChange = (serial: string, connected: boolean) => void

/** 추적이 끝난 이유. adbClient가 분류해 준 에러가 있으면 그것이 더 정확하다. */
export interface TrackFailure {
  /** adbClient가 분류한 에러. 에러 없이 프로세스가 끝났으면 null. */
  error: DeviceError | null
  /** 프로세스 종료 코드. 에러가 먼저 와서 코드를 알 수 없으면 null. */
  exitCode: number | null
}

export type TrackFailureHandler = (failure: TrackFailure) => void

/** 길이 접두사는 항상 4자리 16진수다. */
const LENGTH_PREFIX_BYTES = 4
const LENGTH_PREFIX_PATTERN = /^[0-9a-fA-F]{4}$/

/**
 * `adb track-devices` 한 판을 serial → state 맵으로 바꾼다.
 * payload가 비어 있으면 붙어 있는 기기가 하나도 없다는 뜻이라 빈 맵이 된다.
 */
function parseSnapshot(payload: string): Map<string, string> {
  const snapshot = new Map<string, string>()
  for (const line of payload.split('\n')) {
    const trimmed = line.trim()
    if (!trimmed) continue
    const [serial, state] = trimmed.split(/\s+/)
    if (!serial || !state) continue
    snapshot.set(serial, state)
  }
  return snapshot
}

/**
 * `adb track-devices`를 붙잡고 기기 연결·해제를 알린다.
 * 폴링 대신 쓰는 이유는 부팅 완료 시점을 늦지 않게 잡기 위해서다.
 *
 * 이 명령의 출력은 줄 단위가 아니라 길이로 프레이밍된다. payload 하나마다
 * 4자리 16진수 길이가 앞에 붙고, 그 payload는 변화분이 아니라 그 순간의 목록
 * 전체다. 기기가 빠지면 offline 줄이 오는 게 아니라 다음 목록에서 그냥
 * 사라지고, 기기가 하나도 없으면 payload는 개행조차 없는 빈 문자열이 된다.
 * 그래서 줄 단위 콜백으로는 연결 해제를 영영 알 수 없고, raw 바이트를 받아
 * 직접 프레임을 끊고 직전 목록과 비교해야 한다.
 */
export function trackDevices(
  client: AdbClient,
  onChange: DeviceChange,
  onFailure?: TrackFailureHandler
): () => void {
  const stream = client.stream(null, ['track-devices'])

  /** 아직 한 프레임을 채우지 못한 바이트들. */
  let pending = Buffer.alloc(0)
  /** 직전 스냅샷. 이번 스냅샷에서 빠진 기기를 찾는 데 쓴다. */
  let previous = new Map<string, string>()
  /** serial별로 마지막에 알린 연결 여부. 같은 상태를 두 번 알리지 않으려고 둔다. */
  const lastReported = new Map<string, boolean>()
  let failureReported = false

  function report(serial: string, connected: boolean): void {
    if (lastReported.get(serial) === connected) return
    lastReported.set(serial, connected)
    onChange(serial, connected)
  }

  function applySnapshot(snapshot: Map<string, string>): void {
    for (const [serial, state] of snapshot) {
      report(serial, state === 'device')
    }
    // 직전 목록에는 있었는데 이번 목록에 없는 기기는 빠진 것이다.
    for (const serial of previous.keys()) {
      if (!snapshot.has(serial)) report(serial, false)
    }
    previous = snapshot
  }

  stream.onData((chunk) => {
    pending = pending.length === 0 ? Buffer.from(chunk) : Buffer.concat([pending, chunk])

    // 한 청크 안에 완성된 프레임이 여럿 들어 있을 수 있으니 더 못 자를 때까지 돈다.
    for (;;) {
      if (pending.length < LENGTH_PREFIX_BYTES) return

      const header = pending.subarray(0, LENGTH_PREFIX_BYTES).toString('ascii')
      if (!LENGTH_PREFIX_PATTERN.test(header)) {
        // adb의 host 프로토콜은 항상 이 모양이라 여기 오면 스트림이
        // track-devices 출력이 아니라는 뜻이다. 어긋난 바이트를 붙들고 있어 봐야
        // 영영 프레임이 안 맞으므로 버리고 나간다. 스트림 자체의 실패는
        // adbClient가 onError·onClose로 따로 알려 준다.
        pending = Buffer.alloc(0)
        return
      }

      const payloadLength = Number.parseInt(header, 16)
      const frameEnd = LENGTH_PREFIX_BYTES + payloadLength
      if (pending.length < frameEnd) return

      const payload = pending.subarray(LENGTH_PREFIX_BYTES, frameEnd).toString('utf8')
      pending = Buffer.from(pending.subarray(frameEnd))
      applySnapshot(parseSnapshot(payload))
    }
  })

  // 추적이 끊기면 기기 목록은 그 자리에서 얼어붙는다. 알리지 않으면 위층은
  // "조용한 것"과 "죽은 것"을 구분할 수 없다. adbClient는 에러 뒤에 close를
  // 이어서 주므로, 더 많은 정보를 담은 먼저 온 쪽만 올려보낸다.
  function reportFailure(failure: TrackFailure): void {
    if (failureReported) return
    failureReported = true
    onFailure?.(failure)
  }

  stream.onError((error) => reportFailure({ error, exitCode: null }))
  stream.onClose((code) => reportFailure({ error: null, exitCode: code }))

  return () => stream.close()
}
