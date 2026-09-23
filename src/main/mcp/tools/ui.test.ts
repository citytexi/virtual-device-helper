import { describe, expect, it, vi } from 'vitest'
import type { AvdController } from '../../device/avdController'
import type { DeviceRegistry } from '../../device/registry'
import type { Device } from '../../../shared/types/device'
import { deviceError } from '../../../shared/types/errors'
import { createToolHarness } from '../testHarness'

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

describe('ui_tap', () => {
  it('taps the given coordinates', async () => {
    const tap = vi.fn(async () => {})
    const harness = await harnessFor({ tap })

    await harness.call('ui_tap', { x: 540, y: 930 })

    expect(tap).toHaveBeenCalledWith(540, 930)

    await harness.close()
  })

  it('rejects a call missing a coordinate rather than guessing', async () => {
    const harness = await harnessFor({ tap: vi.fn(async () => {}) })

    // 스키마 검증 실패는 예외가 아니라 isError: true인 구조화된 결과로 온다 —
    // MCP SDK 1.30.0의 McpServer가 검증 에러를 내부에서 잡아 CallToolResult로
    // 바꾸기 때문에 JSON-RPC 요청 자체는 성공으로 끝난다.
    const result = await harness.raw('ui_tap', { x: 540 })
    expect(result.isError).toBe(true)

    await harness.close()
  })
})

describe('ui_swipe', () => {
  it('passes all five arguments in order', async () => {
    const swipe = vi.fn(async () => {})
    const harness = await harnessFor({ swipe })

    await harness.call('ui_swipe', { x1: 100, y1: 1800, x2: 100, y2: 400, durationMs: 300 })

    expect(swipe).toHaveBeenCalledWith(100, 1800, 100, 400, 300)

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

    // 위 ui_tap 테스트와 같은 이유로 isError: true인 구조화된 결과를 기대한다.
    const result = await harness.raw('ui_key', { name: 'volume_up' })
    expect(result.isError).toBe(true)

    await harness.close()
  })
})
