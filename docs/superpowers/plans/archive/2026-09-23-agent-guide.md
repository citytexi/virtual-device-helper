---
id: agent-guide
title: 에이전트 사용 안내와 프롬프트 템플릿
status: done
type: work-order
created: 2026-09-23
updated: 2026-09-23
owner: virtual-device-helper 팀
scope: [main, renderer, mcp, shared, docs]
hosts: []
archived_reason: 구현 완료. 최종 리뷰의 Important 두 건을 고쳐 PR #8로 develop에 머지했다.
related_adr: [ADR-0001, ADR-0004]
related_spec: agent-guide
related_architecture:
related_plan:
related_code: src/shared/agentGuide.ts#promptTemplates, src/main/mcp/httpServer.ts#startMcpHttpServer, src/renderer/src/components/AgentTab.tsx#AgentTab
tags: [plan, agent, mcp, prompt]
---

# 에이전트 사용 안내와 프롬프트 템플릿 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: `superpowers:subagent-driven-development`(권장) 또는
> `superpowers:executing-plans`로 task 단위 구현. 각 단계는 체크박스(`- [ ]`)로 추적한다.

**Goal:** Claude Code로 다른 프로젝트의 Android 앱을 테스트하는 방법을 README, 앱의 "에이전트" 탭, MCP 서버
`instructions` 세 곳에서 같은 원문으로 알려 준다.

**Architecture:** 안내 문구는 `src/shared/agentGuide.ts`의 순수 함수가 만든다. main은 그중
`serverInstructions()`를 `McpServer`의 `instructions`로 싣는다. renderer의 `AgentTab`은 연결 명령과
프롬프트 템플릿을 보여 주고 복사한다. README는 사람이 쓰고, 툴 이름이 어긋나지 않는지는 main 쪽 테스트가 본다.

**Tech Stack:** TypeScript, React, Electron, `@modelcontextprotocol/sdk`, Vitest, @testing-library/react, jsdom

**Spec:** [`../../specs/archive/2026-09-23-agent-guide.md`](../../specs/archive/2026-09-23-agent-guide.md)

## Global Constraints

- 답변·주석·문서는 한국어로 쓴다. 기술 용어·API 이름·명령어·에러 문자열은 원문 그대로 둔다.
- 프롬프트 템플릿과 `serverInstructions`에는 토큰도 URL도 넣지 않는다. 토큰은 `claudeCodeCommand`에만 들어간다.
- 화면에 보이는 텍스트에는 토큰이 나오지 않는다. 연결 명령은 `claudeCodeCommandMasked`로 보여 준다.
- 연결 안내는 Claude Code만 다룬다. 범용 설정 JSON 복사(`EndpointCard`)는 지금 동작을 유지한다.
- 서버 이름은 `virtual-device-helper` 하나다. `agentGuide.ts`의 `MCP_SERVER_NAME`이 단일 출처다.
- shared 층(`src/shared/`)은 main·renderer를 import하지 않는다. main의 테스트 하네스가 필요한 테스트는 `src/main/mcp/`에 둔다.
- 새 의존성을 들이지 않는다.
- 스타일은 `app.css`의 기존 토큰(`--surface`, `--border`, `--text-muted` 등)만 쓴다.
- 기존 테스트가 쓰는 텍스트·role·aria는 바꾸지 않는다. 바꿔야 하면 그 테스트를 같은 task에서 고친다.
- 문서에는 라인번호, 파일·툴 개수, 진행률을 적지 않는다. 파일명과 심볼명으로 가리킨다.
- 문서를 고치면 `python3 docs/script/docs.py lint`와 `python3 docs/script/docs.py links`를 돌린다.
- 커밋 메시지는 한국어 Conventional Commits(`feat(renderer): ...한다`)이고, 끝에 다음 줄을 붙인다:
  `Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>`

## Review Focus

- **대상 기기가 바뀌는 순간**: 탭을 연 채로 기기를 바꾸면 미리보기와 복사 내용이 새 serial이어야 한다. → Task 4에 rerender 테스트.
- **클립보드 거부**: 창이 포커스를 잃으면 `writeText`가 reject한다. 명령 복사와 프롬프트 복사 모두 실패 이유를 보여 줘야 한다. → Task 3과 Task 4 테스트.
- **키보드만으로 탭 이동**: 마지막 탭에서 오른쪽 화살표를 누르면 첫 탭으로 돌아가고, 포커스도 따라가야 한다. → Task 5 테스트.
- **서버 없이 에이전트 탭 열기**: 연결 영역은 안내로 바뀌고, 프롬프트는 여전히 복사할 수 있어야 한다. → Task 4 테스트.
- **토큰 누출**: 템플릿이나 `instructions`에 URL이나 `Bearer`가 섞이면 대화 기록에 남는다. → Task 1 테스트.

---

### Task 1: `agentGuide.ts` — 안내 문구의 단일 출처

**Files:**
- Create: `src/shared/agentGuide.ts`
- Test: `src/shared/agentGuide.test.ts`

**Interfaces:**
- Consumes: `ServerStatus`(`src/shared/types/ipc.ts`) — `{ url: string; port: number; token: string }`
- Produces:
  - `MCP_SERVER_NAME: 'virtual-device-helper'`
  - `CLAUDE_CODE_REMOVE_COMMAND: string`
  - `type PromptTemplateId = 'smoke' | 'scenario' | 'bug-repro'`
  - `interface PromptTemplate { id: PromptTemplateId; label: string; description: string; body: string }`
  - `serverInstructions(): string`
  - `promptTemplates(targetSerial: string | null): PromptTemplate[]`
  - `claudeCodeCommand(server: ServerStatus): string`
  - `claudeCodeCommandMasked(server: ServerStatus): string`

- [ ] **Step 1: 실패하는 테스트를 쓴다**

