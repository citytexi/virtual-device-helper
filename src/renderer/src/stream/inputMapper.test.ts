import { describe, expect, it } from 'vitest'
import { keyToIntent, toVideoPoint, wheelToScroll, type KeyInput } from './inputMapper'

const video = { width: 472, height: 1024 }

describe('toVideoPoint', () => {
  it('scales a click inside an exactly fitting element', () => {
    const rect = { left: 10, top: 20, width: 236, height: 512 }

    expect(toVideoPoint(10 + 50, 20 + 100, rect, video)).toEqual({ x: 100, y: 200, width: 472, height: 1024 })
  })

  it('accounts for the side bars of a letterboxed element', () => {
    // 높이에 맞춰 0.5배로 그려지고 가로로 (600 - 236) / 2 = 182px의 여백이 생긴다.
    const rect = { left: 0, top: 0, width: 600, height: 512 }

    expect(toVideoPoint(182 + 50, 100, rect, video)).toEqual({ x: 100, y: 200, width: 472, height: 1024 })
  })

  it('ignores a click on the letterbox bar', () => {
    const rect = { left: 0, top: 0, width: 600, height: 512 }

    expect(toVideoPoint(20, 100, rect, video)).toBeNull()
  })

  it('clamps to the frame edge when asked, for the end of a drag', () => {
    const rect = { left: 0, top: 0, width: 600, height: 512 }

    expect(toVideoPoint(20, 900, rect, video, { clamp: true })).toEqual({ x: 0, y: 1023, width: 472, height: 1024 })
  })

  it('returns null before the video size is known', () => {
    expect(toVideoPoint(1, 1, { left: 0, top: 0, width: 100, height: 100 }, { width: 0, height: 0 })).toBeNull()
  })
})

describe('wheelToScroll', () => {
  it('turns one pixel-mode notch down into one Android notch down', () => {
    expect(wheelToScroll(0, 100, 0)).toEqual({ hScroll: 0, vScroll: -1 })
  })

  it('keeps the horizontal sign', () => {
    expect(wheelToScroll(100, 0, 0)).toEqual({ hScroll: 1, vScroll: 0 })
  })

  it('treats three lines as one notch', () => {
    expect(wheelToScroll(0, -3, 1)).toEqual({ hScroll: 0, vScroll: 1 })
  })

  it('clamps to the protocol range', () => {
    expect(wheelToScroll(0, 100_000, 0)).toEqual({ hScroll: 0, vScroll: -16 })
  })

  it('returns null for a zero delta', () => {
    expect(wheelToScroll(0, 0, 0)).toBeNull()
  })
})

describe('keyToIntent', () => {
  const plain: KeyInput = { key: 'a', isComposing: false, ctrlKey: false, metaKey: false, altKey: false }

  it('sends a printable ascii character as text', () => {
    expect(keyToIntent(plain)).toEqual({ type: 'text', text: 'a' })
    expect(keyToIntent({ ...plain, key: ' ' })).toEqual({ type: 'text', text: ' ' })
    expect(keyToIntent({ ...plain, key: '~' })).toEqual({ type: 'text', text: '~' })
  })

  it.each([
    ['Enter', 'enter'],
    ['Backspace', 'backspace'],
    ['Delete', 'forward_delete'],
    ['Tab', 'tab'],
    ['Escape', 'escape'],
    ['ArrowUp', 'up'],
    ['ArrowDown', 'down'],
    ['ArrowLeft', 'left'],
    ['ArrowRight', 'right']
  ])('sends %s as the %s key', (key, deviceKey) => {
    expect(keyToIntent({ ...plain, key })).toEqual({ type: 'key', key: deviceKey })
  })

  it.each([
    ['a non-ascii character', { ...plain, key: '한' }],
    ['a key during IME composition', { ...plain, key: 'a', isComposing: true }],
    ['a Cmd shortcut', { ...plain, key: 'r', metaKey: true }],
    ['a Ctrl shortcut', { ...plain, key: 'c', ctrlKey: true }],
    ['an Alt chord', { ...plain, key: 'x', altKey: true }],
    ['a named key we do not map', { ...plain, key: 'F5' }],
    ['a prototype key name', { ...plain, key: 'toString' }]
  ])('sends nothing for %s', (_name, input) => {
    expect(keyToIntent(input)).toBeNull()
  })
})
