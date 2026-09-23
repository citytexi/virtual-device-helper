import type { AvdController } from '../device/avdController'
import type { DeviceRegistry, RegistryEvent } from '../device/registry'
import type { McpServerHandle } from '../mcp/httpServer'
import type { AppSnapshot, MainEvent, SdkStatus, ToolCallRecord, TrackingFailure } from '../../shared/types/ipc'

const DEFAULT_TOOL_CALL_LIMIT = 500

export interface AppStateDeps {
  sdk: SdkStatus
  registry: DeviceRegistry
  avd: AvdController
  server: McpServerHandle | null
  toolCallLimit?: number
}

export interface AppState {
  snapshot(): Promise<AppSnapshot>
  recordToolCall(record: ToolCallRecord): void
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
    error: event.failure.error?.toolError ?? null,
    exitCode: event.failure.exitCode
  }
  return { type: 'tracking_failed', failure }
}

export function createAppState(deps: AppStateDeps): AppState {
  const limit = deps.toolCallLimit ?? DEFAULT_TOOL_CALL_LIMIT
  const toolCalls: ToolCallRecord[] = []
  const listeners = new Set<(event: MainEvent) => void>()
  let server: McpServerHandle | null = deps.server
  let trackingFailure: TrackingFailure | null = null

  function emit(event: MainEvent): void {
    for (const listener of listeners) listener(event)
  }

  async function emitAvds(): Promise<void> {
    try {
      emit({ type: 'avds_changed', avds: await deps.avd.list() })
    } catch (thrown) {
      // 목록 갱신 하나가 실패했다고 main 프로세스에 unhandled rejection을 남기지 않는다.
      // 다음 기기 이벤트나 스냅샷 요청 때 다시 읽는다.
      console.error('AVD 목록을 다시 읽지 못했다', thrown)
    }
  }

  deps.registry.on((event: RegistryEvent) => {
    const mainEvent = toMainEvent(event)
    if (mainEvent.type === 'tracking_failed') trackingFailure = mainEvent.failure
    emit(mainEvent)
    // 기기가 붙거나 떨어지면 AVD의 running 표시가 달라진다.
    if (event.type === 'device_connected' || event.type === 'device_disconnected') void emitAvds()
  })

  function endpoint(): AppSnapshot['server'] {
    return server ? { url: server.url, port: server.port, token: server.token } : null
  }

  return {
    async snapshot() {
      return {
        sdk: deps.sdk,
        server: endpoint(),
        avds: deps.sdk.ok ? await deps.avd.list() : [],
        devices: deps.registry.serials(),
        activeSerial: deps.registry.getActive(),
        toolCalls: [...toolCalls],
        trackingFailure
      }
    },

    recordToolCall(record) {
      toolCalls.push(record)
      // 오래된 것부터 버린다. 전체 이력은 M3의 몫이다.
      if (toolCalls.length > limit) toolCalls.splice(0, toolCalls.length - limit)
      emit({ type: 'tool_call', record })
    },

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
