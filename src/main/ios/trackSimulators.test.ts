import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { deviceError } from '../../shared/types/errors'
import type { TrackFailure } from '../adb/trackDevices'
import { trackSimulators } from './trackSimulators'
import { execOk, fakeSimctl } from './testing'

const booting = readFileSync(join(__dirname, '../device/parsers/__fixtures__/ios/simctl-list-devices-booting.json'), 'utf8')
type Fixture = { devices: Record<string, Array<{ udid: string; state: string }>> }
const all = Object.values((JSON.parse(booting) as Fixture).devices).flat()
const bootingUdid = all.find((device) => device.state === 'Booting')!.udid
const bootedUdid = all.find((device) => device.state === 'Booted')!.udid

/** 같은 fixture에서 한 기기의 상태만 바꾼 목록. */
function withState(udid: string, state: string): string {
  const copy = JSON.parse(booting) as Fixture
  for (const device of Object.values(copy.devices).flat()) if (device.udid === udid) device.state = state
  return JSON.stringify(copy)
}

function emptyList(): string {
  return JSON.stringify({ devices: {} })
}

const KEY = 'list devices booted -j'

/** 호출마다 다음 응답을 돌려주는 simctl. 마지막 응답은 반복한다. */
function sequencedSimctl(responses: Array<string | Error>) {
  let index = 0
  const base = fakeSimctl({})
  base.exec = vi.fn(async (args: string[]) => {
    base.calls.push(args)
    expect(args.join(' ')).toBe(KEY)
    const next = responses[Math.min(index++, responses.length - 1)]!
    if (next instanceof Error) throw next
    return execOk(next)
  })
  return base
}

describe('trackSimulators', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  it('ignores Booting and reports Booted once it turns so, then disconnect when it disappears', async () => {
    const simctl = sequencedSimctl([booting, withState(bootingUdid, 'Booted'), withState(bootingUdid, 'Shutdown')])
    const changes: Array<[string, boolean]> = []

    const stop = trackSimulators(simctl, (serial, connected) => changes.push([serial, connected]), () => {}, { intervalMs: 2000 })

    await vi.advanceTimersByTimeAsync(0)
    expect(changes).toEqual([[bootedUdid, true]])

    await vi.advanceTimersByTimeAsync(2000)
    expect(changes).toContainEqual([bootingUdid, true])

    await vi.advanceTimersByTimeAsync(2000)
    expect(changes).toContainEqual([bootingUdid, false])
    expect(changes).not.toContainEqual([bootedUdid, false])
    stop()
  })

  it('reports disconnect when a booted simulator vanishes', async () => {
    const simctl = sequencedSimctl([withState(bootingUdid, 'Booted'), emptyList()])
    const changes: Array<[string, boolean]> = []

    const stop = trackSimulators(simctl, (serial, connected) => changes.push([serial, connected]), () => {})
    await vi.advanceTimersByTimeAsync(2000)

    expect(changes.filter(([, connected]) => !connected).map(([serial]) => serial).sort()).toEqual([bootedUdid, bootingUdid].sort())
    stop()
  })

  it('calls onFailure once after 3 consecutive failures and then stops polling', async () => {
    const simctl = sequencedSimctl([deviceError('command_failed', 'x', 'y')])
    const failures: TrackFailure[] = []

    trackSimulators(simctl, () => {}, (failure) => failures.push(failure), { intervalMs: 2000, maxFailures: 3 })
    await vi.advanceTimersByTimeAsync(20_000)

    expect(failures).toHaveLength(1)
    expect(failures[0]).toMatchObject({ exitCode: null, error: { toolError: { kind: 'command_failed' } } })
    expect(simctl.calls).toHaveLength(3)
  })

  it('resets the failure count after a success', async () => {
    const boom = new Error('boom')
    const simctl = sequencedSimctl([boom, boom, booting, boom, boom, booting])
    const failures: TrackFailure[] = []

    const stop = trackSimulators(simctl, () => {}, (failure) => failures.push(failure), { intervalMs: 2000, maxFailures: 3 })
    await vi.advanceTimersByTimeAsync(10_000)

    expect(failures).toEqual([])
    stop()
  })

  it('stops polling when the returned function is called', async () => {
    const simctl = sequencedSimctl([booting])

    const stop = trackSimulators(simctl, () => {}, () => {})
    await vi.advanceTimersByTimeAsync(0)
    stop()
    const before = simctl.calls.length
    await vi.advanceTimersByTimeAsync(10_000)

    expect(simctl.calls).toHaveLength(before)
  })

  it('keeps polling when onChange throws, and logs the error', async () => {
    const simctl = sequencedSimctl([booting, withState(bootingUdid, 'Booted')])
    const changes: Array<[string, boolean]> = []
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {})
    let thrown = false

    const stop = trackSimulators(
      simctl,
      (serial, connected) => {
        if (!thrown) {
          thrown = true
          throw new Error('구독자 실패')
        }
        changes.push([serial, connected])
      },
      () => {},
      { intervalMs: 2000 }
    )

    await vi.advanceTimersByTimeAsync(0)
    expect(logged).toHaveBeenCalled()

    await vi.advanceTimersByTimeAsync(2000)
    expect(simctl.calls).toHaveLength(2)
    expect(changes).toContainEqual([bootingUdid, true])

    stop()
    logged.mockRestore()
  })
})