```ts
// src/shared/agentGuide.test.ts
import { describe, expect, it } from 'vitest'
import {
  CLAUDE_CODE_REMOVE_COMMAND,
  MCP_SERVER_NAME,
  claudeCodeCommand,
  claudeCodeCommandMasked,
  promptTemplates,
  serverInstructions
} from './agentGuide'

const server = { url: 'http://127.0.0.1:9321/mcp', port: 9321, token: 'secret-token-value' }

describe('serverInstructions', () => {
  it('tells the agent to find elements before tapping and to check logs on failure', () => {
    const text = serverInstructions()

    expect(text).toContain('`ui_find`')
    expect(text).toContain('`log_read`')
    expect(text).toContain('`hint`')
  })

  it('never carries connection details', () => {
    const text = serverInstructions()

    expect(text).not.toContain('Bearer')
    expect(text).not.toContain('127.0.0.1')
  })
})

describe('promptTemplates', () => {
  it('offers smoke, scenario and bug-repro templates in that order', () => {
    expect(promptTemplates(null).map((template) => template.id)).toEqual(['smoke', 'scenario', 'bug-repro'])
  })

  it('gives every template a label and a one-line description', () => {
    for (const template of promptTemplates(null)) {
      expect(template.label.length).toBeGreaterThan(0)
      expect(template.description).not.toContain('\n')
    }
  })

  it('fills in the target serial when there is one', () => {
    for (const template of promptTemplates('emulator-5554')) {
      expect(template.body).toContain('`emulator-5554`')
    }
  })

  it('tells the agent to pick a device when there is no target', () => {
    for (const template of promptTemplates(null)) {
      expect(template.body).toContain('`device_list`')
      expect(template.body).toContain('`device_select`')
    }
  })

  it('leaves package and APK placeholders for the agent to resolve', () => {
    for (const template of promptTemplates(null)) {
      expect(template.body).toContain('<패키지명>')
      expect(template.body).toContain('<APK 경로>')
    }
  })

  it('never carries connection details', () => {
    for (const template of [...promptTemplates(null), ...promptTemplates('emulator-5554')]) {
      expect(template.body).not.toContain('Bearer')
      expect(template.body).not.toContain('127.0.0.1')
      expect(template.body).not.toContain(server.token)
    }
  })

  it('has a slot for the scenario and for the bug symptom', () => {
    const [, scenario, bug] = promptTemplates(null)

    expect(scenario?.body).toContain('<시나리오>')
    expect(bug?.body).toContain('<증상>')
  })
})

describe('claudeCodeCommand', () => {
  it('builds a claude mcp add command with the url and bearer token', () => {
    expect(claudeCodeCommand(server)).toBe(
      `claude mcp add --transport http ${MCP_SERVER_NAME} http://127.0.0.1:9321/mcp --header "Authorization: Bearer secret-token-value"`
    )
  })

  it('has a masked variant for display that hides the token', () => {
    const masked = claudeCodeCommandMasked(server)

    expect(masked).not.toContain(server.token)
    expect(masked).toContain('http://127.0.0.1:9321/mcp')
    expect(masked).toContain('Bearer ')
  })

  it('names the same server in the remove command', () => {
    expect(CLAUDE_CODE_REMOVE_COMMAND).toBe(`claude mcp remove ${MCP_SERVER_NAME}`)
  })
})
```

- [ ] **Step 2: 실패를 확인한다**

Run: `npx vitest run src/shared/agentGuide.test.ts`
Expected: FAIL — `Failed to resolve import "./agentGuide"`

- [ ] **Step 3: 구현한다**

```ts
// src/shared/agentGuide.ts
import type { ServerStatus } from './types/ipc'

/**
 * 에이전트에게 보여 주는 안내 문구의 단일 출처. main은 serverInstructions를 MCP
 * instructions로, renderer는 나머지를 에이전트 탭에서 쓴다. README는 사람이 쓰지만
 * 툴 이름은 main 쪽 guideConsistency 테스트가 이 문구·README와 대조한다.
 *
 * 프롬프트와 instructions에는 토큰·URL을 넣지 않는다. 대화 기록은 남고 공유되기도
 * 한다. 연결 정보는 claudeCodeCommand 하나에만 들어간다.
 */

export const MCP_SERVER_NAME = 'virtual-device-helper'

export const CLAUDE_CODE_REMOVE_COMMAND = `claude mcp remove ${MCP_SERVER_NAME}`

export type PromptTemplateId = 'smoke' | 'scenario' | 'bug-repro'

export interface PromptTemplate {
  id: PromptTemplateId
  label: string
  description: string
  body: string
}

const RULES = [
  '대상 기기가 불분명하면 `device_list`로 확인하고 `device_select`로 고른다.',
  '좌표를 추측하지 않는다. `ui_find`로 요소를 찾고, 돌려받은 x, y로 `ui_tap`을 부른다.',
  '조작한 뒤에는 `screenshot` 또는 `ui_find`로 결과를 확인하고 나서 다음 단계로 간다.',
  '실패하거나 앱이 죽은 것 같으면 `log_read`로 로그를 본다. 새 시도 전에 `log_clear`를 부르면 그 뒤 로그만 보인다.',
  '깨끗한 상태에서 다시 시작하려면 `app_reset_and_launch`를 쓴다.',
  '에러 응답의 `hint`를 읽고 그대로 복구를 시도한다. 같은 `kind`의 에러가 되풀이되면 멈추고 보고한다.'
]

export function serverInstructions(): string {
  return [
    `${MCP_SERVER_NAME}는 Android 에뮬레이터를 조작하는 MCP 서버다. 다음 규칙을 지켜라.`,
    ...RULES.map((rule) => `- ${rule}`)
  ].join('\n')
}

function deviceSection(targetSerial: string | null): string {
  const line = targetSerial
    ? `대상 기기는 \`${targetSerial}\`이다. 툴을 부를 때 serial로 이 값을 넘겨라.`
    : '대상 기기가 아직 정해지지 않았다. `device_list`로 실행 중인 기기를 확인하고 `device_select`로 골라라.'
  return ['## 기기', line].join('\n')
}

const APP_SECTION = [
  '## 앱',
  '- 패키지명: <패키지명>',
  '- APK 경로: <APK 경로>',
  '모르면 이 프로젝트에서 찾아라(예: build.gradle의 `applicationId`, 빌드 산출물 경로). APK가 없으면 디버그 빌드부터 만든다.'
].join('\n')

const RULES_SECTION = ['## 규칙', ...RULES.map((rule) => `- ${rule}`)].join('\n')

function reportSection(extra: string[]): string {
  return [
    '## 보고',
    '- 단계마다 성공/실패',
    '- 실패한 단계에서 찍은 스크린샷이 있는지',
    '- 관련 로그 발췌(`log_read`)',
    ...extra.map((line) => `- ${line}`)
  ].join('\n')
}

function body(intro: string, targetSerial: string | null, sections: string[]): string {
  return [intro, deviceSection(targetSerial), APP_SECTION, ...sections, RULES_SECTION].join('\n\n')
}

