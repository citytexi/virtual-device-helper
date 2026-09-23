import { useState } from 'react'
import type { JSX } from 'react'
import type { ServerStatus } from '../../../shared/types/ipc'
import {
  CLAUDE_CODE_REMOVE_COMMAND,
  claudeCodeCommand,
  claudeCodeCommandMasked,
  promptTemplates,
  type PromptTemplate,
  type PromptTemplateId
} from '../../../shared/agentGuide'
import { copyStatusText, useCopy, type CopyStatus } from '../hooks/useCopy'

export interface AgentTabProps {
  server: ServerStatus | null
  targetSerial: string | null
}

function CopyNote({ status }: { status: CopyStatus | null }): JSX.Element | null {
  if (!status) return null
  return (
    <p role="status" className="copy-status" data-ok={String(status.ok)}>
      {copyStatusText(status)}
    </p>
  )
}

/**
 * 다른 프로젝트의 앱을 Claude Code로 테스트할 때 필요한 두 가지를 복사하게 한다.
 * 연결 명령에는 토큰이 들어가므로 화면에는 가린 명령을 보여 주고 복사할 때만 진짜를
 * 넘긴다. 프롬프트에는 연결 정보가 없다(agentGuide.ts 참고).
 */
export function AgentTab({ server, targetSerial }: AgentTabProps): JSX.Element {
  const [selected, setSelected] = useState<PromptTemplateId>('smoke')
  const commandCopy = useCopy()
  const promptCopy = useCopy()

  const templates = promptTemplates(targetSerial)
  const template = templates.find((candidate) => candidate.id === selected) ?? (templates[0] as PromptTemplate)

  return (
    <div className="agent-tab">
      <section aria-labelledby="agent-connect-title" className="agent-section">
        <h3 id="agent-connect-title" className="pane-title">
          Claude Code 연결
        </h3>

        {server ? (
          <>
            <p className="agent-help">테스트할 앱의 프로젝트 폴더에서 이 명령을 실행한다.</p>
            <pre className="command-block">{claudeCodeCommandMasked(server)}</pre>
            <div className="button-row">
              <button type="button" className="btn btn-primary" onClick={() => void commandCopy.copy(claudeCodeCommand(server))}>
                명령 복사
              </button>
            </div>
            <CopyNote status={commandCopy.status} />
            <p className="agent-help">
              토큰은 앱을 켤 때마다 바뀐다. 앱을 다시 켰으면 <code>{CLAUDE_CODE_REMOVE_COMMAND}</code>를 먼저
              실행하고 새 명령을 다시 복사해 실행한다.
            </p>
          </>
        ) : (
          <p className="empty">
            서버가 떠 있지 않다. Android SDK를 찾지 못했거나, SDK는 찾았지만 서버가 뜨는 데 실패했을 수 있다.
            main 프로세스 로그를 확인해라.
          </p>
        )}
      </section>

      <section aria-labelledby="agent-prompt-title" className="agent-section">
        <h3 id="agent-prompt-title" className="pane-title">
          프롬프트
        </h3>

        <div role="radiogroup" aria-label="프롬프트 종류" className="segmented">
          {templates.map((candidate) => (
            <label key={candidate.id} className="segmented-option">
              <input
                type="radio"
                name="prompt-template"
                value={candidate.id}
                checked={candidate.id === template.id}
                onChange={() => setSelected(candidate.id)}
              />
              <span>{candidate.label}</span>
            </label>
          ))}
        </div>

        <p className="agent-help">{template.description} &lt;꺾쇠&gt; 칸은 채우거나 에이전트가 찾게 둔다.</p>

        <pre className="prompt-preview" data-testid="prompt-preview">
          {template.body}
        </pre>

        <div className="button-row">
          <button type="button" className="btn btn-primary" onClick={() => void promptCopy.copy(template.body)}>
            프롬프트 복사
          </button>
        </div>
        <CopyNote status={promptCopy.status} />
      </section>
    </div>
  )
}
