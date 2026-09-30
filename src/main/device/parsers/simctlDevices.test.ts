import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { parseSimctlDevices } from './simctlDevices'

const fixture = (name: string): string => readFileSync(join(__dirname, '__fixtures__', 'ios', name), 'utf8')

describe('parseSimctlDevices', () => {
  const entries = parseSimctlDevices(fixture('simctl-list-devices.json'))

  it('keeps same-named simulators of different runtimes as separate entries', () => {
    const sameName = entries.filter((entry) => entry.name === 'iPhone 17 Pro')
    expect(sameName.length).toBeGreaterThan(1)
    expect(new Set(sameName.map((entry) => entry.udid)).size).toBe(sameName.length)
  })

  it('derives osVersion from the runtime key', () => {
    const entry = entries.find((candidate) => candidate.runtime.endsWith('iOS-26-0'))
    expect(entry?.osVersion).toBe('26.0')
    expect(entries.some((candidate) => candidate.osVersion === '18.2')).toBe(true)
  })

  it('reports the state string as is', () => {
    expect(entries.some((entry) => entry.state === 'Booted')).toBe(true)
    expect(entries.some((entry) => entry.state === 'Shutdown')).toBe(true)
  })

  it('drops non-iOS runtimes and unavailable devices', () => {
    // fixture를 자르지 않고 테스트 안에서 다른 런타임과 사용 불가 항목을 끼워 넣는다.
    const parsed = JSON.parse(fixture('simctl-list-devices.json')) as { devices: Record<string, Array<Record<string, unknown>>> }
    const sample = Object.values(parsed.devices)[0]![0]!
    parsed.devices['com.apple.CoreSimulator.SimRuntime.tvOS-26-0'] = [{ ...sample, udid: 'TV-1' }]
    parsed.devices['com.apple.CoreSimulator.SimRuntime.watchOS-11-0'] = [{ ...sample, udid: 'WATCH-1' }]
    parsed.devices['com.apple.CoreSimulator.SimRuntime.iOS-99-0'] = [{ ...sample, udid: 'GONE-1', isAvailable: false }]

    const result = parseSimctlDevices(JSON.stringify(parsed))

    expect(result.map((entry) => entry.udid)).not.toContain('TV-1')
    expect(result.map((entry) => entry.udid)).not.toContain('WATCH-1')
    expect(result.map((entry) => entry.udid)).not.toContain('GONE-1')
    expect(result.every((entry) => entry.runtime.includes('.iOS-'))).toBe(true)
  })
})
