import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { createIosLogTail } from './iosLogTail'
import { parseIosLogLine } from '../device/parsers/iosLog'
import type { LogLine } from '../../shared/types/device'
import type { TailState } from '../../shared/types/logs'
import type { ProcessStream } from '../process/processClient'
import type { SimctlClient } from '../ios/simctlClient'

const NDJSON = readFileSync(join(__dirname, '../device/parsers/__fixtures__/ios/log-stream.ndjson'), 'utf8')
  .split('\n')
  .filter((l) => l.trim() !== '')

interface FakeStream {
  line(raw: string): void
  close(code: number | null): void
  closed: boolean
}

function flush(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0))
}

function setup(): {
  tail: ReturnType<typeof createIosLogTail>
  streams: FakeStream[]
  streamArgs: string[][]
  lines: Array<{ line: LogLine; at: number }>
  states: TailState[]
  resumes: { count: number }
  connected: { value: boolean }
} {
  const streams: FakeStream[] = []
  const streamArgs: string[][] = []
  const lines: Array<{ line: LogLine; at: number }> = []
  const states: TailState[] = []
  const resumes = { count: 0 }
  const connected = { value: true }
  const simctl = {
    exec: async () => {
      throw new Error('exec 미사용')
    },
    stream: (args: string[]): ProcessStream => {
      streamArgs.push(args)
      let lineCb: (l: string) => void = () => {}
      let closeCb: (c: number | null) => void = () => {}
      const fake: FakeStream = {
        closed: false,
        line: (raw) => lineCb(raw),
        close: (code) => closeCb(code)
      }
      streams.push(fake)
      return {
        onLine: (cb) => (lineCb = cb),
        onData: () => {},
        onClose: (cb) => (closeCb = cb),
        onError: () => {},
        close: () => {
          fake.closed = true
        }
      }
    }
  } as SimctlClient
  const tail = createIosLogTail(
    { udid: 'UDID-1', simctl, isConnected: () => connected.value, sleep: async () => {} },
    {
      onLine: (line, at) => lines.push({ line, at }),
      onResume: () => {
        resumes.count += 1
      },
      onState: (s) => states.push(s)
    }
  )
  return { tail, streams, streamArgs, lines, states, resumes, connected }
}

describe('createIosLogTail', () => {
  it('log stream을 ndjson 스타일로 띄우고 줄마다 epochMs와 함께 onLine을 부른다', async () => {
    const s = setup()
    await s.tail.start()
    expect(s.streamArgs[0]).toEqual(['spawn', 'UDID-1', 'log', 'stream', '--style', 'ndjson'])
    s.streams[0]!.line('Filtering the log data using "..."') // 배너는 버린다
    for (const l of NDJSON) s.streams[0]!.line(l)
    s.streams[0]!.line('Child process terminated with signal 13')
    // 파서가 버리는 줄(logEvent가 아닌 것 등)은 onLine에 오지 않는다.
    const parseable = NDJSON.filter((l) => parseIosLogLine(l) !== null)
    expect(parseable.length).toBeGreaterThan(0)
    expect(s.lines).toHaveLength(parseable.length)
    expect(s.lines[0]!.at).toBeGreaterThan(0)
    expect(s.tail.lastTimestamp()).toBe(s.lines.at(-1)!.line.timestamp)
    expect(s.states).toEqual(['running'])
  })

  it('stream이 닫히면 다시 붙고 onResume을 부른다', async () => {
    const s = setup()
    await s.tail.start()
    s.streams[0]!.close(0)
    await flush()
    expect(s.resumes.count).toBe(1)
    expect(s.streams).toHaveLength(2)
    expect(s.states).toEqual(['running', 'reconnecting', 'running'])
  })

  it('기기가 끊겼으면 포기하고 stopped를 한 번 알린다', async () => {
    const s = setup()
    await s.tail.start()
    s.connected.value = false
    s.streams[0]!.close(0)
    await flush()
    expect(s.streams).toHaveLength(1)
    expect(s.states).toEqual(['running', 'stopped'])
  })

  it('stop() 뒤에는 아무 핸들러도 부르지 않는다', async () => {
    const s = setup()
    await s.tail.start()
    s.tail.stop()
    expect(s.streams[0]!.closed).toBe(true)
    const before = [...s.states]
    s.streams[0]!.line(NDJSON[0]!)
    s.streams[0]!.close(0)
    await flush()
    s.tail.stop()
    expect(s.states).toEqual([...before])
    expect(before).toEqual(['running', 'stopped'])
    expect(s.lines).toHaveLength(0)
    expect(s.resumes.count).toBe(0)
  })
})
