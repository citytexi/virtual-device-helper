import type { Device } from '../../shared/types/device'
import type { ScreenSize } from '../../shared/types/ipc'

/**
 * Device 인스턴스별 화면 크기. registry는 기기가 다시 연결되면 새 인스턴스를 만들므로
 * WeakMap 키가 곧 "이번 연결"이다. 탭마다 wm size를 부르지 않으려는 캐시다.
 */
const cache = new WeakMap<Device, Promise<ScreenSize>>()

export function screenSizeOf(device: Device): Promise<ScreenSize> {
  const cached = cache.get(device)
  if (cached) return cached

  const pending = device.info().then((info) => ({ width: info.width, height: info.height }))
  cache.set(device, pending)
  // 실패를 캐시하지 않는다. 부팅 직후처럼 잠깐 실패한 기기는 다음 호출에서 다시 묻는다.
  pending.catch(() => {
    if (cache.get(device) === pending) cache.delete(device)
  })
  return pending
}
