import { describe, expect, it, vi } from 'vitest'
import type { Device } from '../../shared/types/device'
import type { TrackFailure } from '../adb/trackDevices'
import { createDeviceRegistry, type RegistryEvent } from './registry'

function makeRegistry() {
  let notify: ((serial: string, connected: boolean) => void) | undefined
  let notifyFailure: ((failure: TrackFailure) => void) | undefined
  let stopped = false

  const registry = createDeviceRegistry({
    track: (onChange, onFailure) => {
      notify = onChange
      notifyFailure = onFailure
      return () => {
        stopped = true
      }
    },
    createDevice: (serial) => ({ serial }) as Device
  })

  return {
    registry,
    connect: (serial: string) => notify?.(serial, true),
    disconnect: (serial: string) => notify?.(serial, false),
    fail: (failure: TrackFailure) => notifyFailure?.(failure),
    stopped: () => stopped
  }
}

describe('DeviceRegistry membership', () => {
  it('lists a device once it connects', () => {
    const harness = makeRegistry()
    harness.registry.start()

    harness.connect('emulator-5554')

    expect(harness.registry.serials()).toEqual(['emulator-5554'])
  })

  it('drops a device when it disconnects', () => {
    const harness = makeRegistry()
    harness.registry.start()

    harness.connect('emulator-5554')
    harness.disconnect('emulator-5554')

    expect(harness.registry.serials()).toEqual([])
  })

  it('closes the underlying tracker when stopped', () => {
    const harness = makeRegistry()
    harness.registry.start()

    harness.registry.stop()

    expect(harness.stopped()).toBe(true)
  })
})

describe('DeviceRegistry active device', () => {
  it('makes the first device active automatically', () => {
    const harness = makeRegistry()
    harness.registry.start()

    harness.connect('emulator-5554')

    expect(harness.registry.getActive()).toBe('emulator-5554')
  })

  it('does not steal the active slot when a second device appears', () => {
    const harness = makeRegistry()
    harness.registry.start()

    harness.connect('emulator-5554')
    harness.connect('emulator-5556')

    expect(harness.registry.getActive()).toBe('emulator-5554')
  })

  it('falls back to the only remaining device when the active one disappears', () => {
    const harness = makeRegistry()
    harness.registry.start()

    harness.connect('emulator-5554')
    harness.connect('emulator-5556')
    harness.disconnect('emulator-5554')

    expect(harness.registry.getActive()).toBe('emulator-5556')
  })

  it('clears the active slot when the last device disappears', () => {
    const harness = makeRegistry()
    harness.registry.start()

    harness.connect('emulator-5554')
    harness.disconnect('emulator-5554')

    expect(harness.registry.getActive()).toBeNull()
  })

  it('rejects setActive for a serial it does not know', () => {
    const harness = makeRegistry()
    harness.registry.start()

    expect(() => harness.registry.setActive('emulator-9999')).toThrowError(
      expect.objectContaining({ toolError: expect.objectContaining({ kind: 'no_device' }) })
    )
  })
})

describe('DeviceRegistry.resolve', () => {
  it('returns the named device when a serial is given', () => {
    const harness = makeRegistry()
    harness.registry.start()
    harness.connect('emulator-5554')

    expect(harness.registry.resolve('emulator-5554').serial).toBe('emulator-5554')
  })

  it('returns the active device when no serial is given', () => {
    const harness = makeRegistry()
    harness.registry.start()
    harness.connect('emulator-5554')

    expect(harness.registry.resolve().serial).toBe('emulator-5554')
  })

  it('throws no_device when nothing is attached', () => {
    const harness = makeRegistry()
    harness.registry.start()

    expect(() => harness.registry.resolve()).toThrowError(
      expect.objectContaining({ toolError: expect.objectContaining({ kind: 'no_device' }) })
    )
  })

  it('throws ambiguous_device with the candidate list when the active slot is empty', () => {
    const harness = makeRegistry()
    harness.registry.start()
    harness.connect('emulator-5554')
    harness.connect('emulator-5556')
    harness.disconnect('emulator-5554')
    harness.connect('emulator-5558')
    harness.registry.clearActive()

    const error = (() => {
      try {
        harness.registry.resolve()
        return null
      } catch (thrown) {
        return thrown as { toolError: { kind: string; details?: Record<string, unknown> } }
      }
    })()

    expect(error?.toolError.kind).toBe('ambiguous_device')
    expect(error?.toolError.details?.candidates).toEqual(['emulator-5556', 'emulator-5558'])
  })
})

