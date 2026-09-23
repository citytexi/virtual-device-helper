// @vitest-environment jsdom
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { THEME_STORAGE_KEY, ThemeToggle } from './ThemeToggle'

afterEach(() => {
  localStorage.clear()
  delete document.documentElement.dataset.theme
  vi.restoreAllMocks()
})

describe('ThemeToggle', () => {
  it('follows the system theme by default and sets no override', () => {
    render(<ThemeToggle />)

    expect(screen.getByRole('radio', { name: '시스템' })).toHaveProperty('checked', true)
    expect(document.documentElement.dataset.theme).toBeUndefined()
  })

  it('applies the chosen theme to the document root and remembers it', async () => {
    render(<ThemeToggle />)

    await userEvent.click(screen.getByRole('radio', { name: '다크' }))

    expect(document.documentElement.dataset.theme).toBe('dark')
    expect(localStorage.getItem(THEME_STORAGE_KEY)).toBe('dark')
  })

  it('restores a remembered theme on mount', () => {
    localStorage.setItem(THEME_STORAGE_KEY, 'light')

    render(<ThemeToggle />)

    expect(screen.getByRole('radio', { name: '라이트' })).toHaveProperty('checked', true)
    expect(document.documentElement.dataset.theme).toBe('light')
  })

  it('drops the override when going back to the system theme', async () => {
    localStorage.setItem(THEME_STORAGE_KEY, 'dark')
    render(<ThemeToggle />)

    await userEvent.click(screen.getByRole('radio', { name: '시스템' }))

    expect(document.documentElement.dataset.theme).toBeUndefined()
    expect(localStorage.getItem(THEME_STORAGE_KEY)).toBe('system')
  })

  it('ignores an unknown stored value', () => {
    localStorage.setItem(THEME_STORAGE_KEY, 'sepia')

    render(<ThemeToggle />)

    expect(screen.getByRole('radio', { name: '시스템' })).toHaveProperty('checked', true)
  })

  it('still switches themes when storage is unavailable', async () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('blocked')
    })
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('blocked')
    })

    render(<ThemeToggle />)
    await userEvent.click(screen.getByRole('radio', { name: '라이트' }))

    expect(document.documentElement.dataset.theme).toBe('light')
  })
})
