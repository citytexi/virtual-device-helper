import { describe, expect, it, vi } from 'vitest'
import { deviceError } from '../../shared/types/errors'
import { runTool } from './runTool'
import type { ToolCallRecord } from './toolContext'

function collector(): { onToolCall: (record: ToolCallRecord) => void; records: ToolCallRecord[] } {
  const records: ToolCallRecord[] = []
  return { onToolCall: (record) => records.push(record), records }
}

describe('runTool success', () => {
  it('wraps the payload as JSON text content', async () => {
    const sink = collector()

    const result = await runTool(sink, 'device_list', { serial: null }, async () => ({ devices: [] }))

    expect(result.isError).toBeUndefined()
    expect(result.content[0]).toEqual({ type: 'text', text: JSON.stringify({ devices: [] }, null, 2) })
  })

  it('passes a pre-built content array straight through', async () => {
    const sink = collector()

    const result = await runTool(sink, 'screenshot', {}, async () => ({
      content: [{ type: 'image' as const, data: 'AAAA', mimeType: 'image/png' }]
    }))

    expect(result.content[0]).toEqual({ type: 'image', data: 'AAAA', mimeType: 'image/png' })
  })

  it('records a successful call with its duration', async () => {
    const sink = collector()

    await runTool(sink, 'ui_tap', { x: 1, y: 2 }, async () => ({ ok: true }))

    expect(sink.records).toHaveLength(1)
    expect(sink.records[0]?.tool).toBe('ui_tap')
    expect(sink.records[0]?.ok).toBe(true)
    expect(sink.records[0]?.durationMs).toBeGreaterThanOrEqual(0)
    expect(sink.records[0]?.errorKind).toBeUndefined()
  })

  it('summarises arguments without dumping large values', async () => {
    const sink = collector()

    await runTool(sink, 'ui_text', { text: 'x'.repeat(500) }, async () => ({ ok: true }))

    expect(sink.records[0]?.argsSummary.length).toBeLessThanOrEqual(120)
  })
})

describe('runTool failure', () => {
  it('turns a DeviceError into a structured error result rather than throwing', async () => {
    const sink = collector()

    const result = await runTool(sink, 'ui_tap', {}, async () => {
      throw deviceError('no_device', '연결된 기기가 없다', 'device_boot로 부팅해라')
    })

    expect(result.isError).toBe(true)
    const payload = JSON.parse((result.content[0] as { text: string }).text) as {
      kind: string
      hint: string
    }
    expect(payload.kind).toBe('no_device')
    expect(payload.hint).toBe('device_boot로 부팅해라')
  })

  it('turns an unexpected error into command_failed instead of leaking a stack trace', async () => {
    const sink = collector()

    const result = await runTool(sink, 'ui_tap', {}, async () => {
      throw new Error('totally unexpected')
    })

    const payload = JSON.parse((result.content[0] as { text: string }).text) as { kind: string }
    expect(payload.kind).toBe('command_failed')
    expect(result.isError).toBe(true)
  })

  it('records the failure with its error kind', async () => {
    const sink = collector()

    await runTool(sink, 'app_launch', { pkg: 'com.example' }, async () => {
      throw deviceError('package_not_found', '없다', '설치해라')
    })

    expect(sink.records[0]?.ok).toBe(false)
    expect(sink.records[0]?.errorKind).toBe('package_not_found')
  })

  it('still records the call when the handler throws synchronously', async () => {
    const sink = collector()

    await runTool(sink, 'ui_tap', {}, () => {
      throw deviceError('no_device', '없다', '부팅해라')
    })

    expect(sink.records).toHaveLength(1)
  })
})
