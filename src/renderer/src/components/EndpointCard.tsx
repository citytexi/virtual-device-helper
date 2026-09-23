import { useState } from 'react'
import type { JSX } from 'react'
import type { ServerStatus } from '../../../shared/types/ipc'
import { copyStatusText, useCopy } from '../hooks/useCopy'

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

export function EndpointCard({ server }: EndpointCardProps): JSX.Element {
  const [revealed, setRevealed] = useState(false)
  const tokenCopy = useCopy()
  const configCopy = useCopy()

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

        <button type="button" className="btn" onClick={() => void tokenCopy.copy(server.token)}>
          토큰 복사
        </button>

        <button
          type="button"
          className="btn btn-primary"
          onClick={() => void configCopy.copy(configSnippet(server))}
        >
          설정 JSON 복사
        </button>
      </div>

      {tokenCopy.status ? (
        <p role="status" className="copy-status" data-ok={String(tokenCopy.status.ok)}>
          {copyStatusText(tokenCopy.status)}
        </p>
      ) : null}
      {configCopy.status ? (
        <p role="status" className="copy-status" data-ok={String(configCopy.status.ok)}>
          {copyStatusText(configCopy.status)}
        </p>
      ) : null}
    </section>
  )
}
