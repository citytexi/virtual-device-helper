/**
 * 기기 시계를 재는 `adb shell date` 인자. epoch ms와 기기 tz offset을 한 번에 받는다.
 * `%3N`과 `%z` 사이에 공백을 두지 않는다 — `adb shell`은 인자를 공백으로 이어 붙여 기기 셸이
 * 다시 나누므로, 공백이 있으면 date가 인자 둘을 받고 실패한다.
 */
export const DEVICE_CLOCK_ARGS = ['shell', 'date', '+%s%3N%z']

export interface DeviceClock {
  /** 기기의 epoch ms. */
  epochMs: number
  /** 기기 tz의 UTC 대비 분 단위 offset(`+0900` → 540). `%z`를 못 읽었으면 null. */
  tzOffsetMin: number | null
}

/**
 * `date +%s%3N%z` 출력을 파싱한다. 앞의 13자리 숫자가 epoch ms이고 그 뒤에 숫자가 이어지면
 * 안 된다(ns 값 등). 13자리가 안 되면 null이다. 뒤의 `+HHMM`/`-HHMM`은 tz offset이고,
 * 없거나 형식이 다르면(`%z`가 펼쳐지지 않음 등) tzOffsetMin만 null로 둔다.
 *
 * @param stdout 기기 date 명령의 출력
 * @returns 기기 시계, 또는 null
 */
export function parseDeviceClock(stdout: string): DeviceClock | null {
  const match = /^(\d{13})(?!\d)(.*)$/.exec(stdout.trim())
  if (!match) return null

  const tz = /^([+-])(\d{2})(\d{2})$/.exec(match[2] as string)
  const tzOffsetMin =
    tz === null ? null : (tz[1] === '-' ? -1 : 1) * (Number(tz[2]) * 60 + Number(tz[3]))

  return { epochMs: Number(match[1]), tzOffsetMin }
}

/**
 * 호스트와 기기 간 시계 오프셋을 계산한다.
 * 왕복 시간의 절반을 보정한다.
 *
 * @param hostBefore 기기에 date 명령을 보내기 전 호스트 epoch ms
 * @param deviceEpoch 기기의 epoch ms (date +%s%3N)
 * @param hostAfter 기기 응답을 받은 후 호스트 epoch ms
 * @returns 호스트 - 기기 오프셋 ms
 */
export function clockOffset(hostBefore: number, deviceEpoch: number, hostAfter: number): number {
  const hostMidpoint = (hostBefore + hostAfter) / 2
  return hostMidpoint - deviceEpoch
}

/**
 * logcat timestamp를 호스트 epoch ms로 변환한다.
 *
 * logcat threadtime timestamp는 기기 tz의 벽시계다. tzOffsetMin을 알면 그 tz로 해석하고
 * (UTC 필드에서 offset을 뺀다), 모르면 호스트 tz로 해석한다. 연도는 없으므로 작년·올해·내년 중
 * 변환 결과가 hostNow에 가장 가까운 쪽을 고른다.
 *
 * @param timestamp logcat의 timestamp (MM-DD HH:mm:ss.SSS 형식)
 * @param offsetMs 시계 오프셋 (clockOffset 결과)
 * @param hostNow 호스트 현재 시각 epoch ms
 * @param tzOffsetMin 기기 tz offset(분). null이면 호스트 tz로 해석한다.
 * @returns 호스트 epoch ms
 */
export function toHostEpoch(
  timestamp: string,
  offsetMs: number,
  hostNow: number,
  tzOffsetMin: number | null = null
): number {
  const match = /^(\d{2})-(\d{2})\s(\d{2}):(\d{2}):(\d{2})\.(\d{3})$/.exec(timestamp)
  if (!match) {
    return hostNow
  }

  const month = Number(match[1])
  const day = Number(match[2])
  const hour = Number(match[3])
  const minute = Number(match[4])
  const second = Number(match[5])
  const ms = Number(match[6])

  /** 그 연도로 읽은 기기 timestamp의 epoch ms. */
  function deviceEpochIn(year: number): number {
    if (tzOffsetMin === null) {
      // 호스트 로컬 시간대로 해석 (new Date는 호스트 로컬 시간대 기준)
      return new Date(year, month - 1, day, hour, minute, second, ms).getTime()
    }
    return Date.UTC(year, month - 1, day, hour, minute, second, ms) - tzOffsetMin * 60_000
  }

  // 후보 연도의 기준. 둘 중 무엇을 써도 ±1년 후보가 새해 경계를 덮는다.
  const baseYear = tzOffsetMin === null ? new Date(hostNow).getFullYear() : new Date(hostNow).getUTCFullYear()

  let closest = deviceEpochIn(baseYear) + offsetMs
  for (const year of [baseYear - 1, baseYear + 1]) {
    const candidate = deviceEpochIn(year) + offsetMs
    if (Math.abs(candidate - hostNow) < Math.abs(closest - hostNow)) {
      closest = candidate
    }
  }

  return closest
}
