// @vitest-environment jsdom
import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import type { ToolCallRecord } from '../../../shared/types/ipc'
import { ActivityTab } from './ActivityTab'

function record(overrides: Partial<ToolCallRecord> = {}): ToolCallRecord {
  return {
    id: 'a',
    tool: 'ui_tap',
    argsSummary: '{"x":540,"y":930}',
    startedAt: Date.UTC(2026, 8, 22, 2, 6, 21),
    durationMs: 42,
    ok: true,
    ...overrides
  }
}

describe('ActivityTab', () => {
  it('tells the user what to do when nothing has happened yet', () => {
    render(<ActivityTab records={[]} />)

    expect(screen.getByText(/아직 호출이 없다/)).toBeDefined()
  })

  it('shows the tool name, argument summary and duration', () => {
    render(<ActivityTab records={[record()]} />)

    expect(screen.getByText('ui_tap')).toBeDefined()
    expect(screen.getByText('{"x":540,"y":930}')).toBeDefined()
    expect(screen.getByText('42ms')).toBeDefined()
  })

  it('shows newest first so the latest call is not buried', () => {
    render(
      <ActivityTab
        records={[record({ id: 'a', tool: 'app_launch' }), record({ id: 'b', tool: 'screenshot' })]}
      />
    )

    const rows = screen.getAllByRole('listitem')
    expect(rows[0]?.textContent).toContain('screenshot')
  })

  it('marks a failed call and names its error kind', () => {
    render(<ActivityTab records={[record({ ok: false, errorKind: 'no_device' })]} />)

    expect(screen.getByText(/no_device/)).toBeDefined()
    expect(screen.getByRole('listitem').getAttribute('data-ok')).toBe('false')
  })
})
