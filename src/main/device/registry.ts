import type { Device } from '../../shared/types/device'
import { deviceError } from '../../shared/types/errors'
import type { TrackFailure } from '../adb/trackDevices'

export type RegistryEvent =
  | { type: 'device_connected'; serial: string }
  | { type: 'device_disconnected'; serial: string }
  | { type: 'active_changed'; serial: string | null }
  /**
   * 추적이 죽었다는 신호. adb track-devices 스트림이 끝나면 기기 목록은 그
   * 자리에서 얼어붙는데, 이걸 알리지 않으면 위층(M1-4의 UI)은 "지금 기기가
   * 정말 없는 것"과 "추적이 죽어서 갱신이 멈춘 것"을 구분할 수 없다.
   */
  | { type: 'tracking_failed'; failure: TrackFailure }

export interface DeviceRegistryDeps {
  /**
   * 연결·해제와 추적 실패를 알려 주는 구독. 반환값은 구독 해제 함수다.
   * onFailure는 trackDevices의 세 번째 인자를 그대로 통과시키는 자리다 —
   * 실패를 삼키면 원인이 사라지고 "기기가 안 보인다"는 증상만 남는다.
   */
  track: (
    onChange: (serial: string, connected: boolean) => void,
    onFailure: (failure: TrackFailure) => void
  ) => () => void
  createDevice: (serial: string) => Device
}

export interface DeviceRegistry {
  start(): void
  stop(): void
  serials(): string[]
  resolve(serial?: string): Device
  setActive(serial: string): void
  clearActive(): void
  /**
   * 명시적으로 고른 기기. device_select나 앱의 기기 선택으로만 채워진다.
   * 아무것도 고르지 않았으면 기기가 붙어 있어도 null이다 — 기기가 하나뿐일 때
   * 그것이 대상이 되는 판단은 resolve()가 호출 시점에 한다.
   */
  getActive(): string | null
  /** 같은 기기의 명령을 직렬화한다. 다른 기기끼리는 병렬로 돈다. */
  run<T>(serial: string, task: () => Promise<T>): Promise<T>
  on(listener: (event: RegistryEvent) => void): () => void
}

export function createDeviceRegistry(deps: DeviceRegistryDeps): DeviceRegistry {
  const devices = new Map<string, Device>()
  const queues = new Map<string, Promise<unknown>>()
  const listeners = new Set<(event: RegistryEvent) => void>()

  let active: string | null = null
  let stopTracking: (() => void) | null = null

  function emit(event: RegistryEvent): void {
    for (const listener of listeners) listener(event)
  }

  function setActiveInternal(serial: string | null): void {
    if (active === serial) return
    active = serial
    emit({ type: 'active_changed', serial })
  }

  function onChange(serial: string, connected: boolean): void {
    if (connected) {
      if (devices.has(serial)) return
      devices.set(serial, deps.createDevice(serial))
      emit({ type: 'device_connected', serial })
      return
    }

    if (!devices.delete(serial)) return
    // queues에서는 지우지 않는다. 같은 serial로 disconnect 직후 reconnect가
    // 오는 것(에뮬레이터 재부팅)은 흔한 일이고, 여기서 지우면 아직 안 끝난
    // 이전 작업과 새로 들어온 작업이 run()에서 각자 새 체인으로 시작해
    // 같은 기기에서 동시에 돈다 — DeviceRegistry가 막으려는 바로 그 상황이다.
    // settled entry 하나가 serial당 영구히 남는 트레이드오프를 받아들인다.
    emit({ type: 'device_disconnected', serial })

    // 고른 기기가 사라졌으면 선택을 비운다. 남은 기기가 하나뿐일 때 그것이 대상이
    // 되는 일은 resolve()가 그때 판단한다.
    if (active === serial) setActiveInternal(null)
  }

  function onFailure(failure: TrackFailure): void {
    emit({ type: 'tracking_failed', failure })
  }

  return {
    start() {
      if (stopTracking) return
      stopTracking = deps.track(onChange, onFailure)
    },

    stop() {
      stopTracking?.()
      stopTracking = null
    },

    serials() {
      return [...devices.keys()]
    },

    resolve(serial) {
      if (serial) {
        const device = devices.get(serial)
        if (device) return device

        throw deviceError('no_device', `그런 기기가 없다: ${serial}`, 'device_list로 현재 연결된 기기를 확인해라', {
          candidates: [...devices.keys()]
        })
      }

      if (active) {
        const device = devices.get(active)
        if (device) return device
      }

      if (devices.size === 0) {
        throw deviceError('no_device', '연결된 기기가 없다', 'device_list로 AVD를 확인하고 device_boot로 부팅해라')
      }

      // 기기가 하나뿐이면 고를 것이 없다. 스펙의 "기기가 하나면 자동으로 활성이 된다"는
      // 여기서 늦게 판단한다 — 연결 시점에 활성 슬롯을 채우면 기기가 둘일 때의
      // ambiguous_device가 영영 도달하지 않는다.
      if (devices.size === 1) {
        return devices.values().next().value as Device
      }

      throw deviceError('ambiguous_device', '기기가 여럿이라 대상을 정할 수 없다', 'serial을 지정하거나 device_select로 활성 기기를 정해라', {
        candidates: [...devices.keys()]
      })
    },

    setActive(serial) {
      if (!devices.has(serial)) {
        throw deviceError('no_device', `그런 기기가 없다: ${serial}`, 'device_list로 현재 연결된 기기를 확인해라', {
          candidates: [...devices.keys()]
        })
      }
      setActiveInternal(serial)
    },

    clearActive() {
      setActiveInternal(null)
    },

    getActive() {
      return active
    },

    run<T>(serial: string, task: () => Promise<T>): Promise<T> {
      const previous = queues.get(serial) ?? Promise.resolve()
      // 앞선 작업이 실패해도 큐는 계속 돌아야 한다.
      const next = previous.then(task, task)
      queues.set(
        serial,
        next.catch(() => undefined)
      )
      return next
    },

    on(listener) {
      listeners.add(listener)
      return () => listeners.delete(listener)
    }
  }
}
