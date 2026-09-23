import { useState } from 'react'
import type { JSX } from 'react'
import type { ServerStatus } from '../../../shared/types/ipc'

export interface EndpointCardProps {
  server: ServerStatus | null
}

function configSnippet(server: ServerStatus): string {
  return JSON.stringify(
    {
      mcpServers: {
        'virtual-device-helper': {
          type: 'http',
          url: server.url,
          headers: { Authorization: `Bearer ${server.token}` }
        }
      }
    },
    null,
    2
  )
}

type CopyStatus = { ok: true } | { ok: false; message: string }

function statusText(status: CopyStatus): string {
  return status.ok ? '복사했다' : `복사하지 못했다 — ${status.message}`
}

export function EndpointCard({ server }: EndpointCardProps): JSX.Element {
  const [revealed, setRevealed] = useState(false)
  const [tokenCopyStatus, setTokenCopyStatus] = useState<CopyStatus | null>(null)
  const [configCopyStatus, setConfigCopyStatus] = useState<CopyStatus | null>(null)

  // navigator.clipboard.writeText는 reject할 수 있다(예: 창이 포커스를 잃은
  // 상태). 실패를 그냥 삼키면 사용자는 복사됐다고 믿고 붙여넣기 했을 때
  // 빈 값을 넣게 된다. 그래서 성공/실패를 항상 버튼 옆에 알린다.
  async function copy(text: string, report: (status: CopyStatus) => void): Promise<void> {
    try {
      await navigator.clipboard.writeText(text)
      report({ ok: true })
    } catch (thrown: unknown) {
      report({ ok: false, message: thrown instanceof Error ? thrown.message : String(thrown) })
    }
  }

  if (!server) {
    return (
      <section aria-label="MCP 엔드포인트" className="endpoint">
        <h2 className="endpoint-label">
          <span className="status-dot" data-state="off" aria-hidden="true" />
          MCP
        </h2>
        {/* SDK를 못 찾아서일 수도 있고, SDK는 찾았지만 서버가 뜨는 데 실패해서일
            수도 있다(원인은 main 로그에 남는다). 하나로 단정하지 않는다. */}
        <p className="endpoint-message">
          서버가 떠 있지 않다. Android SDK를 찾지 못했거나, SDK는 찾았지만 서버가 뜨는 데
          실패했을 수 있다. main 프로세스 로그를 확인해라.
        </p>
      </section>
    )
  }

  return (
    <section aria-label="MCP 엔드포인트" className="endpoint">
      <h2 className="endpoint-label">
        <span className="status-dot" data-state="on" aria-hidden="true" />
        MCP
      </h2>
      <p className="endpoint-url mono">{server.url}</p>

      {/* 토큰은 기본으로 가린다. 화면 공유나 스크린샷에 그대로 찍히면 그 포트에
          붙을 수 있는 모든 권한이 새어 나간다. */}
      {revealed ? <p className="endpoint-token mono">{server.token}</p> : null}

      <div className="button-row">
        <button type="button" className="btn btn-ghost" onClick={() => setRevealed((current) => !current)}>
          {revealed ? '토큰 숨기기' : '토큰 보기'}
        </button>

        <button type="button" className="btn" onClick={() => void copy(server.token, setTokenCopyStatus)}>
          토큰 복사
        </button>

        <button
          type="button"
          className="btn btn-primary"
          onClick={() => void copy(configSnippet(server), setConfigCopyStatus)}
        >
          설정 JSON 복사
        </button>
      </div>

      {tokenCopyStatus ? (
        <p role="status" className="copy-status" data-ok={String(tokenCopyStatus.ok)}>
          {statusText(tokenCopyStatus)}
        </p>
      ) : null}
      {configCopyStatus ? (
        <p role="status" className="copy-status" data-ok={String(configCopyStatus.ok)}>
          {statusText(configCopyStatus)}
        </p>
      ) : null}
    </section>
  )
}
