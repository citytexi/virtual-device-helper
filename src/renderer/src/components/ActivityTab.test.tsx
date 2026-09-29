// @vitest-environment jsdom
import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import type { TimelineEntry } from '../../../shared/types/ipc'
import { ActivityTab } from './ActivityTab'

type ToolCallEntry = Extract<TimelineEntry, { kind: 'tool_call' }>

function record(overrides: Partial<ToolCallEntry> = {}): ToolCallEntry {
  return {
    kind: 'tool_call',
    id: 'a',
    tool: 'ui_tap',
    argsSummary: '{"x":540,"y":930}',
    at: Date.UTC(2026, 8, 22, 2, 6, 21),
    durationMs: 42,
    ok: true,
    detail: { args: '{"x":540,"y":930}' },
    ...overrides
  }
}

describe('ActivityTab', () => {
  it('tells the user what to do when nothing has happened yet', () => {
    render(<ActivityTab entries={[]} />)

    expect(screen.getByText(/아직 호출이 없다/)).toBeDefined()
  })

  it('shows the tool name, argument summary and duration', () => {
    render(<ActivityTab entries={[record()]} />)

    expect(screen.getByText('ui_tap')).toBeDefined()
    expect(screen.getByText('{"x":540,"y":930}')).toBeDefined()
    expect(screen.getByText('42ms')).toBeDefined()
  })

  it('shows newest first so the latest call is not buried', () => {
    render(
      <ActivityTab
        entries={[record({ id: 'a', tool: 'app_launch' }), record({ id: 'b', tool: 'screenshot' })]}
      />
    )

    const rows = screen.getAllByRole('listitem')
    expect(rows[0]?.textContent).toContain('screenshot')
  })

  it('marks a failed call and names its error kind', () => {
    render(<ActivityTab entries={[record({ ok: false, errorKind: 'no_device' })]} />)

    expect(screen.getByText(/no_device/)).toBeDefined()
    expect(screen.getByRole('listitem').getAttribute('data-ok')).toBe('false')
  })

  it('shows a successful call as succeeded', () => {
    render(<ActivityTab entries={[record({ ok: true })]} />)

    expect(screen.getByText('성공')).toBeDefined()
  })

  it('shows a failed call without an error kind as failed', () => {
    render(<ActivityTab entries={[record({ ok: false, errorKind: undefined })]} />)

    expect(screen.getByText('실패')).toBeDefined()
  })

  it('shows only tool calls for now and skips device entries', () => {
    render(
      <ActivityTab
        entries={[
          { kind: 'device', id: 'd', at: 0, serial: 'emulator-5554', event: 'connected' },
          record({ id: 'a', tool: 'screenshot' })
        ]}
      />
    )

    const rows = screen.getAllByRole('listitem')
    expect(rows).toHaveLength(1)
    expect(rows[0]?.textContent).toContain('screenshot')
  })

  it('still says nothing has happened when there are only device entries', () => {
    render(<ActivityTab entries={[{ kind: 'device', id: 'd', at: 0, serial: null, event: 'active_changed' }]} />)

    expect(screen.getByText(/아직 호출이 없다/)).toBeDefined()
  })
})
