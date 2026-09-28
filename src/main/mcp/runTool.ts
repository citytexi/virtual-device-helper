import { randomUUID } from 'node:crypto'
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js'
import { isDeviceError, type ToolError } from '../../shared/types/errors'
import type { Gesture } from '../../shared/types/ipc'
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

/**
 * 들여쓰기 없는 compact JSON을 쓴다. pretty-print(`null, 2`)는 키 이름을 줄마다
 * 반복하고 공백을 넣어 응답을 눈에 띄게 부풀린다 — log_read처럼 배열이 큰 툴에서는
 * 이 차이가 에이전트가 결과를 inline으로 못 받는 정도까지 간다. 에이전트는 JSON을
 * 파싱해서 읽지 눈으로 들여쓰기를 보지 않으므로 가독성 손실은 없다.
 */
export function jsonResult(payload: unknown): ToolResult {
  return { content: [{ type: 'text', text: JSON.stringify(payload) }] }
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
export interface RunToolOpts {
  /**
   * 성공한 호출에만 부른다. 던지거나 undefined면 gesture 없이 기록한다 — 오버레이용
   * 부가 정보가 툴 결과를 바꾸면 안 된다.
   */
  gesture?: () => Promise<Gesture | undefined>
}

/**
 * gesture 조회(화면 크기 등)를 이 시간까지만 기다린다. `screenSizeOf`가 캐시 미스일 때 부르는
 * `Device.info()`는 adb exec 타임아웃(30초)까지 걸릴 수 있는데, 이미 성공한 tap·swipe 결과를
 * gesture 하나 때문에 그만큼 붙잡아 두면 안 된다. 오버레이 표시 하나 놓치는 것보다 훨씬 싸다.
 */
export const GESTURE_TIMEOUT_MS = 1000

/**
 * gesture 콜백을 GESTURE_TIMEOUT_MS 안에서만 기다린다. 시간 안에 못 끝나거나 던지면
 * undefined로 낙착한다 — 원래 promise는 취소하지 않고 그대로 흘려보낸다. `screenSizeOf`
 * 내부 캐시는 그 promise가 끝나야 채워지므로, 지금 호출은 gesture 없이 기록되더라도
 * 다음 호출은 캐시 덕분에 바로 끝난다. 타이머는 둘 중 먼저 끝나는 쪽에서 정리해
 * 유령 타이머를 남기지 않는다.
 */
function withGestureTimeout(build?: () => Promise<Gesture | undefined>): Promise<Gesture | undefined> {
  if (!build) return Promise.resolve(undefined)

  return new Promise((resolve) => {
    let settled = false

    const timer = setTimeout(() => {
      if (settled) return
      settled = true
      resolve(undefined)
    }, GESTURE_TIMEOUT_MS)

    // build()가 (async 함수가 아니어서) 동기적으로 던질 수도 있으니 Promise.resolve로 감싸
    // 항상 프라미스 체인 안에서 실패를 받는다.
    Promise.resolve()
      .then(build)
      .then((gesture) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        resolve(gesture)
      })
      .catch(() => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        resolve(undefined)
      })
  })
}

export async function runTool(
  sink: ToolCallSink,
  tool: string,
  args: unknown,
  handler: () => Promise<unknown> | unknown,
  opts: RunToolOpts = {}
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
    // 활동 탭에 보일 소요 시간은 handler가 끝난 시점까지만 잰다. gesture 조회는 그 뒤에
    // 이어지는 부가 작업이라 GESTURE_TIMEOUT_MS까지 더 기다릴 수 있는데, 그 대기를
    // durationMs에 얹으면 이미 끝난 호출이 실제보다 오래 걸린 것처럼 보인다.
    const durationMs = Date.now() - startedAt

    const gesture = await withGestureTimeout(opts.gesture)

    recordSafely({
      id,
      tool,
      argsSummary: summariseArgs(args),
      startedAt,
      durationMs,
      ok: true,
      ...(gesture ? { gesture } : {})
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
      content: [{ type: 'text', text: JSON.stringify(toolError) }],
      isError: true
    }
    return result as CallToolResult
  }
}
