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

/**
 * 타임라인(툴 호출·기기 이벤트)에 남기는 항목 수 상한. main의 링과 renderer의 `reduce`가
 * 같은 값으로 오래된 항목부터 버린다.
 */
export const TIMELINE_LIMIT = 1000

/** 한 번에 보이는 화면 칸 수의 상한. 늘릴 때 함께 볼 곳은 M5 스펙 "화면 칸 조정자" 절에 있다. */
export const MAX_SCREEN_SLOTS = 2