describe('DeviceRegistry.run', () => {
  it('runs commands for one device strictly in order', async () => {
    const harness = makeRegistry()
    harness.registry.start()
    harness.connect('emulator-5554')

    const order: string[] = []
    const slow = harness.registry.run('emulator-5554', async () => {
      await new Promise((resolve) => setTimeout(resolve, 20))
      order.push('slow')
    })
    const fast = harness.registry.run('emulator-5554', async () => {
      order.push('fast')
    })

    await Promise.all([slow, fast])

    expect(order).toEqual(['slow', 'fast'])
  })

  it('keeps the queue alive after a command throws', async () => {
    const harness = makeRegistry()
    harness.registry.start()
    harness.connect('emulator-5554')

    await expect(
      harness.registry.run('emulator-5554', async () => {
        throw new Error('boom')
      })
    ).rejects.toThrow('boom')

    await expect(harness.registry.run('emulator-5554', async () => 'ok')).resolves.toBe('ok')
  })

  it('lets different devices run at the same time', async () => {
    const harness = makeRegistry()
    harness.registry.start()
    harness.connect('emulator-5554')
    harness.connect('emulator-5556')

    const order: string[] = []
    const slow = harness.registry.run('emulator-5554', async () => {
      await new Promise((resolve) => setTimeout(resolve, 20))
      order.push('slow')
    })
    const fast = harness.registry.run('emulator-5556', async () => {
      order.push('fast')
    })

    await Promise.all([slow, fast])

    expect(order).toEqual(['fast', 'slow'])
  })
})

describe('DeviceRegistry events', () => {
  it('emits connect, disconnect and active changes to listeners', () => {
    const harness = makeRegistry()
    const events: RegistryEvent[] = []
    harness.registry.on((event) => events.push(event))
    harness.registry.start()

    harness.connect('emulator-5554')
    harness.disconnect('emulator-5554')

    expect(events).toEqual([
      { type: 'device_connected', serial: 'emulator-5554' },
      { type: 'active_changed', serial: 'emulator-5554' },
      { type: 'device_disconnected', serial: 'emulator-5554' },
      { type: 'active_changed', serial: null }
    ])
  })

  it('stops delivering events after the listener unsubscribes', () => {
    const harness = makeRegistry()
    const events: RegistryEvent[] = []
    const off = harness.registry.on((event) => events.push(event))
    harness.registry.start()

    off()
    harness.connect('emulator-5554')

    expect(events).toEqual([])
  })
})

// M1-1에서 넘어온 항목 3: trackDevices가 (client, onChange, onFailure?)로 넓어졌으므로
// DeviceRegistryDeps.track도 실패를 받아 이벤트로 올려야 한다. 조용히 삼키면 "기기가
// 안 보인다"는 증상만 남고 원인(추적이 죽었다는 사실)이 사라진다.
describe('DeviceRegistry tracking failure', () => {
  it('surfaces a tracking failure to listeners as an event instead of dropping it', () => {
    const harness = makeRegistry()
    const events: RegistryEvent[] = []
    harness.registry.on((event) => events.push(event))
    harness.registry.start()

    const failure: TrackFailure = { error: null, exitCode: 1 }
    harness.fail(failure)

    expect(events).toEqual([{ type: 'tracking_failed', failure }])
  })

  it('keeps the existing device list intact when tracking fails', () => {
    const harness = makeRegistry()
    harness.registry.start()
    harness.connect('emulator-5554')

    harness.fail({ error: null, exitCode: 1 })

    expect(harness.registry.serials()).toEqual(['emulator-5554'])
  })
})
