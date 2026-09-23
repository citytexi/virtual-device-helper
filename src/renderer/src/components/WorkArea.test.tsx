// @vitest-environment jsdom
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it } from 'vitest'
import type { AppSnapshot } from '../../../shared/types/ipc'
import { WorkArea } from './WorkArea'

const snapshot: AppSnapshot = {
  sdk: { ok: true, sdkRoot: '/opt/sdk' },
  server: { url: 'http://127.0.0.1:9321/mcp', port: 9321, token: 'token-value' },
  avds: [{ name: 'Pixel_7_API_34', running: true, serial: 'emulator-5554' }],
  devices: ['emulator-5554'],
  activeSerial: 'emulator-5554',
  toolCalls: [],
  trackingFailure: null
}

describe('WorkArea', () => {
  it('offers the activity and agent tabs', () => {
    render(<WorkArea snapshot={snapshot} />)

    expect(screen.getByRole('tablist')).toBeDefined()
    expect(screen.getByRole('tab', { name: '활동' })).toBeDefined()
    expect(screen.getByRole('tab', { name: '에이전트' })).toBeDefined()
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
    const agent = screen.getByRole('tab', { name: '에이전트' })
    expect(agent.getAttribute('aria-selected')).toBe('true')
    expect(document.activeElement).toBe(agent)

    await userEvent.keyboard('{ArrowRight}')
    expect(activity.getAttribute('aria-selected')).toBe('true')
    expect(document.activeElement).toBe(activity)

    await userEvent.keyboard('{ArrowLeft}')
    expect(agent.getAttribute('aria-selected')).toBe('true')
  })

  it('keeps only the selected tab in the tab order', () => {
    render(<WorkArea snapshot={snapshot} />)

    expect(screen.getByRole('tab', { name: '활동' }).getAttribute('tabindex')).toBe('0')
    expect(screen.getByRole('tab', { name: '에이전트' }).getAttribute('tabindex')).toBe('-1')
  })
})
