import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import type { AvdController } from '../../device/avdController'
import type { DeviceRegistry } from '../../device/registry'
import type { Device, LogLine } from '../../../shared/types/device'
import { parseLogcat } from '../../device/parsers/logcat'
import { createToolHarness } from '../testHarness'
import { LOG_READ_DEFAULT_LIMIT, LOG_READ_MAX_LIMIT, LOG_READ_RESPONSE_BUDGET_BYTES } from './observe'

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
  it('returns lines compacted into one string per line, with the truncation flag', async () => {
    const harness = await harnessFor({
      readLogs: async () => ({ lines: [line], truncated: false, droppedCount: 0 })
    })

    await expect(harness.call('log_read')).resolves.toEqual({
      lines: ['09-22 11:06:21.123 E AndroidRuntime(5678): FATAL EXCEPTION: main'],
      truncated: false,
      droppedCount: 0
    })

    await harness.close()
  })

  it('caps a long message with a visible marker instead of letting one line blow the budget', async () => {
    const longMessage = 'x'.repeat(500)
    const harness = await harnessFor({
      readLogs: async () => ({
        lines: [{ ...line, message: longMessage }],
        truncated: false,
        droppedCount: 0
      })
    })

    const payload = (await harness.call('log_read')) as { lines: string[] }

    expect(payload.lines).toHaveLength(1)
    const formatted = payload.lines[0] as string
    expect(formatted).toContain('x'.repeat(300))
    expect(formatted).not.toContain('x'.repeat(301))
    expect(formatted).toMatch(/…\(\+200자\)$/)

    await harness.close()
  })

  it('caps a long message by code points, keeping a surrogate pair intact at the boundary', async () => {
    // 이모지(😀)는 UTF-16으로 서로게이트 쌍 2유닛이지만 코드포인트로는 1개다.
    // 299번째 'a' 다음에 이 이모지를 놓아 자르는 경계(300번째 코드포인트)에 걸치게
    // 만든다 — .length/.slice(UTF-16 기준)로 잘랐다면 이 이모지의 반쪽(단독
    // 서로게이트)만 남아 문자열이 깨졌을 자리다.
    const longMessage = `${'a'.repeat(299)}😀${'b'.repeat(10)}`
    expect(Array.from(longMessage)).toHaveLength(310)

    const harness = await harnessFor({
      readLogs: async () => ({
        lines: [{ ...line, message: longMessage }],
        truncated: false,
        droppedCount: 0
      })
    })

    const payload = (await harness.call('log_read')) as { lines: string[] }

    expect(payload.lines).toHaveLength(1)
    const formatted = payload.lines[0] as string

    // 이모지가 온전히 남아 있어야 한다 — 반쪽 서로게이트가 아니다.
    expect(formatted).toContain(`${'a'.repeat(299)}😀`)
    expect(formatted).not.toContain('b')
    expect(formatted).toMatch(/…\(\+10자\)$/)

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

describe('log_read response size regression', () => {
  it('stays under 25,000 characters at the max limit with realistic long lines', async () => {
    const fixturePath = join(
      __dirname,
      '../../device/parsers/__fixtures__/logcat-threadtime-emulator.txt'
    )
    const fixtureLines = parseLogcat(readFileSync(fixturePath, 'utf8'))
    expect(fixtureLines.length).toBeGreaterThan(0)

    // 실제 픽스처를 필요한 만큼 반복해 최대 줄 수를 채우고, 그중 한 줄은 아주 긴
    // message로 바꿔 넣는다 — 잘림 표식이 없으면 그 한 줄만으로도 예산을 넘길 수 있다.
    const repeated: LogLine[] = []
    while (repeated.length < LOG_READ_MAX_LIMIT) {
      repeated.push(...fixtureLines)
    }
    const lines = repeated.slice(0, LOG_READ_MAX_LIMIT)
    const hugeLineIndex = lines.length - 1
    lines[hugeLineIndex] = { ...(lines[hugeLineIndex] as LogLine), message: 'x'.repeat(5000) }

    const harness = await harnessFor({
      readLogs: async () => ({ lines, truncated: false, droppedCount: 0 })
    })

    const raw = await harness.raw('log_read', { limit: LOG_READ_MAX_LIMIT })
    const text = (raw.content[0] as { text: string }).text

    expect(text.length).toBeLessThan(25_000)

    await harness.close()
  })

  it('stays under the response budget when every line is near its own cap, dropping the oldest lines and merging droppedCount', async () => {
    // 픽스처가 아니라 합성 데이터를 쓴다: 200줄 전부가 2000자짜리 메시지를 담으면
    // 각 줄이 개별 상한(300 코드포인트)까지 잘려도 합치면 여전히 예산을 넘는다
    // (리뷰어 실측: 대략 71,000자). tag에 순번을 담아 남은 줄이 최신(뒤쪽) 것인지
    // 확인한다.
    const lines: LogLine[] = Array.from({ length: LOG_READ_MAX_LIMIT }, (_, i) => ({
      timestamp: '09-22 11:06:21.123',
      level: 'D',
      tag: `Tag${i}`,
      pid: 1000 + i,
      message: 'y'.repeat(2000)
    }))

    // AndroidDevice.readLogs가 이미 상한에 걸려 5줄을 버린 상태(truncated: true,
    // droppedCount: 5)라고 가정한다 — tool 층의 예산 초과 드랍이 이 값 위에 더해져야
    // 한다(요구사항 3: "droppedCount counts both limit-dropped and budget-dropped").
    const deviceDroppedCount = 5
    const harness = await harnessFor({
      readLogs: async () => ({ lines, truncated: true, droppedCount: deviceDroppedCount })
    })

    const raw = await harness.raw('log_read', { limit: LOG_READ_MAX_LIMIT })
    const text = (raw.content[0] as { text: string }).text
    const payload = JSON.parse(text) as { lines: string[]; truncated: boolean; droppedCount: number }

    expect(Buffer.byteLength(text, 'utf8')).toBeLessThanOrEqual(LOG_READ_RESPONSE_BUDGET_BYTES)
    expect(payload.truncated).toBe(true)

    const budgetDroppedCount = LOG_READ_MAX_LIMIT - payload.lines.length
    expect(budgetDroppedCount).toBeGreaterThan(0) // 실제로 예산 때문에 더 버려졌는지 확인
    expect(payload.droppedCount).toBe(deviceDroppedCount + budgetDroppedCount)

    // 남은 줄은 가장 최신(뒤쪽, 큰 인덱스) 것들이어야 한다.
    const firstKeptIndex = LOG_READ_MAX_LIMIT - payload.lines.length
    expect(payload.lines[0]).toContain(`Tag${firstKeptIndex}(`)
    expect(payload.lines[payload.lines.length - 1]).toContain(`Tag${LOG_READ_MAX_LIMIT - 1}(`)

    await harness.close()
  })
})

describe('log_read response budget in UTF-8 bytes', () => {
  it('measures the budget in UTF-8 bytes, so Korean-heavy lines under the budget in characters are still trimmed', async () => {
    // 한글은 UTF-8에서 한 글자가 3바이트다. 클라이언트가 받는 것은 바이트이므로 문자 수로
    // 재면 한글 로그는 예산의 세 배 가까이 새어 나간다. 줄 수와 길이를 골라 문자 수로는
    // 예산 안이지만 바이트로는 예산을 넘는 입력을 만든다.
    const lines: LogLine[] = Array.from({ length: LOG_READ_MAX_LIMIT }, (_, i) => ({
      timestamp: '09-23 10:15:00.000',
      level: 'I',
      tag: `Tag${i}`,
      pid: 2000 + i,
      message: '로그인 화면에서 이메일 입력 칸을 찾지 못했다 다시 시도한다'
    }))
    const untrimmed = JSON.stringify({
      lines: lines.map((line) => `${line.timestamp} ${line.level} ${line.tag}(${line.pid}): ${line.message}`),
      truncated: false,
      droppedCount: 0
    })
    // 전제: 문자 수로는 예산 안, 바이트로는 예산 밖.
    expect(untrimmed.length).toBeLessThanOrEqual(LOG_READ_RESPONSE_BUDGET_BYTES)
    expect(Buffer.byteLength(untrimmed, 'utf8')).toBeGreaterThan(LOG_READ_RESPONSE_BUDGET_BYTES)

    const harness = await harnessFor({
      readLogs: async () => ({ lines, truncated: false, droppedCount: 0 })
    })

    const raw = await harness.raw('log_read', { limit: LOG_READ_MAX_LIMIT })
    const text = (raw.content[0] as { text: string }).text
    const payload = JSON.parse(text) as { lines: string[]; truncated: boolean; droppedCount: number }

    expect(Buffer.byteLength(text, 'utf8')).toBeLessThanOrEqual(LOG_READ_RESPONSE_BUDGET_BYTES)
    expect(payload.truncated).toBe(true)
    expect(payload.lines.length).toBeLessThan(LOG_READ_MAX_LIMIT)
    expect(payload.droppedCount).toBe(LOG_READ_MAX_LIMIT - payload.lines.length)
    expect(payload.lines[payload.lines.length - 1]).toContain(`Tag${LOG_READ_MAX_LIMIT - 1}(`)

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
