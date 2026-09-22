import { z } from 'zod'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { runTool } from '../runTool'
import type { ToolContext } from '../toolContext'

const serial = z
  .string()
  .optional()
  .describe('대상 기기의 serial. 생략하면 활성 기기를 쓴다. 기기가 여럿인데 생략하면 에러가 난다.')

/** 한 번에 돌려줄 요소 수 상한. 긴 목록 화면에서 응답이 폭발하는 것을 막는다. */
export const UI_FIND_MAX_NODES = 60

export function registerUiTools(server: McpServer, context: ToolContext): void {
  server.registerTool(
    'ui_tap',
    {
      description: '화면 좌표를 누른다. 좌표는 ui_find가 돌려준 x, y를 그대로 쓴다.',
      inputSchema: {
        x: z.number().describe('가로 좌표 (픽셀)'),
        y: z.number().describe('세로 좌표 (픽셀)'),
        serial
      }
    },
    async (args) =>
      runTool(context, 'ui_tap', args, async () => {
        const device = context.registry.resolve(args.serial)
        await context.registry.run(device.serial, () => device.tap(args.x, args.y))
        return { tapped: { x: args.x, y: args.y } }
      })
  )

  server.registerTool(
    'ui_swipe',
    {
      description: '한 좌표에서 다른 좌표로 스와이프한다. 스크롤에 쓴다.',
      inputSchema: {
        x1: z.number().describe('시작 가로 좌표'),
        y1: z.number().describe('시작 세로 좌표'),
        x2: z.number().describe('끝 가로 좌표'),
        y2: z.number().describe('끝 세로 좌표'),
        durationMs: z.number().describe('스와이프에 걸리는 시간(밀리초). 보통 300 정도'),
        serial
      }
    },
    async (args) =>
      runTool(context, 'ui_swipe', args, async () => {
        const device = context.registry.resolve(args.serial)
        await context.registry.run(device.serial, () =>
          device.swipe(args.x1, args.y1, args.x2, args.y2, args.durationMs)
        )
        return { swiped: true }
      })
  )

  server.registerTool(
    'ui_text',
    {
      description:
        '지금 포커스된 입력 필드에 텍스트를 넣는다. 먼저 ui_tap으로 필드를 눌러 포커스를 줘야 한다. ASCII만 보낼 수 있다.',
      inputSchema: { text: z.string().describe('입력할 텍스트 (ASCII)'), serial }
    },
    async (args) =>
      runTool(context, 'ui_text', args, async () => {
        const device = context.registry.resolve(args.serial)
        await context.registry.run(device.serial, () => device.inputText(args.text))
        return { typed: true }
      })
  )

  server.registerTool(
    'ui_key',
    {
      description: '하드웨어 키를 누른다. back, home, enter, tab 중 하나를 고른다.',
      inputSchema: {
        name: z.enum(['back', 'home', 'enter', 'tab']).describe('누를 키 이름'),
        serial
      }
    },
    async (args) =>
      runTool(context, 'ui_key', args, async () => {
        const device = context.registry.resolve(args.serial)
        await context.registry.run(device.serial, () => device.pressKey(args.name))
        return { pressed: args.name }
      })
  )

  server.registerTool(
    'ui_find',
    {
      description:
        '지금 화면의 요소 목록을 돌려준다. 각 요소는 누를 수 있는 중심 좌표를 가지므로 받은 x, y를 ui_tap에 그대로 넣으면 된다. 화면을 조작하기 전에 먼저 부른다.',
      inputSchema: {
        query: z
          .string()
          .optional()
          .describe('텍스트·설명·id에 대한 부분일치 필터. 대소문자를 가리지 않는다.'),
        serial
      }
    },
    async (args) =>
      runTool(context, 'ui_find', args, async () => {
        const device = context.registry.resolve(args.serial)
        const all = await context.registry.run(device.serial, () => device.dumpUi())

        const needle = args.query?.toLowerCase()
        const matched = needle
          ? all.filter((node) =>
              `${node.text ?? ''}\n${node.contentDesc ?? ''}\n${node.resourceId ?? ''}`
                .toLowerCase()
                .includes(needle)
            )
          : all

        const kept = matched.slice(0, UI_FIND_MAX_NODES)

        return {
          nodes: kept.map((node, index) => ({ ...node, index })),
          truncated: matched.length > kept.length,
          droppedCount: matched.length - kept.length
        }
      })
  )
}
