import { describe, expect, it } from 'vitest'
import { createLogTail, type LogTailDeps, type LogTailHandlers } from './logTail'
import { toHostEpoch } from './logClock'
import type { LogLine } from '../../shared/types/device'
import type { TailState } from '../../shared/types/logs'
import type { AdbClient, AdbStream, ExecResult } from '../adb/adbClient'

/** 테스트용 가짜 AdbStream. 콜백을 배열에 모아 뒀다가 line/close/error로 흘려보낸다. */
interface FakeStream {
  line(raw: string): void
  close(code: number | null): void
}

function flush(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0))
}

interface Setup {
  tail: ReturnType<typeof createLogTail>
  streams: FakeStream[]
  streamArgs: string[][]
  lines: Array<{ line: LogLine; at: number }>
  states: TailState[]
  onResumeCalls: number
  connected: { value: boolean }
  clock: { value: number }
}

function setup(opts: { execStdout?: string; execRejects?: boolean } = {}): Setup {
  const streams: FakeStream[] = []
  const streamArgs: string[][] = []
  const lines: Array<{ line: LogLine; at: number }> = []
  const states: TailState[] = []
  let onResumeCalls = 0
  const connected = { value: true }
  const clock = { value: 0 }

  const adb: Pick<AdbClient, 'exec' | 'stream'> = {
    exec: async (): Promise<ExecResult> => {
      if (opts.execRejects) throw new Error('boom')
      return {
        stdout: opts.execStdout ?? '',
        stdoutRaw: Buffer.from(opts.execStdout ?? ''),
        stderr: '',
        exitCode: 0
      }
    },
    stream: (_serial: string | null, args: string[]): AdbStream => {
      streamArgs.push(args)
      const lineCbs: Array<(line: string) => void> = []
      const closeCbs: Array<(code: number | null) => void> = []
      const fake: FakeStream = {
        line: (raw) => {
          for (const cb of lineCbs) cb(raw)
        },
        close: (code) => {
          for (const cb of closeCbs) cb(code)
        }
      }
      streams.push(fake)
      return {
        onLine: (cb) => lineCbs.push(cb),
        onData: () => {},
        onClose: (cb) => closeCbs.push(cb),
        onError: () => {},
        close: () => {}
      }
    }
  }

  const deps: LogTailDeps = {
    serial: 'emulator-5554',
    adb,
    isConnected: () => connected.value,
    now: () => clock.value,
    sleep: async () => {}
  }

  const handlers: LogTailHandlers = {
    onLine: (line, at) => lines.push({ line, at }),
    onResume: () => {
      onResumeCalls += 1
    },
    onState: (state) => states.push(state)
  }

  const tail = createLogTail(deps, handlers)
  return {
    tail,
    streams,
    streamArgs,
    lines,
    states,
    get onResumeCalls() {
      return onResumeCalls
    },
    connected,
    clock
  } as Setup
}

