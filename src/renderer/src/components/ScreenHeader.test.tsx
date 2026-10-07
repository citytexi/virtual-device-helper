// @vitest-environment jsdom
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import { ScreenHeader } from './ScreenHeader'

const screenSlot = { id: 'x', epoch: 1, serial: 'emulator-5554', label: 'Android' }

function setup(overrides: { isTarget?: boolean; canReconnect?: boolean } = {}) {
  const onMakeTarget = vi.fn()
  const onReconnect = vi.fn()
  render(
    <ScreenHeader
      screen={screenSlot}
      isTarget={overrides.isTarget ?? false}
      canReconnect={overrides.canReconnect ?? false}
      onMakeTarget={onMakeTarget}
      onReconnect={onReconnect}
    />
  )
  return { onMakeTarget, onReconnect }
}

describe('ScreenHeader', () => {
  it('label과 serial을 보이고 serial의 title이 전체 값이다', () => {
    setup()
    expect(screen.getByText('Android')).toBeTruthy()
    expect(screen.getByText('emulator-5554').getAttribute('title')).toBe('emulator-5554')
  })

  it('대상이 아니면 대상으로 버튼이 켜져 있고 누르면 onMakeTarget을 부른다', async () => {
    const { onMakeTarget } = setup()
    const button = screen.getByRole('button', { name: 'Android emulator-5554 대상으로' }) as HTMLButtonElement
    expect(button.disabled).toBe(false)
    expect(screen.queryByText('(대상)')).toBeNull()
    await userEvent.click(button)
    expect(onMakeTarget).toHaveBeenCalledTimes(1)
  })

  it('대상이면 (대상) 배지가 있고 버튼이 꺼져 있다', () => {
    setup({ isTarget: true })
    expect(screen.getByText('(대상)')).toBeTruthy()
    expect((screen.getByRole('button', { name: 'Android emulator-5554 대상으로' }) as HTMLButtonElement).disabled).toBe(true)
  })

  it('canReconnect일 때만 다시 연결이 있고 누르면 onReconnect를 부른다', async () => {
    const off = setup()
    expect(screen.queryByRole('button', { name: '다시 연결' })).toBeNull()
    off.onReconnect.mockClear()
    document.body.innerHTML = ''
    const { onReconnect } = setup({ canReconnect: true })
    await userEvent.click(screen.getByRole('button', { name: '다시 연결' }))
    expect(onReconnect).toHaveBeenCalledTimes(1)
  })
})
