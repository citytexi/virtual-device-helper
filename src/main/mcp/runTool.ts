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

/** `ToolCallDetail.args`와 `error.details`에 같이 쓰는 상한(스펙 "근거 표기 규칙"의 2KB). */
export const DETAIL_LIMIT_BYTES = 2048

/** JSON으로 못 옮기는 값(순환 참조 등)을 만났을 때 쓰는 표식. */
const SERIALIZE_FAILURE = '<직렬화 실패>'

/** `redact` 콜백이 던졌을 때 인자를 통째로 이 표식으로 바꾼다. */
const REDACT_FAILURE = '<가림 실패>'

/** `…(잘림)` 표식. `observe.ts`의 로그 잘림 표식과 자리만 다르고 이유는 같다. */
const TRUNCATION_MARK = '…(잘림)'

/**
 * `ui_text`처럼 원문을 남기면 안 되는 인자를 가릴 때 쓴다. 코드포인트 수(N)만 남기고
 * 나머지는 버린다 — `.length`(UTF-16 코드유닛)를 쓰면 서로게이트 쌍이 낀 문자열에서
 * 실제 글자 수와 다르게 샌다.
 */
export function redactText(text: string): string {
  return `<${Array.from(text).length}자 가림>`
}

/**
 * UTF-8 바이트 기준으로 `limitBytes`(표식 포함)를 넘지 않게 자른다. 코드포인트 경계에서
 * 끊어서 서로게이트 쌍이 반쪽만 남는 것을 막는다(`observe.ts`의 `truncateMessage`와 같은 이유,
 * 다만 여기는 코드포인트 수가 아니라 바이트 수가 상한이다).
 */
function truncateToBytes(text: string, limitBytes: number): string {
  if (Buffer.byteLength(text, 'utf8') <= limitBytes) return text

  const budget = Math.max(0, limitBytes - Buffer.byteLength(TRUNCATION_MARK, 'utf8'))
  let kept = ''
  let bytes = 0
  for (const codePoint of text) {
    const codePointBytes = Buffer.byteLength(codePoint, 'utf8')
    if (bytes + codePointBytes > budget) break
    kept += codePoint
    bytes += codePointBytes
  }
  return `${kept}${TRUNCATION_MARK}`
}

/** 직렬화가 안 되면(순환 참조 등) `SERIALIZE_FAILURE` 표식으로 대체한다. */
function safeStringify(value: unknown): string {
  try {
    return JSON.stringify(value ?? {})
  } catch {
    return SERIALIZE_FAILURE
  }
}

function summariseArgs(text: string): string {
  return text.length <= ARGS_SUMMARY_LIMIT ? text : `${text.slice(0, ARGS_SUMMARY_LIMIT - 1)}…`
}

/** `detail.args`용 문자열을 만든다. 이미 직렬화 실패 표식이면 그대로 두고, 아니면 2KB로 자른다. */
function buildDetailArgs(text: string): string {
  return text === SERIALIZE_FAILURE ? text : truncateToBytes(text, DETAIL_LIMIT_BYTES)
}

/**
 * `redact`를 먼저 적용하고 그 결과를 한 번만 직렬화해서 `argsSummary`와 `detail.args`를
 * 함께 만든다. `redact`가 던지면 인자를 통째로 표식으로 바꿔서 원본이 어느 필드에도
 * 남지 않는다.
 */
function buildArgsFields(
  args: unknown,
  redact?: (args: unknown) => unknown
): { argsSummary: string; detailArgs: string } {
  let redactedArgs: unknown = args
  if (redact) {
    try {
      redactedArgs = redact(args)
    } catch {
      return { argsSummary: REDACT_FAILURE, detailArgs: REDACT_FAILURE }
    }
  }
  const text = safeStringify(redactedArgs)
  return { argsSummary: summariseArgs(text), detailArgs: buildDetailArgs(text) }
}

