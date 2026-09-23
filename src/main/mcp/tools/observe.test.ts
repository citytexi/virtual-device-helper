import { describe, expect, it, vi } from 'vitest'
import type { AvdController } from '../../device/avdController'
import type { DeviceRegistry } from '../../device/registry'
import type { Device, LogLine } from '../../../shared/types/device'
import { createToolHarness } from '../testHarness'
import { LOG_READ_DEFAULT_LIMIT, LOG_READ_MAX_LIMIT } from './observe'

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

const line: LogLine = {
  timestamp: '09-22 11:06:21.123',
  level: 'E',
  tag: 'AndroidRuntime',
  pid: 5678,
  message: 'FATAL EXCEPTION: main'
}

describe('screenshot', () => {
  it('returns an image content block, not base64 buried in text', async () => {
    const harness = await harnessFor({
      screenshot: async () => ({ base64: 'QUJD', width: 360, height: 800 })
    })

    const raw = await harness.raw('screenshot')

    expect(raw.content[0]).toEqual({ type: 'image', data: 'QUJD', mimeType: 'image/png' })

    await harness.close()
  })

  it('passes scale through to the device', async () => {
    const screenshot = vi.fn(async () => ({ base64: 'QUJD', width: 1, height: 1 }))
    const harness = await harnessFor({ screenshot })

    await harness.raw('screenshot', { scale: 0.5 })

    expect(screenshot).toHaveBeenCalledWith({ scale: 0.5 })

    await harness.close()
  })

  it('rejects a scale outside the allowed range at the schema level', async () => {
    const harness = await harnessFor({
      screenshot: async () => ({ base64: 'QUJD', width: 1, height: 1 })
    })

    // 스키마 검증 실패는 예외가 아니라 isError: true인 구조화된 결과로 온다 —
    // McpServer가 검증 에러를 내부에서 잡아 CallToolResult로 바꾸기 때문이다.
    const result = await harness.raw('screenshot', { scale: 5 })

    expect(result.isError).toBe(true)
    const first = result.content[0] as { type: string; text?: string }
    expect(first.text).toMatch(/scale/i)

    await harness.close()
  })
})

describe('log_read', () => {
  it('returns parsed lines with the truncation flag', async () => {
    const harness = await harnessFor({
      readLogs: async () => ({ lines: [line], truncated: false, droppedCount: 0 })
    })

    await expect(harness.call('log_read')).resolves.toEqual({
      lines: [line],
      truncated: false,
      droppedCount: 0
    })

    await harness.close()
  })

  it('passes filter, since and limit through', async () => {
    const readLogs = vi.fn(async () => ({ lines: [], truncated: false, droppedCount: 0 }))
    const harness = await harnessFor({ readLogs })

    await harness.call('log_read', { filter: 'AndroidRuntime', since: '09-22 11:00:00.000', limit: 50 })

    expect(readLogs).toHaveBeenCalledWith({
      filter: 'AndroidRuntime',
      since: '09-22 11:00:00.000',
      limit: 50
    })

    await harness.close()
  })

  it('reports truncation so the agent knows to narrow the query', async () => {
    const harness = await harnessFor({
      readLogs: async () => ({ lines: [line], truncated: true, droppedCount: 1800 })
    })

    const payload = (await harness.call('log_read')) as { truncated: boolean; droppedCount: number }

    expect(payload.truncated).toBe(true)
    expect(payload.droppedCount).toBe(1800)

    await harness.close()
  })

  it('rejects a non-positive limit at the schema level', async () => {
    const harness = await harnessFor({
      readLogs: async () => ({ lines: [], truncated: false, droppedCount: 0 })
    })

    const result = await harness.raw('log_read', { limit: 0 })

    expect(result.isError).toBe(true)
    const first = result.content[0] as { type: string; text?: string }
    expect(first.text).toMatch(/limit/i)

    await harness.close()
  })

  it('applies a default limit when the argument is omitted, without being asked to', async () => {
    const readLogs = vi.fn(async () => ({ lines: [], truncated: false, droppedCount: 0 }))
    const harness = await harnessFor({ readLogs })

    await harness.call('log_read')

    expect(readLogs).toHaveBeenCalledWith({ limit: LOG_READ_DEFAULT_LIMIT })

    await harness.close()
  })

  it('rejects a limit above the hard cap at the schema level — the cap cannot be raised by argument', async () => {
    const readLogs = vi.fn(async () => ({ lines: [], truncated: false, droppedCount: 0 }))
    const harness = await harnessFor({ readLogs })

    const result = await harness.raw('log_read', { limit: LOG_READ_MAX_LIMIT + 1 })

    expect(result.isError).toBe(true)
    expect(readLogs).not.toHaveBeenCalled()
    const first = result.content[0] as { type: string; text?: string }
    expect(first.text).toMatch(/limit/i)

    await harness.close()
  })

  it('accepts a limit exactly at the hard cap', async () => {
    const readLogs = vi.fn(async () => ({ lines: [], truncated: false, droppedCount: 0 }))
    const harness = await harnessFor({ readLogs })

    await harness.call('log_read', { limit: LOG_READ_MAX_LIMIT })

    expect(readLogs).toHaveBeenCalledWith({ limit: LOG_READ_MAX_LIMIT })

    await harness.close()
  })
})

describe('log_clear', () => {
  it('clears the log buffer', async () => {
    const clearLogs = vi.fn(async () => {})
    const harness = await harnessFor({ clearLogs })

    await harness.call('log_clear')

    expect(clearLogs).toHaveBeenCalled()

    await harness.close()
  })
})
