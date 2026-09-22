import { describe, expect, it, vi } from 'vitest'
import type { AvdController } from '../../device/avdController'
import type { DeviceRegistry } from '../../device/registry'
import type { Device, UiNode } from '../../../shared/types/device'
import { createToolHarness } from '../testHarness'
import { UI_FIND_MAX_NODES } from './ui'
import { waitForSettle } from './app'

function node(overrides: Partial<UiNode> = {}): UiNode {
  return {
    index: 0,
    text: '로그인',
    contentDesc: null,
    resourceId: 'login',
    className: 'Button',
    x: 540,
    y: 930,
    clickable: true,
    ...overrides
  }
}

function harnessFor(device: Partial<Device>) {
  const full = { serial: 'emulator-5554', ...device } as Device
  const registry = {
    start: vi.fn(),
    stop: vi.fn(),
    serials: () => ['emulator-5554'],
    resolve: () => full,
    setActive: vi.fn(),
    clearActive: vi.fn(),
    getActive: () => 'emulator-5554',
    run: (_serial: string, task: () => Promise<unknown>) => task(),
    on: () => () => {}
  } as unknown as DeviceRegistry

  const avd = {
    list: async () => [],
    boot: async () => 'emulator-5554',
    shutdown: async () => {}
  } as AvdController

  return createToolHarness({ registry, avd })
}

describe('ui_find', () => {
  it('returns summarised nodes ready to feed into ui_tap', async () => {
    const harness = await harnessFor({ dumpUi: async () => [node()] })

    const payload = (await harness.call('ui_find')) as { nodes: UiNode[]; truncated: boolean }

    expect(payload.nodes).toEqual([node()])
    expect(payload.truncated).toBe(false)

    await harness.close()
  })

  it('filters by query, case-insensitively, across text and resourceId', async () => {
    const harness = await harnessFor({
      dumpUi: async () => [
        node({ index: 0, text: '로그인', resourceId: 'login' }),
        node({ index: 1, text: '취소', resourceId: 'cancel' })
      ]
    })

    const payload = (await harness.call('ui_find', { query: 'CANCEL' })) as { nodes: UiNode[] }

    expect(payload.nodes.map((n) => n.resourceId)).toEqual(['cancel'])

    await harness.close()
  })

  it('caps the node count and says so instead of dumping everything', async () => {
    const many = Array.from({ length: UI_FIND_MAX_NODES + 20 }, (_, i) =>
      node({ index: i, text: `item ${i}`, resourceId: `item${i}` })
    )
    const harness = await harnessFor({ dumpUi: async () => many })

    const payload = (await harness.call('ui_find')) as {
      nodes: UiNode[]
      truncated: boolean
      droppedCount: number
    }

    expect(payload.nodes).toHaveLength(UI_FIND_MAX_NODES)
    expect(payload.truncated).toBe(true)
    expect(payload.droppedCount).toBe(20)

    await harness.close()
  })

  it('renumbers the returned nodes from zero after filtering', async () => {
    const harness = await harnessFor({
      dumpUi: async () => [
        node({ index: 0, text: '취소', resourceId: 'cancel' }),
        node({ index: 1, text: '로그인', resourceId: 'login' })
      ]
    })

    const payload = (await harness.call('ui_find', { query: '로그인' })) as { nodes: UiNode[] }

    expect(payload.nodes[0]?.index).toBe(0)

    await harness.close()
  })

  it('never returns raw XML', async () => {
    const harness = await harnessFor({ dumpUi: async () => [node()] })

    const raw = await harness.raw('ui_find')
    const text = (raw.content[0] as { text: string }).text

    expect(text).not.toContain('<node')
    expect(text).not.toContain('<hierarchy')

    await harness.close()
  })
})

describe('app_reset_and_launch', () => {
  it('stops, clears, launches and then waits for the screen to settle', async () => {
    const order: string[] = []
    const harness = await harnessFor({
      stop: async () => {
        order.push('stop')
      },
      clearData: async () => {
        order.push('clear')
      },
      launch: async () => {
        order.push('launch')
      },
      dumpUi: async () => {
        order.push('dump')
        return [node()]
      }
    })

    await harness.call('app_reset_and_launch', { pkg: 'com.example.app' })

    expect(order.slice(0, 3)).toEqual(['stop', 'clear', 'launch'])
    expect(order).toContain('dump')

    await harness.close()
  })

  it('reports how many nodes the first stable screen had', async () => {
    const harness = await harnessFor({
      stop: async () => {},
      clearData: async () => {},
      launch: async () => {},
      dumpUi: async () => [node(), node({ index: 1, resourceId: 'cancel' })]
    })

    const payload = (await harness.call('app_reset_and_launch', { pkg: 'com.example.app' })) as {
      pkg: string
      settled: boolean
      nodeCount: number
    }

    expect(payload.pkg).toBe('com.example.app')
    expect(payload.settled).toBe(true)
    expect(payload.nodeCount).toBe(2)

    await harness.close()
  })

})

// app_reset_and_launch는 settleTimeoutMs를 툴 인자로 노출하지 않는다 (공개 인터페이스는
// pkg, serial? 뿐이다). 짧은 타임아웃을 주입해야 하는 시나리오는 waitForSettle을 직접
// 단위 테스트한다 — 함수 자체는 여전히 타임아웃을 파라미터로 받는다.
describe('waitForSettle', () => {
  it('reports settled false rather than never returning when the screen keeps changing', async () => {
    let call = 0
    const result = await waitForSettle(
      async () => {
        call += 1
        return Array.from({ length: call }, (_, i) => node({ index: i, resourceId: `n${call}-${i}` }))
      },
      100,
      (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
      () => Date.now()
    )

    expect(result.settled).toBe(false)
  })

  it('does not report settled from a single dump, even when that dump is empty', async () => {
    let calls = 0
    const result = await waitForSettle(
      async () => {
        calls += 1
        return []
      },
      50,
      (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
      () => Date.now()
    )

    // timeoutMs(50)가 폴링 간격(400ms)보다 짧으므로 덤프는 정확히 한 번만 일어난다.
    // 그 한 번만으로 settled: true가 나오면 previous의 초기값을 빈 문자열과
    // 혼동한 것이다 — 빈 배열의 지문도 빈 문자열이기 때문이다.
    expect(calls).toBe(1)
    expect(result).toEqual({ settled: false, nodeCount: 0 })
  })

  it('settles once two consecutive empty dumps agree', async () => {
    let calls = 0
    const result = await waitForSettle(
      async () => {
        calls += 1
        return []
      },
      1000,
      (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
      () => Date.now()
    )

    expect(calls).toBe(2)
    expect(result).toEqual({ settled: true, nodeCount: 0 })
  })
})