export function promptTemplates(targetSerial: string | null): PromptTemplate[] {
  return [
    {
      id: 'smoke',
      label: '스모크 테스트',
      description: '설치하고 실행했을 때 죽지 않는지만 빠르게 본다.',
      body: body('virtual-device-helper MCP로 이 프로젝트의 Android 앱을 스모크 테스트해라.', targetSerial, [
        [
          '## 할 일',
          '1. `log_clear`로 로그를 비운다.',
          '2. `app_install`로 APK를 설치한다.',
          '3. `app_launch`로 실행한다.',
          '4. `screenshot`으로 첫 화면을 확인한다.',
          '5. `log_read`로 크래시(FATAL EXCEPTION)나 ANR이 있는지 본다.'
        ].join('\n'),
        reportSection([])
      ])
    },
    {
      id: 'scenario',
      label: '시나리오 E2E',
      description: '적어 둔 사용자 시나리오를 단계마다 확인하며 끝까지 수행한다.',
      body: body('virtual-device-helper MCP로 이 프로젝트의 Android 앱에서 아래 시나리오를 수행하고 검증해라.', targetSerial, [
        ['## 시나리오', '<시나리오>', '(한 줄에 한 단계씩, 단계마다 기대 결과를 적는다)'].join('\n'),
        [
          '## 할 일',
          '1. `app_install`로 APK를 설치한다.',
          '2. `log_clear`로 로그를 비운다.',
          '3. `app_reset_and_launch`로 깨끗한 상태에서 실행한다.',
          '4. 시나리오의 단계마다 `ui_find`로 요소를 찾고, `ui_tap`·`ui_text`·`ui_swipe`·`ui_key`로 조작하고, `screenshot` 또는 `ui_find`로 기대 결과를 확인한다.',
          '5. 기대와 다르면 그 단계에서 멈추고 `screenshot`과 `log_read`로 증거를 모은다.'
        ].join('\n'),
        reportSection(['멈춘 단계와 기대 결과, 실제 결과'])
      ])
    },
    {
      id: 'bug-repro',
      label: '버그 재현',
      description: '증상을 재현하고 스크린샷과 로그를 모은다.',
      body: body('virtual-device-helper MCP로 이 프로젝트의 Android 앱에서 아래 버그를 재현해라.', targetSerial, [
        ['## 버그', '- 증상: <증상>', '- 재현 단계: <재현 단계(모르면 비워 둔다)>'].join('\n'),
        [
          '## 할 일',
          '1. `app_install`로 APK를 설치한다.',
          '2. `log_clear`로 로그를 비운다.',
          '3. `app_reset_and_launch`로 깨끗한 상태에서 실행한다.',
          '4. 재현 단계를 따라 한다. 단계가 비어 있으면 증상에서 추측한 경로를 시도한다.',
          '5. 재현되면 `screenshot`과 `log_read`로 증거를 모은다.'
        ].join('\n'),
        reportSection(['재현 여부', '재현되지 않았으면 시도한 경로 목록'])
      ])
    }
  ]
}

function command(server: ServerStatus, token: string): string {
  return `claude mcp add --transport http ${MCP_SERVER_NAME} ${server.url} --header "Authorization: Bearer ${token}"`
}

/** 복사 전용이다. 화면에는 claudeCodeCommandMasked를 보여 준다. */
export function claudeCodeCommand(server: ServerStatus): string {
  return command(server, server.token)
}

export function claudeCodeCommandMasked(server: ServerStatus): string {
  return command(server, '••••••••')
}
```

- [ ] **Step 4: 통과를 확인한다**

Run: `npx vitest run src/shared/agentGuide.test.ts`
Expected: PASS

- [ ] **Step 5: 커밋한다**

```bash
git add src/shared/agentGuide.ts src/shared/agentGuide.test.ts
git commit -m "feat(shared): 에이전트 안내 문구와 프롬프트 템플릿을 한 곳에서 만든다

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task 2: MCP `instructions`와 안내 문구의 툴 이름 검사

**Files:**
- Modify: `src/main/mcp/httpServer.ts` — `SERVER_INFO`와 `new McpServer(...)`
- Modify: `src/main/mcp/testHarness.ts` — `createToolHarness`의 `new McpServer(...)`
- Modify: `src/main/mcp/httpServer.test.ts` — initialize 응답 테스트 추가
- Create: `src/main/mcp/guideConsistency.test.ts`

**Interfaces:**
- Consumes: `MCP_SERVER_NAME`, `serverInstructions()`, `promptTemplates()` (Task 1)
- Produces: MCP 초기화 응답의 `instructions`. `createToolHarness`로 만든 클라이언트의 `client.getInstructions()`가
  `serverInstructions()`와 같은 값을 돌려준다.

- [ ] **Step 1: 실패하는 테스트를 쓴다**

```ts
// src/main/mcp/guideConsistency.test.ts
import { describe, expect, it, vi } from 'vitest'
import { promptTemplates, serverInstructions } from '../../shared/agentGuide'
import type { AvdController } from '../device/avdController'
import type { DeviceRegistry } from '../device/registry'
import { createToolHarness } from './testHarness'

/**
 * 안내 문구(agentGuide)와 README가 실제로 등록된 툴과 어긋나지 않는지 본다.
 * shared 층은 이 하네스를 import할 수 없어서 이 테스트를 main 쪽에 둔다.
 */

function fakeRegistryAndAvd() {
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

  return { registry, avd }
}

async function registeredToolNames(): Promise<string[]> {
  const harness = await createToolHarness(fakeRegistryAndAvd())
  const listed = await harness.client.listTools()
  await harness.close()
  return listed.tools.map((tool) => tool.name)
}

/** 백틱 안의 snake_case 단어. 툴 이름을 언급하는 방식이 이것 하나다. */
function mentionedToolNames(text: string): string[] {
  return Array.from(text.matchAll(/`([a-z]+(?:_[a-z]+)+)`/g), (match) => match[1] as string)
}

describe('agent guide consistency', () => {
  it('hands serverInstructions to every connecting client', async () => {
    const harness = await createToolHarness(fakeRegistryAndAvd())

    expect(harness.client.getInstructions()).toBe(serverInstructions())

    await harness.close()
  })

  it('mentions only tools that are actually registered', async () => {
    const registered = new Set(await registeredToolNames())
    const texts = [serverInstructions(), ...promptTemplates(null).map((template) => template.body)]

    for (const name of texts.flatMap(mentionedToolNames)) {
      expect(registered, `unknown tool mentioned: ${name}`).toContain(name)
    }
  })
})
```

`src/main/mcp/httpServer.test.ts`의 `describe('startMcpHttpServer authentication', ...)` 블록 끝에 다음 테스트를 더하고,
파일 위쪽 import에 `serverInstructions`를 더한다.

```ts
import { serverInstructions } from '../../shared/agentGuide'
```

```ts
  it('sends the agent guide as instructions in the initialize response', async () => {
    handle = await startMcpHttpServer({ context: fakeContext() })

    const response = await post(`${handle.url}`, { authorization: `Bearer ${handle.token}` }, initialize)

    // 응답은 SSE 한 줄에 JSON으로 온다. 줄바꿈은 \n으로 이스케이프된 채 들어 있다.
    expect(response.text).toContain(JSON.stringify(serverInstructions()).slice(1, -1))
  })
```

- [ ] **Step 2: 실패를 확인한다**

Run: `npx vitest run src/main/mcp/guideConsistency.test.ts src/main/mcp/httpServer.test.ts`
Expected: FAIL — `hands serverInstructions to every connecting client`는 `undefined`를 받고, `sends the agent guide as instructions`는 `toContain`에서 실패한다.
`mentions only tools that are actually registered`는 이미 통과할 수 있다. Task 1의 문구가 실제 툴만 언급하기 때문이다.

- [ ] **Step 3: 구현한다**

`src/main/mcp/httpServer.ts`:

