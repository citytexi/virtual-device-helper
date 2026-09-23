import { z } from 'zod'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { runTool } from '../runTool'
import type { ToolContext } from '../toolContext'
import { DEFAULT_LOG_LIMIT, MAX_LOG_LIMIT } from '../../../shared/limits'
import type { LogLine } from '../../../shared/types/device'

const serial = z
  .string()
  .optional()
  .describe('대상 기기의 serial. 생략하면 활성 기기를 쓴다. 기기가 여럿인데 생략하면 에러가 난다.')

/**
 * log_read가 limit을 생략했을 때 쓰는 기본 줄 수, 그리고 인자로도 넘을 수 없는 상한.
 * 응답 크기는 이 mcpTools 층이 소유하지만(스펙 "응답 크기 규칙"), 같은 값을
 * `AndroidDevice.readLogs`도 안전판으로 쓴다. ADR-0005의 층 규칙상 이 층은 Android
 * 구현(`androidDevice.ts`)을 import할 수 없으므로, 두 층이 함께 기대는 shared의
 * `limits.ts`에서 가져와 값이 둘로 갈라지지 않게 한다.
 */
export const LOG_READ_DEFAULT_LIMIT = DEFAULT_LOG_LIMIT
export const LOG_READ_MAX_LIMIT = MAX_LOG_LIMIT

/**
 * 로그 한 줄의 message를 이 만큼(코드포인트 기준)으로 자른다. 줄 하나가 응답 예산을
 * 통째로 먹는 것을 막는다. UTF-16 코드유닛(`.length`)이 아니라 코드포인트로 세고
 * 자른다 — `.length`나 `.slice`로 자르면 서로게이트 쌍(이모지 등) 딱 그 경계에서
 * 반쪽만 남아 깨진 문자열이 될 수 있다.
 */
const LOG_MESSAGE_MAX_CODEPOINTS = 300

/**
 * 이 tool이 돌려주는 텍스트 전체(직렬화된 JSON)의 상한. UTF-8 바이트로 잰다 —
 * 클라이언트가 받는 것은 바이트이고, 한글 로그는 한 글자가 3바이트라 문자 수로 재면
 * 예산이 세 배 가까이 샌다. 줄 하나하나는 `LOG_MESSAGE_MAX_CODEPOINTS`로 잘라도, 줄 수가
 * 많으면(최대 `LOG_READ_MAX_LIMIT`줄) 합쳐서 여전히 에이전트가 inline으로 못 받을 만큼
 * 커질 수 있다. 이 상한을 넘으면 가장 오래된 줄부터 버려서 맞춘다. 값의 근거는
 * ADR-0008에 있다.
 */
export const LOG_READ_RESPONSE_BUDGET_BYTES = 20_000

/** message가 상한을 넘으면 코드포인트 단위로 잘라내고, 몇 자를 버렸는지 보이는 표식을 남긴다. */
function truncateMessage(message: string): string {
  const codePoints = Array.from(message)
  if (codePoints.length <= LOG_MESSAGE_MAX_CODEPOINTS) return message
  const overflow = codePoints.length - LOG_MESSAGE_MAX_CODEPOINTS
  return `${codePoints.slice(0, LOG_MESSAGE_MAX_CODEPOINTS).join('')}…(+${overflow}자)`
}

/**
 * `LogLine`을 사람이 읽는 한 줄로 압축한다. 키 이름을 반복하는 pretty JSON 대신
 * `MM-DD HH:MM:SS.mmm L tag(pid): message` 형태로 써서 응답 크기를 줄인다.
 * 구조화된 형태가 필요한 쪽(renderer, 장차 M3)은 `AndroidDevice.readLogs`를 직접 쓴다.
 */
function formatLogLine(line: LogLine): string {
  return `${line.timestamp} ${line.level} ${line.tag}(${line.pid}): ${truncateMessage(line.message)}`
}

interface LogReadPayload {
  lines: string[]
  truncated: boolean
  droppedCount: number
}

/**
 * 직렬화된 JSON 텍스트의 UTF-8 바이트 수가 `LOG_READ_RESPONSE_BUDGET_BYTES`를 넘으면 가장
 * 오래된 줄부터 버린다. `lines`는 이미 오래된 것이 앞, 최신이 뒤 순서다
 * (`AndroidDevice.readLogs`가 자르는 방향과 같다 — "최신 쪽이 쓸모 있다") — 그래서
 * 앞에서부터 하나씩 뗀다. 버린 만큼 droppedCount에 더하고 truncated를 true로 올린다.
 * `AndroidDevice.readLogs`가 이미 잘라서 truncated/droppedCount가 차 있어도 그대로
 * 이어받아 누적한다.
 */
