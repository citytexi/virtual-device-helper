import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { parseDevices } from './devices'

const fixture = readFileSync(join(__dirname, '__fixtures__', 'devices-l.txt'), 'utf8')
const emulatorFixture = readFileSync(join(__dirname, '__fixtures__', 'devices-l-emulator.txt'), 'utf8')

describe('parseDevices', () => {
  it('skips the "List of devices attached" header', () => {
    const entries = parseDevices(fixture)

    expect(entries.every((entry) => entry.serial !== 'List')).toBe(true)
  })

  it('reads serial and state from each line', () => {
    const entries = parseDevices('List of devices attached\nemulator-5554          device transport_id:1\n')

    expect(entries).toEqual([{ serial: 'emulator-5554', state: 'device', model: null }])
  })

  it('reads the model key when present', () => {
    const entries = parseDevices(
      'List of devices attached\nemulator-5554  device product:sdk_gphone64_arm64 model:sdk_gphone64_arm64 device:emu64a\n'
    )

    expect(entries[0]?.model).toBe('sdk_gphone64_arm64')
  })

  it('keeps non-device states so callers can tell offline from absent', () => {
    const entries = parseDevices('List of devices attached\nemulator-5556  offline transport_id:2\n')

    expect(entries[0]?.state).toBe('offline')
  })

  it('ignores blank lines and daemon startup chatter', () => {
    const entries = parseDevices(
      '* daemon not running; starting now at tcp:5037\n* daemon started successfully\nList of devices attached\n\nemulator-5554  device\n\n'
    )

    expect(entries).toEqual([{ serial: 'emulator-5554', state: 'device', model: null }])
  })

  it('returns an empty array when nothing is attached', () => {
    expect(parseDevices('List of devices attached\n\n')).toEqual([])
  })

  it('parses the recorded fixture without throwing', () => {
    expect(() => parseDevices(fixture)).not.toThrow()
  })

  it('parses the real device fixture into the attached physical device', () => {
    const entries = parseDevices(fixture)

    expect(entries).toEqual([{ serial: 'RFCXC00V8AZ', state: 'device', model: 'SM_A356N' }])
  })

  it('parses the real emulator fixture into a device entry in state "device"', () => {
    const entries = parseDevices(emulatorFixture)
    const emulator = entries.find((entry) => entry.serial === 'emulator-5554')

    expect(emulator).toBeDefined()
    expect(emulator?.state).toBe('device')
  })
})
