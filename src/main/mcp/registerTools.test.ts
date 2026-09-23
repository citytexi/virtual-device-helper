import { describe, expect, it, vi } from 'vitest'
import type { AvdController } from '../device/avdController'
import type { DeviceRegistry } from '../device/registry'
import { createToolHarness } from './testHarness'

const EXPECTED_TOOLS = [
  'device_list',
  'device_boot',
  'device_shutdown',
  'device_select',
  'device_info',
  'app_install',
  'app_uninstall',
  'app_launch',
  'app_stop',
  'app_clear_data',
  'app_grant_permission',
  'app_reset_and_launch',
  'ui_tap',
  'ui_swipe',
  'ui_text',
  'ui_key',
  'ui_find',
  'screenshot',
  'log_read',
  'log_clear'
]

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

describe('registerTools', () => {
  it('exposes exactly the tools the spec lists', async () => {
    const { registry, avd } = fakeRegistryAndAvd()

    const harness = await createToolHarness({ registry, avd })
    const listed = await harness.client.listTools()

    expect(listed.tools.map((tool) => tool.name).sort()).toEqual([...EXPECTED_TOOLS].sort())

    await harness.close()
  })

  it('gives every tool a description an agent can choose from', async () => {
    const { registry, avd } = fakeRegistryAndAvd()

    const harness = await createToolHarness({ registry, avd })
    const listed = await harness.client.listTools()

    for (const tool of listed.tools) {
      expect(tool.description, `${tool.name} has no description`).toBeTruthy()
      expect((tool.description ?? '').length).toBeGreaterThan(20)
    }

    await harness.close()
  })
})
