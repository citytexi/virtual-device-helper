import { z } from 'zod'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { runTool } from '../runTool'
import type { ToolContext } from '../toolContext'

const serial = z
  .string()
  .optional()
  .describe('대상 기기의 serial. 생략하면 활성 기기를 쓴다. 기기가 여럿인데 생략하면 에러가 난다.')

/** log_read가 limit을 생략했을 때 쓰는 기본 줄 수. */
export const LOG_READ_DEFAULT_LIMIT = 200
/** log_read가 인자로도 넘을 수 없는 상한. ui.ts의 UI_FIND_MAX_NODES와 같은 패턴이다. */
export const LOG_READ_MAX_LIMIT = 2000

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
        'logcat을 읽는다. 기본 줄 수 제한이 있고 인자로도 상한을 넘을 수 없다. 잘리면 truncated가 true로 온다 — 그때는 filter로 좁혀서 다시 불러라.',
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

        return context.registry.run(device.serial, () => device.readLogs(opts))
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
