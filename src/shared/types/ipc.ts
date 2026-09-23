import type { AvdEntry, ScreenshotResult } from './device'
import type { ToolError, ToolErrorKind } from './errors'

export interface ToolCallRecord {
  id: string
  tool: string
  /** 인자를 한 줄로 요약한 것. 원본을 통째로 담지 않는다. */
  argsSummary: string
  startedAt: number
  durationMs: number
  ok: boolean
  errorKind?: ToolErrorKind
}

/** 채널 이름은 여기 한곳에만 둔다. preload와 main이 같은 상수를 본다. */
export const IPC_CHANNELS = {
  getSnapshot: 'app:get-snapshot',
  selectDevice: 'app:select-device',
  bootAvd: 'app:boot-avd',
  shutdownDevice: 'app:shutdown-device',
  captureScreenshot: 'app:capture-screenshot',
  startStream: 'app:start-stream',
  stopStream: 'app:stop-stream',
  /** main → renderer. 스트림 포트 하나를 싣는다. preload가 main world로 다시 건넨다. */
  streamPort: 'app:stream-port',
  event: 'app:event'
} as const

export type SdkStatus = { ok: true; sdkRoot: string } | { ok: false; searched: string[] }

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
  error: ToolError | null
  exitCode: number | null
}

export interface AppSnapshot {
  sdk: SdkStatus
  server: ServerStatus | null
  avds: AvdEntry[]
  devices: string[]
  activeSerial: string | null
  toolCalls: ToolCallRecord[]
  trackingFailure: TrackingFailure | null
}

export type MainEvent =
  | { type: 'device_connected'; serial: string }
  | { type: 'device_disconnected'; serial: string }
  | { type: 'active_changed'; serial: string | null }
  | { type: 'avds_changed'; avds: AvdEntry[] }
  | { type: 'tool_call'; record: ToolCallRecord }
  | { type: 'server_changed'; server: ServerStatus | null }
  | { type: 'tracking_failed'; failure: TrackingFailure }

/** renderer가 볼 수 있는 전부. 이 목록 밖의 능력은 renderer에 없다. */
export interface RendererApi {
  getSnapshot(): Promise<AppSnapshot>
  selectDevice(serial: string): Promise<Outcome<void>>
  bootAvd(name: string): Promise<Outcome<void>>
  shutdownDevice(serial: string): Promise<Outcome<void>>
  captureScreenshot(serial: string): Promise<Outcome<ScreenshotResult>>
  /** 이 기기로 스트림을 연다. 이전 스트림은 main이 닫는다. 포트는 IPC_CHANNELS.streamPort로 따로 온다. */
  startStream(serial: string): Promise<Outcome<void>>
  stopStream(): Promise<Outcome<void>>
  onEvent(callback: (event: MainEvent) => void): () => void
}
