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

function setup(
  opts: {
    execStdout?: string
    execRejects?: boolean
    /** exec이 이 promise가 풀릴 때까지 기다리게 한다. start() 도중 stop()이 끼어드는 경우를 재현한다. */
    execGate?: () => Promise<void>
    sleep?: (ms: number) => Promise<void>
  } = {}
): Setup {
  const streams: FakeStream[] = []
  const streamArgs: string[][] = []
  const lines: Array<{ line: LogLine; at: number }> = []
  const states: TailState[] = []
  let onResumeCalls = 0
  const connected = { value: true }
  const clock = { value: 0 }

  const adb: Pick<AdbClient, 'exec' | 'stream'> = {
    exec: async (): Promise<ExecResult> => {
      if (opts.execGate) await opts.execGate()
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
        // 실제 adbClient의 close()는 SIGTERM을 보내고 나중에 close 이벤트가 뒤따른다.
        // 그 뒤따르는 close 이벤트를 재현해야 "stop()이 부른 close도 handleClose를 한 번
        // 더 태운다"는 경로(그리고 그 경로가 stopped 가드로 조용히 물러난다는 것)를 검증할 수 있다.
        close: () => fake.close(null)
      }
    }
  }

  const deps: LogTailDeps = {
    serial: 'emulator-5554',
    adb,
    isConnected: () => connected.value,
    now: () => clock.value,
    sleep: opts.sleep ?? (async () => {})
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

  it('does not orphan a stream when stop() runs while start() awaits the clock exec', async () => {
    let releaseExec: () => void = () => {}
    const s = setup({
      execGate: () =>
        new Promise<void>((resolve) => {
          releaseExec = resolve
        })
    })

    const startPromise = s.tail.start()
    s.tail.stop() // exec이 아직 안 끝났을 때 stop()이 끼어든다
    releaseExec() // 이제야 exec이 풀린다(성공이든 실패든 상관없다)
    await startPromise

    expect(s.streamArgs).toHaveLength(0) // spawnStream이 불리지 않았다 — 고아 프로세스가 없다
    expect(s.states).toEqual(['stopped'])
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

  it('gives up when every restart only replays the resume-timestamp line', async () => {
    // -T로 이어 받으면 그 timestamp의 줄이 다시 온다(재생). 재생 줄만으로 재시도 카운터를
    // 되돌리면 재생 직후 죽는 기기에서 재시도가 끝없이 이어진다 — 그러면 안 된다.
    const s = setup()
    await s.tail.start()

    for (let i = 0; i < 4; i += 1) {
      s.streams[i]!.line('09-28 10:00:00.000  1  1 I T: a')
      s.streams[i]!.close(0)
      await flush()
    }

    expect(s.states.at(-1)).toBe('stopped')
    // 최초 1회 + 재시도 3회
    expect(s.streamArgs).toHaveLength(4)
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

    // 포기한 뒤 log manager가 정리 차원에서 stop()을 불러도 'stopped'가 두 번 나가지 않는다
    s.tail.stop()
    expect(s.states.filter((state) => state === 'stopped')).toHaveLength(1)
  })

  it('does not reconnect after stop()', async () => {
    const s = setup()
    await s.tail.start()

    s.tail.stop()
    await flush()

    expect(s.streamArgs).toHaveLength(1)
    expect(s.states).toEqual(['running', 'stopped'])
  })

  it('does not reconnect when stop() is called while a reconnect sleep is in flight', async () => {
    // sleep이 끝날 때까지 stopped를 세우지 않으면 close 뒤에 재시작이 일어난다.
    let releaseSleep: () => void = () => {}
    const s = setup({
      sleep: () =>
        new Promise<void>((resolve) => {
          releaseSleep = () => resolve()
        })
    })

    await s.tail.start()
    s.streams[0]!.close(0) // unexpected close → reconnecting, sleep이 걸려 있는 채로 멈춘다
    await flush()
    expect(s.states.at(-1)).toBe('reconnecting')

    s.tail.stop()
    releaseSleep() // sleep이 뒤늦게 끝나도 재시작하지 않아야 한다
    await flush()

    expect(s.states).toEqual(['running', 'reconnecting', 'stopped'])
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

    // 이후 log manager가 stop()을 불러도 'stopped'가 다시 나가지 않는다
    s.tail.stop()
    expect(s.states).toEqual(['running', 'stopped'])
  })

  it('exposes the last received timestamp', async () => {
    const s = setup()
    expect(s.tail.lastTimestamp()).toBeNull()

    await s.tail.start()
    s.streams[0]!.line('09-28 10:00:00.000  1  1 I T: a')

    expect(s.tail.lastTimestamp()).toBe('09-28 10:00:00.000')
  })
})
