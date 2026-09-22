import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { registerDeviceTools } from './tools/device'
import { registerAppTools } from './tools/app'
import { registerUiTools } from './tools/ui'
import type { ToolContext } from './toolContext'

/**
 * 툴을 한 서버에 묶는다. 묶음별 등록 함수는 Task 2~6에서 채운다.
 * 순서는 스펙의 표 순서와 같게 유지한다 — 툴 목록이 그 순서로 노출된다.
 */
export function registerTools(server: McpServer, context: ToolContext): void {
  registerDeviceTools(server, context)
  registerAppTools(server, context)
  registerUiTools(server, context)
}
