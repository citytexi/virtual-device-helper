import type { ToolErrorKind } from './errors'

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
