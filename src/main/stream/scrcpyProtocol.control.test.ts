import { describe, expect, it } from 'vitest'
import { isDeviceError } from '../../shared/types/errors'
import { ANDROID_KEYCODES, INJECT_TEXT_MAX_BYTES, serializeControl } from './scrcpyProtocol'

function hex(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString('hex')
}

const point = { x: 100, y: 200, width: 472, height: 1024 }

describe('serializeControl', () => {
  it('writes a key as a down message followed by an up message', () => {
    const bytes = serializeControl({ type: 'key', key: 'home' })

    expect(hex(bytes)).toBe(
      '00' + '00' + '00000003' + '00000000' + '00000000' + // down HOME repeat 0 meta 0
        '00' + '01' + '00000003' + '00000000' + '00000000' // up
    )
  })

  it('maps every device key to its Android keycode', () => {
    expect(ANDROID_KEYCODES).toEqual({
      back: 4,
      home: 3,
      app_switch: 187,
      power: 26,
      volume_up: 24,
      volume_down: 25,
      enter: 66,
      backspace: 67,
      forward_delete: 112,
      tab: 61,
      escape: 111,
      up: 19,
      down: 20,
      left: 21,
      right: 22
    })
  })

  it('writes text as a length-prefixed utf-8 string', () => {
    expect(hex(serializeControl({ type: 'text', text: 'hi' }))).toBe('01' + '00000002' + '6869')
  })

  it('refuses text longer than the server limit instead of letting the server drop the connection', () => {
    const tooLong = 'a'.repeat(INJECT_TEXT_MAX_BYTES + 1)

    let thrown: unknown
    try {
      serializeControl({ type: 'text', text: tooLong })
    } catch (error) {
      thrown = error
    }

    expect(isDeviceError(thrown)).toBe(true)
  })

  it('writes a touch down as a generic finger with full pressure', () => {
    expect(hex(serializeControl({ type: 'touch', action: 'down', point }))).toBe(
      '02' + '00' + 'fffffffffffffffe' + '00000064' + '000000c8' + '01d8' + '0400' + 'ffff' + '00000000' + '00000000'
    )
  })

  it('writes a touch up with zero pressure and a move with action 2', () => {
    const up = hex(serializeControl({ type: 'touch', action: 'up', point }))
    const move = hex(serializeControl({ type: 'touch', action: 'move', point }))

    expect(up.slice(2, 4)).toBe('01')
    expect(up.slice(44, 48)).toBe('0000')
    expect(move.slice(2, 4)).toBe('02')
    expect(move.slice(44, 48)).toBe('ffff')
  })

  it('rounds fractional coordinates to whole pixels', () => {
    const bytes = serializeControl({ type: 'touch', action: 'down', point: { ...point, x: 99.6, y: 200.4 } })

    expect(hex(bytes).slice(20, 36)).toBe('00000064' + '000000c8')
  })

  it('writes scroll amounts as i16 fixed point over the [-16, 16] range', () => {
    const bytes = serializeControl({ type: 'scroll', point: { x: 260, y: 1026, width: 1080, height: 1920 }, hScroll: 16, vScroll: -16 })

    // scrcpy 클라이언트의 test_serialize_inject_scroll_event와 같은 기대값(buttons만 0)
    expect(hex(bytes)).toBe('03' + '00000104' + '00000402' + '0438' + '0780' + '7fff' + '8000' + '00000000')
  })

  it('writes one wheel notch upward as 1/16 of the range', () => {
    const bytes = serializeControl({ type: 'scroll', point, hScroll: 0, vScroll: 1 })

    expect(hex(bytes).slice(26, 34)).toBe('0000' + '0800')
  })

  it('clamps scroll amounts beyond the range', () => {
    const bytes = serializeControl({ type: 'scroll', point, hScroll: 100, vScroll: -100 })

    expect(hex(bytes).slice(26, 34)).toBe('7fff' + '8000')
  })
})