describe('createLogTail', () => {
  it('starts with -T 2000 and reports running', async () => {
    const { tail, streamArgs, states } = setup()
    await tail.start()
    expect(streamArgs[0]).toEqual(['logcat', '-v', 'threadtime', '-T', '2000'])
    expect(states).toEqual(['running'])
  })

  it('converts device timestamps with the measured offset', async () => {
    // toHostEpoch가 연도를 호스트 현재 시각으로 추정하므로 실제 epoch 규모의 값을 쓴다.
    const hostAt = Date.parse('2026-09-28T10:00:05Z')
    // 기기가 1000ms 늦다(기기 epoch = hostAt - 1000) → offset = +1000
    const s = setup({ execStdout: String(hostAt - 1000) })
    s.clock.value = hostAt
    await s.tail.start()

    s.clock.value = hostAt // 줄을 받는 순간의 호스트 시각(연도 추정에만 쓰인다)
    s.streams[0]!.line('09-28 10:00:00.000  1  1 I T: a')

    const expectedAt = toHostEpoch('09-28 10:00:00.000', 1000, hostAt)
    expect(s.lines[0]!.at).toBe(expectedAt)
  })

  it('falls back to host receive time when date fails', async () => {
    // '%3N'이 펼쳐지지 않은 값 → parseDeviceEpoch가 null
    const s = setup({ execStdout: '1790000000%3N' })
    await s.tail.start()

    s.clock.value = 42_000
    s.streams[0]!.line('09-28 10:00:00.000  1  1 I T: a')

    expect(s.lines[0]!.at).toBe(42_000)
  })

  it('falls back when the date exec rejects', async () => {
    const s = setup({ execRejects: true })
    await s.tail.start()

    s.clock.value = 99_000
    s.streams[0]!.line('09-28 10:00:00.000  1  1 I T: a')

    expect(s.lines[0]!.at).toBe(99_000)
  })

  it('restarts from the last timestamp after an unexpected close', async () => {
    const s = setup()
    await s.tail.start()

    s.streams[0]!.line('09-28 10:00:00.000  1  1 I T: a')
    s.streams[0]!.close(0)
    await flush()

    expect(s.states).toEqual(['running', 'reconnecting', 'running'])
    expect(s.streamArgs[1]).toEqual(['logcat', '-v', 'threadtime', '-T', '09-28 10:00:00.000'])
    expect(s.onResumeCalls).toBe(1)
  })

  it('gives up after the reconnect delays and reports stopped', async () => {
    const s = setup()
    await s.tail.start()

    // 매번 즉시 닫혀서 한 번도 줄을 못 받는 경우
    for (let i = 0; i < 4; i += 1) {
      s.streams[i]!.close(0)
      await flush()
    }

    expect(s.states.at(-1)).toBe('stopped')
    // 최초 1회 + 재시도 3회
    expect(s.streamArgs).toHaveLength(4)
  })

  it('does not reconnect after stop()', async () => {
    const s = setup()
    await s.tail.start()

    s.tail.stop()
    await flush()

    expect(s.streamArgs).toHaveLength(1)
    expect(s.states.at(-1)).toBe('stopped')
  })

  it('does not reconnect when stop() is called while a reconnect sleep is in flight', async () => {
    // sleep이 끝날 때까지 stopped를 세우지 않으면 close 뒤에 재시작이 일어난다.
    let releaseSleep: () => void = () => {}
    const s = setup()
    const deps: LogTailDeps = {
      serial: 'emulator-5554',
      adb: {
        exec: async () => ({ stdout: '', stdoutRaw: Buffer.alloc(0), stderr: '', exitCode: 0 }),
        stream: (_serial, args) => {
          s.streamArgs.push(args)
          const lineCbs: Array<(line: string) => void> = []
          const closeCbs: Array<(code: number | null) => void> = []
          const fake: FakeStream = {
            line: (raw) => {
              for (const cb of lineCbs) cb(raw)
            },
            close: (code) => {
              for (const cb of closeCbs) cb(code)
            }
          }
          s.streams.push(fake)
          return {
            onLine: (cb) => lineCbs.push(cb),
            onData: () => {},
            onClose: (cb) => closeCbs.push(cb),
            onError: () => {},
            close: () => {}
          }
        }
      },
      isConnected: () => true,
      now: () => s.clock.value,
      sleep: () =>
        new Promise<void>((resolve) => {
          releaseSleep = () => resolve()
        })
    }
    const handlers: LogTailHandlers = {
      onLine: (line, at) => s.lines.push({ line, at }),
      onResume: () => {},
      onState: (state) => s.states.push(state)
    }
    const tail = createLogTail(deps, handlers)

    await tail.start()
    s.streams[0]!.close(0) // unexpected close → reconnecting, sleep이 걸려 있는 채로 멈춘다
    await flush()
    expect(s.states.at(-1)).toBe('reconnecting')

    tail.stop()
    releaseSleep() // sleep이 뒤늦게 끝나도 재시작하지 않아야 한다
    await flush()

    expect(s.states.at(-1)).toBe('stopped')
    expect(s.streamArgs).toHaveLength(1)
  })

  it('stops without retry when the device is gone', async () => {
    const s = setup()
    await s.tail.start()
    s.connected.value = false

    s.streams[0]!.close(0)
    await flush()

    expect(s.states).toEqual(['running', 'stopped'])
    expect(s.streamArgs).toHaveLength(1)
  })

  it('exposes the last received timestamp', async () => {
    const s = setup()
    expect(s.tail.lastTimestamp()).toBeNull()

    await s.tail.start()
    s.streams[0]!.line('09-28 10:00:00.000  1  1 I T: a')

    expect(s.tail.lastTimestamp()).toBe('09-28 10:00:00.000')
  })
})
