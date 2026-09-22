import { connect } from 'node:net'
import { networkInterfaces } from 'node:os'
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

/** 이 머신의 loopback이 아닌 IPv4 주소 하나. 없는 환경(예: CI 컨테이너)이면 null. */
function nonLoopbackIPv4(): string | null {
  for (const entries of Object.values(networkInterfaces())) {
    for (const entry of entries ?? []) {
      if (entry.family === 'IPv4' && !entry.internal) return entry.address
    }
  }
  return null
}

/** TCP 연결 자체가 되는지만 본다. 되면 'connected', 거부/타임아웃되면 'refused'. */
function tryConnect(host: string, port: number): Promise<'connected' | 'refused'> {
  return new Promise((resolve) => {
    const socket = connect({ host, port, timeout: 500 })
    const settle = (result: 'connected' | 'refused'): void => {
      socket.destroy()
      resolve(result)
    }
    socket.once('connect', () => settle('connected'))
    socket.once('error', () => settle('refused'))
    socket.once('timeout', () => settle('refused'))
  })
}

/**
 * 본문을 다 보내지 않고 소켓을 끊는다. 서버가 이 도중 끊김을 unhandled rejection으로
 * 흘리는지(Finding 1 회귀) 볼 때 쓴다.
 */
function sendPartialBodyThenAbort(port: number, token: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const socket = connect(port, '127.0.0.1', () => {
      const partialBody = '{"incomplete":'
      const request = [
        'POST /mcp HTTP/1.1',
        'Host: 127.0.0.1',
        'Content-Type: application/json',
        'Accept: application/json, text/event-stream',
        `Authorization: Bearer ${token}`,
        'Content-Length: 1000',
        'Connection: close',
        '',
        partialBody
      ].join('\r\n')
      socket.write(request)
      // 서버가 헤더를 파싱하고 본문 읽기를 시작할 시간을 준 뒤 끊는다.
      setTimeout(() => {
        socket.destroy()
        resolve()
      }, 50)
    })
    socket.once('error', () => resolve())
    socket.setTimeout(2000, () => {
      socket.destroy()
      reject(new Error('timed out waiting to send partial body'))
    })
  })
}

describe('startMcpHttpServer binding', () => {
  it('binds to loopback only', async () => {
    handle = await startMcpHttpServer({ context: fakeContext() })

    expect(handle.url.startsWith('http://127.0.0.1:')).toBe(true)

    await expect(fetch(`http://127.0.0.1:${handle.port}/mcp`, { method: 'GET' })).resolves.toBeDefined()
  })

  it('refuses TCP connections on a non-loopback interface', async () => {
    const externalAddress = nonLoopbackIPv4()
    if (!externalAddress) {
      // 이 환경에 loopback 아닌 IPv4 인터페이스가 없다 (예: 격리된 CI 컨테이너). 검증할
      // 대상 자체가 없으므로 건너뛴다.
      return
    }

    handle = await startMcpHttpServer({ context: fakeContext() })

    const result = await tryConnect(externalAddress, handle.port)

    expect(result).toBe('refused')
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

  it('rejects an Origin header even when its value is empty', async () => {
    handle = await startMcpHttpServer({ context: fakeContext() })

    // 헤더가 "있고" 값이 빈 문자열인 경우다. `if (headers.origin)`은 이 값을 falsy로 봐서
    // 통과시켰던 버그가 있었다 — 헤더의 "존재"만으로 거부해야 한다.
    const response = await post(`${handle.url}`, { authorization: `Bearer ${handle.token}`, origin: '' }, initialize)

    expect(response.status).toBe(403)
  })

  it('does not reject when the Origin header is entirely absent', async () => {
    handle = await startMcpHttpServer({ context: fakeContext() })

    // 대조군: 헤더 자체가 없으면(undefined) Origin 검사를 통과해야 한다.
    const response = await post(`${handle.url}`, { authorization: `Bearer ${handle.token}` }, initialize)

    expect(response.status).toBeLessThan(400)
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

describe('startMcpHttpServer client aborts', () => {
  it('does not crash the process when a client sends a partial body and disconnects', async () => {
    handle = await startMcpHttpServer({ context: fakeContext() })

    const rejections: unknown[] = []
    const onUnhandledRejection = (reason: unknown): void => {
      rejections.push(reason)
    }
    process.on('unhandledRejection', onUnhandledRejection)

    try {
      await sendPartialBodyThenAbort(handle.port, handle.token)
      // 이벤트 루프에 두 틱을 더 줘서, readBody의 for-await가 ECONNRESET으로 reject되고
      // 그것이 (고쳐지지 않았다면) unhandledRejection으로 표면화될 시간을 준다.
      await new Promise((resolve) => setImmediate(resolve))
      await new Promise((resolve) => setTimeout(resolve, 50))
    } finally {
      process.removeListener('unhandledRejection', onUnhandledRejection)
    }

    expect(rejections).toEqual([])

    // 서버 자체는 이 요청 하나가 끊겼다고 죽지 않고 계속 응답해야 한다.
    const response = await post(`${handle.url}`, { authorization: `Bearer ${handle.token}` }, initialize)
    expect(response.status).toBeLessThan(500)
  })
})
