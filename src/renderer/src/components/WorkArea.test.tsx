// @vitest-environment jsdom
import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import type { AppSnapshot } from '../../../shared/types/ipc'
import { WorkArea } from './WorkArea'

const snapshot: AppSnapshot = {
  sdk: { ok: true, sdkRoot: '/opt/sdk' },
  server: null,
  avds: [],
  devices: [],
  activeSerial: null,
  toolCalls: [],
  trackingFailure: null
}

describe('WorkArea', () => {
  it('renders a tab list even though M1 has only one tab', () => {
    render(<WorkArea snapshot={snapshot} />)

    expect(screen.getByRole('tablist')).toBeDefined()
    expect(screen.getByRole('tab', { name: '활동' })).toBeDefined()
  })

  it('shows the activity panel as the selected tab', () => {
    render(<WorkArea snapshot={snapshot} />)

    expect(screen.getByRole('tab', { name: '활동' }).getAttribute('aria-selected')).toBe('true')
    expect(screen.getByRole('tabpanel')).toBeDefined()
  })
})
