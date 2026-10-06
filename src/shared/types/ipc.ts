import type { Platform, ScreenshotResult, VirtualDeviceEntry } from './device'
import type { ToolError, ToolErrorKind } from './errors'

/**
 * 활동 탭 상세 패널이 쓰는 값. `args`는 가린 인자의 JSON(2KB 넘으면 자름), `error`는
 * 실패했을 때의 `ToolError`(`details`도 같은 상한), `resultSummary`는 성공했을 때의
 * 결과 한 줄 요약이다.
 */
export interface ToolCallDetail {
  args: string
  error?: ToolError
  resultSummary?: string
}

/**
 * 에이전트의 화면 동작. 좌표는 디스플레이 전체 크기 기준 0..1 정규화 값이다.
 * renderer는 비디오 크기를 곱하기만 하면 된다 — 회전은 이미 정규화 단계에서 반영됐다.
 */
export type Gesture =
  | { kind: 'tap'; serial: string; x: number; y: number }
  | { kind: 'swipe'; serial: string; x1: number; y1: number; x2: number; y2: number }

export interface ToolCallRecord {
  id: string
  tool: string
  /** 인자를 한 줄로 요약한 것. 원본을 통째로 담지 않는다. */
  argsSummary: string
  startedAt: number
  durationMs: number
  ok: boolean
  errorKind?: ToolErrorKind
  /** 화면 위 동작이 있는 툴(ui_tap·ui_swipe)이 성공했을 때만 붙는다. 실시간 화면 오버레이가 쓴다. */
  gesture?: Gesture
  /** 핸들러가 실제로 대상으로 삼은 기기. 콜백이 없거나 던지면 뺀다. */
  serial?: string
  /** 활동 탭 상세 패널용 가린 인자·에러·결과 요약. */
  detail: ToolCallDetail
}

/** 타임라인에 쌓이는 기기·스트림·로그 상태 변화. */
export type DeviceTimelineEvent =
  | 'connected'
  | 'disconnected'
  | 'active_changed'
  | 'stream_started'
  | 'stream_stopped'
  | 'stream_reconnecting'
  | 'log_stopped'

/**
 * 활동 탭이 보는 한 줄. 툴 호출과 기기 이벤트가 기록된 순서대로 한 줄에 선다.
 * `tool_call`의 `at`은 `ToolCallRecord.startedAt`이라 앞 항목보다 이를 수 있다 — `at`으로 다시 정렬하지 않는다.
 */
export type TimelineEntry =
  | {
      kind: 'tool_call'; id: string; at: number; serial?: string
      tool: string; argsSummary: string; durationMs: number; ok: boolean
      errorKind?: ToolErrorKind; gesture?: Gesture; detail: ToolCallDetail
    }
  | {
      kind: 'device'; id: string; at: number; serial: string | null
      event: 'connected' | 'disconnected' | 'active_changed'
           | 'stream_started' | 'stream_stopped' | 'stream_reconnecting'
           | 'log_stopped'
    }

/** 채널 이름은 여기 한곳에만 둔다. preload와 main이 같은 상수를 본다. */
export const IPC_CHANNELS = {
  getSnapshot: 'app:get-snapshot',
  selectDevice: 'app:select-device',
  bootVirtualDevice: 'app:boot-virtual-device',
  shutdownDevice: 'app:shutdown-device',
  captureScreenshot: 'app:capture-screenshot',
  startStream: 'app:start-stream',
  stopStream: 'app:stop-stream',
  openLogs: 'app:open-logs',
  closeLogs: 'app:close-logs',
  /** main → renderer. 스트림 포트 하나를 싣는다. preload가 main world로 다시 건넨다. */
  streamPort: 'app:stream-port',
  /** main → renderer. 로그 포트 하나를 싣는다. preload가 main world로 다시 건넨다. */
  logPort: 'app:log-port',
  event: 'app:event'
} as const

