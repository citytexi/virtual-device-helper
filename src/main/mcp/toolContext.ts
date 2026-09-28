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
  /**
   * 이 연결 동안 그 패키지가 가졌던 pid 전부(지금 살아있는 pid 포함)를 돌려준다.
   * `logManager`가 구현한다(Task 7). 이 층은 `src/main/logs/`를 import하지 않는다 —
   * 함수 시그니처만 여기 둔다(ADR-0005).
   */
  pidHistory(serial: string, pkg: string): Promise<number[]>
}
