import { z } from 'zod'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import type { Device, DisplayFrame } from '../../../shared/types/device'
import { runTool } from '../runTool'
import type { ToolContext } from '../toolContext'
import { DEFAULT_SWIPE_MS, centerOf, round4, swipeWithin, toPixel, type Direction, type NormalizedPoint } from '../coordinates'
import { formatRef, nodeRefs } from '../nodeRefs'

const serial = z
  .string()
  .optional()
  .describe('대상 기기의 serial. 생략하면 활성 기기를 쓴다. 기기가 여럿인데 생략하면 에러가 난다.')

/** 정규화 좌표 필드. 디스플레이 전체 크기 기준 0..1이다. */
const coord = z.number().min(0).max(1)

/** 한 번에 돌려줄 요소 수 상한. 긴 목록 화면에서 응답이 폭발하는 것을 막는다. */
export const UI_FIND_MAX_NODES = 60

export function registerUiTools(server: McpServer, context: ToolContext): void {
  server.registerTool(
    'ui_tap',
    {
      description: 'ui_find의 ref를 먼저 쓴다. 노드가 없는 화면에서만 0..1 좌표를 쓴다.',
      inputSchema: z
        .object({
          ref: z.string().optional().describe('ui_find가 돌려준 ref. 있으면 좌표 대신 이 노드의 중심을 탭한다'),
          x: coord.optional().describe('가로 좌표 (0..1, 디스플레이 전체 기준). ref가 없을 때만 쓴다'),
          y: coord.optional().describe('세로 좌표 (0..1, 디스플레이 전체 기준). ref가 없을 때만 쓴다'),
          serial
        })
        .superRefine((data, ctx) => {
          const hasRef = data.ref !== undefined
          const hasCoords = data.x !== undefined || data.y !== undefined
          if (hasRef && hasCoords) {
            ctx.addIssue({ code: 'custom', message: 'ref와 x·y 좌표를 동시에 줄 수 없다' })
          } else if (!hasRef && !(data.x !== undefined && data.y !== undefined)) {
            ctx.addIssue({ code: 'custom', message: 'ref 또는 x·y 좌표 쌍 중 하나를 줘야 한다' })
          }
        })
    },
    async (args) => {
      // 핸들러가 고른 기기·좌표를 gesture도 쓴다. 다시 resolve하면 그사이 활성 기기가 바뀔 수 있다.
      let target: Device | null = null
      let point: NormalizedPoint | null = null
      return runTool(
        context,
        'ui_tap',
        args,
        async () => {
          const device = context.registry.resolve(args.serial)
          target = device
          return context.registry.run(device.serial, async () => {
            let frame: DisplayFrame
            let resolvedPoint: NormalizedPoint
            if (args.ref !== undefined) {
              const resolved = await nodeRefs.resolve(device, args.ref)
              resolvedPoint = centerOf(resolved.node.bounds)
              frame = resolved.frame
            } else {
              // 캐스팅 전 원본 값을 소수 4자리로 반올림한다 — 좌표 경로도 ref 경로처럼
              // 응답·gesture가 4자리를 넘지 않게 맞춘다.
              resolvedPoint = { x: round4(args.x as number), y: round4(args.y as number) }
              frame = await device.displayFrame()
            }
            point = resolvedPoint
            const pixel = toPixel(resolvedPoint, frame)
            await device.tap(pixel.x, pixel.y)
            return { tapped: { ref: args.ref, x: resolvedPoint.x, y: resolvedPoint.y } }
          })
        },
        {
          gesture: async () => {
            if (!target || !point) return undefined
            return { kind: 'tap', serial: target.serial, x: point.x, y: point.y }
          }
        }
      )
    }
  )

  server.registerTool(
    'ui_swipe',
    {
      description: 'ui_find의 ref로 그 노드 안에서 스크롤하거나, 노드가 없는 화면에서 두 좌표 사이를 스와이프한다.',
      inputSchema: z
        .object({
          ref: z.string().optional().describe('ui_find가 돌려준, 스크롤할 노드의 ref'),
          direction: z
            .enum(['up', 'down', 'left', 'right'])
            .optional()
            .describe('보고 싶은 쪽. down은 아래 콘텐츠를 본다(손가락은 위로). ref와 함께 쓴다'),
          x1: coord.optional().describe('시작 가로 좌표 (0..1). ref가 없을 때만 쓴다'),
          y1: coord.optional().describe('시작 세로 좌표 (0..1). ref가 없을 때만 쓴다'),
          x2: coord.optional().describe('끝 가로 좌표 (0..1). ref가 없을 때만 쓴다'),
          y2: coord.optional().describe('끝 세로 좌표 (0..1). ref가 없을 때만 쓴다'),
          durationMs: z
            .number()
            .optional()
            .describe('스와이프에 걸리는 시간(밀리초). 좌표 경로는 필수다. ref 경로는 생략하면 300'),
          serial
        })
        .superRefine((data, ctx) => {
          const hasRef = data.ref !== undefined
          const hasAnyCoord =
            data.x1 !== undefined || data.y1 !== undefined || data.x2 !== undefined || data.y2 !== undefined
          const hasAllCoords =
            data.x1 !== undefined && data.y1 !== undefined && data.x2 !== undefined && data.y2 !== undefined

          if (hasRef && hasAnyCoord) {
            ctx.addIssue({ code: 'custom', message: 'ref와 좌표를 동시에 줄 수 없다' })
            return
          }
          if (hasRef) {
            if (data.direction === undefined) {
              ctx.addIssue({ code: 'custom', message: 'ref 경로는 direction이 필요하다' })
            }
            return
          }
          if (!hasAllCoords) {
            ctx.addIssue({ code: 'custom', message: 'ref 또는 x1·y1·x2·y2 좌표 네 개를 모두 줘야 한다' })
            return
          }
          if (data.durationMs === undefined) {
            ctx.addIssue({ code: 'custom', message: '좌표 경로는 durationMs가 필요하다' })
            return
          }
          if (data.direction !== undefined) {
            ctx.addIssue({ code: 'custom', message: 'direction은 ref 경로에서만 쓴다' })
          }
        })
    },
    async (args) => {
      let target: Device | null = null
      let from: NormalizedPoint | null = null
      let to: NormalizedPoint | null = null
      return runTool(
        context,
        'ui_swipe',
        args,
        async () => {
          const device = context.registry.resolve(args.serial)
          target = device
          return context.registry.run(device.serial, async () => {
            let frame: DisplayFrame
            let fromPoint: NormalizedPoint
            let toPoint: NormalizedPoint
            let durationMs: number
            if (args.ref !== undefined) {
              const resolved = await nodeRefs.resolve(device, args.ref)
              const trajectory = swipeWithin(resolved.node.bounds, args.direction as Direction)
              fromPoint = trajectory.from
              toPoint = trajectory.to
              frame = resolved.frame
              durationMs = args.durationMs ?? DEFAULT_SWIPE_MS
            } else {
              // 캐스팅 전 원본 값을 소수 4자리로 반올림한다 — 좌표 경로도 ref 경로처럼
              // 응답·gesture가 4자리를 넘지 않게 맞춘다.
              fromPoint = { x: round4(args.x1 as number), y: round4(args.y1 as number) }
              toPoint = { x: round4(args.x2 as number), y: round4(args.y2 as number) }
              frame = await device.displayFrame()
              durationMs = args.durationMs as number
            }
            from = fromPoint
            to = toPoint
            const p1 = toPixel(fromPoint, frame)
            const p2 = toPixel(toPoint, frame)
            await device.swipe(p1.x, p1.y, p2.x, p2.y, durationMs)
            return {
              swiped: { ref: args.ref, x1: fromPoint.x, y1: fromPoint.y, x2: toPoint.x, y2: toPoint.y }
            }
          })
        },
        {
          gesture: async () => {
            if (!target || !from || !to) return undefined
            return { kind: 'swipe', serial: target.serial, x1: from.x, y1: from.y, x2: to.x, y2: to.y }
          }
        }
      )
    }
  )

  server.registerTool(
    'ui_text',
    {
      description:
        'ref를 주면 그 입력칸을 눌러 포커스를 준 뒤 입력한다. 생략하면 지금 포커스된 입력 필드에 바로 넣는다. ASCII만 보낼 수 있다.',
      inputSchema: {
        ref: z.string().optional().describe('ui_find가 돌려준, 포커스를 줄 입력 필드의 ref'),
        text: z.string().describe('입력할 텍스트 (ASCII)'),
        serial
      }
    },
    async (args) => {
      let target: Device | null = null
      let tapPoint: NormalizedPoint | null = null
      return runTool(
        context,
        'ui_text',
        args,
        async () => {
          const device = context.registry.resolve(args.serial)
          target = device
          return context.registry.run(device.serial, async () => {
            if (args.ref !== undefined) {
              const resolved = await nodeRefs.resolve(device, args.ref)
              const point = centerOf(resolved.node.bounds)
              const pixel = toPixel(point, resolved.frame)
              await device.tap(pixel.x, pixel.y)
              tapPoint = point
            }
            await device.inputText(args.text)
            return { typed: true, ref: args.ref }
          })
        },
        {
          gesture: async () => {
            if (!target || !tapPoint) return undefined
            return { kind: 'tap', serial: target.serial, x: tapPoint.x, y: tapPoint.y }
          }
        }
      )
    }
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
        '지금 화면의 요소 목록을 ref와 함께 돌려준다. 각 요소의 bounds는 디스플레이 전체 크기 기준 정규화 좌표(0..1)다. ' +
        'ref는 ui_tap·ui_swipe·ui_text에 그대로 넘긴다. 화면을 조작하기 전에 먼저 부른다.',
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
        const dump = await context.registry.run(device.serial, () => device.dumpUi())

        const needle = args.query?.toLowerCase()
        const matched = needle
          ? dump.nodes.filter((node) =>
              `${node.text ?? ''}\n${node.contentDesc ?? ''}\n${node.resourceId ?? ''}`
                .toLowerCase()
                .includes(needle)
            )
          : dump.nodes

        const kept = matched.slice(0, UI_FIND_MAX_NODES)

        // 세대는 필터 전 전체 덤프를 기준으로 매긴다 — parentRef가 걸러진 조상을
        // 가리킬 수 있고, ref 재해석(resolve)도 전체 덤프를 스냅샷으로 쓴다.
        const generation = nodeRefs.remember(device, dump)

        const nodes = kept.map((node) => ({
          ref: formatRef(generation, node.index),
          parentRef: node.parentIndex !== null ? formatRef(generation, node.parentIndex) : null,
          text: node.text,
          contentDesc: node.contentDesc,
          resourceId: node.resourceId,
          className: node.className,
          bounds: node.bounds,
          clickable: node.clickable,
          enabled: node.enabled,
          focused: node.focused,
          scrollable: node.scrollable
        }))

        return {
          generation,
          nodes,
          truncated: matched.length > kept.length,
          droppedCount: matched.length - kept.length
        }
      })
  )
}
