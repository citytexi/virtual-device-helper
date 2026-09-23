// @vitest-environment jsdom
import { act, renderHook } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { copyStatusText, useCopy } from './useCopy'

function stubClipboard(writeText: (text: string) => Promise<void>): void {
  Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true })
}

describe('useCopy', () => {
  it('starts with no status', () => {
    const { result } = renderHook(() => useCopy())

    expect(result.current.status).toBeNull()
  })

  it('writes the text and reports success', async () => {
    const writeText = vi.fn(async (_text: string) => {})
    stubClipboard(writeText)
    const { result } = renderHook(() => useCopy())

    await act(async () => {
      await result.current.copy('hello')
    })

    expect(writeText).toHaveBeenCalledWith('hello')
    expect(result.current.status).toEqual({ ok: true })
  })

  it('reports the reason when the clipboard rejects', async () => {
    stubClipboard(async () => {
      throw new Error('document is not focused')
    })
    const { result } = renderHook(() => useCopy())

    await act(async () => {
      await result.current.copy('hello')
    })

    expect(result.current.status).toEqual({ ok: false, message: 'document is not focused' })
  })
})

describe('copyStatusText', () => {
  it('says what happened in one line', () => {
    expect(copyStatusText({ ok: true })).toBe('복사했다')
    expect(copyStatusText({ ok: false, message: 'denied' })).toBe('복사하지 못했다 — denied')
  })
})