/**
 * 플랫폼 하나가 준비됐는지. Android는 location이 SDK 경로, searched가 찾아본 경로다.
 * iOS는 location이 Xcode 개발자 디렉토리이고 searched는 비어 있다.
 * ok:false의 hint는 사용자가 할 일을 main이 정해 내려 주는 문구다. 할 일이 없으면(예: 이 호스트에서는
 * 설치할 수 없는 도구) null이고, renderer는 호스트 OS를 보고 따로 안내를 만들지 않는다.
 */
export type PlatformStatus =
  | { ok: true; location: string; /** 준비는 됐지만 알려 둘 것. 없으면 빈 배열이다. */ notes: string[] }
  | { ok: false; reason: string; searched: string[]; hint: string | null }

export interface PlatformStatuses {
  android: PlatformStatus
  ios: PlatformStatus
}

/**
 * IPC를 넘는 결과. 예외로 던지지 않는다 — Electron IPC를 넘는 Error는
 * stack 문자열만 남고 우리가 붙인 kind와 hint가 사라진다.
 */
export type Outcome<T> = { ok: true; value: T } | { ok: false; error: ToolError }

export interface ServerStatus {
  url: string
  port: number
  token: string
}

/**
 * registry.ts의 tracking_failed 이벤트를 IPC로 나를 수 있게 평평하게 만든 것.
 * 원본 TrackFailure.error는 DeviceError 클래스 인스턴스라 구조적 복제(structured
 * clone)를 못 버틴다 — 프로토타입이 사라지고 kind·hint가 딸린 toolError도
 * 함께 사라진다. 그래서 여기서는 이미 평평한 ToolError로 바꿔 담는다.
 */
export interface TrackingFailure {
  /** 어느 플랫폼의 추적이 죽었는지. renderer는 이 값으로 문구를 가르지 않고 label을 그대로 보인다. */
  platform: Platform
  /** 사람이 읽는 플랫폼 이름. main이 정한다. */
  label: string
  error: ToolError | null
  exitCode: number | null
}

export interface AppSnapshot {
  platforms: PlatformStatuses
  server: ServerStatus | null
  virtualDevices: VirtualDeviceEntry[]
  devices: string[]
  activeSerial: string | null
  timeline: TimelineEntry[]
  /** 플랫폼별 추적 실패. 추적이 살아 있으면(또는 그 플랫폼을 조립하지 않았으면) null이다. */
  trackingFailures: Record<Platform, TrackingFailure | null>
}

export type MainEvent =
  | { type: 'device_connected'; serial: string }
  | { type: 'device_disconnected'; serial: string }
  | { type: 'active_changed'; serial: string | null }
  | { type: 'virtual_devices_changed'; virtualDevices: VirtualDeviceEntry[] }
  | { type: 'timeline'; entry: TimelineEntry }
  | { type: 'server_changed'; server: ServerStatus | null }
  | { type: 'tracking_failed'; failure: TrackingFailure }

/** renderer가 볼 수 있는 전부. 이 목록 밖의 능력은 renderer에 없다. */
export interface RendererApi {
  getSnapshot(): Promise<AppSnapshot>
  selectDevice(serial: string): Promise<Outcome<void>>
  bootVirtualDevice(id: string): Promise<Outcome<void>>
  shutdownDevice(serial: string): Promise<Outcome<void>>
  captureScreenshot(serial: string): Promise<Outcome<ScreenshotResult>>
  /** 이 기기로 스트림을 연다. 이전 스트림은 main이 닫는다. 포트는 IPC_CHANNELS.streamPort로 따로 온다. */
  startStream(serial: string): Promise<Outcome<void>>
  stopStream(): Promise<Outcome<void>>
  /** 이 기기의 로그를 연다. 이전 로그 포트는 main이 닫는다. 포트는 IPC_CHANNELS.logPort로 따로 온다. */
  openLogs(serial: string): Promise<Outcome<void>>
  closeLogs(): Promise<Outcome<void>>
  onEvent(callback: (event: MainEvent) => void): () => void
}
