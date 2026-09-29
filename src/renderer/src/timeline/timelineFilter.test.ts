import { describe, expect, it } from 'vitest'
import type { TimelineEntry } from '../../../shared/types/ipc'
import { EMPTY_TIMELINE_FILTER, matchTimeline, type TimelineFilter } from './timelineFilter'

type ToolCallEntry = Extract<TimelineEntry, { kind: 'tool_call' }>
type DeviceEntry = Extract<TimelineEntry, { kind: 'device' }>

function toolCall(overrides: Partial<ToolCallEntry> = {}): ToolCallEntry {
  return {
    kind: 'tool_call',
    id: 'a',
    tool: 'ui_tap',
    argsSummary: '{"x":1}',
    at: 0,
    durationMs: 10,
    ok: true,
    detail: { args: '{"x":1}' },
    ...overrides
  }
}

function deviceEntry(overrides: Partial<DeviceEntry> = {}): DeviceEntry {
  return { kind: 'device', id: 'd', at: 0, serial: 'emulator-5554', event: 'connected', ...overrides }
}

describe('matchTimeline', () => {
  it('filters by tool name and result', () => {
    const filter: TimelineFilter = { ...EMPTY_TIMELINE_FILTER, tool: 'ui_tap', result: 'ok' }

    expect(matchTimeline(toolCall({ tool: 'ui_tap', ok: true }), filter)).toBe(true)
    expect(matchTimeline(toolCall({ tool: 'app_launch', ok: true }), filter)).toBe(false)
    expect(matchTimeline(toolCall({ tool: 'ui_tap', ok: false }), filter)).toBe(false)
  })

  it('hides device entries when showDevice is off, and tool filter never hides them otherwise', () => {
    const off: TimelineFilter = { ...EMPTY_TIMELINE_FILTER, showDevice: false }
    expect(matchTimeline(deviceEntry(), off)).toBe(false)

    const withToolAndResult: TimelineFilter = { ...EMPTY_TIMELINE_FILTER, tool: 'ui_tap', result: 'fail' }
    expect(matchTimeline(deviceEntry(), withToolAndResult)).toBe(true)

    const withText: TimelineFilter = { ...EMPTY_TIMELINE_FILTER, text: 'nothing to do with device' }
    expect(matchTimeline(deviceEntry(), withText)).toBe(true)
  })

  it('searches tool name, detail.args and error message case-insensitively', () => {
    // argsSummary는 120자로 잘리므로 뒤쪽 인자는 detail.args에서만 찾힌다
    const fullArgs = `{"query":"${'x'.repeat(200)}NEEDLE"}`
    const truncatedSummary = fullArgs.slice(0, 120)
    const entry = toolCall({ tool: 'log_search', argsSummary: truncatedSummary, detail: { args: fullArgs } })
    expect(truncatedSummary.toLowerCase()).not.toContain('needle')

    const textFilter: TimelineFilter = { ...EMPTY_TIMELINE_FILTER, text: 'needle' }
    expect(matchTimeline(entry, textFilter)).toBe(true)

    const toolNameFilter: TimelineFilter = { ...EMPTY_TIMELINE_FILTER, text: 'UI_TAP' }
    expect(matchTimeline(toolCall({ tool: 'ui_tap' }), toolNameFilter)).toBe(true)

    const errorFilter: TimelineFilter = { ...EMPTY_TIMELINE_FILTER, text: 'STALE' }
    const failed = toolCall({
      ok: false,
      detail: { args: '{}', error: { kind: 'stale_ref', message: '참조가 stale 상태다', hint: '다시 시도하라' } }
    })
    expect(matchTimeline(failed, errorFilter)).toBe(true)

    const noMatch: TimelineFilter = { ...EMPTY_TIMELINE_FILTER, text: 'zzz-no-match' }
    expect(matchTimeline(toolCall(), noMatch)).toBe(false)
  })
})
