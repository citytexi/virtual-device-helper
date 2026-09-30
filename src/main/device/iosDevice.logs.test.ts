import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { fakeSimctl } from '../ios/testing'
import type { ProcessStream } from '../process/processClient'
import { deviceError, type DeviceError } from '../../shared/types/errors'
import { createIosDevice } from './iosDevice'

const ndjson = readFileSync(join(__dirname, 'parsers', '__fixtures__', 'ios', 'log-show.ndjson'), 'utf8')
const UDID = 'AAAA-BBBB'
const noopResize = (png: Buffer) => ({ png, width: 1, height: 1 })

const pad = (n: number) => String(n).padStart(2, '0')
function localStart(ms: number): string {
  const d = new Date(ms)
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
}

interface StreamScript {
  /** 흘릴 줄. 기본은 fixture 전체. */
  lines?: string[]
  /** 줄을 다 흘린 뒤 보낼 에러. onClose가 뒤따른다(processClient 계약). */
  error?: Error
  /** true면 줄만 흘리고 끝내지 않는다(시간 초과 확인용). */
  hang?: boolean
}

/** 어떤 log show 호출이든 fixture를 줄 단위로 흘리는 가짜 simctl.stream. exec는 쓰지 않는다. */
function fakeLogSimctl(script: StreamScript = {}) {
  const simctl = fakeSimctl({})
  const closed: boolean[] = []
  ;(simctl.stream as unknown as { mockImplementation: (f: (args: string[]) => ProcessStream) => void }).mockImplementation((args) => {
    ;(simctl.calls as string[][]).push(args)
    const index = closed.push(false) - 1
    let onLine: (line: string) => void = () => {}
    let onClose: (code: number | null) => void = () => {}
    let onError: (error: DeviceError) => void = () => {}
    setTimeout(() => {
      for (const line of script.lines ?? ndjson.split('\n')) onLine(line)
      if (script.hang) return
      if (script.error) {
        onError(script.error as DeviceError)
        onClose(null)
        return
      }
      onClose(0)
    }, 0)
    return {
      onLine: (cb) => (onLine = cb),
      onData: () => {},
      onClose: (cb) => (onClose = cb),
      onError: (cb) => (onError = cb),
      close: () => {
        closed[index] = true
      }
    }
  })
  return { simctl, closed }
}

function setup(nowMs: number, script: StreamScript = {}) {
  const { simctl, closed } = fakeLogSimctl(script)
  const device = createIosDevice({ udid: UDID, simctl, resizeImage: noopResize, now: () => nowMs })
  return { simctl, device, closed }
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
    const { simctl } = fakeLogSimctl()
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

  it('reads log show through a stream, not exec, so the output is never held whole', async () => {
    const { simctl, device } = setup(NOW)
    await device.readLogs()
    expect(simctl.stream).toHaveBeenCalledTimes(1)
    expect(simctl.exec).not.toHaveBeenCalled()
  })

  it('narrows by pid in the predicate too, ANDed with the filter', async () => {
    const { simctl, device } = setup(NOW)
    await device.readLogs({ pids: [12, 34] })
    await device.readLogs({ pids: [12], filter: 'x' })
    const onlyPids = simctl.calls[0]!
    expect(onlyPids.slice(onlyPids.indexOf('--predicate'))).toEqual(['--predicate', 'processID IN {12, 34}'])
    const both = simctl.calls[1]!
    expect(both.slice(both.indexOf('--predicate'))).toEqual([
      '--predicate',
      '(eventMessage CONTAINS[c] "x" OR subsystem CONTAINS[c] "x" OR process CONTAINS[c] "x") AND processID IN {12}'
    ])
  })

  it('keeps only integers in the pid predicate', async () => {
    const { simctl, device } = setup(NOW)
    await device.readLogs({ pids: [12, 1.5, Number.NaN, -3] as number[] })
    const args = simctl.calls[0]!
    expect(args[args.indexOf('--predicate') + 1]).toBe('processID IN {12}')
  })

  it('rejects with the stream error', async () => {
    const failure = deviceError('command_failed', 'simctl 명령이 실패했다', '첨부된 stderr를 확인해라')
    const { device } = setup(NOW, { error: failure })
    await expect(device.readLogs()).rejects.toBe(failure)
  })

  it('closes the stream and reports device_unresponsive when log show never ends', async () => {
    vi.useFakeTimers()
    try {
      const { device, closed } = setup(NOW, { hang: true })
      const settled = device.readLogs().catch((error: unknown) => error)
      await vi.advanceTimersByTimeAsync(60_000)
      const error = (await settled) as DeviceError
      expect(error.toolError.kind).toBe('device_unresponsive')
      expect(closed).toEqual([true])
    } finally {
      vi.useRealTimers()
    }
  })
})
