import { z } from 'zod'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { runTool } from '../runTool'
import type { ToolContext } from '../toolContext'
import { DEFAULT_LOG_LIMIT, MAX_LOG_LIMIT } from '../../device/androidDevice'
import type { LogLine } from '../../../shared/types/device'

const serial = z
  .string()
  .optional()
  .describe('대상 기기의 serial. 생략하면 활성 기기를 쓴다. 기기가 여럿인데 생략하면 에러가 난다.')

/**
 * log_read가 limit을 생략했을 때 쓰는 기본 줄 수, 그리고 인자로도 넘을 수 없는 상한.
 * 응답 크기는 이 mcpTools 층이 소유하지만(스펙 "응답 크기 규칙"), 값 자체는
 * `AndroidDevice.readLogs`(androidDevice.ts)에 이미 있는 같은 이름의 안전판과 겹친다.
 * 위층은 바로 아래층만 부른다는 층 규칙 때문에 android쪽이 여기를 import할 수 없어서,
 * 이 파일이 그쪽 상수를 그대로 재사용해 값이 둘로 갈라지지 않게 한다.
 */
export const LOG_READ_DEFAULT_LIMIT = DEFAULT_LOG_LIMIT
export const LOG_READ_MAX_LIMIT = MAX_LOG_LIMIT

/** 로그 한 줄의 message를 이 길이로 자른다. 줄 하나가 응답 예산을 통째로 먹는 것을 막는다. */
const LOG_MESSAGE_MAX_CHARS = 300

/** message가 상한을 넘으면 잘라내고, 몇 자를 버렸는지 보이는 표식을 남긴다. */
function truncateMessage(message: string): string {
  if (message.length <= LOG_MESSAGE_MAX_CHARS) return message
  const overflow = message.length - LOG_MESSAGE_MAX_CHARS
  return `${message.slice(0, LOG_MESSAGE_MAX_CHARS)}…(+${overflow}자)`
}

/**
 * `LogLine`을 사람이 읽는 한 줄로 압축한다. 키 이름을 반복하는 pretty JSON 대신
 * `MM-DD HH:MM:SS.mmm L tag(pid): message` 형태로 써서 응답 크기를 줄인다.
 * 구조화된 형태가 필요한 쪽(renderer, 장차 M3)은 `AndroidDevice.readLogs`를 직접 쓴다.
 */
function formatLogLine(line: LogLine): string {
  return `${line.timestamp} ${line.level} ${line.tag}(${line.pid}): ${truncateMessage(line.message)}`
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
        '("MM-DD HH:MM:SS.mmm L tag(pid): message" 형태). 긴 message는 잘리고 "…(+N자)"로 얼마나 잘렸는지 표시된다.',
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

        return {
          lines: result.lines.map(formatLogLine),
          truncated: result.truncated,
          droppedCount: result.droppedCount
        }
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