```ts
// import 목록에 추가
import { MCP_SERVER_NAME, serverInstructions } from '../../shared/agentGuide'

// 기존: const SERVER_INFO = { name: 'virtual-device-helper', version: '0.0.0' }
const SERVER_INFO = { name: MCP_SERVER_NAME, version: '0.0.0' }
```

같은 파일에서 요청마다 서버를 만드는 줄을 바꾼다.

```ts
    // 상태를 두지 않는다. 기기 상태는 DeviceRegistry에 있어 세션에 둘 것이 없다.
    // instructions는 Claude Code 같은 클라이언트가 에이전트 컨텍스트에 넣는다 — 툴 사용 규칙이다.
    const mcp = new McpServer(SERVER_INFO, { instructions: serverInstructions() })
```

`src/main/mcp/testHarness.ts`:

```ts
// import 목록에 추가
import { MCP_SERVER_NAME, serverInstructions } from '../../shared/agentGuide'

// 기존: const server = new McpServer({ name: 'virtual-device-helper', version: '0.0.0' })
  const server = new McpServer(
    { name: MCP_SERVER_NAME, version: '0.0.0' },
    { instructions: serverInstructions() }
  )
```

- [ ] **Step 4: 통과를 확인한다**

Run: `npx vitest run src/main/mcp/ && npm run typecheck`
Expected: PASS, typecheck 에러 없음. `layering.test.ts`도 통과해야 한다. mcp 층이 shared를 import하는 것은 허용된다.

- [ ] **Step 5: 커밋한다**

```bash
git add src/main/mcp/httpServer.ts src/main/mcp/testHarness.ts src/main/mcp/httpServer.test.ts src/main/mcp/guideConsistency.test.ts
git commit -m "feat(mcp): 연결하는 에이전트에게 툴 사용 규칙을 instructions로 보낸다

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task 3: `useCopy` hook — `EndpointCard`의 복사 로직 추출

**Files:**
- Create: `src/renderer/src/hooks/useCopy.ts`
- Test: `src/renderer/src/hooks/useCopy.test.tsx`
- Modify: `src/renderer/src/components/EndpointCard.tsx` — 로컬 `copy`·`CopyStatus`·`statusText`를 hook으로 교체

**Interfaces:**
- Produces:
  - `type CopyStatus = { ok: true } | { ok: false; message: string }`
  - `copyStatusText(status: CopyStatus): string` — `'복사했다'` 또는 `'복사하지 못했다 — <message>'`
  - `useCopy(): { status: CopyStatus | null; copy: (text: string) => Promise<void> }`

- [ ] **Step 1: 실패하는 테스트를 쓴다**

```tsx
// src/renderer/src/hooks/useCopy.test.tsx
// @vitest-environment jsdom
import { act, renderHook } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { copyStatusText, useCopy } from './useCopy'

function stubClipboard(writeText: (text: string) => Promise<void>): void {
  Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true })
}

describe('useCopy', () => {
  it('starts with no status', () => {
    const { result } = renderHook(() => useCopy())

    expect(result.current.status).toBeNull()
  })

  it('writes the text and reports success', async () => {
    const writeText = vi.fn(async (_text: string) => {})
    stubClipboard(writeText)
    const { result } = renderHook(() => useCopy())

    await act(async () => {
      await result.current.copy('hello')
    })

    expect(writeText).toHaveBeenCalledWith('hello')
    expect(result.current.status).toEqual({ ok: true })
  })

  it('reports the reason when the clipboard rejects', async () => {
    stubClipboard(async () => {
      throw new Error('document is not focused')
    })
    const { result } = renderHook(() => useCopy())

    await act(async () => {
      await result.current.copy('hello')
    })

    expect(result.current.status).toEqual({ ok: false, message: 'document is not focused' })
  })
})

describe('copyStatusText', () => {
  it('says what happened in one line', () => {
    expect(copyStatusText({ ok: true })).toBe('복사했다')
    expect(copyStatusText({ ok: false, message: 'denied' })).toBe('복사하지 못했다 — denied')
  })
})
```

- [ ] **Step 2: 실패를 확인한다**

Run: `npx vitest run src/renderer/src/hooks/useCopy.test.tsx`
Expected: FAIL — `Failed to resolve import "./useCopy"`

- [ ] **Step 3: hook을 구현한다**

```ts
// src/renderer/src/hooks/useCopy.ts
import { useCallback, useState } from 'react'

export type CopyStatus = { ok: true } | { ok: false; message: string }

export function copyStatusText(status: CopyStatus): string {
  return status.ok ? '복사했다' : `복사하지 못했다 — ${status.message}`
}

/**
 * 클립보드 복사와 그 결과. navigator.clipboard.writeText는 reject할 수 있다(예: 창이
 * 포커스를 잃은 상태). 실패를 삼키면 사용자는 복사됐다고 믿고 빈 값을 붙여넣게 된다.
 * 그래서 성공/실패를 항상 status로 돌려주고, 쓰는 쪽이 버튼 옆에 보여 준다.
 */
export function useCopy(): { status: CopyStatus | null; copy: (text: string) => Promise<void> } {
  const [status, setStatus] = useState<CopyStatus | null>(null)

  const copy = useCallback(async (text: string) => {
    try {
      await navigator.clipboard.writeText(text)
      setStatus({ ok: true })
    } catch (thrown: unknown) {
      setStatus({ ok: false, message: thrown instanceof Error ? thrown.message : String(thrown) })
    }
  }, [])

  return { status, copy }
}
```

- [ ] **Step 4: hook 테스트 통과를 확인한다**

Run: `npx vitest run src/renderer/src/hooks/useCopy.test.tsx`
Expected: PASS

- [ ] **Step 5: `EndpointCard`를 hook으로 바꾼다**

`src/renderer/src/components/EndpointCard.tsx`에서 다음을 지운다.
- `type CopyStatus = ...`
- `function statusText(...)`
- `tokenCopyStatus`·`configCopyStatus`의 `useState`
- 컴포넌트 안의 `async function copy(...)`와 그 위 주석

그리고 다음처럼 바꾼다.

```tsx
// import 목록에 추가
import { copyStatusText, useCopy } from '../hooks/useCopy'

// 컴포넌트 첫 줄들
  const [revealed, setRevealed] = useState(false)
  const tokenCopy = useCopy()
  const configCopy = useCopy()
```

버튼과 상태 표시:

```tsx
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
```

- [ ] **Step 6: 기존 `EndpointCard` 테스트가 그대로 통과하는지 확인한다**

Run: `npx vitest run src/renderer/src/components/EndpointCard.test.tsx src/renderer/src/hooks/ && npm run typecheck`
Expected: PASS. `EndpointCard.test.tsx`는 고치지 않는다.

- [ ] **Step 7: 커밋한다**

```bash
git add src/renderer/src/hooks/ src/renderer/src/components/EndpointCard.tsx
git commit -m "refactor(renderer): 복사와 결과 표시를 useCopy hook으로 뽑는다

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task 4: `AgentTab` — 연결 명령과 프롬프트 템플릿

