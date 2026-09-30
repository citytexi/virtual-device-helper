// @vitest-environment jsdom
import { act, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { AppSnapshot, RendererApi } from '../../../shared/types/ipc'
import type { LogDown, LogPortMeta } from '../../../shared/types/logs'
import type { LogStreamDeps } from '../hooks/useLogStream'
import { LOG_ROW_HEIGHT, LogTab } from './LogTab'
import { WorkArea } from './WorkArea'

// LogTab이 받은 props를 보려고 실제 구현을 감싼 spy로 바꾼다.
vi.mock('./LogTab', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./LogTab')>()
  return { ...actual, LogTab: vi.fn(actual.LogTab) }
})

// 숨겨진 로그 패널도 마운트돼 useLogStream의 effect가 돈다. logDeps를 넘기지 않는 테스트는
// window.api로 간다.
beforeEach(() => {
  ;(window as unknown as { api: Partial<RendererApi> }).api = {
    openLogs: vi.fn(async () => ({ ok: true as const, value: undefined })),
    closeLogs: vi.fn(async () => ({ ok: true as const, value: undefined }))
  }
})

function logHarness() {
  let portCallback: ((meta: LogPortMeta, port: MessagePort) => void) | null = null
  const deps: LogStreamDeps = {
    openLogs: vi.fn(async () => ({ ok: true as const, value: undefined })),
    closeLogs: vi.fn(async () => ({ ok: true as const, value: undefined })),
    onLogPort: vi.fn((callback) => {
      portCallback = callback
      return () => {
        portCallback = null
      }
    })
  }
  const port = { onmessage: null as ((event: MessageEvent) => void) | null, postMessage: vi.fn(), close: vi.fn() }
  const deliverPort = () =>
    act(() => portCallback?.({ serial: 'emulator-5554', sessionId: 's1' }, port as unknown as MessagePort))
  const deliver = (message: LogDown) => act(() => port.onmessage?.({ data: message } as MessageEvent))
  return { deps, port, deliverPort, deliver }
}

const snapshot: AppSnapshot = {
  sdk: { ok: true, sdkRoot: '/opt/sdk' },
  server: { url: 'http://127.0.0.1:9321/mcp', port: 9321, token: 'token-value' },
  virtualDevices: [{ platform: 'android', id: 'Pixel_7_API_34', name: 'Pixel_7_API_34', running: true, serial: 'emulator-5554', osVersion: null }],
  devices: ['emulator-5554'],
  activeSerial: 'emulator-5554',
  timeline: [],
  trackingFailure: null
}

