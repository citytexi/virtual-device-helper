import { randomUUID } from 'node:crypto'
import { isDeviceError, type ToolError } from '../../shared/types/errors'
import type { ToolCallSink } from './toolContext'

export type ToolContent =
  | { type: 'text'; text: string }
  | { type: 'image'; data: string; mimeType: string }

export interface ToolResult {
  /**
   * MCP SDK의 `registerTool` 콜백이 기대하는 반환 타입(`CallToolResult`)은 zod로 추론된
   * 타입이라 인덱스 시그니처가 함께 따라온다. 이 인덱스 시그니처가 없으면 TypeScript가
   * `ToolResult`를 그 자리에 대입하지 못한다 — 형변환을 각 툴 파일에 흩어 두는 대신 여기서
   * 한 번만 맞춰 둔다.
   */
  [key: string]: unknown
  content: ToolContent[]
  isError?: boolean
}

const ARGS_SUMMARY_LIMIT = 120

function summariseArgs(args: unknown): string {
  const text = JSON.stringify(args ?? {})
  return text.length <= ARGS_SUMMARY_LIMIT ? text : `${text.slice(0, ARGS_SUMMARY_LIMIT - 1)}…`
}

function isContentPayload(value: unknown): value is { content: ToolContent[] } {
  return typeof value === 'object' && value !== null && Array.isArray((value as { content?: unknown }).content)
}

export function jsonResult(payload: unknown): ToolResult {
  return { content: [{ type: 'text', text: JSON.stringify(payload, null, 2) }] }
}

/**
 * 모든 툴 핸들러를 감싼다. 세 가지를 한곳에서 책임진다.
 * 1. 실패를 예외가 아니라 구조화된 결과로 바꾼다 — 에이전트가 읽고 복구할 수 있어야 한다.
 * 2. 호출을 기록해 앱의 활동 탭으로 흘린다.
 * 3. 응답을 MCP content 형태로 포장한다.
 */
export async function runTool(
  sink: ToolCallSink,
  tool: string,
  args: unknown,
  handler: () => Promise<unknown> | unknown
): Promise<ToolResult> {
  const startedAt = Date.now()
  const id = randomUUID()

  try {
    const payload = await handler()
    sink.onToolCall({
      id,
      tool,
      argsSummary: summariseArgs(args),
      startedAt,
      durationMs: Date.now() - startedAt,
      ok: true
    })

    return isContentPayload(payload) ? { content: payload.content } : jsonResult(payload)
  } catch (thrown) {
    const toolError: ToolError = isDeviceError(thrown)
      ? thrown.toolError
      : {
          kind: 'command_failed',
          message: thrown instanceof Error ? thrown.message : String(thrown),
          hint: '같은 호출을 다시 시도하고, 반복되면 앱의 활동 탭에서 맥락을 확인해라'
        }

    sink.onToolCall({
      id,
      tool,
      argsSummary: summariseArgs(args),
      startedAt,
      durationMs: Date.now() - startedAt,
      ok: false,
      errorKind: toolError.kind
    })

    return {
      content: [{ type: 'text', text: JSON.stringify(toolError, null, 2) }],
      isError: true
    }
  }
}