**Files:**
- Create: `src/renderer/src/components/AgentTab.tsx`
- Test: `src/renderer/src/components/AgentTab.test.tsx`
- Modify: `src/renderer/src/app.css` — 에이전트 탭 스타일 추가

**Interfaces:**
- Consumes: `claudeCodeCommand`, `claudeCodeCommandMasked`, `CLAUDE_CODE_REMOVE_COMMAND`, `promptTemplates`,
  `PromptTemplate`, `PromptTemplateId` (Task 1). `useCopy`, `copyStatusText` (Task 3).
- Produces: `AgentTab(props: { server: ServerStatus | null; targetSerial: string | null }): JSX.Element`

- [ ] **Step 1: 실패하는 테스트를 쓴다**

```tsx
// src/renderer/src/components/AgentTab.test.tsx
// @vitest-environment jsdom
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import { claudeCodeCommand, promptTemplates } from '../../../shared/agentGuide'
import { AgentTab } from './AgentTab'

const server = { url: 'http://127.0.0.1:9321/mcp', port: 9321, token: 'token-value' }

/** user-event의 setup()이 clipboard를 바꿔치기하므로 setup() 뒤에 부른다. */
function stubClipboard(writeText: (text: string) => Promise<void>): void {
  Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true })
}

describe('AgentTab connection', () => {
  it('shows the claude mcp add command without the token', () => {
    render(<AgentTab server={server} targetSerial={null} />)

    expect(screen.getByText(/claude mcp add --transport http/)).toBeDefined()
    expect(document.body.textContent).not.toContain('token-value')
  })

  it('copies the full command including the token', async () => {
    const user = userEvent.setup()
    const writeText = vi.fn(async (_text: string) => {})
    stubClipboard(writeText)
    render(<AgentTab server={server} targetSerial={null} />)

    await user.click(screen.getByRole('button', { name: '명령 복사' }))

    await waitFor(() => expect(writeText).toHaveBeenCalledWith(claudeCodeCommand(server)))
    expect(screen.getByText('복사했다')).toBeDefined()
  })

  it('reports why the command copy failed', async () => {
    const user = userEvent.setup()
    stubClipboard(async () => {
      throw new Error('document is not focused')
    })
    render(<AgentTab server={server} targetSerial={null} />)

    await user.click(screen.getByRole('button', { name: '명령 복사' }))

    await waitFor(() => expect(screen.getByText(/document is not focused/)).toBeDefined())
  })

  it('tells the user how to re-register after the token changes', () => {
    render(<AgentTab server={server} targetSerial={null} />)

    expect(screen.getByText('claude mcp remove virtual-device-helper')).toBeDefined()
  })

  it('explains that the server is not running and still offers prompts', () => {
    render(<AgentTab server={null} targetSerial={null} />)

    expect(screen.getByText(/서버가 떠 있지 않다/)).toBeDefined()
    expect(screen.queryByRole('button', { name: '명령 복사' })).toBeNull()
    expect(screen.getByRole('button', { name: '프롬프트 복사' })).toBeDefined()
  })
})

describe('AgentTab prompts', () => {
  it('previews the smoke test template by default', () => {
    render(<AgentTab server={server} targetSerial="emulator-5554" />)

    const smoke = promptTemplates('emulator-5554')[0]
    expect(screen.getByRole('radio', { name: '스모크 테스트' })).toHaveProperty('checked', true)
    expect(screen.getByTestId('prompt-preview').textContent).toBe(smoke?.body)
  })

  it('switches the preview when another template is chosen', async () => {
    render(<AgentTab server={server} targetSerial="emulator-5554" />)

    await userEvent.click(screen.getByRole('radio', { name: '버그 재현' }))

    const bug = promptTemplates('emulator-5554')[2]
    expect(screen.getByTestId('prompt-preview').textContent).toBe(bug?.body)
  })

  it('copies the chosen template', async () => {
    const user = userEvent.setup()
    const writeText = vi.fn(async (_text: string) => {})
    stubClipboard(writeText)
    render(<AgentTab server={server} targetSerial="emulator-5554" />)

    await user.click(screen.getByRole('radio', { name: '시나리오 E2E' }))
    await user.click(screen.getByRole('button', { name: '프롬프트 복사' }))

    await waitFor(() => expect(writeText).toHaveBeenCalledWith(promptTemplates('emulator-5554')[1]?.body))
  })

  it('reports why the prompt copy failed', async () => {
    const user = userEvent.setup()
    stubClipboard(async () => {
      throw new Error('document is not focused')
    })
    render(<AgentTab server={server} targetSerial={null} />)

    await user.click(screen.getByRole('button', { name: '프롬프트 복사' }))

    await waitFor(() => expect(screen.getByText(/document is not focused/)).toBeDefined())
  })

  it('redraws the preview with the new serial when the target device changes', () => {
    const { rerender } = render(<AgentTab server={server} targetSerial="emulator-5554" />)

    rerender(<AgentTab server={server} targetSerial="emulator-5556" />)

    const preview = screen.getByTestId('prompt-preview').textContent ?? ''
    expect(preview).toContain('`emulator-5556`')
    expect(preview).not.toContain('`emulator-5554`')
  })
})
```

- [ ] **Step 2: 실패를 확인한다**

Run: `npx vitest run src/renderer/src/components/AgentTab.test.tsx`
Expected: FAIL — `Failed to resolve import "./AgentTab"`

- [ ] **Step 3: 구현한다**

```tsx
// src/renderer/src/components/AgentTab.tsx
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
```

- [ ] **Step 4: 스타일을 더한다**

`src/renderer/src/app.css`의 `/* ── SDK 안내 ── */` 섹션 바로 앞에 넣는다.

```css
/* ── 에이전트 탭 ──────────────────────────────────────── */

.agent-tab {
  display: flex;
  flex-direction: column;
  gap: var(--space-4);
  padding-top: var(--space-2);
}

.agent-section {
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
}

.agent-help {
  color: var(--text-muted);
  font-size: 13px;
}

/* 명령과 프롬프트 미리보기. 긴 줄은 접어서 탭 폭 안에 둔다. */
.command-block,
.prompt-preview {
  margin: 0;
  padding: var(--space-3);
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  background: var(--surface-muted);
  font-family: var(--font-mono);
  font-size: 12px;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}

.prompt-preview {
  max-height: 360px;
  overflow-y: auto;
}

/* 상단 바의 테마 전환은 오른쪽으로 밀지만, 탭 안에서는 왼쪽에 둔다. */
.agent-tab .segmented {
  align-self: flex-start;
  margin-left: 0;
}
```

- [ ] **Step 5: 통과를 확인한다**

Run: `npx vitest run src/renderer/src/components/AgentTab.test.tsx && npm run typecheck`
Expected: PASS

- [ ] **Step 6: 커밋한다**

