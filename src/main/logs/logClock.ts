/**
 * `date +%s%3N` 출력을 파싱한다. 공백을 뺀 값이 정확히 13자리 숫자여야 한다.
 * 값이 없거나 형식이 잘못되면 null을 돌려준다.
 *
 * @param stdout 기기 date 명령의 출력
 * @returns 밀리초 단위 epoch, 또는 null
 */
export function parseDeviceEpoch(stdout: string): number | null {
  const trimmed = stdout.trim()

  // 정확히 13자리 숫자여야 한다 (ms는 10자리 + 3자리)
  if (!/^\d{13}$/.test(trimmed)) {
    return null
  }

  return Number(trimmed)
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
 * @param timestamp logcat의 timestamp (MM-DD HH:mm:ss.SSS 형식)
 * @param offsetMs 시계 오프셋 (clockOffset 결과)
 * @param hostNow 호스트 현재 시각 epoch ms
 * @returns 호스트 epoch ms
 */
export function toHostEpoch(timestamp: string, offsetMs: number, hostNow: number): number {
  // timestamp에서 월일시분초 파싱
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

  // 호스트 현재 시각에서 년도 구하기
  const hostDate = new Date(hostNow)
  const currentYear = hostDate.getFullYear()

  // 세 가지 후보 시간 생성: 올해, 작년, 내년
  const candidates = [
    { year: currentYear, epochMs: 0 },
    { year: currentYear - 1, epochMs: 0 },
    { year: currentYear + 1, epochMs: 0 }
  ]

  for (const candidate of candidates) {
    // 호스트 로컬 시간대로 해석 (new Date는 호스트 로컬 시간대 기준)
    const date = new Date(candidate.year, month - 1, day, hour, minute, second, ms)
    candidate.epochMs = date.getTime()
  }

  // hostNow에 가장 가까운 후보를 선택
  let closest = candidates[0]!
  let minDiff = Math.abs(closest.epochMs - hostNow)

  for (let i = 1; i < candidates.length; i++) {
    const diff = Math.abs(candidates[i]!.epochMs - hostNow)
    if (diff < minDiff) {
      minDiff = diff
      closest = candidates[i]!
    }
  }

  return closest.epochMs + offsetMs
}
