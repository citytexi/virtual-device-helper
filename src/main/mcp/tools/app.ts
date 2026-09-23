import { z } from 'zod'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { runTool } from '../runTool'
import type { ToolContext } from '../toolContext'

const serial = z
  .string()
  .optional()
  .describe('대상 기기의 serial. 생략하면 활성 기기를 쓴다. 기기가 여럿인데 생략하면 에러가 난다.')

const pkg = z.string().describe('안드로이드 패키지명. 예: com.example.app')

export const SETTLE_POLL_MS = 400
export const SETTLE_DEFAULT_TIMEOUT_MS = 8_000

/**
 * 첫 화면이 안정됐는지 본다. UI 덤프의 요소 구성이 연속 두 번 같으면 안정으로 본다.
 * 고정 대기보다 빠르고, 로그 신호보다 앱에 덜 의존한다.
 * 스펙의 열린 질문이므로 실제 앱으로 검증한 뒤 필요하면 기준을 바꾼다.
 *
 * previous는 "아직 첫 덤프가 없다"를 뜻하는 null로 시작한다. 빈 문자열로 시작하면
 * dump()가 빈 배열을 돌려줄 때 그 지문도 빈 문자열이라 첫 덤프 단 한 번만으로
 * "이전과 같다"고 오판한다 — 스플래시 화면이 전부 걸러지는 앱 실행 직후가 그 경우다.
 */
export async function waitForSettle(
  dump: () => Promise<Array<{ resourceId: string | null; text: string | null }>>,
  timeoutMs: number,
  sleep: (ms: number) => Promise<void>,
  now: () => number
): Promise<{ settled: boolean; nodeCount: number }> {
  const deadline = now() + timeoutMs
  let previous: string | null = null
  let nodeCount = 0

  while (now() < deadline) {
    const nodes = await dump()
    nodeCount = nodes.length
    const fingerprint = nodes.map((node) => `${node.resourceId ?? ''}|${node.text ?? ''}`).join('\n')

    if (previous !== null && fingerprint === previous) return { settled: true, nodeCount }

    previous = fingerprint
    await sleep(SETTLE_POLL_MS)
  }

  return { settled: false, nodeCount }
}

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

  server.registerTool(
    'app_reset_and_launch',
    {
      description:
        '앱을 강제 종료하고 데이터를 지운 뒤 다시 실행하고, 첫 화면이 안정될 때까지 기다린다. 매번 같은 조건에서 테스트를 시작할 때 쓴다.',
      inputSchema: {
        pkg,
        serial
      }
    },
    async (args) =>
      runTool(context, 'app_reset_and_launch', args, async () => {
        const device = context.registry.resolve(args.serial)

        return context.registry.run(device.serial, async () => {
          await device.stop(args.pkg)
          await device.clearData(args.pkg)
          await device.launch(args.pkg)

          const settle = await waitForSettle(
            () => device.dumpUi(),
            SETTLE_DEFAULT_TIMEOUT_MS,
            (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
            () => Date.now()
          )

          return { pkg: args.pkg, ...settle }
        })
      })
  )
}
