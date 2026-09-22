import { describe, expect, it, vi } from 'vitest'
import type { AdbClient, AdbStream } from './adbClient'
import { trackDevices } from './trackDevices'

function fakeClient(): { client: AdbClient; emit: (line: string) => void; closed: () => boolean } {
  let lineCallback: ((line: string) => void) | undefined
  let closed = false
  const stream: AdbStream = {
    onLine: (callback) => {
      lineCallback = callback
    },
    onClose: () => {},
    close: () => {
      closed = true
    }
  }
  return {
    client: { exec: vi.fn(), stream: () => stream } as unknown as AdbClient,
    emit: (line) => lineCallback?.(line),
    closed: () => closed
  }
}

describe('trackDevices', () => {
  it('reports a device as connected when it appears in device state', () => {
    const fake = fakeClient()
    const changes: Array<{ serial: string; connected: boolean }> = []

    trackDevices(fake.client, (serial, connected) => changes.push({ serial, connected }))
    fake.emit('emulator-5554\tdevice')

    expect(changes).toEqual([{ serial: 'emulator-5554', connected: true }])
  })

  it('treats offline and unauthorized states as not connected', () => {
    const fake = fakeClient()
    const changes: Array<{ serial: string; connected: boolean }> = []

    trackDevices(fake.client, (serial, connected) => changes.push({ serial, connected }))
    fake.emit('emulator-5554\tdevice')
    fake.emit('emulator-5554\toffline')

    expect(changes).toEqual([
      { serial: 'emulator-5554', connected: true },
      { serial: 'emulator-5554', connected: false }
    ])
  })

  it('does not repeat a change when the state is unchanged', () => {
    const fake = fakeClient()
    const changes: string[] = []

    trackDevices(fake.client, (serial) => changes.push(serial))
    fake.emit('emulator-5554\tdevice')
    fake.emit('emulator-5554\tdevice')

    expect(changes).toEqual(['emulator-5554'])
  })

  it('ignores blank lines', () => {
    const fake = fakeClient()
    const changes: string[] = []

    trackDevices(fake.client, (serial) => changes.push(serial))
    fake.emit('')
    fake.emit('   ')

    expect(changes).toEqual([])
  })

  it('closes the underlying stream when stopped', () => {
    const fake = fakeClient()
    const stop = trackDevices(fake.client, () => {})

    stop()

    expect(fake.closed()).toBe(true)
  })
})
