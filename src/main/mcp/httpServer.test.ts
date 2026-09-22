import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AvdController } from '../device/avdController'
import type { DeviceRegistry } from '../device/registry'
import { startMcpHttpServer, type McpServerHandle } from './httpServer'

function fakeContext() {
  const registry = {
    start: vi.fn(),
    stop: vi.fn(),
    serials: () => [],
    resolve: vi.fn(),
    setActive: vi.fn(),
    clearActive: vi.fn(),
    getActive: () => null,
    run: (_serial: string, task: () => Promise<unknown>) => task(),
    on: () => () => {}
  } as unknown as DeviceRegistry
  const avd = { list: async () => [], boot: async () => '', shutdown: async () => {} } as AvdController
  return { registry, avd, onToolCall: vi.fn() }
}

let handle: McpServerHandle | null = null

afterEach(async () => {
  await handle?.close()
  handle = null
})

async function post(
  url: string,
  headers: Record<string, string>,
  body: unknown
): Promise<{ status: number; text: string }> {
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', ...headers },
    body: JSON.stringify(body)
  })
  return { status: response.status, text: await response.text() }
}

const initialize = {
  jsonrpc: '2.0',
  id: 1,
  method: 'initialize',
  params: {
    protocolVersion: '2025-03-26',
    capabilities: {},
    clientInfo: { name: 'test', version: '0.0.0' }
  }
}

describe('startMcpHttpServer binding', () => {
  it('binds to loopback only', async () => {
    handle = await startMcpHttpServer({ context: fakeContext() })

    expect(handle.url.startsWith('http://127.0.0.1:')).toBe(true)

    await expect(fetch(`http://127.0.0.1:${handle.port}/mcp`, { method: 'GET' })).resolves.toBeDefined()
  })

  it('issues a random token long enough not to be guessed', async () => {
    handle = await startMcpHttpServer({ context: fakeContext() })

    expect(handle.token.length).toBeGreaterThanOrEqual(32)
  })

  it('moves to the next free port when the preferred one is taken', async () => {
    const first = await startMcpHttpServer({ context: fakeContext() })
    const second = await startMcpHttpServer({ context: fakeContext(), preferredPort: first.port })

    expect(second.port).not.toBe(first.port)

    await first.close()
    await second.close()
  })
})

describe('startMcpHttpServer authentication', () => {
  it('rejects a request with no Authorization header', async () => {
    handle = await startMcpHttpServer({ context: fakeContext() })

    const response = await post(`${handle.url}`, {}, initialize)

    expect(response.status).toBe(401)
  })

  it('rejects a wrong token', async () => {
    handle = await startMcpHttpServer({ context: fakeContext() })

    const response = await post(`${handle.url}`, { authorization: 'Bearer wrong' }, initialize)

    expect(response.status).toBe(401)
  })

  it('accepts the issued token', async () => {
    handle = await startMcpHttpServer({ context: fakeContext() })

    const response = await post(`${handle.url}`, { authorization: `Bearer ${handle.token}` }, initialize)

    expect(response.status).toBeLessThan(400)
  })
})

describe('startMcpHttpServer origin checking', () => {
  it('rejects any request carrying an Origin header', async () => {
    handle = await startMcpHttpServer({ context: fakeContext() })

    const response = await post(
      `${handle.url}`,
      { authorization: `Bearer ${handle.token}`, origin: 'https://evil.example' },
      initialize
    )

    expect(response.status).toBe(403)
  })

  it('rejects a localhost Origin too, since no browser client is supported', async () => {
    handle = await startMcpHttpServer({ context: fakeContext() })

    const response = await post(
      `${handle.url}`,
      { authorization: `Bearer ${handle.token}`, origin: 'http://localhost:3000' },
      initialize
    )

    expect(response.status).toBe(403)
  })
})

describe('startMcpHttpServer routing and shutdown', () => {
  it('serves MCP on /mcp and 404s everything else', async () => {
    handle = await startMcpHttpServer({ context: fakeContext() })

    const response = await post(
      `http://127.0.0.1:${handle.port}/somewhere-else`,
      { authorization: `Bearer ${handle.token}` },
      initialize
    )

    expect(response.status).toBe(404)
  })

  it('stops accepting connections after close', async () => {
    const started = await startMcpHttpServer({ context: fakeContext() })
    const { port, token } = started
    await started.close()

    await expect(
      post(`http://127.0.0.1:${port}/mcp`, { authorization: `Bearer ${token}` }, initialize)
    ).rejects.toThrow()
  })
})
