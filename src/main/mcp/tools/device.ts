import { z } from 'zod'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { runTool } from '../runTool'
import type { ToolContext } from '../toolContext'

const serialArg = {
  serial: z
    .string()
    .optional()
    .describe('대상 기기의 serial. 생략하면 활성 기기를 쓴다. 기기가 여럿인데 생략하면 에러가 난다.')
}

export function registerDeviceTools(server: McpServer, context: ToolContext): void {
  server.registerTool(
    'device_list',
    {
      description:
        '사용할 수 있는 AVD 목록과 실행 중인 기기, 현재 활성 기기를 돌려준다. 다른 툴을 쓰기 전에 먼저 부른다.',
      inputSchema: {}
    },
    async () =>
      runTool(context, 'device_list', {}, async () => ({
        avds: await context.avd.list(),
        connected: context.registry.serials(),
        active: context.registry.getActive()
      }))
  )

  server.registerTool(
    'device_boot',
    {
      description:
        'AVD를 부팅하고 부팅이 끝날 때까지 기다린 뒤 기기 정보를 돌려준다. 이름은 device_list로 확인한다.',
      inputSchema: { avd: z.string().describe('부팅할 AVD 이름') }
    },
    async ({ avd }) =>
      runTool(context, 'device_boot', { avd }, async () => {
        const serial = await context.avd.boot(avd)
        return context.registry.resolve(serial).info()
      })
  )

  server.registerTool(
    'device_shutdown',
    {
      description: '실행 중인 에뮬레이터를 종료한다. serial을 생략하면 활성 기기를 끈다.',
      inputSchema: serialArg
    },
    async ({ serial }) =>
      runTool(context, 'device_shutdown', { serial }, async () => {
        const device = context.registry.resolve(serial)
        await context.avd.shutdown(device.serial)
        return { serial: device.serial, shutdown: true }
      })
  )

  server.registerTool(
    'device_select',
    {
      description:
        '활성 기기를 정한다. 이후 serial을 생략한 툴 호출은 모두 이 기기로 간다.',
      inputSchema: { serial: z.string().describe('활성으로 삼을 기기의 serial') }
    },
    async ({ serial }) =>
      runTool(context, 'device_select', { serial }, () => {
        context.registry.setActive(serial)
        return { active: serial }
      })
  )

  server.registerTool(
    'device_info',
    {
      description: '기기의 모델명, API 레벨, 화면 크기를 돌려준다. 좌표를 계산하기 전에 쓴다.',
      inputSchema: serialArg
    },
    async ({ serial }) =>
      runTool(context, 'device_info', { serial }, async () => {
        const device = context.registry.resolve(serial)
        return context.registry.run(device.serial, () => device.info())
      })
  )
}
