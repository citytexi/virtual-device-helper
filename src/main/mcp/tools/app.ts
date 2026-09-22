import { z } from 'zod'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { runTool } from '../runTool'
import type { ToolContext } from '../toolContext'

const serial = z
  .string()
  .optional()
  .describe('대상 기기의 serial. 생략하면 활성 기기를 쓴다.')

const pkg = z.string().describe('안드로이드 패키지명. 예: com.example.app')

export function registerAppTools(server: McpServer, context: ToolContext): void {
  server.registerTool(
    'app_install',
    {
      description:
        'APK를 기기에 설치하고 설치된 패키지명을 돌려준다. 호스트의 절대 경로를 준다.',
      inputSchema: {
        apkPath: z.string().describe('호스트에 있는 .apk 파일의 절대 경로'),
        reinstall: z.boolean().optional().describe('이미 설치돼 있으면 데이터를 유지한 채 덮어쓴다'),
        serial
      }
    },
    async (args) =>
      runTool(context, 'app_install', args, async () => {
        const device = context.registry.resolve(args.serial)
        const installed = await context.registry.run(device.serial, () =>
          device.install(args.apkPath, { reinstall: args.reinstall })
        )
        return { pkg: installed }
      })
  )

  server.registerTool(
    'app_uninstall',
    {
      description:
        '패키지를 기기에서 완전히 지운다. 재설치 전에 깨끗한 상태로 되돌릴 때 쓴다.',
      inputSchema: { pkg, serial }
    },
    async (args) =>
      runTool(context, 'app_uninstall', args, async () => {
        const device = context.registry.resolve(args.serial)
        await context.registry.run(device.serial, () => device.uninstall(args.pkg))
        return { pkg: args.pkg, uninstalled: true }
      })
  )

  server.registerTool(
    'app_launch',
    {
      description:
        '앱을 실행한다. activity를 생략하면 런처 진입점을 찾아 실행한다. 설치 직후에는 보통 생략한다.',
      inputSchema: {
        pkg,
        activity: z.string().optional().describe('액티비티 이름. 예: .MainActivity'),
        serial
      }
    },
    async (args) =>
      runTool(context, 'app_launch', args, async () => {
        const device = context.registry.resolve(args.serial)
        await context.registry.run(device.serial, () => device.launch(args.pkg, args.activity))
        return { pkg: args.pkg, launched: true }
      })
  )

  server.registerTool(
    'app_stop',
    {
      description:
        '앱을 강제 종료한다. 프로세스를 정리하고 처음부터 다시 실행하고 싶을 때 쓴다.',
      inputSchema: { pkg, serial }
    },
    async (args) =>
      runTool(context, 'app_stop', args, async () => {
        const device = context.registry.resolve(args.serial)
        await context.registry.run(device.serial, () => device.stop(args.pkg))
        return { pkg: args.pkg, stopped: true }
      })
  )

  server.registerTool(
    'app_clear_data',
    {
      description: '앱의 저장 데이터를 지운다. 첫 실행 상태로 되돌릴 때 쓴다.',
      inputSchema: { pkg, serial }
    },
    async (args) =>
      runTool(context, 'app_clear_data', args, async () => {
        const device = context.registry.resolve(args.serial)
        await context.registry.run(device.serial, () => device.clearData(args.pkg))
        return { pkg: args.pkg, cleared: true }
      })
  )

  server.registerTool(
    'app_grant_permission',
    {
      description:
        '런타임 권한을 부여한다. 권한 요청 다이얼로그를 눌러 넘기는 대신 미리 줄 때 쓴다.',
      inputSchema: {
        pkg,
        permission: z.string().describe('권한 이름. 예: android.permission.CAMERA'),
        serial
      }
    },
    async (args) =>
      runTool(context, 'app_grant_permission', args, async () => {
        const device = context.registry.resolve(args.serial)
        await context.registry.run(device.serial, () =>
          device.grantPermission(args.pkg, args.permission)
        )
        return { pkg: args.pkg, permission: args.permission, granted: true }
      })
  )
}