function enforceResponseBudget(lines: string[], truncated: boolean, droppedCount: number): LogReadPayload {
  let kept = lines
  let trunc = truncated
  let dropped = droppedCount

  while (kept.length > 0) {
    const bytes = Buffer.byteLength(JSON.stringify({ lines: kept, truncated: trunc, droppedCount: dropped }), 'utf8')
    if (bytes <= LOG_READ_RESPONSE_BUDGET_BYTES) break
    kept = kept.slice(1)
    dropped += 1
    trunc = true
  }

  return { lines: kept, truncated: trunc, droppedCount: dropped }
}

export function registerObserveTools(server: McpServer, context: ToolContext): void {
  server.registerTool(
    'screenshot',
    {
      description:
        '지금 화면을 캡처한다. 기본으로 축소해서 돌려준다. 원본 해상도가 필요하면 scale을 올린다.',
      inputSchema: {
        scale: z
          .number()
          .gt(0)
          .lte(1)
          .optional()
          .describe('원본 대비 비율. 0보다 크고 1 이하. 생략하면 기본 축소를 쓴다.'),
        serial
      }
    },
    async (args) =>
      runTool(context, 'screenshot', args, async () => {
        const device = context.registry.resolve(args.serial)
        const shot = await context.registry.run(device.serial, () =>
          device.screenshot(args.scale === undefined ? undefined : { scale: args.scale })
        )

        return {
          content: [{ type: 'image' as const, data: shot.base64, mimeType: 'image/png' }]
        }
      })
  )

  server.registerTool(
    'log_read',
    {
      description:
        `logcat을 읽는다. 기본 줄 수 제한이 있고(${LOG_READ_DEFAULT_LIMIT}) 인자로도 상한(${LOG_READ_MAX_LIMIT})을 넘을 수 없다. ` +
        '잘리면 truncated가 true로 온다 — 그때는 filter로 좁혀서 다시 불러라. lines는 한 줄당 문자열 하나로 온다 ' +
        '("MM-DD HH:MM:SS.mmm L tag(pid): message" 형태). 긴 message는 잘리고 "…(+N자)"로 얼마나 잘렸는지 표시된다. ' +
        `줄 수가 상한 안이어도 응답 전체가 UTF-8로 ${LOG_READ_RESPONSE_BUDGET_BYTES}바이트를 넘으면 가장 오래된 줄부터 추가로 버리고 그만큼 truncated·droppedCount에 반영한다.`,
      inputSchema: {
        filter: z.string().optional().describe('태그나 메시지에 대한 부분일치 필터'),
        since: z.string().optional().describe('이 시각 이후만. 형식은 "MM-DD HH:mm:ss.SSS"'),
        limit: z
          .number()
          .int()
          .positive()
          .max(LOG_READ_MAX_LIMIT)
          .optional()
          .describe(
            `가져올 최대 줄 수. 생략하면 ${LOG_READ_DEFAULT_LIMIT}, 상한은 ${LOG_READ_MAX_LIMIT}이며 인자로도 못 넘는다.`
          ),
        serial
      }
    },
    async (args) =>
      runTool(context, 'log_read', args, async () => {
        const device = context.registry.resolve(args.serial)
        const opts: { filter?: string; since?: string; limit: number } = {
          limit: args.limit ?? LOG_READ_DEFAULT_LIMIT
        }
        if (args.filter !== undefined) opts.filter = args.filter
        if (args.since !== undefined) opts.since = args.since

        const result = await context.registry.run(device.serial, () => device.readLogs(opts))
        const formatted = result.lines.map(formatLogLine)

        return enforceResponseBudget(formatted, result.truncated, result.droppedCount)
      })
  )

  server.registerTool(
    'log_clear',
    {
      description:
        'logcat 버퍼를 비운다. 테스트 시나리오를 시작하기 직전에 부르면 이후 로그만 보게 된다.',
      inputSchema: { serial }
    },
    async (args) =>
      runTool(context, 'log_clear', args, async () => {
        const device = context.registry.resolve(args.serial)
        await context.registry.run(device.serial, () => device.clearLogs())
        return { cleared: true }
      })
  )
}
