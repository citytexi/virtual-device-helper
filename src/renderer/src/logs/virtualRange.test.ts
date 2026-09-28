import { describe, expect, it } from 'vitest'
import { visibleRange } from './virtualRange'

describe('visibleRange', () => {
  it('covers the viewport plus overscan', () => {
    expect(visibleRange(200, 100, 20, 1000, 2)).toEqual({ start: 8, end: 17 })
  })

  it('clamps to the list bounds', () => {
    expect(visibleRange(0, 100, 20, 3)).toEqual({ start: 0, end: 3 })
  })

  it('defaults overscan to 10', () => {
    expect(visibleRange(200, 100, 20, 1000)).toEqual({ start: 0, end: 25 })
  })

  it('does not include the end index itself', () => {
    const { start, end } = visibleRange(0, 40, 20, 100, 0)
    expect(end - start).toBe(2)
  })
})
