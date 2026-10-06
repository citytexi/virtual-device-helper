import { describe, expect, it } from 'vitest'
import { IOS_KEY_ARGS, IOS_KEYS } from './iosKeys'

describe('iosKeys', () => {
  it('IOS_KEYS는 정해진 순서이고 표의 키와 일치한다', () => {
    expect(IOS_KEYS).toEqual(['home', 'power', 'enter', 'backspace', 'forward_delete', 'tab', 'escape', 'up', 'down', 'left', 'right'])
    expect(Object.keys(IOS_KEY_ARGS).sort()).toEqual([...IOS_KEYS].sort())
  })

  it('버튼과 HID keycode 인자를 돌려준다', () => {
    expect(IOS_KEY_ARGS.home).toEqual(['button', 'home'])
    expect(IOS_KEY_ARGS.power).toEqual(['button', 'lock'])
    expect(IOS_KEY_ARGS.enter).toEqual(['key', '40'])
    expect(IOS_KEY_ARGS.up).toEqual(['key', '82'])
    expect(IOS_KEY_ARGS.forward_delete).toEqual(['key', '76'])
  })
})
