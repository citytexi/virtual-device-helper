import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
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

const README = resolve(__dirname, '../../../README.md')

/**
 * `markdown`에서 `heading` 제목 아래 본문만 떼어 낸다. 같은 수준 이상의 다음 제목 전까지다.
 * 툴 표는 "### 툴" 아래만 본다 — "자주 나는 실패" 표의 에러 kind(`no_device` 등)도
 * 백틱 snake_case라 섹션 전체를 보면 툴로 오인한다. Windows에서 CRLF로 체크아웃돼도
 * 같게 읽도록 줄바꿈을 먼저 LF로 맞춘다.
 */
function readmeSection(markdown: string, heading: string): string {
  const text = markdown.replace(/\r\n/g, '\n')
  const start = text.indexOf(`\n${heading}\n`)
  if (start === -1) throw new Error(`README에 "${heading}" 제목이 없다`)
  const level = heading.split(' ')[0] as string
  const rest = text.slice(start + heading.length + 2)
  const next = new RegExp(`\\n#{1,${level.length}} `)
  const end = rest.search(next)
  return end === -1 ? rest : rest.slice(0, end)
}

const readme = (): string => readFileSync(README, 'utf8')

describe('readmeSection', () => {
  it('reads a README checked out with CRLF line endings', () => {
    const crlf = '# t\r\n\r\n## 에이전트로 테스트하기\r\n\r\nbody\r\n\r\n## 개발\r\n'

    expect(readmeSection(crlf, '## 에이전트로 테스트하기')).toContain('body')
    expect(readmeSection(crlf, '## 에이전트로 테스트하기')).not.toContain('개발')
  })
})

describe('README agent section', () => {
  it('has the agent section with a tool table under it', () => {
    expect(readmeSection(readme(), '## 에이전트로 테스트하기')).toContain('### 툴')
  })

  it('lists every registered tool in the tool table', async () => {
    const table = readmeSection(readme(), '### 툴')

    for (const name of await registeredToolNames()) {
      expect(table, `README 툴 표에 빠진 툴: ${name}`).toContain(`\`${name}\``)
    }
  })

  it('names only registered tools in the tool table', async () => {
    const registered = new Set(await registeredToolNames())

    for (const name of mentionedToolNames(readmeSection(readme(), '### 툴'))) {
      expect(registered, `README 툴 표가 없는 툴을 언급한다: ${name}`).toContain(name)
    }
  })
})
