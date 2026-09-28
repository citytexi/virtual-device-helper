import { describe, expect, it } from 'vitest'
import { parseDeviceEpoch, clockOffset, toHostEpoch } from './logClock'

const host = (iso: string) => Date.parse(iso)

describe('parseDeviceEpoch', () => {
  it('reads date +%s%3N', () => {
    expect(parseDeviceEpoch('1790000000123\n')).toBe(1790000000123)
  })

  it('returns null for an unexpanded %3N', () => {
    expect(parseDeviceEpoch('1790000000%3N')).toBeNull()
  })

  it('returns null for a nanosecond value', () => {
    expect(parseDeviceEpoch('1790000000123456789')).toBeNull()
  })
})

describe('clockOffset', () => {
  it('takes the round trip midpoint', () => {
    expect(clockOffset(1000, 900, 1200)).toBe(200)
  })
})

describe('toHostEpoch', () => {
  it('adds the offset to a same-year timestamp', () => {
    expect(toHostEpoch('09-28 10:00:00.000', 500, host('2026-09-28T10:00:05'))).toBe(
      host('2026-09-28T10:00:00') + 500
    )
  })

  it('picks last year for a december line seen in january', () => {
    expect(toHostEpoch('12-31 23:59:59.000', 0, host('2027-01-01T00:00:01'))).toBe(
      host('2026-12-31T23:59:59')
    )
  })
})
