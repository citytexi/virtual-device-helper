import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { MCP_SERVER_NAME, serverInstructions } from '../../shared/agentGuide'
import { registerTools } from './registerTools'
import type { ToolCallRecord, ToolContext } from './toolContext'

export interface ToolHarness {
  client: Client
  records: ToolCallRecord[]
  /** 툴 하나를 부르고 파싱된 JSON 페이로드를 돌려준다. */
  call(tool: string, args?: Record<string, unknown>): Promise<unknown>
  /** 실패를 기대할 때 쓴다. ToolError 형태를 그대로 돌려준다. */
  callExpectingError(tool: string, args?: Record<string, unknown>): Promise<{ kind: string; hint: string }>
  raw(tool: string, args?: Record<string, unknown>): Promise<{ content: unknown[]; isError?: boolean }>
  close(): Promise<void>
}

/**
 * HTTP를 띄우지 않고 툴 호출 전 경로를 돌린다.
 * 전송은 인메모리라 포트도 인증도 끼어들지 않는다.
 */
export async function createToolHarness(
  context: Omit<ToolContext, 'onToolCall'>
): Promise<ToolHarness> {
  const records: ToolCallRecord[] = []
  const server = new McpServer(
    { name: MCP_SERVER_NAME, version: '0.0.0' },
    { instructions: serverInstructions() }
  )

  registerTools(server, { ...context, onToolCall: (record) => records.push(record) })

  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
  const client = new Client({ name: 'test', version: '0.0.0' })

  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)])

  async function raw(tool: string, args: Record<string, unknown> = {}) {
    return (await client.callTool({ name: tool, arguments: args })) as {
      content: unknown[]
      isError?: boolean
    }
  }

  return {
    client,
    records,
    raw,
    async call(tool, args = {}) {
      const result = await raw(tool, args)
      const first = result.content[0] as { type: string; text?: string }
      if (result.isError) throw new Error(`tool ${tool} failed: ${first.text}`)
      return first.text ? (JSON.parse(first.text) as unknown) : result.content
    },
    async callExpectingError(tool, args = {}) {
      const result = await raw(tool, args)
      const first = result.content[0] as { text: string }
      if (!result.isError) throw new Error(`tool ${tool} unexpectedly succeeded`)
      return JSON.parse(first.text) as { kind: string; hint: string }
    },
    async close() {
      await client.close()
      await server.close()
    }
  }
}
