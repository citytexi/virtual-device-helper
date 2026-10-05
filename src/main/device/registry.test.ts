import { describe, expect, it, vi } from 'vitest'
import type { Device, Platform } from '../../shared/types/device'
import type { TrackFailure } from '../adb/trackDevices'
import { createDeviceRegistry, type RegistryEvent } from './registry'

function makeRegistry() {
  let notify: ((serial: string, connected: boolean, platform: Platform) => void) | undefined
  let notifyFailure: ((platform: Platform, failure: TrackFailure) => void) | undefined
  let stopped = false
  const created: Array<[string, Platform]> = []

  const registry = createDeviceRegistry({
    track: (onChange, onFailure) => {
      notify = onChange
      notifyFailure = onFailure
      return () => {
        stopped = true
      }
    },
    createDevice: (serial, platform) => {
      created.push([serial, platform])
      return { serial, platform } as Device
    }
  })

  return {
    registry,
    created,
    connect: (serial: string, platform: Platform = 'android') => notify?.(serial, true, platform),
    disconnect: (serial: string, platform: Platform = 'android') => notify?.(serial, false, platform),
    fail: (failure: TrackFailure, platform: Platform = 'android') => notifyFailure?.(platform, failure),
    stopped: () => stopped
  }
}

describe('DeviceRegistry membership', () => {
  it('passes the platform reported by track to createDevice', () => {
    const harness = makeRegistry()
    harness.registry.start()

    harness.connect('emulator-5554', 'android')
    harness.connect('UDID-1', 'ios')

    expect(harness.created).toEqual([
      ['emulator-5554', 'android'],
      ['UDID-1', 'ios']
    ])
  })

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
  // 스펙에서 활성 기기는 "명시적으로 고른 기기" 하나만 뜻한다. 기기가 하나뿐일 때
  // 그것이 대상이 되는 것은 resolve()가 늦게 판단하는 일이다. 연결 시점에 활성
  // 슬롯을 채워 버리면 기기가 둘일 때의 ambiguous_device가 도달할 수 없게 된다.
  it('leaves the active slot empty when a device connects on its own', () => {
    const harness = makeRegistry()
    harness.registry.start()

    harness.connect('emulator-5554')

    expect(harness.registry.getActive()).toBeNull()
  })

  it('remembers the device that was chosen explicitly', () => {
    const harness = makeRegistry()
    harness.registry.start()
    harness.connect('emulator-5554')

    harness.registry.setActive('emulator-5554')

    expect(harness.registry.getActive()).toBe('emulator-5554')
  })

  it('does not steal the active slot when a second device appears', () => {
    const harness = makeRegistry()
    harness.registry.start()
    harness.connect('emulator-5554')
    harness.registry.setActive('emulator-5554')

    harness.connect('emulator-5556')

    expect(harness.registry.getActive()).toBe('emulator-5554')
  })

  it('clears the active slot when the chosen device disappears', () => {
    const harness = makeRegistry()
    harness.registry.start()
    harness.connect('emulator-5554')
    harness.connect('emulator-5556')
    harness.registry.setActive('emulator-5554')

    harness.disconnect('emulator-5554')

    expect(harness.registry.getActive()).toBeNull()
  })

  it('clears the active slot when the last device disappears', () => {
    const harness = makeRegistry()
    harness.registry.start()
    harness.connect('emulator-5554')
    harness.registry.setActive('emulator-5554')

    harness.disconnect('emulator-5554')

    expect(harness.registry.getActive()).toBeNull()
  })

  it('forgets the choice when it is cleared', () => {
    const harness = makeRegistry()
    harness.registry.start()
    harness.connect('emulator-5554')
    harness.registry.setActive('emulator-5554')

    harness.registry.clearActive()

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

  it('resolves to the only attached device even though nothing chose it', () => {
    const harness = makeRegistry()
    harness.registry.start()
    harness.connect('emulator-5554')

    expect(harness.registry.resolve().serial).toBe('emulator-5554')
  })

  it('prefers the explicitly chosen device when several are attached', () => {
    const harness = makeRegistry()
    harness.registry.start()
    harness.connect('emulator-5554')
    harness.connect('emulator-5556')
    harness.registry.setActive('emulator-5556')

    expect(harness.registry.resolve().serial).toBe('emulator-5556')
  })

  it('throws no_device when nothing is attached', () => {
    const harness = makeRegistry()
    harness.registry.start()

    expect(() => harness.registry.resolve()).toThrowError(
      expect.objectContaining({ toolError: expect.objectContaining({ kind: 'no_device' }) })
    )
  })

  // 스펙의 완료 조건: "기기가 둘인데 serial을 빼면 후보 목록이 온다."
  // 기기 둘, 아무것도 고르지 않은 상태가 이 에러의 정확한 조건이다.
  it('throws ambiguous_device with the candidate list when two devices are attached and none was chosen', () => {
    const harness = makeRegistry()
    harness.registry.start()
    harness.connect('emulator-5554')
    harness.connect('emulator-5556')

    const error = (() => {
      try {
        harness.registry.resolve()
        return null
      } catch (thrown) {
        return thrown as { toolError: { kind: string; details?: Record<string, unknown> } }
      }
    })()

    expect(error?.toolError.kind).toBe('ambiguous_device')
    expect(error?.toolError.details?.candidates).toEqual(['emulator-5554', 'emulator-5556'])
  })

  it('falls back to the only remaining device after the chosen one disappears', () => {
    const harness = makeRegistry()
    harness.registry.start()
    harness.connect('emulator-5554')
    harness.connect('emulator-5556')
    harness.registry.setActive('emulator-5554')

    harness.disconnect('emulator-5554')

    expect(harness.registry.resolve().serial).toBe('emulator-5556')
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

  it('keeps a task queued for a serial ordered even if that device disconnects and reconnects mid-flight', async () => {
    // 평범한 에뮬레이터 재부팅 시나리오다: 같은 serial로 disconnect 직후
    // reconnect가 온다. run()이 큐 항목을 지운 채 새 체인을 새로 시작하면,
    // 아직 안 끝난 taskA와 뒤이은 taskB가 같은 기기에서 동시에 돈다 —
    // DeviceRegistry가 막으려는 바로 그 상황이다.
    const harness = makeRegistry()
    harness.registry.start()
    harness.connect('emulator-5554')

    let resolveTaskA: (() => void) | undefined
    const order: string[] = []
    const taskA = harness.registry.run('emulator-5554', async () => {
      await new Promise<void>((resolve) => {
        resolveTaskA = resolve
      })
      order.push('taskA')
    })

    harness.disconnect('emulator-5554')
    harness.connect('emulator-5554')

    let taskBStarted = false
    const taskB = harness.registry.run('emulator-5554', async () => {
      taskBStarted = true
      order.push('taskB')
    })

    await new Promise((resolve) => setTimeout(resolve, 10))
    expect(taskBStarted).toBe(false)

    resolveTaskA?.()
    await Promise.all([taskA, taskB])

    expect(order).toEqual(['taskA', 'taskB'])
  })
})

describe('DeviceRegistry events', () => {
  it('emits connect, disconnect and active changes to listeners', () => {
    const harness = makeRegistry()
    const events: RegistryEvent[] = []
    harness.registry.on((event) => events.push(event))
    harness.registry.start()

    harness.connect('emulator-5554')
    harness.registry.setActive('emulator-5554')
    harness.disconnect('emulator-5554')

    expect(events).toEqual([
      { type: 'device_connected', serial: 'emulator-5554' },
      { type: 'active_changed', serial: 'emulator-5554' },
      { type: 'device_disconnected', serial: 'emulator-5554' },
      { type: 'active_changed', serial: null }
    ])
  })

  it('does not announce an active change for a device nobody chose', () => {
    const harness = makeRegistry()
    const events: RegistryEvent[] = []
    harness.registry.on((event) => events.push(event))
    harness.registry.start()

    harness.connect('emulator-5554')
    harness.disconnect('emulator-5554')

    expect(events).toEqual([
      { type: 'device_connected', serial: 'emulator-5554' },
      { type: 'device_disconnected', serial: 'emulator-5554' }
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

    expect(events).toEqual([{ type: 'tracking_failed', platform: 'android', failure }])
  })

  it('어느 플랫폼의 추적이 죽었는지 이벤트에 싣는다', () => {
    const harness = makeRegistry()
    const events: RegistryEvent[] = []
    harness.registry.on((event) => events.push(event))
    harness.registry.start()

    const failure: TrackFailure = { error: null, exitCode: null }
    harness.fail(failure, 'ios')

    expect(events).toEqual([{ type: 'tracking_failed', platform: 'ios', failure }])
  })

  it('keeps the existing device list intact when tracking fails', () => {
    const harness = makeRegistry()
    harness.registry.start()
    harness.connect('emulator-5554')

    harness.fail({ error: null, exitCode: 1 })

    expect(harness.registry.serials()).toEqual(['emulator-5554'])
  })
})

// 부팅 직후 기기는 추적(특히 simctl 폴링)이 아직 못 봤을 수 있다. waitFor는 그 틈을 기다린다.
describe('DeviceRegistry.waitFor', () => {
  it('resolves immediately with a device that is already known', async () => {
    vi.useFakeTimers()
    try {
      const harness = makeRegistry()
      harness.registry.start()
      harness.connect('UDID-1', 'ios')

      await expect(harness.registry.waitFor('UDID-1', 5000)).resolves.toMatchObject({ serial: 'UDID-1' })
      expect(vi.getTimerCount()).toBe(0)
    } finally {
      vi.useRealTimers()
    }
  })

  it('resolves once the serial connects later', async () => {
    vi.useFakeTimers()
    try {
      const harness = makeRegistry()
      harness.registry.start()

      const waiting = harness.registry.waitFor('UDID-1', 5000)
      harness.connect('OTHER', 'ios')
      await vi.advanceTimersByTimeAsync(1000)
      harness.connect('UDID-1', 'ios')

      await expect(waiting).resolves.toMatchObject({ serial: 'UDID-1', platform: 'ios' })
      expect(vi.getTimerCount()).toBe(0)
    } finally {
      vi.useRealTimers()
    }
  })

  it('rejects with device_unresponsive when the serial never connects in time', async () => {
    vi.useFakeTimers()
    try {
      const harness = makeRegistry()
      harness.registry.start()

      const waiting = harness.registry.waitFor('UDID-1', 5000)
      const settled = waiting.catch((error: unknown) => error)
      await vi.advanceTimersByTimeAsync(5000)

      const error = (await settled) as { toolError: { kind: string; details: unknown } }
      expect(error.toolError.kind).toBe('device_unresponsive')
      expect(error.toolError.details).toEqual({ serial: 'UDID-1', timeoutMs: 5000 })
    } finally {
      vi.useRealTimers()
    }
  })

  it('removes its listener and timer on every path', async () => {
    vi.useFakeTimers()
    try {
      const harness = makeRegistry()
      harness.registry.start()
      const unsubscribes: Array<ReturnType<typeof vi.fn>> = []
      const originalOn = harness.registry.on.bind(harness.registry)
      vi.spyOn(harness.registry, 'on').mockImplementation((listener) => {
        const unsubscribe = vi.fn(originalOn(listener))
        unsubscribes.push(unsubscribe)
        return unsubscribe
      })

      // 나중에 연결
      const connected = harness.registry.waitFor('UDID-1', 5000)
      harness.connect('UDID-1', 'ios')
      await connected
      // 시간 초과
      const timedOut = harness.registry.waitFor('UDID-2', 5000).catch(() => undefined)
      await vi.advanceTimersByTimeAsync(5000)
      await timedOut

      expect(unsubscribes).toHaveLength(2)
      for (const unsubscribe of unsubscribes) expect(unsubscribe).toHaveBeenCalledTimes(1)
      expect(vi.getTimerCount()).toBe(0)
    } finally {
      vi.useRealTimers()
    }
  })
})