describe('WorkArea', () => {
  it('orders tabs 활동, 로그, 에이전트', () => {
    render(<WorkArea snapshot={snapshot} />)

    expect(screen.getByRole('tablist')).toBeDefined()
    expect(screen.getAllByRole('tab').map((tab) => tab.textContent)).toEqual(['활동', '로그', '에이전트'])
  })

  it('shows the activity panel first', () => {
    render(<WorkArea snapshot={snapshot} />)

    expect(screen.getByRole('tab', { name: '활동' }).getAttribute('aria-selected')).toBe('true')
    expect(screen.getByRole('tabpanel').id).toBe('panel-activity')
  })

  it('switches to the agent panel on click', async () => {
    render(<WorkArea snapshot={snapshot} />)

    await userEvent.click(screen.getByRole('tab', { name: '에이전트' }))

    expect(screen.getByRole('tab', { name: '에이전트' }).getAttribute('aria-selected')).toBe('true')
    expect(screen.getByRole('tabpanel').id).toBe('panel-agent')
    expect(screen.getByRole('button', { name: '프롬프트 복사' })).toBeDefined()
  })

  it('passes the target device to the agent tab', async () => {
    render(<WorkArea snapshot={snapshot} />)

    await userEvent.click(screen.getByRole('tab', { name: '에이전트' }))

    expect(screen.getByTestId('prompt-preview').textContent).toContain('`emulator-5554`')
  })

  it('moves between tabs with the arrow keys and wraps around, moving focus along', async () => {
    render(<WorkArea snapshot={snapshot} />)
    const activity = screen.getByRole('tab', { name: '활동' })
    activity.focus()

    await userEvent.keyboard('{ArrowRight}')
    const logs = screen.getByRole('tab', { name: '로그' })
    expect(logs.getAttribute('aria-selected')).toBe('true')
    expect(document.activeElement).toBe(logs)
    expect(screen.getByRole('tabpanel').id).toBe('panel-logs')

    await userEvent.keyboard('{ArrowRight}')
    const agent = screen.getByRole('tab', { name: '에이전트' })
    expect(agent.getAttribute('aria-selected')).toBe('true')
    expect(document.activeElement).toBe(agent)

    await userEvent.keyboard('{ArrowRight}')
    expect(activity.getAttribute('aria-selected')).toBe('true')
    expect(document.activeElement).toBe(activity)

    await userEvent.keyboard('{ArrowLeft}')
    expect(agent.getAttribute('aria-selected')).toBe('true')
  })

  it('opens logs for the target device even while the log tab is hidden', async () => {
    render(<WorkArea snapshot={snapshot} />)

    await waitFor(() => expect(window.api.openLogs).toHaveBeenCalledWith('emulator-5554'))
  })

  it('recomputes follow scroll when the hidden log tab becomes visible', async () => {
    const h = logHarness()
    render(<WorkArea snapshot={snapshot} logDeps={h.deps} />)
    await waitFor(() => expect(h.deps.openLogs).toHaveBeenCalledWith('emulator-5554'))
    h.deliverPort()
    // 숨겨진 채로 붙었으니 새 포트에 바로 pause가 간다.
    expect(h.port.postMessage).toHaveBeenCalledWith({ type: 'pause' })

    const list = screen.getByTestId('log-list')
    Object.defineProperty(list, 'scrollTop', { value: 0, writable: true, configurable: true })
    h.deliver({
      type: 'snapshot',
      done: true,
      entries: Array.from({ length: 50 }, (_, seq) => ({
        timestamp: '09-28 12:00:00.000',
        level: 'I' as const,
        tag: 'T',
        pid: 1,
        message: `m${seq}`,
        seq,
        at: seq
      }))
    })
    // 숨겨진 패널은 clientHeight가 0이다.
    expect(list.scrollTop).toBe(50 * LOG_ROW_HEIGHT)

    Object.defineProperty(list, 'clientHeight', { value: 200, configurable: true })
    await userEvent.click(screen.getByRole('tab', { name: '로그' }))

    expect(list.scrollTop).toBe(50 * LOG_ROW_HEIGHT - 200)
    expect(h.port.postMessage).toHaveBeenCalledWith({ type: 'resume', afterSeq: 49 })
  })

  it('switches to the log tab and passes a jump for the clicked call', async () => {
    const withCall: AppSnapshot = {
      ...snapshot,
      timeline: [
        {
          kind: 'tool_call',
          id: 'c1',
          at: 10_000,
          serial: 'emulator-5554',
          tool: 'ui_tap',
          argsSummary: '{}',
          durationMs: 300,
          ok: true,
          detail: { args: '{}' }
        }
      ]
    }
    render(<WorkArea snapshot={withCall} />)

    await userEvent.click(screen.getByRole('button', { name: /ui_tap/ }))
    await userEvent.click(screen.getByRole('button', { name: '이 시점 로그 보기' }))

    expect(screen.getByRole('tab', { name: '로그' }).getAttribute('aria-selected')).toBe('true')
    const props = vi.mocked(LogTab).mock.lastCall?.[0]
    expect(props?.jump).toEqual({ id: 'c1', serial: 'emulator-5554', at: 8000, highlight: { fromAt: 10_000, toAt: 10_300 } })
    expect(props?.serial).toBe('emulator-5554')
  })

  it('drops a pending jump when the target device changes before it is applied', async () => {
    const withCall: AppSnapshot = {
      ...snapshot,
      devices: ['emulator-5554', 'emulator-5556'],
      timeline: [
        {
          kind: 'tool_call',
          id: 'c1',
          at: 10_000,
          serial: 'emulator-5554',
          tool: 'ui_tap',
          argsSummary: '{}',
          durationMs: 300,
          ok: true,
          detail: { args: '{}' }
        }
      ]
    }
    const { rerender } = render(<WorkArea snapshot={withCall} />)

    await userEvent.click(screen.getByRole('button', { name: /ui_tap/ }))
    await userEvent.click(screen.getByRole('button', { name: '이 시점 로그 보기' }))
    expect(vi.mocked(LogTab).mock.lastCall?.[0].jump?.id).toBe('c1')

    // resumed가 오기 전에 활성 기기가 바뀐다.
    rerender(<WorkArea snapshot={{ ...withCall, activeSerial: 'emulator-5556' }} />)
    expect(vi.mocked(LogTab).mock.lastCall?.[0].serial).toBe('emulator-5556')
    expect(vi.mocked(LogTab).mock.lastCall?.[0].jump).toBeNull()

    // 원래 기기로 돌아와도 옛 요청이 되살아나지 않는다.
    rerender(<WorkArea snapshot={withCall} />)
    expect(vi.mocked(LogTab).mock.lastCall?.[0].jump).toBeNull()
  })

  it('keeps only the selected tab in the tab order', () => {
    render(<WorkArea snapshot={snapshot} />)

    expect(screen.getByRole('tab', { name: '활동' }).getAttribute('tabindex')).toBe('0')
    expect(screen.getByRole('tab', { name: '로그' }).getAttribute('tabindex')).toBe('-1')
    expect(screen.getByRole('tab', { name: '에이전트' }).getAttribute('tabindex')).toBe('-1')
  })
})
