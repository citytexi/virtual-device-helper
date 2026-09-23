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
