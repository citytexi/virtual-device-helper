import { z } from 'zod'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import type { Device } from '../../../shared/types/device'
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
        '사용할 수 있는 가상 기기(AVD·시뮬레이터) 목록과 실행 중인 기기, 현재 활성 기기를 돌려준다. 다른 툴을 쓰기 전에 먼저 부른다.',
      inputSchema: {}
    },
    async () =>
      runTool(context, 'device_list', {}, async () => ({
        virtualDevices: await context.catalog.list(),
        connected: context.registry.serials(),
        active: context.registry.getActive()
      }))
  )

  server.registerTool(
    'device_boot',
    {
      description:
        '가상 기기를 부팅하고 부팅이 끝날 때까지 기다린 뒤 기기 정보를 돌려준다. id는 device_list의 virtualDevices[].id로 확인한다.',
      inputSchema: { id: z.string().describe('부팅할 가상 기기의 id. device_list의 virtualDevices[].id') }
    },
    async ({ id }) => {
      let target: Device | null = null
      return runTool(
        context,
        'device_boot',
        { id },
        async () => {
          const serial = await context.catalog.boot(id)
          const device = context.registry.resolve(serial)
          target = device
          return device.info()
        },
        { serial: () => target?.serial }
      )
    }
  )

  server.registerTool(
    'device_shutdown',
    {
      description: '실행 중인 에뮬레이터를 종료한다. serial을 생략하면 활성 기기를 끈다.',
      inputSchema: serialArg
    },
    async ({ serial }) => {
      let target: Device | null = null
      // 여기서만 context.registry.run(...) 직렬화 큐를 의도적으로 건너뛰고 context.catalog.shutdown을
      // 바로 부른다. device_shutdown은 device_unresponsive 에러의 복구 경로이기 때문이다.
      // 큐에 줄을 세우면 이미 막혀 있는 명령 뒤에서 종료 명령까지 같은 타임아웃만큼 늦어져
      // 복구 자체가 안 된다. "빠진 직렬화"로 보고 큐에 넣지 마라.
      return runTool(
        context,
        'device_shutdown',
        { serial },
        async () => {
          const device = context.registry.resolve(serial)
          target = device
          await context.catalog.shutdown(device.serial, device.platform)
          return { serial: device.serial, shutdown: true }
        },
        { serial: () => target?.serial }
      )
    }
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
      description: '기기의 플랫폼, 모델명, OS 버전, 화면 크기를 돌려준다. 좌표를 계산하기 전에 쓴다.',
      inputSchema: serialArg
    },
    async ({ serial }) => {
      let target: Device | null = null
      return runTool(
        context,
        'device_info',
        { serial },
        async () => {
          const device = context.registry.resolve(serial)
          target = device
          return context.registry.run(device.serial, () => device.info())
        },
        { serial: () => target?.serial }
      )
    }
  )
}
