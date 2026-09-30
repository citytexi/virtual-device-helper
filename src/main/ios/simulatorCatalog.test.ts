import { describe, expect, it } from 'vitest'
import { createSimulatorCatalog } from './simulatorCatalog'
import { execOk, fakeSimctl } from './testing'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const listJson = readFileSync(join(__dirname, '../device/parsers/__fixtures__/ios/simctl-list-devices.json'), 'utf8')
const parsed = JSON.parse(listJson) as { devices: Record<string, Array<{ udid: string; state: string; name: string }>> }
const all = Object.values(parsed.devices).flat()
const booted = all.find((device) => device.state === 'Booted')!
const shutdown = all.find((device) => device.state === 'Shutdown')!

describe('simulatorCatalog', () => {
  it('lists simulators with udid as id and serial only when booted', async () => {
    const catalog = createSimulatorCatalog({ simctl: fakeSimctl({ 'list devices -j': execOk(listJson) }) })

    const entries = await catalog.list()

    const bootedEntry = entries.find((entry) => entry.id === booted.udid)
    expect(bootedEntry).toMatchObject({ platform: 'ios', running: true, serial: booted.udid })
    expect(bootedEntry?.osVersion).toMatch(/^\d+\.\d+$/)
    expect(entries.find((entry) => entry.id === shutdown.udid)).toMatchObject({ running: false, serial: null })
  })

  it('boots then waits with bootstatus -b and returns the udid', async () => {
    const simctl = fakeSimctl({
      'list devices -j': execOk(listJson),
      [`boot ${shutdown.udid}`]: execOk(),
      [`bootstatus ${shutdown.udid} -b`]: execOk()
    })

    const serial = await createSimulatorCatalog({ simctl }).boot(shutdown.udid)

    expect(serial).toBe(shutdown.udid)
    expect(simctl.calls.slice(-2)).toEqual([['boot', shutdown.udid], ['bootstatus', shutdown.udid, '-b']])
    expect(simctl.exec).toHaveBeenLastCalledWith(['bootstatus', shutdown.udid, '-b'], { timeoutMs: 180_000 })
  })

  it('rejects with command_failed when already booted', async () => {
    const simctl = fakeSimctl({ 'list devices -j': execOk(listJson) })

    await expect(createSimulatorCatalog({ simctl }).boot(booted.udid)).rejects.toMatchObject({
      toolError: { kind: 'command_failed', message: `이미 실행 중이다: ${booted.name}` }
    })
    expect(simctl.calls).toEqual([['list', 'devices', '-j']])
  })

  it('rejects with command_failed for an unknown udid', async () => {
    const simctl = fakeSimctl({ 'list devices -j': execOk(listJson) })

    await expect(createSimulatorCatalog({ simctl }).boot('NOPE')).rejects.toMatchObject({ toolError: { kind: 'command_failed' } })
  })

  it('shuts down by serial', async () => {
    const simctl = fakeSimctl({ 'shutdown U-1': execOk() })

    await createSimulatorCatalog({ simctl }).shutdown('U-1')

    expect(simctl.calls).toEqual([['shutdown', 'U-1']])
  })
})
