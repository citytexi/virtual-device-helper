// @vitest-environment jsdom
import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import type { TimelineEntry } from '../../../shared/types/ipc'
import { TimelineDetail } from './TimelineDetail'

type ToolCallEntry = Extract<TimelineEntry, { kind: 'tool_call' }>

function record(overrides: Partial<ToolCallEntry> = {}): ToolCallEntry {
  return {
    kind: 'tool_call',
    id: 'a',
    tool: 'ui_tap',
    argsSummary: '{"x":1}',
    at: 1000,
    durationMs: 10,
    ok: true,
    serial: 'e1',
    detail: { args: '{"x":1}' },
    ...overrides
  }
}

describe('TimelineDetail', () => {
  it('disables 이 시점 로그 보기 with a reason when the call targets another device', () => {
    render(<TimelineDetail entry={record({ serial: 'e2' })} targetSerial="e1" />)

    const button = screen.getByRole('button', { name: '이 시점 로그 보기' }) as HTMLButtonElement
    expect(button.disabled).toBe(true)
    expect(screen.getByText('활성 기기의 호출만 로그로 이동할 수 있다')).toBeDefined()
  })

  it('disables the button when the call has no serial at all', () => {
    render(<TimelineDetail entry={record({ serial: undefined })} targetSerial="e1" />)

    const button = screen.getByRole('button', { name: '이 시점 로그 보기' }) as HTMLButtonElement
    expect(button.disabled).toBe(true)
  })

  it('calls onJumpToLogs for the active device', () => {
    const onJumpToLogs = vi.fn()
    const entry = record({ serial: 'e1' })
    render(<TimelineDetail entry={entry} targetSerial="e1" onJumpToLogs={onJumpToLogs} />)

    const button = screen.getByRole('button', { name: '이 시점 로그 보기' }) as HTMLButtonElement
    expect(button.disabled).toBe(false)

    fireEvent.click(button)
    expect(onJumpToLogs).toHaveBeenCalledWith(entry)
  })

  it('shows indented JSON args, and falls back to the raw text when it fails to parse', () => {
    const { rerender } = render(
      <TimelineDetail entry={record({ detail: { args: '{"x":1,"y":2}' } })} targetSerial="e1" />
    )
    expect(screen.getByText(/"x": 1/)).toBeDefined()

    rerender(<TimelineDetail entry={record({ detail: { args: '{"x":1,"y":2' } })} targetSerial="e1" />)
    expect(screen.getByText('{"x":1,"y":2')).toBeDefined()
  })
})
