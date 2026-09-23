import { useEffect, useState } from 'react'
import type { AppSnapshot, MainEvent } from '../../../shared/types/ipc'

function reduce(snapshot: AppSnapshot, event: MainEvent): AppSnapshot {
  switch (event.type) {
    case 'device_connected':
      return snapshot.devices.includes(event.serial)
        ? snapshot
        : { ...snapshot, devices: [...snapshot.devices, event.serial] }
    case 'device_disconnected':
      return { ...snapshot, devices: snapshot.devices.filter((serial) => serial !== event.serial) }
    case 'active_changed':
      return { ...snapshot, activeSerial: event.serial }
    case 'avds_changed':
      return { ...snapshot, avds: event.avds }
    case 'tool_call':
      return { ...snapshot, toolCalls: [...snapshot.toolCalls, event.record] }
    case 'server_changed':
      return { ...snapshot, server: event.server }
    case 'tracking_failed':
      return { ...snapshot, trackingFailure: event.failure }
  }
}

/**
 * main이 유일한 진실원이다. 여기서는 스냅샷을 한 번 받고 이벤트로 갱신만 한다.
 * renderer가 자기만의 기기 상태를 따로 추론하지 않는다.
 */
export function useAppState(): { snapshot: AppSnapshot | null; loading: boolean } {
  const [snapshot, setSnapshot] = useState<AppSnapshot | null>(null)

  useEffect(() => {
    let alive = true

    void window.api.getSnapshot().then((initial) => {
      if (alive) setSnapshot(initial)
    })

    const off = window.api.onEvent((event) => {
      setSnapshot((current) => (current ? reduce(current, event) : current))
    })

    return () => {
      alive = false
      off()
    }
  }, [])

  return { snapshot, loading: snapshot === null }
}

/**
 * 명령이 갈 대상 기기를 파생시킨다. registry.ts의 DeviceRegistry.getActive()는
 * 명시적으로 고른 기기만 돌려준다 — 그 계약 문서가 "기기가 하나뿐이면 그것이
 * 대상이 되는 판단은 이 값을 쓰는 쪽에서 파생시켜라"라고 못박는다. 스냅샷의
 * activeSerial은 원본 그대로 두고, 여기서만 파생한다.
 */
export function targetSerial(snapshot: AppSnapshot): string | null {
  if (snapshot.activeSerial !== null) return snapshot.activeSerial
  return snapshot.devices.length === 1 ? (snapshot.devices[0] ?? null) : null
}
