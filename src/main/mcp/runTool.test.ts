import { describe, expect, it, vi } from 'vitest'
import { deviceError } from '../../shared/types/errors'
import { redactText, runTool } from './runTool'
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
    expect(result.content[0]).toEqual({ type: 'text', text: JSON.stringify({ devices: [] }) })
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

describe('runTool sink isolation', () => {
  it('still returns a success result when the sink throws on a successful call', async () => {
    const sink = {
      onToolCall: () => {
        throw new Error('Object has been destroyed')
      }
    }

    const result = await runTool(sink, 'device_list', {}, async () => ({ devices: [] }))

    expect(result.isError).toBeUndefined()
    expect(result.content[0]).toEqual({ type: 'text', text: JSON.stringify({ devices: [] }) })
  })

  it('still returns the original structured error when the sink throws on a failed call, without rejecting', async () => {
    const sink = {
      onToolCall: () => {
        throw new Error('Object has been destroyed')
      }
    }

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

  it('calls the sink exactly once per invocation, even when the sink throws', async () => {
    let calls = 0
    const sink = {
      onToolCall: () => {
        calls += 1
        throw new Error('Object has been destroyed')
      }
    }

    await runTool(sink, 'device_list', {}, async () => ({ devices: [] }))
    expect(calls).toBe(1)

    calls = 0
    await runTool(sink, 'ui_tap', {}, async () => {
      throw deviceError('no_device', '없다', '부팅해라')
    })
    expect(calls).toBe(1)
  })
})

describe('runTool gesture', () => {
  it('attaches the gesture of a successful call', async () => {
    const sink = collector()
    const gesture = { kind: 'tap' as const, serial: 's', x: 0, y: 0 }

    await runTool(sink, 'ui_tap', {}, async () => ({ ok: true }), {
      gesture: async () => gesture
    })

    expect(sink.records[0]?.gesture).toEqual(gesture)
  })

  it('does not ask for a gesture when the call fails', async () => {
    const sink = collector()
    const gesture = vi.fn(async () => undefined)

    await runTool(sink, 'ui_tap', {}, async () => {
      throw new Error('boom')
    }, { gesture })

    expect(gesture).not.toHaveBeenCalled()
    expect(sink.records[0]?.gesture).toBeUndefined()
  })

  it('keeps the success when building the gesture throws', async () => {
    const sink = collector()

    const result = await runTool(sink, 'ui_tap', {}, async () => ({ ok: true }), {
      gesture: async () => {
        throw new Error('no size')
      }
    })

    expect(result.isError).toBeFalsy()
    expect(sink.records[0]).toMatchObject({ ok: true })
    expect(sink.records[0]?.gesture).toBeUndefined()
  })
})

describe('runTool detail', () => {
  it('records the serial the handler resolved', async () => {
    const sink = collector()

    await runTool(sink, 't', {}, async () => ({}), { serial: () => 'emulator-5554' })

    expect(sink.records[0]?.serial).toBe('emulator-5554')
  })

  it('omits serial when the callback returns undefined or throws', async () => {
    const sink = collector()

    await runTool(sink, 't', {}, async () => ({}), { serial: () => undefined })
    expect(sink.records[0]?.serial).toBeUndefined()

    const sink2 = collector()
    await runTool(sink2, 't', {}, async () => ({}), {
      serial: () => {
        throw new Error('boom')
      }
    })
    expect(sink2.records[0]?.serial).toBeUndefined()
  })

  it('records the full args json in detail', async () => {
    const sink = collector()

    await runTool(sink, 't', { x: 1, y: 2 }, async () => ({}))

    expect(sink.records[0]?.detail.args).toBe(JSON.stringify({ x: 1, y: 2 }))
  })

  it('truncates detail args past 2KB and marks it', async () => {
    const sink = collector()

    await runTool(sink, 't', { q: 'x'.repeat(5000) }, async () => ({}))

    const args = sink.records[0]!.detail.args
    expect(Buffer.byteLength(args)).toBeLessThanOrEqual(2048)
    expect(args.endsWith('…(잘림)')).toBe(true)
  })

  it('applies redact to both argsSummary and detail.args', async () => {
    const sink = collector()
    await runTool(sink, 'ui_text', { text: 'hunter2' }, async () => ({}), {
      redact: (a) => ({ ...(a as object), text: redactText('hunter2') })
    })
    const r = sink.records[0]!
    expect(r.argsSummary).not.toContain('hunter2')
    expect(r.detail.args).toContain('<7자 가림>')
  })

  it('replaces args with <가림 실패> when redact throws', async () => {
    const sink = collector()

    await runTool(sink, 'ui_text', { text: 'hunter2' }, async () => ({}), {
      redact: () => {
        throw new Error('boom')
      }
    })

    const r = sink.records[0]!
    expect(r.argsSummary).toBe('<가림 실패>')
    expect(r.detail.args).toBe('<가림 실패>')
  })

  it('stores the ToolError in detail on failure', async () => {
    const sink = collector()

    await runTool(sink, 'app_launch', {}, async () => {
      throw deviceError('package_not_found', '없다', '설치해라')
    })

    expect(sink.records[0]?.detail.error).toEqual({
      kind: 'package_not_found',
      message: '없다',
      hint: '설치해라'
    })
  })

  it('replaces oversized error details with a truncated string field', async () => {
    const sink = collector()

    await runTool(sink, 'app_launch', {}, async () => {
      throw deviceError('command_failed', '실패', '다시 시도해라', { stderr: 'x'.repeat(5000) })
    })

    const error = sink.records[0]!.detail.error!
    expect(typeof error.details?.truncated).toBe('string')
    expect((error.details!.truncated as string).endsWith('…(잘림)')).toBe(true)
    expect(Buffer.byteLength(error.details!.truncated as string)).toBeLessThanOrEqual(2048)
  })

  it('records without detail.args when the args cannot be serialized', async () => {
    const sink = collector()
    const args: Record<string, unknown> = {}
    args.self = args

    const result = await runTool(sink, 't', args, async () => ({ ok: true }))

    expect(result.isError).toBeFalsy()
    expect(sink.records[0]?.detail.args).toBe('<직렬화 실패>')
  })

  it('stores a result summary on success and none when summarise throws', async () => {
    const sink = collector()
    await runTool(sink, 't', {}, async () => ({ n: 3 }), {
      summarise: (payload) => `n=${(payload as { n: number }).n}`
    })
    expect(sink.records[0]?.detail.resultSummary).toBe('n=3')

    const sink2 = collector()
    await runTool(sink2, 't', {}, async () => ({ n: 3 }), {
      summarise: () => {
        throw new Error('boom')
      }
    })
    expect(sink2.records[0]?.detail.resultSummary).toBeUndefined()
  })

  it('keeps the tool result unchanged when serial or summarise throws', async () => {
    const sink = collector()

    const result = await runTool(sink, 't', {}, async () => ({ ok: true }), {
      serial: () => {
        throw new Error('boom')
      },
      summarise: () => {
        throw new Error('boom')
      }
    })

    expect(result.isError).toBeFalsy()
    expect(result.content[0]).toEqual({ type: 'text', text: JSON.stringify({ ok: true }) })
  })
})

describe('redactText', () => {
  it('counts code points, not UTF-16 units', () => {
    expect(redactText('hunter2')).toBe('<7자 가림>')
    expect(redactText('안녕')).toBe('<2자 가림>')
  })
})