```bash
git add src/renderer/src/components/AgentTab.tsx src/renderer/src/components/AgentTab.test.tsx src/renderer/src/app.css
git commit -m "feat(renderer): Claude Code 연결 명령과 프롬프트 템플릿을 복사하는 에이전트 탭을 만든다

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task 5: `WorkArea` 탭 전환

**Files:**
- Modify: `src/renderer/src/components/WorkArea.tsx`
- Modify: `src/renderer/src/components/WorkArea.test.tsx`
- Modify: `src/renderer/src/app.css` — `.tabpanel[hidden]`

**Interfaces:**
- Consumes: `AgentTab` (Task 4), `targetSerial(snapshot)`(`src/renderer/src/state/useAppState.ts`)
- Produces: `WorkArea`의 props는 그대로 `{ snapshot: AppSnapshot }`. `App.tsx`는 고치지 않는다.

- [ ] **Step 1: 테스트를 고쳐 쓴다**

`src/renderer/src/components/WorkArea.test.tsx` 전체를 다음으로 바꾼다.

```tsx
// @vitest-environment jsdom
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it } from 'vitest'
import type { AppSnapshot } from '../../../shared/types/ipc'
import { WorkArea } from './WorkArea'

const snapshot: AppSnapshot = {
  sdk: { ok: true, sdkRoot: '/opt/sdk' },
  server: { url: 'http://127.0.0.1:9321/mcp', port: 9321, token: 'token-value' },
  avds: [{ name: 'Pixel_7_API_34', running: true, serial: 'emulator-5554' }],
  devices: ['emulator-5554'],
  activeSerial: 'emulator-5554',
  toolCalls: [],
  trackingFailure: null
}

describe('WorkArea', () => {
  it('offers the activity and agent tabs', () => {
    render(<WorkArea snapshot={snapshot} />)

    expect(screen.getByRole('tablist')).toBeDefined()
    expect(screen.getByRole('tab', { name: '활동' })).toBeDefined()
    expect(screen.getByRole('tab', { name: '에이전트' })).toBeDefined()
  })

  it('shows the activity panel first', () => {
    render(<WorkArea snapshot={snapshot} />)

    expect(screen.getByRole('tab', { name: '활동' }).getAttribute('aria-selected')).toBe('true')
    expect(screen.getByRole('tabpanel').id).toBe('panel-activity')
  })

  it('switches to the agent panel on click', async () => {
    render(<WorkArea snapshot={snapshot} />)

    await userEvent.click(screen.getByRole('tab', { name: '에이전트' }))

    expect(screen.getByRole('tab', { name: '에이전트' }).getAttribute('aria-selected')).toBe('true')
    expect(screen.getByRole('tabpanel').id).toBe('panel-agent')
    expect(screen.getByRole('button', { name: '프롬프트 복사' })).toBeDefined()
  })

  it('passes the target device to the agent tab', async () => {
    render(<WorkArea snapshot={snapshot} />)

    await userEvent.click(screen.getByRole('tab', { name: '에이전트' }))

    expect(screen.getByTestId('prompt-preview').textContent).toContain('`emulator-5554`')
  })

  it('moves between tabs with the arrow keys and wraps around, moving focus along', async () => {
    render(<WorkArea snapshot={snapshot} />)
    const activity = screen.getByRole('tab', { name: '활동' })
    activity.focus()

    await userEvent.keyboard('{ArrowRight}')
    const agent = screen.getByRole('tab', { name: '에이전트' })
    expect(agent.getAttribute('aria-selected')).toBe('true')
    expect(document.activeElement).toBe(agent)

    await userEvent.keyboard('{ArrowRight}')
    expect(activity.getAttribute('aria-selected')).toBe('true')
    expect(document.activeElement).toBe(activity)

    await userEvent.keyboard('{ArrowLeft}')
    expect(agent.getAttribute('aria-selected')).toBe('true')
  })

  it('keeps only the selected tab in the tab order', () => {
    render(<WorkArea snapshot={snapshot} />)

    expect(screen.getByRole('tab', { name: '활동' }).getAttribute('tabindex')).toBe('0')
    expect(screen.getByRole('tab', { name: '에이전트' }).getAttribute('tabindex')).toBe('-1')
  })
})
```

- [ ] **Step 2: 실패를 확인한다**

Run: `npx vitest run src/renderer/src/components/WorkArea.test.tsx`
Expected: FAIL — `Unable to find an accessible element with the role "tab" and name "에이전트"`

- [ ] **Step 3: 구현한다**

`src/renderer/src/components/WorkArea.tsx` 전체를 다음으로 바꾼다.

```tsx
import { useRef, useState } from 'react'
import type { JSX, KeyboardEvent } from 'react'
import type { AppSnapshot } from '../../../shared/types/ipc'
import { targetSerial } from '../state/useAppState'
import { ActivityTab } from './ActivityTab'
import { AgentTab } from './AgentTab'

export interface WorkAreaProps {
  snapshot: AppSnapshot
}

const TABS = [
  { id: 'activity', label: '활동' },
  { id: 'agent', label: '에이전트' }
] as const

type TabId = (typeof TABS)[number]['id']

/**
 * 오른쪽 작업 영역. WAI-ARIA tabs 패턴을 따른다 — 선택된 탭만 Tab 순서에 두고,
 * 좌우 화살표로 옮기며 끝에서 반대쪽 끝으로 돈다. 선택되지 않은 패널은 hidden이다.
 * M3에서 "로그" 탭이 여기 붙는다.
 */
export function WorkArea({ snapshot }: WorkAreaProps): JSX.Element {
  const [selected, setSelected] = useState<TabId>('activity')
  const tabRefs = useRef<Partial<Record<TabId, HTMLButtonElement | null>>>({})

  function onKeyDown(event: KeyboardEvent<HTMLDivElement>): void {
    if (event.key !== 'ArrowRight' && event.key !== 'ArrowLeft') return
    event.preventDefault()

    const index = TABS.findIndex((tab) => tab.id === selected)
    const step = event.key === 'ArrowRight' ? 1 : -1
    const next = TABS[(index + step + TABS.length) % TABS.length] as (typeof TABS)[number]

    setSelected(next.id)
    tabRefs.current[next.id]?.focus()
  }

  return (
    <section aria-label="작업 영역" className="pane pane-work">
      <div role="tablist" aria-label="작업 영역 탭" className="tablist" onKeyDown={onKeyDown}>
        {TABS.map((tab) => {
          const isSelected = tab.id === selected
          return (
            <button
              key={tab.id}
              ref={(element) => {
                tabRefs.current[tab.id] = element
              }}
              type="button"
              role="tab"
              className="tab"
              id={`tab-${tab.id}`}
              aria-controls={`panel-${tab.id}`}
              aria-selected={isSelected}
              tabIndex={isSelected ? 0 : -1}
              onClick={() => setSelected(tab.id)}
            >
              {tab.label}
            </button>
          )
        })}
      </div>

      <div
        role="tabpanel"
        className="tabpanel"
        id="panel-activity"
        aria-labelledby="tab-activity"
        hidden={selected !== 'activity'}
      >
        <ActivityTab records={snapshot.toolCalls} />
      </div>

      <div role="tabpanel" className="tabpanel" id="panel-agent" aria-labelledby="tab-agent" hidden={selected !== 'agent'}>
        <AgentTab server={snapshot.server} targetSerial={targetSerial(snapshot)} />
      </div>
    </section>
  )
}
```

`src/renderer/src/app.css`의 `.tabpanel { ... }` 규칙 바로 뒤에 넣는다.

```css
/* .tabpanel이 display를 정하게 되더라도 선택되지 않은 패널은 숨긴다. */
.tabpanel[hidden] {
  display: none;
}
```

- [ ] **Step 4: 통과를 확인한다**

Run: `npm test && npm run typecheck`
Expected: 전부 PASS. `App.test.tsx`의 `getByRole('region', { name: '작업 영역' })`도 그대로 통과해야 한다.

- [ ] **Step 5: 커밋한다**

```bash
git add src/renderer/src/components/WorkArea.tsx src/renderer/src/components/WorkArea.test.tsx src/renderer/src/app.css
git commit -m "feat(renderer): 작업 영역에 활동·에이전트 탭 전환을 넣는다

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task 6: README "에이전트로 테스트하기"와 README 일치 테스트

