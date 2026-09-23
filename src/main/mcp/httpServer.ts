import { randomBytes, timingSafeEqual } from 'node:crypto'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import { MCP_SERVER_NAME, serverInstructions } from '../../shared/agentGuide'
import { registerTools } from './registerTools'
import type { ToolContext } from './toolContext'

export const DEFAULT_PORT = 9321
export const MAX_PORT_ATTEMPTS = 20
const MCP_PATH = '/mcp'
const SERVER_INFO = { name: MCP_SERVER_NAME, version: '0.0.0' }

export interface McpServerHandle {
  /** 클라이언트 설정에 그대로 넣는 주소. */
  url: string
  port: number
  token: string
  close(): Promise<void>
}

export interface StartMcpHttpServerOpts {
  context: ToolContext
  preferredPort?: number
}

function constantTimeEquals(a: string, b: string): boolean {
  const left = Buffer.from(a)
  const right = Buffer.from(b)
  if (left.length !== right.length) return false
  return timingSafeEqual(left, right)
}

function listenOn(server: Server, port: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const onError = (error: NodeJS.ErrnoException): void => {
      server.removeListener('listening', onListening)
      reject(error)
    }
    const onListening = (): void => {
      server.removeListener('error', onError)
      resolve()
    }
    server.once('error', onError)
    server.once('listening', onListening)
    // 루프백에만 묶는다. 외부 바인드 옵션을 만들지 않는다.
    server.listen(port, '127.0.0.1')
  })
}

async function readBody(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = []
  for await (const chunk of request) chunks.push(chunk as Buffer)
  const text = Buffer.concat(chunks).toString('utf8')
  if (!text) return undefined
  try {
    return JSON.parse(text) as unknown
  } catch {
    return undefined
  }
}

function deny(response: ServerResponse, status: number, message: string): void {
  response.writeHead(status, { 'content-type': 'application/json' })
  response.end(JSON.stringify({ error: message }))
}

// 클라이언트가 요청 도중(예: 본문을 다 보내지 않고) 소켓을 끊으면 readBody나
// transport.handleRequest가 reject된다. 여기서 받지 않으면 Electron main 프로세스에서
// unhandled rejection이 나 앱이 죽을 수 있다.
function failSafely(response: ServerResponse): void {
  if (response.headersSent || response.writableEnded) {
    response.destroy()
    return
  }
  try {
    deny(response, 500, 'internal error')
  } catch {
    response.destroy()
  }
}

export async function startMcpHttpServer(opts: StartMcpHttpServerOpts): Promise<McpServerHandle> {
  const token = randomBytes(32).toString('base64url')

  const server = createServer((request, response) => {
    handle(request, response).catch(() => failSafely(response))
  })

  async function handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    // Origin 헤더가 존재하면 값과 상관없이(빈 문자열 포함) 거부한다. 브라우저 클라이언트를
    // 지원하지 않으므로 헤더의 존재 자체가 거부 사유다. DNS rebinding을 막는다.
    if (request.headers.origin !== undefined) {
      deny(response, 403, 'browser origins are not accepted')
      return
    }

    const authorization = request.headers.authorization ?? ''
    const presented = authorization.startsWith('Bearer ') ? authorization.slice('Bearer '.length) : ''
    if (!presented || !constantTimeEquals(presented, token)) {
      deny(response, 401, 'invalid or missing token')
      return
    }

    const path = (request.url ?? '').split('?')[0]
    if (path !== MCP_PATH) {
      deny(response, 404, 'not found')
      return
    }

    // 상태를 두지 않는다. 기기 상태는 DeviceRegistry에 있어 세션에 둘 것이 없다.
    // instructions는 Claude Code 같은 클라이언트가 에이전트 컨텍스트에 넣는다 — 툴 사용 규칙이다.
    const mcp = new McpServer(SERVER_INFO, { instructions: serverInstructions() })
    registerTools(mcp, opts.context)

    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined })
    response.on('close', () => {
      // 연결이 도중에 끊긴 뒤라 close()가 실패해도 요청 처리와는 무관하다 — 조용히 삼킨다.
      transport.close().catch(() => {})
      mcp.close().catch(() => {})
    })

    await mcp.connect(transport)
    await transport.handleRequest(request, response, await readBody(request))
  }

  const first = opts.preferredPort ?? DEFAULT_PORT
  let bound = false

  for (let attempt = 0; attempt < MAX_PORT_ATTEMPTS; attempt += 1) {
    try {
      await listenOn(server, first + attempt)
      bound = true
      break
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EADDRINUSE') throw error
    }
  }

  if (!bound) {
    throw new Error(`포트 ${first}부터 ${MAX_PORT_ATTEMPTS}개를 시도했지만 모두 사용 중이다`)
  }

  const address = server.address()
  const port = typeof address === 'object' && address !== null ? address.port : first

  return {
    url: `http://127.0.0.1:${port}${MCP_PATH}`,
    port,
    token,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.closeAllConnections?.()
        server.close((error) => (error ? reject(error) : resolve()))
      })
  }
}
