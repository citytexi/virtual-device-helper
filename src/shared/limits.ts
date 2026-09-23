/**
 * 로그 읽기의 기본 줄 수와, 인자로도 넘을 수 없는 줄 수 상한.
 *
 * 두 층이 같은 값을 쓴다. `observe.ts`(mcpTools 층)는 `log_read`의 기본값·입력 스키마
 * 상한으로 쓰고, `androidDevice.ts`의 `readLogs`는 mcpTools를 거치지 않는 경로(장차 M3의
 * renderer/IPC 경로, 테스트)에도 같은 안전판을 둔다. ADR-0005의 층 규칙상 mcpTools는
 * Android 구현을 import할 수 없고, 아래층이 위층을 import할 수도 없으므로 두 층 모두가
 * 기댈 수 있는 shared에 둔다.
 */
export const DEFAULT_LOG_LIMIT = 100
export const MAX_LOG_LIMIT = 200
