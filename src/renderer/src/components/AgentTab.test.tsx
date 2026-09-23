// @vitest-environment jsdom
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import { claudeCodeCommand, promptTemplates } from '../../../shared/agentGuide'
import { AgentTab } from './AgentTab'

const server = { url: 'http://127.0.0.1:9321/mcp', port: 9321, token: 'token-value' }

/** user-event의 setup()이 clipboard를 바꿔치기하므로 setup() 뒤에 부른다. */
function stubClipboard(writeText: (text: string) => Promise<void>): void {
  Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true })
}

describe('AgentTab connection', () => {
  it('shows the claude mcp add command without the token', () => {
    render(<AgentTab server={server} targetSerial={null} />)

    expect(screen.getByText(/claude mcp add --transport http/)).toBeDefined()
    expect(document.body.textContent).not.toContain('token-value')
  })

  it('copies the full command including the token', async () => {
    const user = userEvent.setup()
    const writeText = vi.fn(async (_text: string) => {})
    stubClipboard(writeText)
    render(<AgentTab server={server} targetSerial={null} />)

    await user.click(screen.getByRole('button', { name: '명령 복사' }))

    await waitFor(() => expect(writeText).toHaveBeenCalledWith(claudeCodeCommand(server)))
    expect(screen.getByText('복사했다')).toBeDefined()
  })

  it('reports why the command copy failed', async () => {
    const user = userEvent.setup()
    stubClipboard(async () => {
      throw new Error('document is not focused')
    })
    render(<AgentTab server={server} targetSerial={null} />)

    await user.click(screen.getByRole('button', { name: '명령 복사' }))

    await waitFor(() => expect(screen.getByText(/document is not focused/)).toBeDefined())
  })

  it('tells the user how to re-register after the token changes', () => {
    render(<AgentTab server={server} targetSerial={null} />)

    expect(screen.getByText('claude mcp remove virtual-device-helper')).toBeDefined()
  })

  it('explains that the server is not running and still offers prompts', () => {
    render(<AgentTab server={null} targetSerial={null} />)

    expect(screen.getByText(/서버가 떠 있지 않다/)).toBeDefined()
    expect(screen.queryByRole('button', { name: '명령 복사' })).toBeNull()
    expect(screen.getByRole('button', { name: '프롬프트 복사' })).toBeDefined()
  })
})

describe('AgentTab prompts', () => {
  it('previews the smoke test template by default', () => {
    render(<AgentTab server={server} targetSerial="emulator-5554" />)

    const smoke = promptTemplates('emulator-5554')[0]
    expect(screen.getByRole('radio', { name: '스모크 테스트' })).toHaveProperty('checked', true)
    expect(screen.getByTestId('prompt-preview').textContent).toBe(smoke?.body)
  })

  it('switches the preview when another template is chosen', async () => {
    render(<AgentTab server={server} targetSerial="emulator-5554" />)

    await userEvent.click(screen.getByRole('radio', { name: '버그 재현' }))

    const bug = promptTemplates('emulator-5554')[2]
    expect(screen.getByTestId('prompt-preview').textContent).toBe(bug?.body)
  })

  it('copies the chosen template', async () => {
    const user = userEvent.setup()
    const writeText = vi.fn(async (_text: string) => {})
    stubClipboard(writeText)
    render(<AgentTab server={server} targetSerial="emulator-5554" />)

    await user.click(screen.getByRole('radio', { name: '시나리오 E2E' }))
    await user.click(screen.getByRole('button', { name: '프롬프트 복사' }))

    await waitFor(() => expect(writeText).toHaveBeenCalledWith(promptTemplates('emulator-5554')[1]?.body))
  })

  it('reports why the prompt copy failed', async () => {
    const user = userEvent.setup()
    stubClipboard(async () => {
      throw new Error('document is not focused')
    })
    render(<AgentTab server={server} targetSerial={null} />)

    await user.click(screen.getByRole('button', { name: '프롬프트 복사' }))

    await waitFor(() => expect(screen.getByText(/document is not focused/)).toBeDefined())
  })

  it('redraws the preview with the new serial when the target device changes', () => {
    const { rerender } = render(<AgentTab server={server} targetSerial="emulator-5554" />)

    rerender(<AgentTab server={server} targetSerial="emulator-5556" />)

    const preview = screen.getByTestId('prompt-preview').textContent ?? ''
    expect(preview).toContain('`emulator-5556`')
    expect(preview).not.toContain('`emulator-5554`')
  })
})
