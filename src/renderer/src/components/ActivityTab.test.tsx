// @vitest-environment jsdom
import { fireEvent, render, screen, within } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import type { TimelineEntry } from '../../../shared/types/ipc'
import { ActivityTab } from './ActivityTab'

type ToolCallEntry = Extract<TimelineEntry, { kind: 'tool_call' }>
type DeviceEntry = Extract<TimelineEntry, { kind: 'device' }>

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

function deviceEntry(overrides: Partial<DeviceEntry> = {}): DeviceEntry {
  return { kind: 'device', id: 'd', at: 0, serial: 'emulator-5554', event: 'connected', ...overrides }
}

describe('ActivityTab', () => {
  it('tells the user what to do when nothing has happened yet', () => {
    render(<ActivityTab entries={[]} targetSerial={null} />)

    expect(screen.getByText(/아직 호출이 없다/)).toBeDefined()
  })

  it('shows the tool name, argument summary and duration', () => {
    render(<ActivityTab entries={[record()]} targetSerial={null} />)

    const row = screen.getByRole('listitem')
    expect(within(row).getByText('ui_tap')).toBeDefined()
    expect(within(row).getByText('{"x":540,"y":930}')).toBeDefined()
    expect(within(row).getByText('42ms')).toBeDefined()
  })

  it('shows newest first so the latest call is not buried', () => {
    render(
      <ActivityTab
        entries={[record({ id: 'a', tool: 'app_launch' }), record({ id: 'b', tool: 'screenshot' })]}
        targetSerial={null}
      />
    )

    const rows = screen.getAllByRole('listitem')
    expect(rows[0]?.textContent).toContain('screenshot')
  })

  it('marks a failed call and names its error kind', () => {
    render(<ActivityTab entries={[record({ ok: false, errorKind: 'no_device' })]} targetSerial={null} />)

    expect(screen.getByText(/no_device/)).toBeDefined()
    expect(screen.getByRole('listitem').getAttribute('data-ok')).toBe('false')
  })

  it('shows a successful call as succeeded', () => {
    render(<ActivityTab entries={[record({ ok: true })]} targetSerial={null} />)

    expect(screen.getByRole('listitem').textContent).toContain('성공')
  })

  it('shows a failed call without an error kind as failed', () => {
    render(<ActivityTab entries={[record({ ok: false, errorKind: undefined })]} targetSerial={null} />)

    expect(screen.getByRole('listitem').textContent).toContain('실패')
  })

  it('renders device entries as muted separator rows with a Korean label', () => {
    render(
      <ActivityTab
        entries={[
          deviceEntry({ id: 'd1', serial: 'emulator-5554', event: 'disconnected' }),
          deviceEntry({ id: 'd2', serial: null, event: 'log_stopped' })
        ]}
        targetSerial={null}
      />
    )

    expect(screen.getByText('emulator-5554 연결 끊김')).toBeDefined()
    expect(screen.getByText('로그 수집 멈춤')).toBeDefined()
  })

  it('shows a device row even when there are no tool calls yet', () => {
    render(
      <ActivityTab
        entries={[deviceEntry({ serial: null, event: 'active_changed' })]}
        targetSerial={null}
      />
    )

    expect(screen.getByText('활성 기기 해제됨')).toBeDefined()
    expect(screen.queryByText('활성 기기로 선택됨')).toBeNull()
    expect(screen.queryByText(/아직 호출이 없다/)).toBeNull()
  })

  it('labels active_changed with a serial as 선택됨', () => {
    render(<ActivityTab entries={[deviceEntry({ event: 'active_changed' })]} targetSerial={null} />)

    expect(screen.getByText('emulator-5554 활성 기기로 선택됨')).toBeDefined()
  })

  it('expands a tool call row in place and collapses it again', () => {
    render(<ActivityTab entries={[record({ id: 'a' })]} targetSerial={null} />)

    const row = screen.getByRole('listitem')
    const toggle = within(row).getByRole('button')
    expect(toggle.getAttribute('aria-expanded')).toBe('false')

    fireEvent.click(toggle)
    expect(toggle.getAttribute('aria-expanded')).toBe('true')
    expect(within(row).getByText(/"x": 540/)).toBeDefined()

    fireEvent.click(toggle)
    expect(toggle.getAttribute('aria-expanded')).toBe('false')
    expect(within(row).queryByText(/"x": 540/)).toBeNull()
  })

  it('shows message and hint for a failed call and the summary for a successful one', () => {
    render(
      <ActivityTab
        entries={[
          record({ id: 'ok', ok: true, detail: { args: '{}', resultSummary: '스크린샷 저장됨' } }),
          record({
            id: 'fail',
            ok: false,
            errorKind: 'stale_ref',
            detail: {
              args: '{}',
              error: { kind: 'stale_ref', message: '참조가 오래됐다', hint: '다시 찍어라' }
            }
          })
        ]}
        targetSerial={null}
      />
    )

    // entries는 [ok, fail] 순서로 들어가고, 화면은 최신이 위이므로 rows[0]이 fail이다.
    const rows = screen.getAllByRole('listitem')
    const failRow = rows[0] as HTMLElement
    const okRow = rows[1] as HTMLElement

    fireEvent.click(within(failRow).getByRole('button'))
    expect(within(failRow).getByText('참조가 오래됐다')).toBeDefined()
    expect(within(failRow).getByText('다시 찍어라')).toBeDefined()

    fireEvent.click(within(okRow).getByRole('button'))
    expect(within(okRow).getByText('스크린샷 저장됨')).toBeDefined()
  })

  it('filters rows by tool name', () => {
    render(
      <ActivityTab
        entries={[record({ id: 'a', tool: 'app_launch' }), record({ id: 'b', tool: 'screenshot' })]}
        targetSerial={null}
      />
    )

    fireEvent.change(screen.getByLabelText('툴'), { target: { value: 'screenshot' } })

    const rows = screen.getAllByRole('listitem')
    expect(rows).toHaveLength(1)
    expect(rows[0]?.textContent).toContain('screenshot')
  })

  it('hides device rows when the device toggle is off', () => {
    render(
      <ActivityTab
        entries={[deviceEntry({ id: 'd1' }), record({ id: 'a' })]}
        targetSerial={null}
      />
    )

    fireEvent.click(screen.getByLabelText('기기 이벤트 표시'))

    const rows = screen.getAllByRole('listitem')
    expect(rows).toHaveLength(1)
    expect(rows[0]?.textContent).toContain('ui_tap')
  })
})
