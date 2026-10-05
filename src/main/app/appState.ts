import { randomUUID } from 'node:crypto'
import type { VirtualDeviceCatalog } from '../device/virtualDeviceCatalog'
import type { DeviceRegistry, RegistryEvent } from '../device/registry'
import type { McpServerHandle } from '../mcp/httpServer'
import type { Platform, VirtualDeviceEntry } from '../../shared/types/device'
import { TIMELINE_LIMIT } from '../../shared/limits'
import type {
  AppSnapshot,
  DeviceTimelineEvent,
  MainEvent,
  PlatformStatuses,
  TimelineEntry,
  ToolCallRecord,
  TrackingFailure
} from '../../shared/types/ipc'

export interface AppStateDeps {
  platforms: PlatformStatuses
  registry: DeviceRegistry
  catalog: VirtualDeviceCatalog
  server: McpServerHandle | null
  /** 타임라인 상한. 기본값은 TIMELINE_LIMIT. */
  timelineLimit?: number
  /** 기기 이벤트 항목의 시각. 기본값은 Date.now. */
  now?: () => number
  /** 기기 이벤트 항목의 id. 기본값은 randomUUID. */
  newId?: () => string
}

export interface AppState {
  snapshot(): Promise<AppSnapshot>
  /** 툴 호출을 `tool_call` 타임라인 항목으로 감싸 쌓는다. `at`은 `record.startedAt`이다. */
  recordToolCall(record: ToolCallRecord): void
  /** 기기·스트림·로그 상태 변화를 `device` 타임라인 항목으로 쌓는다. */
  recordDeviceEvent(serial: string | null, event: DeviceTimelineEvent): void
  /** 서버는 상태가 만들어진 뒤에 열린다. 툴 컨텍스트가 서버보다 먼저 필요하기 때문이다. */
  setServer(handle: McpServerHandle | null): void
  onEvent(listener: (event: MainEvent) => void): () => void
}

/**
 * registry의 이벤트를 IPC로 나를 수 있는 모양으로 바꾼다. tracking_failed의 error는
 * DeviceError 클래스 인스턴스라 structured clone을 넘으면 toolError가 사라진다.
 * 그래서 안에 든 평평한 ToolError만 꺼내 담는다.
 */
function toMainEvent(event: RegistryEvent): MainEvent {
  if (event.type !== 'tracking_failed') return event
  const failure: TrackingFailure = {
    platform: event.platform,
    label: PLATFORM_LABELS[event.platform],
    error: event.failure.error?.toolError ?? null,
    exitCode: event.failure.exitCode
  }
  return { type: 'tracking_failed', failure }
}

/** 추적 실패 안내가 어느 플랫폼인지 말할 때 쓰는 이름. 문구는 main이 정하고 renderer는 그대로 보인다. */
const PLATFORM_LABELS: Record<Platform, string> = { android: 'Android', ios: 'iOS' }

/** registry 이벤트 중 타임라인에 남길 것. tracking_failed는 스냅샷의 trackingFailures가 따로 말한다. */
function deviceEventOf(event: RegistryEvent): { serial: string | null; event: DeviceTimelineEvent } | null {
  switch (event.type) {
    case 'device_connected':
      return { serial: event.serial, event: 'connected' }
    case 'device_disconnected':
      return { serial: event.serial, event: 'disconnected' }
    case 'active_changed':
      return { serial: event.serial, event: 'active_changed' }
    default:
      return null
  }
}

/** 선택 필드는 값이 있을 때만 싣는다. undefined 키가 IPC·비교에 섞이지 않게 한다. */
function toolCallEntry(record: ToolCallRecord): TimelineEntry {
  return {
    kind: 'tool_call',
    id: record.id,
    at: record.startedAt,
    ...(record.serial !== undefined ? { serial: record.serial } : {}),
    tool: record.tool,
    argsSummary: record.argsSummary,
    durationMs: record.durationMs,
    ok: record.ok,
    ...(record.errorKind !== undefined ? { errorKind: record.errorKind } : {}),
    ...(record.gesture !== undefined ? { gesture: record.gesture } : {}),
    detail: record.detail
  }
}

