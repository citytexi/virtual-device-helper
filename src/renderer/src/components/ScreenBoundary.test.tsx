// @vitest-environment jsdom
import { render, screen } from '@testing-library/react'
import type { JSX } from 'react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ScreenBoundary } from './ScreenBoundary'

let shouldThrow = true
function Bomb(): JSX.Element {
  if (shouldThrow) throw new Error('boom')
  return <p>정상 화면</p>
}

let errorSpy: ReturnType<typeof vi.spyOn>
beforeEach(() => {
  shouldThrow = true
  errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
})
afterEach(() => errorSpy.mockRestore())

describe('ScreenBoundary', () => {
  it('자식이 던지면 안내를 보이고 형제 요소는 그대로 둔다', () => {
    render(
      <div>
        <p>형제</p>
        <ScreenBoundary>
          <Bomb />
        </ScreenBoundary>
      </div>
    )
    expect(screen.getByText('이 화면을 그리지 못했다')).toBeTruthy()
    expect(screen.getByText('형제')).toBeTruthy()
    expect(errorSpy.mock.calls.some((call: unknown[]) => call.some((arg: unknown) => arg instanceof Error && arg.message === 'boom'))).toBe(true)
  })

  it('다시 시도를 누르면 자식을 다시 마운트한다', async () => {
    render(
      <ScreenBoundary>
        <Bomb />
      </ScreenBoundary>
    )
    shouldThrow = false
    await userEvent.click(screen.getByRole('button', { name: '다시 시도' }))
    expect(screen.getByText('정상 화면')).toBeTruthy()
    expect(screen.queryByText('이 화면을 그리지 못했다')).toBeNull()
  })
})
