import { randomUUID } from 'node:crypto'
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js'
import { isDeviceError, type ToolError } from '../../shared/types/errors'
import type { ToolCallSink } from './toolContext'

export type ToolContent =
  | { type: 'text'; text: string }
  | { type: 'image'; data: string; mimeType: string }

export interface ToolResult {
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
 *
 * 선언한 반환 타입은 `ToolResult`가 아니라 MCP SDK가 `registerTool` 콜백에 기대하는
 * `CallToolResult`다(zod로 추론된 타입이라 인덱스 시그니처가 붙는다). 그래야 이 함수를
 * 그대로 콜백으로 넘기는 모든 툴 파일이 형변환 없이 쓸 수 있다. `ToolResult`는 이
 * 함수 내부에서만 쓰는 엄격한 중간 타입으로 남기고, 캐스트는 두 `return` 지점에만 둔다 —
 * `ToolResult`에 인덱스 시그니처를 넣어 두면 `isError` 같은 선택 필드의 오타를 excess
 * property check가 잡아내지 못하게 된다.
 */
export async function runTool(
  sink: ToolCallSink,
  tool: string,
  args: unknown,
  handler: () => Promise<unknown> | unknown
): Promise<CallToolResult> {
  const startedAt = Date.now()
  const id = randomUUID()

  // 기록(sink.onToolCall)은 툴 결과와 완전히 분리한다. sink가 예외를 던져도(예: 창을 닫은
  // 뒤 webContents가 destroyed 상태인 경우) 이미 끝난 handler의 성공/실패 판정을 바꾸면
  // 안 된다. 그래서 sink 호출은 이 작은 함수 하나로 모으고 예외를 삼킨다. 호출당 정확히
  // 한 번만 부르도록 성공/실패 분기 각각에서 한 번씩만 이 함수를 쓴다.
  function recordSafely(record: Parameters<ToolCallSink['onToolCall']>[0]): void {
    try {
      sink.onToolCall(record)
    } catch {
      // 기록 실패는 무시한다. 활동 탭에 못 남아도 툴 결과는 그대로 에이전트에게 간다.
    }
  }

  try {
    const payload = await handler()
    recordSafely({
      id,
      tool,
      argsSummary: summariseArgs(args),
      startedAt,
      durationMs: Date.now() - startedAt,
      ok: true
    })

    const result: ToolResult = isContentPayload(payload) ? { content: payload.content } : jsonResult(payload)
    return result as CallToolResult
  } catch (thrown) {
    const toolError: ToolError = isDeviceError(thrown)
      ? thrown.toolError
      : {
          kind: 'command_failed',
          message: thrown instanceof Error ? thrown.message : String(thrown),
          hint: '같은 호출을 다시 시도하고, 반복되면 앱의 활동 탭에서 맥락을 확인해라'
        }

    recordSafely({
      id,
      tool,
      argsSummary: summariseArgs(args),
      startedAt,
      durationMs: Date.now() - startedAt,
      ok: false,
      errorKind: toolError.kind
    })

    const result: ToolResult = {
      content: [{ type: 'text', text: JSON.stringify(toolError, null, 2) }],
      isError: true
    }
    return result as CallToolResult
  }
}
