/**
 * 툴 실패의 종류. 에이전트가 이 값을 보고 복구 경로를 고른다.
 * 응답 잘림은 여기 들어가지 않는다 — 에러가 아니라 성공 응답의 필드다.
 */
export type ToolErrorKind =
  | 'sdk_not_found'
  | 'adb_not_found'
  | 'no_device'
  | 'ambiguous_device'
  | 'package_not_found'
  | 'apk_path_invalid'
  | 'device_unresponsive'
  | 'command_failed'

export interface ToolError {
  kind: ToolErrorKind
  /** 무엇이 잘못됐는지. 사람이 읽는 한 문장. */
  message: string
  /** 다음에 무엇을 하면 되는지. 한 줄. */
  hint: string
  /** 후보 serial 목록, 원문 stderr 등 에이전트가 쓸 수 있는 부가 정보. */
  details?: Record<string, unknown>
}

export class DeviceError extends Error {
  constructor(readonly toolError: ToolError) {
    super(toolError.message)
    this.name = 'DeviceError'
  }
}

export function deviceError(
  kind: ToolErrorKind,
  message: string,
  hint: string,
  details?: Record<string, unknown>
): DeviceError {
  return new DeviceError({ kind, message, hint, details })
}

export function isDeviceError(value: unknown): value is DeviceError {
  return value instanceof DeviceError
}
