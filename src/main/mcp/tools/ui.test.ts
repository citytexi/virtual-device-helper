import { describe, expect, it, vi } from 'vitest'
import type { AvdController } from '../../device/avdController'
import type { DeviceRegistry } from '../../device/registry'
import type { Device, DisplayFrame, UiDump, UiNode } from '../../../shared/types/device'
import { deviceError, type DeviceError } from '../../../shared/types/errors'
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

  it('rounds echoed coordinates to 4 decimals', async () => {
    const tap = vi.fn(async () => {})
    const harness = await harnessFor({ tap })

    const result = (await harness.call('ui_tap', { x: 0.123456, y: 0.5 })) as {
      tapped: { x: number; y: number }
    }

    expect(result.tapped.x).toBe(0.1235)
    expect(harness.records.at(-1)?.gesture).toMatchObject({ x: 0.1235 })

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

  it('rejects a ref call missing direction', async () => {
    const harness = await harnessFor({ swipe: vi.fn(async () => {}) })

    expect((await harness.raw('ui_swipe', { ref: 'g1:0' })).isError).toBe(true)

    await harness.close()
  })

  it('rejects ref combined with an otherwise-complete coordinate set', async () => {
    const harness = await harnessFor({ swipe: vi.fn(async () => {}) })

    // direction까지 포함해 ref 경로 자체는 완전하다 — 유일한 결함이 좌표와의 동시 지정임을 가린다.
    expect(
      (
        await harness.raw('ui_swipe', {
          ref: 'g1:0',
          direction: 'down',
          x1: 0.1,
          y1: 0.1,
          x2: 0.2,
          y2: 0.2
        })
      ).isError
    ).toBe(true)

    await harness.close()
  })

  it('rejects coordinates without durationMs', async () => {
    const harness = await harnessFor({ swipe: vi.fn(async () => {}) })

    expect((await harness.raw('ui_swipe', { x1: 0.1, y1: 0.1, x2: 0.2, y2: 0.2 })).isError).toBe(true)

    await harness.close()
  })

  it('rejects coordinates combined with direction', async () => {
    const swipe = vi.fn(async () => {})
    const harness = await harnessFor({ swipe })

    // 좌표 경로에서는 durationMs까지 채워도 direction이 섞이면 거절한다 — 에이전트가
    // direction이 조용히 무시된 채 좌표대로만 움직였다고 착각하면 안 된다.
    const result = await harness.raw('ui_swipe', {
      x1: 0.1,
      y1: 0.1,
      x2: 0.2,
      y2: 0.2,
      durationMs: 300,
      direction: 'down'
    })

    expect(result.isError).toBe(true)
    expect(swipe).not.toHaveBeenCalled()

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

describe('detail: serial·redact·summarise', () => {
  it('never records typed text in the clear', async () => {
    const harness = await harnessFor({ inputText: vi.fn(async () => {}) })

    await harness.call('ui_text', { text: 'hunter2' })

    expect(JSON.stringify(harness.records)).not.toContain('hunter2')
    expect(harness.records[0]?.detail.args).toContain('<7자 가림>')
    expect(harness.records[0]?.argsSummary).toContain('<7자 가림>')

    await harness.close()
  })

  // 실패 기록 경로 셋. androidDevice.ts `escapeInputText`의 거부, adbClient.ts의 명령 실패,
  // 타임아웃이 각각 원문(또는 adb용으로 이스케이프한 형태)을 message·details에 싣는다.
  const secret = 'my secret#1'
  const escapedSecret = 'my%ssecret\\#1'
  const failurePaths: Array<[string, () => DeviceError]> = [
    [
      'escapeInputText rejection',
      () =>
        deviceError('command_failed', 'adb input text로는 %를 포함한 문자열을 보낼 수 없다', '나눠서 보내라', {
          text: secret
        })
    ],
    [
      'adb command failure',
      () =>
        deviceError('command_failed', `adb 명령이 실패했다: shell input text ${escapedSecret}`, '첨부된 stderr를 확인해라', {
          stderr: `error near ${secret}`,
          args: ['shell', 'input', 'text', escapedSecret]
        })
    ],
    [
      'adb timeout',
      () =>
        deviceError(
          'device_unresponsive',
          `adb 명령이 10000ms 안에 끝나지 않았다: -s emulator-5554 shell input text ${escapedSecret}`,
          '기기 상태를 확인해라',
          { args: ['-s', 'emulator-5554', 'shell', 'input', 'text', escapedSecret], timeoutMs: 10000 }
        )
    ]
  ]

  for (const [name, makeError] of failurePaths) {
    it(`never records typed text in the clear when ui_text fails (${name})`, async () => {
      const original = makeError()
      const harness = await harnessFor({
        inputText: async () => {
          throw original
        }
      })

      const error = (await harness.callExpectingError('ui_text', { text: secret })) as unknown as {
        kind: string
        message: string
      }

      const recorded = JSON.stringify(harness.records)
      expect(recorded).not.toContain(secret)
      expect(recorded).not.toContain(escapedSecret)
      expect(recorded).not.toContain('secret')
      expect(harness.records[0]?.errorKind).toBe(error.kind)
      // 에이전트가 받는 MCP 에러 결과는 그대로다.
      expect(error.message).toBe(original.toolError.message)

      await harness.close()
    })
  }

  it('records the serial of ui_tap', async () => {
    const harness = await harnessFor({ tap: vi.fn(async () => {}) })

    await harness.call('ui_tap', { x: 0.5, y: 0.5 })

    expect(harness.records[0]?.serial).toBe('emulator-5554')

    await harness.close()
  })

  it('summarises ui_find as 노드 N개', async () => {
    const harness = await harnessFor({
      dumpUi: async () =>
        dump([node({ index: 0, text: 'a' }), node({ index: 1, text: 'b' }), node({ index: 2, text: 'c' })])
    })

    await harness.call('ui_find')

    expect(harness.records[0]?.detail.resultSummary).toBe('노드 3개')

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
