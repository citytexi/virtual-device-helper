import { describe, expect, it } from 'vitest'
import { parseDeviceClock, clockOffset, toHostEpoch } from './logClock'

const host = (iso: string) => Date.parse(iso)

describe('parseDeviceClock', () => {
  it('reads date +%s%3N%z into epoch ms and the device tz offset', () => {
    expect(parseDeviceClock('1790000000123+0900\n')).toEqual({ epochMs: 1790000000123, tzOffsetMin: 540 })
  })

  it('reads a negative tz offset', () => {
    expect(parseDeviceClock('1790000000123-0330')).toEqual({ epochMs: 1790000000123, tzOffsetMin: -210 })
  })

  it('keeps the epoch but drops the tz when %z is missing or unexpanded', () => {
    expect(parseDeviceClock('1790000000123\n')).toEqual({ epochMs: 1790000000123, tzOffsetMin: null })
    expect(parseDeviceClock('1790000000123%z')).toEqual({ epochMs: 1790000000123, tzOffsetMin: null })
  })

  it('returns null for an unexpanded %3N', () => {
    expect(parseDeviceClock('1790000000%3N+0900')).toBeNull()
  })

  it('returns null for a nanosecond value', () => {
    expect(parseDeviceClock('1790000000123456789+0900')).toBeNull()
  })
})

describe('clockOffset', () => {
  it('takes the round trip midpoint', () => {
    expect(clockOffset(1000, 900, 1200)).toBe(200)
  })
})

describe('toHostEpoch with a known device tz', () => {
  it('reads a +0000 device timestamp as UTC regardless of the host tz', () => {
    const hostNow = Date.UTC(2026, 8, 28, 10, 0, 5)
    expect(toHostEpoch('09-28 10:00:00.000', 500, hostNow, 0)).toBe(Date.UTC(2026, 8, 28, 10, 0, 0) + 500)
  })

  it('subtracts a +0900 device tz offset', () => {
    const hostNow = Date.UTC(2026, 8, 28, 1, 0, 5)
    expect(toHostEpoch('09-28 10:00:00.000', 0, hostNow, 540)).toBe(Date.UTC(2026, 8, 28, 1, 0, 0))
  })

  it('picks the year nearest the host clock across new year in the device tz', () => {
    // 기기(+0900)에서는 12-31 23:59:59, UTC로는 같은 해 14:59:59다. 호스트는 그 1초 뒤.
    const hostNow = Date.UTC(2026, 11, 31, 15, 0, 0)
    expect(toHostEpoch('12-31 23:59:59.000', 0, hostNow, 540)).toBe(Date.UTC(2026, 11, 31, 14, 59, 59))
  })

  it('picks last year for a december device line seen in january UTC', () => {
    const hostNow = Date.UTC(2027, 0, 1, 0, 0, 1)
    expect(toHostEpoch('12-31 23:59:59.000', 0, hostNow, 0)).toBe(Date.UTC(2026, 11, 31, 23, 59, 59))
  })
})

describe('toHostEpoch without a device tz (host tz fallback)', () => {
  it('adds the offset to a same-year timestamp', () => {
    expect(toHostEpoch('09-28 10:00:00.000', 500, host('2026-09-28T10:00:05'))).toBe(
      host('2026-09-28T10:00:00') + 500
    )
  })

  it('picks last year for a december line seen in january', () => {
    expect(toHostEpoch('12-31 23:59:59.000', 0, host('2027-01-01T00:00:01'), null)).toBe(
      host('2026-12-31T23:59:59')
    )
  })
})