/**
 * `error.details`가 2KB를 넘으면 원래 모양(`Record<string, unknown>`)을 유지한 채
 * `{ truncated: '<앞부분 JSON>…(잘림)' }`으로 바꾼다. `message`·`hint`는 그대로 둔다.
 */
function limitErrorDetails(error: ToolError): ToolError {
  if (!error.details) return error

  let text: string
  try {
    text = JSON.stringify(error.details)
  } catch {
    return { ...error, details: { truncated: SERIALIZE_FAILURE } }
  }
  if (Buffer.byteLength(text, 'utf8') <= DETAIL_LIMIT_BYTES) return error

  return { ...error, details: { truncated: truncateToBytes(text, DETAIL_LIMIT_BYTES) } }
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
  /**
   * 핸들러가 실제로 대상으로 삼은 기기의 serial. 성공·실패 모두에서 부른다. 던지거나
   * undefined를 돌려주면 기록에서 `serial` 필드를 뺀다 — 툴 결과에는 영향 없다.
   */
  serial?: () => string | undefined
  /**
   * 성공한 호출의 payload를 한 줄로 요약한다. 던지면 `detail.resultSummary`를 비운다.
   */
  summarise?: (payload: unknown) => string
  /**
   * `argsSummary`와 `detail.args`를 만들기 전에 인자에서 원문을 지운다(예: `ui_text`의
   * `text`). 던지면 인자를 통째로 `"<가림 실패>"`로 바꾼다 — 원본이 어느 필드에도
   * 남지 않는다.
   */
  redact?: (args: unknown) => unknown
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

  // args는 handler 실행 여부와 무관하다. redact·직렬화를 한 번만 하고 성공/실패 양쪽
  // 기록에서 같은 값을 쓴다.
  const { argsSummary, detailArgs } = buildArgsFields(args, opts.redact)

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

  // serial 콜백은 성공·실패 모두에서 부른다. 던지거나 undefined면 필드를 뺀다 —
  // 툴 결과에는 영향 없다.
  function resolveSerial(): string | undefined {
    if (!opts.serial) return undefined
    try {
      return opts.serial()
    } catch {
      return undefined
    }
  }

  try {
    const payload = await handler()
    // 활동 탭에 보일 소요 시간은 handler가 끝난 시점까지만 잰다. gesture 조회는 그 뒤에
    // 이어지는 부가 작업이라 그 대기를 durationMs에 얹으면 이미 끝난 호출이 실제보다
    // 오래 걸린 것처럼 보인다.
    const durationMs = Date.now() - startedAt

    // gesture 콜백은 성공 뒤에만, 실패해도 툴 결과에 영향 없이 직접 기다린다.
    let gesture: Gesture | undefined
    if (opts.gesture) {
      try {
        gesture = await opts.gesture()
      } catch {
        gesture = undefined
      }
    }

    // summarise도 성공 뒤에만 부른다. 던지면 resultSummary 없이 기록한다 — 툴 결과에는
    // 영향 없다.
    let resultSummary: string | undefined
    if (opts.summarise) {
      try {
        resultSummary = opts.summarise(payload)
      } catch {
        resultSummary = undefined
      }
    }

    const serial = resolveSerial()

    recordSafely({
      id,
      tool,
      argsSummary,
      startedAt,
      durationMs,
      ok: true,
      ...(gesture ? { gesture } : {}),
      ...(serial !== undefined ? { serial } : {}),
      detail: {
        args: detailArgs,
        ...(resultSummary !== undefined ? { resultSummary } : {})
      }
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

    const serial = resolveSerial()

    recordSafely({
      id,
      tool,
      argsSummary,
      startedAt,
      durationMs: Date.now() - startedAt,
      ok: false,
      errorKind: toolError.kind,
      ...(serial !== undefined ? { serial } : {}),
      detail: {
        args: detailArgs,
        error: limitErrorDetails(toolError)
      }
    })

    const result: ToolResult = {
      content: [{ type: 'text', text: JSON.stringify(toolError) }],
      isError: true
    }
    return result as CallToolResult
  }
}
