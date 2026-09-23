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
      return snapshot.toolCalls.some((call) => call.id === event.record.id)
        ? snapshot
        : { ...snapshot, toolCalls: [...snapshot.toolCalls, event.record] }
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
export function useAppState(): {
  snapshot: AppSnapshot | null
  loading: boolean
  error: string | null
} {
  const [snapshot, setSnapshot] = useState<AppSnapshot | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let alive = true
    // getSnapshot()이 아직 안 끝났는데 이벤트가 먼저 도착할 수 있다. 그때 그냥
    // 버리면 그 이벤트는 영영 반영되지 않아 renderer가 main과 계속 어긋난 채
    // 남는다. 그래서 스냅샷이 오기 전까지는 이벤트를 순서대로 버퍼에 쌓아 두고,
    // 스냅샷이 도착하면 그 위에 버퍼를 순서대로 재생한다. tool_call 리듀서가
    // id로 중복을 걸러내므로 스냅샷에 이미 실린 레코드가 버퍼에도 있어도
    // 두 번 쌓이지 않는다.
    const buffer: MainEvent[] = []

    const off = window.api.onEvent((event) => {
      setSnapshot((current) => {
        if (current === null) {
          buffer.push(event)
          return current
        }
        return reduce(current, event)
      })
    })

    window.api
      .getSnapshot()
      .then((initial) => {
        if (!alive) return
        setSnapshot(buffer.reduce(reduce, initial))
      })
      .catch((thrown: unknown) => {
        if (!alive) return
        setError(thrown instanceof Error ? thrown.message : String(thrown))
      })

    return () => {
      alive = false
      off()
    }
  }, [])

  return { snapshot, loading: snapshot === null && error === null, error }
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