**Files:**
- Modify: `README.md` — "에이전트 붙이기" 섹션을 교체
- Modify: `src/main/mcp/guideConsistency.test.ts` — README 테스트 추가

**Interfaces:**
- Consumes: Task 2의 `registeredToolNames()`(같은 테스트 파일 안의 함수)

- [ ] **Step 1: 실패하는 테스트를 쓴다**

`src/main/mcp/guideConsistency.test.ts` 위쪽 import에 더한다.

```ts
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
```

파일 끝에 더한다.

```ts
const README = resolve(__dirname, '../../../README.md')

/**
 * README에서 `heading` 제목 아래 본문만 떼어 낸다. 같은 수준 이상의 다음 제목 전까지다.
 * 툴 표는 "### 툴" 아래만 본다 — "자주 나는 실패" 표의 에러 kind(`no_device` 등)도
 * 백틱 snake_case라 섹션 전체를 보면 툴로 오인한다.
 */
function readmeSection(heading: string): string {
  const text = readFileSync(README, 'utf8')
  const start = text.indexOf(`\n${heading}\n`)
  if (start === -1) throw new Error(`README에 "${heading}" 제목이 없다`)
  const level = heading.split(' ')[0] as string
  const rest = text.slice(start + heading.length + 2)
  const next = new RegExp(`\\n#{1,${level.length}} `)
  const end = rest.search(next)
  return end === -1 ? rest : rest.slice(0, end)
}

describe('README agent section', () => {
  it('has the agent section with a tool table under it', () => {
    expect(readmeSection('## 에이전트로 테스트하기')).toContain('### 툴')
  })

  it('lists every registered tool in the tool table', async () => {
    const table = readmeSection('### 툴')

    for (const name of await registeredToolNames()) {
      expect(table, `README 툴 표에 빠진 툴: ${name}`).toContain(`\`${name}\``)
    }
  })

  it('names only registered tools in the tool table', async () => {
    const registered = new Set(await registeredToolNames())

    for (const name of mentionedToolNames(readmeSection('### 툴'))) {
      expect(registered, `README 툴 표가 없는 툴을 언급한다: ${name}`).toContain(name)
    }
  })
})
```

- [ ] **Step 2: 실패를 확인한다**

Run: `npx vitest run src/main/mcp/guideConsistency.test.ts`
Expected: FAIL — `README에 "## 에이전트로 테스트하기" 제목이 없다`

- [ ] **Step 3: README를 고친다**

`README.md`에서 `## 에이전트 붙이기` 제목부터 `## 개발` 바로 앞까지를 다음으로 바꾼다.

````markdown
## 에이전트로 테스트하기

다른 프로젝트에서 만든 Android 앱을 Claude Code로 테스트하는 흐름이다.

1. 이 앱을 켜고 기기 목록에서 AVD를 부팅한다.
2. 테스트할 앱의 프로젝트 폴더에서 Claude Code를 켠다.
3. 이 앱의 **에이전트** 탭에서 "명령 복사"를 누르고 터미널에서 실행한다.

   ```bash
   claude mcp add --transport http virtual-device-helper http://127.0.0.1:<port>/mcp --header "Authorization: Bearer <token>"
   ```

4. 에이전트 탭에서 용도에 맞는 프롬프트를 골라 "프롬프트 복사"를 누르고 Claude Code에 붙인다.

서버는 `127.0.0.1`에만 열리고 토큰을 요구한다. 토큰은 앱을 켤 때마다 새로 만들어진다. 앱을 다시 켰으면
`claude mcp remove virtual-device-helper`를 실행한 뒤 새 명령을 다시 등록한다. 앱을 닫으면 서버도 닫힌다.

Claude Code가 아닌 MCP 클라이언트는 상단 바의 "설정 JSON 복사"로 받은 `mcpServers` 설정을 쓴다.

### 프롬프트

에이전트 탭에 세 가지가 있다. 본문은 앱에서 복사한다. 원문은 `src/shared/agentGuide.ts`다.

| 프롬프트 | 쓰는 때 |
|---|---|
| 스모크 테스트 | 설치하고 실행했을 때 죽지 않는지만 빠르게 본다 |
| 시나리오 E2E | 적어 둔 사용자 시나리오를 단계마다 확인하며 끝까지 수행한다 |
| 버그 재현 | 증상을 재현하고 스크린샷과 로그를 모은다 |

`<패키지명>`·`<APK 경로>` 같은 꺾쇠 칸은 직접 채우거나, 비워 두고 에이전트가 프로젝트에서 찾게 한다.
프롬프트에는 토큰이 들어가지 않는다.

연결하면 서버가 툴 사용 규칙을 MCP `instructions`로 보낸다. 프롬프트 없이 붙여도 에이전트는 기본 규칙을 안다.

### 툴

| 묶음 | 툴 | 하는 일 |
|---|---|---|
| device | `device_list` | AVD 목록, 실행 중인 기기, 활성 기기. 다른 툴보다 먼저 부른다 |
| device | `device_boot` | AVD를 부팅하고 끝날 때까지 기다린다 |
| device | `device_shutdown` | 실행 중인 에뮬레이터를 끈다 |
| device | `device_select` | 활성 기기를 정한다. serial을 생략한 호출은 이 기기로 간다 |
| device | `device_info` | 모델명, API 레벨, 화면 크기 |
| app | `app_install` | APK를 설치하고 패키지명을 돌려준다. 호스트의 절대 경로를 준다 |
| app | `app_uninstall` | 패키지를 완전히 지운다 |
| app | `app_launch` | 앱을 실행한다. activity를 생략하면 런처 진입점을 찾는다 |
| app | `app_stop` | 앱을 강제 종료한다 |
| app | `app_clear_data` | 앱 데이터를 지워 첫 실행 상태로 되돌린다 |
| app | `app_grant_permission` | 런타임 권한을 미리 준다 |
| app | `app_reset_and_launch` | 종료, 데이터 삭제, 재실행 후 첫 화면이 안정될 때까지 기다린다 |
| ui | `ui_find` | 화면 요소와 누를 좌표. 조작 전에 먼저 부른다 |
| ui | `ui_tap` | 좌표를 누른다. `ui_find`의 x, y를 그대로 쓴다 |
| ui | `ui_swipe` | 스와이프. 스크롤에 쓴다 |
| ui | `ui_text` | 포커스된 입력 칸에 ASCII 텍스트를 넣는다 |
| ui | `ui_key` | back, home, enter, tab 키 |
| observe | `screenshot` | 지금 화면. 기본으로 축소해서 준다 |
| observe | `log_read` | logcat을 읽는다. 잘리면 `truncated`가 true다 — filter로 좁혀 다시 부른다 |
| observe | `log_clear` | logcat 버퍼를 비운다. 시나리오 직전에 부른다 |

