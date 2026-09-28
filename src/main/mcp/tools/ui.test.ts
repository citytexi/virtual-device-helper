import { describe, expect, it, vi } from 'vitest'
import type { AvdController } from '../../device/avdController'
import type { DeviceRegistry } from '../../device/registry'
import type { Device, DisplayFrame, UiDump, UiNode } from '../../../shared/types/device'
import { deviceError } from '../../../shared/types/errors'
import { createToolHarness } from '../testHarness'

const frame: DisplayFrame = { width: 1080, height: 2400 }

function node(overrides: Partial<UiNode> = {}): UiNode {
  return {
    index: 0,
    parentIndex: null,
    text: null,
    contentDesc: null,
    resourceId: null,
    className: 'View',
    bounds: { x: 0, y: 0, w: 0.1, h: 0.1 },
    clickable: false,
    enabled: true,
    focused: false,
    scrollable: false,
    ...overrides
  }
}

function dump(nodes: UiNode[]): UiDump {
  return { nodes, frame }
}

function harnessFor(device: Partial<Device>) {
  const full = { serial: 'emulator-5554', displayFrame: async () => frame, ...device } as Device
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

describe('ui_find refs', () => {
  it('ui_find returns refs of one generation with parentRef', async () => {
    const harness = await harnessFor({
      dumpUi: async () =>
        dump([
          node({ index: 0, className: 'View', resourceId: 'container' }),
          node({
            index: 1,
            parentIndex: 0,
            className: 'Button',
            resourceId: 'login',
            text: '로그인',
            clickable: true
          })
        ])
    })

    const result = (await harness.call('ui_find')) as {
      generation: number
      nodes: Array<{ ref: string; parentRef: string | null }>
    }

    expect(result.nodes[0]?.ref).toBe(`g${result.generation}:0`)
    expect(result.nodes[1]?.parentRef).toBe(`g${result.generation}:0`)
    expect(result.nodes[0]).not.toHaveProperty('x')

    await harness.close()
  })

  it('ui_find keeps dump index in refs after a query filter', async () => {
    const harness = await harnessFor({
      dumpUi: async () =>
        dump([
          node({ index: 0, text: '취소', resourceId: 'cancel' }),
          node({ index: 1, text: '메뉴', resourceId: 'menu' }),
          node({ index: 2, text: '설정', resourceId: 'settings' }),
          node({ index: 3, text: '로그인', resourceId: 'login' })
        ])
    })

    const result = (await harness.call('ui_find', { query: '로그인' })) as {
      generation: number
      nodes: Array<{ ref: string }>
    }

    expect(result.nodes).toHaveLength(1)
    expect(result.nodes[0]?.ref).toBe(`g${result.generation}:3`)

    await harness.close()
  })
})

describe('ui_tap', () => {
  it('ui_tap by coordinates converts through displayFrame', async () => {
    const tap = vi.fn(async () => {})
    const harness = await harnessFor({ tap })

    await harness.call('ui_tap', { x: 0.5, y: 0.25 })

    expect(tap).toHaveBeenCalledWith(540, 600)

    await harness.close()
  })

  it('rejects pixel coordinates from an old client', async () => {
    const tap = vi.fn(async () => {})
    const harness = await harnessFor({ tap })

    expect((await harness.raw('ui_tap', { x: 540, y: 930 })).isError).toBe(true)
    expect(tap).not.toHaveBeenCalled()

    await harness.close()
  })

  it('rejects a call missing one coordinate rather than guessing', async () => {
    const tap = vi.fn(async () => {})
    const harness = await harnessFor({ tap })

    expect((await harness.raw('ui_tap', { x: 0.5 })).isError).toBe(true)
    expect(tap).not.toHaveBeenCalled()

    await harness.close()
  })

  it('rejects both ref and coordinates, and neither', async () => {
    const harness = await harnessFor({ tap: vi.fn(async () => {}) })

    expect((await harness.raw('ui_tap', { ref: 'g1:0', x: 0.5, y: 0.5 })).isError).toBe(true)
    expect((await harness.raw('ui_tap', {})).isError).toBe(true)

    await harness.close()
  })

  it('ui_tap by ref taps the fresh center and records a normalized gesture', async () => {
    const tap = vi.fn(async () => {})
    const dumpUi = vi
      .fn()
      .mockResolvedValueOnce(
        dump([
          node({ index: 0, text: '취소', resourceId: 'cancel', className: 'Button' }),
          node({
            index: 1,
            text: '로그인',
            resourceId: 'login',
            className: 'Button',
            bounds: { x: 0.1, y: 0.4, w: 0.2, h: 0.1 },
            clickable: true
          })
        ])
      )
      .mockResolvedValueOnce(
        // 재검증 덤프: login이 이동했다.
        dump([
          node({
            index: 0,
            text: '로그인',
            resourceId: 'login',
            className: 'Button',
            bounds: { x: 0.2, y: 0.5, w: 0.2, h: 0.1 },
            clickable: true
          })
        ])
      )
    const harness = await harnessFor({ tap, dumpUi })

    const { generation } = (await harness.call('ui_find')) as { generation: number }
    await harness.call('ui_tap', { ref: `g${generation}:1` })

    expect(tap).toHaveBeenCalledWith(324, 1320)
    expect(harness.records.at(-1)?.gesture).toEqual({
      kind: 'tap',
      serial: 'emulator-5554',
      x: 0.3,
      y: 0.55
    })

    await harness.close()
  })

  it('ui_tap with a stale ref taps nothing and returns stale_ref', async () => {
    const tap = vi.fn(async () => {})
    const harness = await harnessFor({ tap })

    const error = await harness.callExpectingError('ui_tap', { ref: 'g999999:0' })

    expect(error.kind).toBe('stale_ref')
    expect(tap).not.toHaveBeenCalled()

    await harness.close()
  })

  it('resolves and acts inside one registry.run call', async () => {
    const tap = vi.fn(async () => {})
    const loginDump = dump([
      node({
        index: 0,
        className: 'Button',
        resourceId: 'login',
        bounds: { x: 0.1, y: 0.4, w: 0.2, h: 0.1 },
        clickable: true
      })
    ])
    const full = {
      serial: 'emulator-5554',
      displayFrame: async () => frame,
      tap,
      dumpUi: async () => loginDump
    } as unknown as Device

    let runCalls = 0
    const registry = {
      start: vi.fn(),
      stop: vi.fn(),
      serials: () => ['emulator-5554'],
      resolve: () => full,
      setActive: vi.fn(),
      clearActive: vi.fn(),
      getActive: () => 'emulator-5554',
      run: (_serial: string, task: () => Promise<unknown>) => {
        runCalls += 1
        return task()
      },
      on: () => () => {}
    } as unknown as DeviceRegistry

    const avd = {
      list: async () => [],
      boot: async () => 'emulator-5554',
      shutdown: async () => {}
    } as AvdController

    const harness = await createToolHarness({ registry, avd })

    const { generation } = (await harness.call('ui_find')) as { generation: number }
    runCalls = 0

    await harness.call('ui_tap', { ref: `g${generation}:0` })

    expect(runCalls).toBe(1)

    await harness.close()
  })
})

describe('ui_swipe', () => {
  it('passes all five arguments through coordinates', async () => {
    const swipe = vi.fn(async () => {})
    const harness = await harnessFor({ swipe })

    await harness.call('ui_swipe', { x1: 0.0926, y1: 0.75, x2: 0.0926, y2: 0.1667, durationMs: 300 })

    expect(swipe).toHaveBeenCalledWith(100, 1800, 100, 400, 300)

    await harness.close()
  })

  it('ui_swipe rejects direction without ref and ref with coordinates', async () => {
    const harness = await harnessFor({ swipe: vi.fn(async () => {}) })

    expect((await harness.raw('ui_swipe', { direction: 'down' })).isError).toBe(true)
    expect((await harness.raw('ui_swipe', { ref: 'g1:0', x1: 0.1, y1: 0.1, x2: 0.2, y2: 0.2 })).isError).toBe(true)

    await harness.close()
  })

  it('rejects coordinates without durationMs', async () => {
    const harness = await harnessFor({ swipe: vi.fn(async () => {}) })

    expect((await harness.raw('ui_swipe', { x1: 0.1, y1: 0.1, x2: 0.2, y2: 0.2 })).isError).toBe(true)

    await harness.close()
  })

  it('ui_swipe by ref scrolls inside the node', async () => {
    const swipe = vi.fn(async () => {})
    const scrollableDump = dump([
      node({
        index: 0,
        className: 'RecyclerView',
        resourceId: 'list',
        scrollable: true,
        bounds: { x: 0, y: 0.2, w: 1, h: 0.6 }
      })
    ])
    const harness = await harnessFor({ swipe, dumpUi: async () => scrollableDump })

    const { generation } = (await harness.call('ui_find')) as { generation: number }
    await harness.call('ui_swipe', { ref: `g${generation}:0`, direction: 'down' })

    expect(swipe).toHaveBeenCalledWith(540, 1776, 540, 624, 300)

    await harness.close()
  })
})

describe('ui_text', () => {
  it('sends text to the focused field', async () => {
    const inputText = vi.fn(async () => {})
    const harness = await harnessFor({ inputText })

    await harness.call('ui_text', { text: 'hello@example.com' })

    expect(inputText).toHaveBeenCalledWith('hello@example.com')

    await harness.close()
  })

  it('surfaces the ASCII-only limitation as a structured error', async () => {
    const harness = await harnessFor({
      inputText: async () => {
        throw deviceError('command_failed', 'ASCII 문자만 보낼 수 있다', '다른 방법이 필요하다')
      }
    })

    const error = await harness.callExpectingError('ui_text', { text: '안녕' })
    expect(error.kind).toBe('command_failed')

    await harness.close()
  })

  it('ui_text by ref taps the node center before typing', async () => {
    const order: string[] = []
    const tap = vi.fn(async () => {
      order.push('tap')
    })
    const inputText = vi.fn(async () => {
      order.push('inputText')
    })
    const emailDump = dump([
      node({ index: 0, className: 'EditText', resourceId: 'email', bounds: { x: 0.1, y: 0.3, w: 0.6, h: 0.08 } })
    ])
    const harness = await harnessFor({ tap, inputText, dumpUi: async () => emailDump })

    const { generation } = (await harness.call('ui_find')) as { generation: number }
    await harness.call('ui_text', { ref: `g${generation}:0`, text: 'hello' })

    expect(order).toEqual(['tap', 'inputText'])
    expect(harness.records.at(-1)?.gesture?.kind).toBe('tap')

    await harness.close()
  })
})

describe('ui_key', () => {
  it('accepts the four supported key names', async () => {
    const pressKey = vi.fn(async (_key: string) => {})
    const harness = await harnessFor({ pressKey })

    for (const name of ['back', 'home', 'enter', 'tab']) {
      await harness.call('ui_key', { name })
    }

    expect(pressKey.mock.calls.map((call) => call[0])).toEqual(['back', 'home', 'enter', 'tab'])

    await harness.close()
  })

  it('rejects a key name it does not support', async () => {
    const harness = await harnessFor({ pressKey: vi.fn(async () => {}) })

    const result = await harness.raw('ui_key', { name: 'volume_up' })
    expect(result.isError).toBe(true)

    await harness.close()
  })
})

describe('gesture records', () => {
  it('records a successful tap with its normalized coordinates', async () => {
    const harness = await harnessFor({ tap: vi.fn(async () => {}) })

    await harness.call('ui_tap', { x: 0.5, y: 0.3875 })

    expect(harness.records[0]?.gesture).toEqual({
      kind: 'tap',
      serial: 'emulator-5554',
      x: 0.5,
      y: 0.3875
    })
    await harness.close()
  })

  it('records a successful swipe with both ends', async () => {
    const harness = await harnessFor({ swipe: vi.fn(async () => {}) })

    await harness.call('ui_swipe', { x1: 0.0926, y1: 0.75, x2: 0.0926, y2: 0.1667, durationMs: 300 })

    expect(harness.records[0]?.gesture).toEqual({
      kind: 'swipe',
      serial: 'emulator-5554',
      x1: 0.0926,
      y1: 0.75,
      x2: 0.0926,
      y2: 0.1667
    })
    await harness.close()
  })

  it('records no gesture for a failed tap', async () => {
    const harness = await harnessFor({
      tap: vi.fn(async () => {
        throw deviceError('device_unresponsive', 'timeout', 'retry')
      })
    })

    await harness.callExpectingError('ui_tap', { x: 0.1, y: 0.1 })

    expect(harness.records[0]?.gesture).toBeUndefined()
    await harness.close()
  })

  it('returns the error and taps nothing when displayFrame fails', async () => {
    const tap = vi.fn(async () => {})
    const harness = await harnessFor({
      tap,
      displayFrame: async () => {
        throw deviceError('command_failed', 'wm size 출력에서 화면 크기를 읽지 못했다', 'x')
      }
    })

    const error = await harness.callExpectingError('ui_tap', { x: 0.5, y: 0.5 })

    expect(error.kind).toBe('command_failed')
    expect(tap).not.toHaveBeenCalled()
    await harness.close()
  })
})

describe('inputSchema shape', () => {
  it('keeps ui_tap and ui_swipe as object schemas after superRefine', async () => {
    const harness = await harnessFor({})

    const { tools } = await harness.client.listTools()
    const byName = Object.fromEntries(tools.map((t) => [t.name, t]))

    expect((byName.ui_tap?.inputSchema as { type?: string } | undefined)?.type).toBe('object')
    expect((byName.ui_swipe?.inputSchema as { type?: string } | undefined)?.type).toBe('object')

    await harness.close()
  })
})