export function createAppState(deps: AppStateDeps): AppState {
  const limit = deps.timelineLimit ?? TIMELINE_LIMIT
  const now = deps.now ?? Date.now
  const newId = deps.newId ?? (() => randomUUID())
  // 기록한 순서대로 쌓는다. 툴 호출은 끝날 때 기록되므로 at이 앞 항목보다 이를 수 있지만 다시 정렬하지 않는다.
  const timeline: TimelineEntry[] = []
  const listeners = new Set<(event: MainEvent) => void>()
  let server: McpServerHandle | null = deps.server
  const trackingFailures: AppSnapshot['trackingFailures'] = { android: null, ios: null }
  const anyReady = deps.platforms.android.ok || deps.platforms.ios.ok

  function emit(event: MainEvent): void {
    for (const listener of listeners) listener(event)
  }

  async function emitVirtualDevices(): Promise<void> {
    try {
      emit({ type: 'virtual_devices_changed', virtualDevices: await deps.catalog.list() })
    } catch (thrown) {
      // 목록 갱신 하나가 실패했다고 main 프로세스에 unhandled rejection을 남기지 않는다.
      // 다음 기기 이벤트나 스냅샷 요청 때 다시 읽는다.
      console.error('가상 기기 목록을 다시 읽지 못했다', thrown)
    }
  }

  /**
   * 스냅샷은 renderer가 첫 화면을 그리는 유일한 재료다. 가상 기기 목록 하나를 못 읽었다고
   * 스냅샷 전체를 실패시키면 기기·서버 정보까지 함께 사라진다. 빈 목록으로 대신한다.
   */
  async function listVirtualDevicesOrEmpty(): Promise<VirtualDeviceEntry[]> {
    try {
      return await deps.catalog.list()
    } catch (thrown) {
      console.error('스냅샷용 가상 기기 목록을 읽지 못했다', thrown)
      return []
    }
  }

  function record(entry: TimelineEntry): void {
    timeline.push(entry)
    // 오래된 것부터 버린다. renderer의 reduce도 같은 상한으로 자른다.
    if (timeline.length > limit) timeline.splice(0, timeline.length - limit)
    emit({ type: 'timeline', entry })
  }

  function recordDeviceEvent(serial: string | null, event: DeviceTimelineEvent): void {
    record({ kind: 'device', id: newId(), at: now(), serial, event })
  }

  deps.registry.on((event: RegistryEvent) => {
    const mainEvent = toMainEvent(event)
    if (mainEvent.type === 'tracking_failed') trackingFailures[mainEvent.failure.platform] = mainEvent.failure
    emit(mainEvent)
    const device = deviceEventOf(event)
    if (device) recordDeviceEvent(device.serial, device.event)
    // 기기가 붙거나 떨어지면 가상 기기의 running 표시가 달라진다.
    if (event.type === 'device_connected' || event.type === 'device_disconnected') void emitVirtualDevices()
  })

  function endpoint(): AppSnapshot['server'] {
    return server ? { url: server.url, port: server.port, token: server.token } : null
  }

  return {
    async snapshot() {
      return {
        platforms: deps.platforms,
        server: endpoint(),
        virtualDevices: anyReady ? await listVirtualDevicesOrEmpty() : [],
        devices: deps.registry.serials(),
        activeSerial: deps.registry.getActive(),
        timeline: [...timeline],
        trackingFailures: { ...trackingFailures }
      }
    },

    recordToolCall(toolCall) {
      record(toolCallEntry(toolCall))
    },

    recordDeviceEvent,

    setServer(handle) {
      server = handle
      emit({ type: 'server_changed', server: endpoint() })
    },

    onEvent(listener) {
      listeners.add(listener)
      return () => listeners.delete(listener)
    }
  }
}