전형적인 흐름은 빌드 → `app_install` → `log_clear` → `app_launch` → `ui_find` → `ui_tap`·`ui_text` →
`screenshot` → `log_read`다.

### 자주 나는 실패

툴이 실패하면 응답에 `kind`, `message`, `hint`가 온다. 에이전트는 `hint`를 따라 복구한다.

| `kind` | 뜻 | 할 일 |
|---|---|---|
| `sdk_not_found`, `adb_not_found` | Android SDK나 adb를 못 찾았다 | Android Studio를 설치하거나 `ANDROID_HOME`을 지정하고 앱을 다시 켠다 |
| `no_device` | 대상 기기가 없다 | `device_list`로 확인하고 `device_boot` 또는 `device_select` |
| `ambiguous_device` | 기기가 여럿인데 대상을 정하지 않았다 | `device_select`로 하나를 고른다 |
| `package_not_found` | 기기에 그 패키지가 없다 | 패키지명을 확인하고 `app_install`을 먼저 한다 |
| `apk_path_invalid` | APK 경로가 틀렸다 | 빌드를 먼저 하고 호스트의 절대 경로를 준다 |
| `device_unresponsive` | 기기가 응답하지 않는다 | `device_shutdown` 후 `device_boot`로 다시 켠다 |
| `command_failed` | 그 밖의 명령 실패 | `hint`와 `details`의 stderr를 읽는다 |
````

- [ ] **Step 4: 통과를 확인한다**

Run: `npx vitest run src/main/mcp/guideConsistency.test.ts && python3 docs/script/docs.py links`
Expected: PASS, 깨진 링크 0건

- [ ] **Step 5: 커밋한다**

```bash
git add README.md src/main/mcp/guideConsistency.test.ts
git commit -m "docs: README에 Claude Code로 테스트하는 방법과 툴·실패 표를 쓴다

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task 7: 실제 앱과 Claude Code로 확인하고 스펙에 결과를 남긴다

**Files:**
- Modify: `docs/superpowers/specs/2026-09-23-agent-guide.md` — "검증 결과" 섹션 추가, 열린 질문 갱신, `verified`
- Modify: `docs/superpowers/plans/2026-09-23-agent-guide.md` — 이 계획의 `status`

사람이 볼 화면과 외부 도구가 끼므로 이 task는 사람과 함께 한다. 관찰한 것만 적고, 해 보지 않은 것은 해 보지 않았다고 적는다.

- [ ] **Step 1: 전체 테스트와 타입 검사를 돌린다**

Run: `npm test && npm run typecheck`
Expected: 전부 PASS

- [ ] **Step 2: 앱을 띄워 에이전트 탭을 본다**

Run: `npm run dev`

확인할 것:
- 에이전트 탭에 가린 명령이 보이고, 토큰이 화면에 없다.
- 라이트·다크 모두에서 명령 블록과 미리보기가 읽힌다.
- 긴 프롬프트는 미리보기 안에서 스크롤되고 창 전체가 스크롤되지 않는다.
- 기기를 바꾸면 미리보기의 serial이 바뀐다.

- [ ] **Step 3: Claude Code로 연결한다**

다른 폴더(예: 테스트할 Android 프로젝트)에서 에이전트 탭의 "명령 복사"로 받은 명령을 실행한다.

Run: `claude mcp list`
Expected: `virtual-device-helper`가 connected로 보인다.

- [ ] **Step 4: `instructions`가 에이전트에게 닿는지 본다**

같은 폴더에서 Claude Code를 켜고 묻는다: "virtual-device-helper MCP 서버가 보낸 instructions를 그대로 말해 줘."
Expected: `serverInstructions()`의 규칙이 나온다. 나오지 않으면 그 사실을 적는다. 스펙의 열린 질문대로
템플릿에 규칙을 더 싣는 후속 작업을 제안한다.

- [ ] **Step 5: 스모크 테스트 프롬프트로 한 번 돌린다**

에이전트 탭에서 스모크 테스트 프롬프트를 복사해 붙인다. 자리표시자는 비워 둔다.
Expected: 에이전트가 패키지명과 APK 경로를 프로젝트에서 찾고 `app_install` → `app_launch` → `screenshot` → `log_read`를
거쳐 보고한다. 앱의 활동 탭에 호출이 쌓인다.

끝나면 등록을 지운다.

Run: `claude mcp remove virtual-device-helper`

- [ ] **Step 6: 스펙에 결과를 적는다**

`docs/superpowers/specs/2026-09-23-agent-guide.md`의 "테스트" 섹션 뒤에 다음 형태로 넣는다. 괄호 안은 관찰한 내용으로 채운다.

```markdown
## 검증 결과 (2026-09-23)

- 연결: (claude mcp list에서 본 상태)
- instructions 전달: (에이전트가 규칙을 말했는지, 어떤 형태로)
- 스모크 테스트 프롬프트: (에이전트가 찾은 패키지명·APK 경로, 거친 툴 순서, 보고 형식이 지켜졌는지)
- 화면: (토큰 노출 여부, 라이트·다크, 미리보기 스크롤)
- 해 보지 않은 것: (예: 시나리오 E2E·버그 재현 템플릿은 실제로 돌리지 않았다)
```

"열린 질문"의 `instructions 반영 범위` 항목은 관찰 결과로 답하고, 답이 나왔으면 본문으로 올린다.
frontmatter의 `verified`를 확인한 날짜로, `status`를 `implemented`로 바꾼다. 계획의 `status`는 `done`으로 바꾼다.
아카이브는 PR이 머지된 뒤에 한다.

- [ ] **Step 7: 문서 검사 후 커밋한다**

Run: `python3 docs/script/docs.py lint && python3 docs/script/docs.py links`
Expected: 문제 0건

```bash
git add docs/superpowers/specs/2026-09-23-agent-guide.md docs/superpowers/plans/2026-09-23-agent-guide.md
git commit -m "docs: 에이전트 안내 검증 결과를 스펙에 옮긴다

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```
