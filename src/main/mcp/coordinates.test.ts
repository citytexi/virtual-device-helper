import { describe, expect, it } from 'vitest'
import { centerOf, DEFAULT_SWIPE_MS, REF_SWIPE_INSET, swipeWithin, toPixel } from './coordinates'
import type { DisplayFrame, NormalizedRect } from '../../shared/types/device'

describe('coordinates', () => {
  const frame: DisplayFrame = { width: 1080, height: 2400 }
  const rect: NormalizedRect = { x: 0.1, y: 0.2, w: 0.8, h: 0.5 }

  describe('toPixel', () => {
    it('maps a normalized point to device pixels', () => {
      expect(toPixel({ x: 0.5, y: 0.25 }, frame)).toEqual({ x: 540, y: 600 })
    })

    it('keeps the far edge inside the display', () => {
      expect(toPixel({ x: 1, y: 1 }, frame)).toEqual({ x: 1079, y: 2399 })
    })

    it('uses the rotated frame as given', () => {
      expect(toPixel({ x: 0.5, y: 0.5 }, { width: 2400, height: 1080 })).toEqual({ x: 1200, y: 540 })
    })
  })

  describe('centerOf', () => {
    it('centers a rect', () => {
      expect(centerOf(rect)).toEqual({ x: 0.5, y: 0.45 })
    })
  })

  describe('swipeWithin', () => {
    it('down means the finger moves up inside the inner 80%', () => {
      expect(swipeWithin(rect, 'down')).toEqual({ from: { x: 0.5, y: 0.65 }, to: { x: 0.5, y: 0.25 } })
    })

    it('up means the finger moves down', () => {
      expect(swipeWithin(rect, 'up')).toEqual({ from: { x: 0.5, y: 0.25 }, to: { x: 0.5, y: 0.65 } })
    })

    it('right means the finger moves left', () => {
      expect(swipeWithin(rect, 'right')).toEqual({ from: { x: 0.82, y: 0.45 }, to: { x: 0.18, y: 0.45 } })
    })

    it('left means the finger moves right', () => {
      expect(swipeWithin(rect, 'left')).toEqual({ from: { x: 0.18, y: 0.45 }, to: { x: 0.82, y: 0.45 } })
    })
  })

  describe('constants', () => {
    it('exports REF_SWIPE_INSET', () => {
      expect(REF_SWIPE_INSET).toBe(0.1)
    })

    it('exports DEFAULT_SWIPE_MS', () => {
      expect(DEFAULT_SWIPE_MS).toBe(300)
    })
  })
})
