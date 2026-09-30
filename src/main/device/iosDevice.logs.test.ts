import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { execOk, fakeSimctl } from '../ios/testing'
import { createIosDevice } from './iosDevice'

const ndjson = readFileSync(join(__dirname, 'parsers', '__fixtures__', 'ios', 'log-show.ndjson'), 'utf8')
const UDID = 'AAAA-BBBB'
const noopResize = (png: Buffer) => ({ png, width: 1, height: 1 })

const pad = (n: number) => String(n).padStart(2, '0')
function localStart(ms: number): string {
  const d = new Date(ms)
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
}

/** 어떤 log show 호출이든 fixture를 돌려주는 가짜 simctl. */
function setup(nowMs: number) {
  const simctl = fakeSimctl({})
  const impl = async (args: string[]) => {
    ;(simctl.calls as string[][]).push(args)
    return execOk(ndjson)
  }
  ;(simctl.exec as unknown as { mockImplementation: (f: typeof impl) => void }).mockImplementation(impl)
  const device = createIosDevice({ udid: UDID, simctl, resizeImage: noopResize, now: () => nowMs })
  return { simctl, device }
}

const NOW = new Date(2026, 8, 30, 15, 0, 0).getTime()

describe('IosDevice.readLogs', () => {
  it('starts 5 minutes back by default', async () => {
    const { simctl, device } = setup(NOW)
    await device.readLogs()
    expect(simctl.calls[0]).toEqual(['spawn', UDID, 'log', 'show', '--style', 'ndjson', '--start', localStart(NOW - 300_000)])
  })

  it('starts at the clearLogs watermark and does not call simctl for clearLogs', async () => {
    let clock = NOW
    const simctl = fakeSimctl({})
    ;(simctl.exec as unknown as { mockImplementation: (f: (args?: unknown) => Promise<unknown>) => void }).mockImplementation(async (args?: unknown) => {
      ;(simctl.calls as unknown[]).push(args)
      return execOk(ndjson)
    })
    const device = createIosDevice({ udid: UDID, simctl, resizeImage: noopResize, now: () => clock })
    await device.clearLogs()
    expect(simctl.calls).toEqual([])
    clock = NOW + 60_000
    await device.readLogs()
    expect(simctl.calls[0]).toContain(localStart(NOW))
  })

  it('drops lines logged before the watermark within the same second', async () => {
    // 픽스처의 14:40:14.608 두 줄 다음, .610704 줄 직전(+0900)에 clearLogs를 한다.
    const watermark = Date.UTC(2026, 8, 30, 5, 40, 14, 610)
    let clock = watermark
    const { device, simctl } = setup(watermark)
    const all = await device.readLogs({ limit: 200, since: '01-01 00:00:00.000' })
    const dev = createIosDevice({ udid: UDID, simctl, resizeImage: noopResize, now: () => clock })
    await dev.clearLogs()
    clock = watermark + 60_000
    const result = await dev.readLogs({ limit: 200 })
    expect(result.lines[0]!.timestamp).toBe('09-30 14:40:14.610')
    expect(result.lines).toEqual(all.lines.filter((line) => line.timestamp >= '09-30 14:40:14.610'))
    expect(result.lines.length).toBeLessThan(all.lines.length)
  })

  it('prefers since over the watermark', async () => {
    const { simctl, device } = setup(NOW)
    await device.clearLogs()
    await device.readLogs({ since: '09-30 14:00:00.000' })
    expect(simctl.calls[0]).toContain('2026-09-30 14:00:00')
  })

  it('keeps the last lines and reports truncation', async () => {
    const { device } = setup(NOW)
    const all = await device.readLogs({ limit: 200 })
    const result = await device.readLogs({ limit: 2 })
    expect(result.lines).toEqual(all.lines.slice(-2))
    expect(result.truncated).toBe(true)
    expect(result.droppedCount).toBe(all.lines.length - 2)
  })

  it('filters by pid before applying the limit', async () => {
    const { device } = setup(NOW)
    const all = await device.readLogs({ limit: 200 })
    const pid = all.lines[0]!.pid
    const expected = all.lines.filter((line) => line.pid === pid)
    const result = await device.readLogs({ pids: [pid], limit: 200 })
    expect(result.lines).toEqual(expected)
  })

  it('passes the filter as one --predicate argument', async () => {
    const { simctl, device } = setup(NOW)
    await device.readLogs({ filter: 'a"b' })
    const args = simctl.calls[0]!
    const i = args.indexOf('--predicate')
    expect(args[i + 1]).toBe('eventMessage CONTAINS[c] "a\\"b" OR subsystem CONTAINS[c] "a\\"b" OR process CONTAINS[c] "a\\"b"')
    expect(args.length).toBe(i + 2)
  })

  it('does not leak epochMs into lines', async () => {
    const { device } = setup(NOW)
    const result = await device.readLogs({ limit: 1 })
    expect(Object.keys(result.lines[0]!).sort()).toEqual(['level', 'message', 'pid', 'tag', 'timestamp'])
  })
})
