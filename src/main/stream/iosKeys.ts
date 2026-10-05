import type { DeviceKey } from '../../shared/types/stream'

/**
 * iOS 기기 키 → axe 인자. 이 표가 iOS가 지원하는 키의 유일한 목록이다.
 * `home`·`power`는 하드웨어 버튼이고, 나머지는 HID keycode(`axe key <code>`)다.
 */
export const IOS_KEY_ARGS: Partial<Record<DeviceKey, string[]>> = {
  home: ['button', 'home'],
  power: ['button', 'lock'],
  enter: ['key', '40'],
  backspace: ['key', '42'],
  forward_delete: ['key', '76'],
  tab: ['key', '43'],
  escape: ['key', '41'],
  up: ['key', '82'],
  down: ['key', '81'],
  left: ['key', '80'],
  right: ['key', '79']
}

/** 세션이 renderer에 알리는 키 목록. 표의 키를 이 순서로 보여 준다. */
export const IOS_KEYS: DeviceKey[] = [
  'home',
  'power',
  'enter',
  'backspace',
  'forward_delete',
  'tab',
  'escape',
  'up',
  'down',
  'left',
  'right'
].filter((k): k is DeviceKey => (k as DeviceKey) in IOS_KEY_ARGS)
