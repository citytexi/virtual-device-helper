import type { AvdController } from '../device/avdController'
import type { DeviceRegistry } from '../device/registry'
import type { ToolCallRecord } from '../../shared/types/ipc'

export type { ToolCallRecord }

export interface ToolCallSink {
  onToolCall(record: ToolCallRecord): void
}

export interface ToolContext extends ToolCallSink {
  registry: DeviceRegistry
  avd: AvdController
}
