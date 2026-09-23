// @vitest-environment jsdom
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import { EndpointCard } from './EndpointCard'

const server = { url: 'http://127.0.0.1:9321/mcp', port: 9321, token: 'token-value' }

/**
 * user-event의 setup()이 navigator.clipboard를 자기 스텁으로 바꿔치기할 수
 * 있다. 그래서 setup() 이후에 우리 스텁을 정의해 우리 것이 남도록 한다.
 */
function stubClipboard(writeText: (text: string) => Promise<void>): void {
  Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true })
}

describe('EndpointCard', () => {
  it('explains that the server is not running when there is none', () => {
    render(<EndpointCard server={null} />)

    expect(screen.getByText(/서버가 떠 있지 않다/)).toBeDefined()
  })

  it('does not claim a missing SDK is the only reason the server is down', () => {
    render(<EndpointCard server={null} />)

    const message = screen.getByText(/서버가 떠 있지 않다/).textContent ?? ''
    // SDK를 찾았어도 서버가 뜨는 데 실패할 수 있다 — 메시지가 SDK 부재만을
    // 원인으로 단정하면 안 된다.
    expect(message).not.toMatch(/^서버가 떠 있지 않다\. Android SDK를 찾지 못하면 서버를 열지 않는다\.?$/)
  })

  it('shows the endpoint url', () => {
    render(<EndpointCard server={server} />)

    expect(screen.getByText('http://127.0.0.1:9321/mcp')).toBeDefined()
  })

  it('hides the token until the user asks to see it', async () => {
    const user = userEvent.setup()
    stubClipboard(async () => {})
    render(<EndpointCard server={server} />)

    expect(screen.queryByText('token-value')).toBeNull()

    await user.click(screen.getByRole('button', { name: '토큰 보기' }))

    expect(screen.getByText('token-value')).toBeDefined()
  })

  it('copies the token and reports success', async () => {
    const user = userEvent.setup()
    const writeText = vi.fn(async (_text: string) => {})
    stubClipboard(writeText)
    render(<EndpointCard server={server} />)

    await user.click(screen.getByRole('button', { name: '토큰 복사' }))

    await waitFor(() => expect(writeText).toHaveBeenCalledWith('token-value'))
    expect(screen.getByText('복사했다')).toBeDefined()
  })

  it('reports why the token copy failed when the clipboard rejects', async () => {
    const user = userEvent.setup()
    stubClipboard(async () => {
      throw new Error('document is not focused')
    })
    render(<EndpointCard server={server} />)

    await user.click(screen.getByRole('button', { name: '토큰 복사' }))

    await waitFor(() => expect(screen.getByText(/document is not focused/)).toBeDefined())
  })

  it('copies a config snippet that carries both url and token, and reports success', async () => {
    const user = userEvent.setup()
    const writeText = vi.fn(async (_text: string) => {})
    stubClipboard(writeText)
    render(<EndpointCard server={server} />)

    await user.click(screen.getByRole('button', { name: '설정 JSON 복사' }))

    await waitFor(() => expect(writeText).toHaveBeenCalled())
    const copied = writeText.mock.calls[0]?.[0] as string
    const parsed = JSON.parse(copied) as Record<string, unknown>

    expect(copied).toContain('http://127.0.0.1:9321/mcp')
    expect(copied).toContain('token-value')
    expect(parsed).toHaveProperty('mcpServers')
    expect(screen.getByText('복사했다')).toBeDefined()
  })

  it('reports why the config copy failed when the clipboard rejects', async () => {
    const user = userEvent.setup()
    stubClipboard(async () => {
      throw new Error('document is not focused')
    })
    render(<EndpointCard server={server} />)

    await user.click(screen.getByRole('button', { name: '설정 JSON 복사' }))

    await waitFor(() => expect(screen.getByText(/document is not focused/)).toBeDefined())
  })
})
