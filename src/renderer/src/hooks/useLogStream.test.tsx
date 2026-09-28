// @vitest-environment jsdom
import { StrictMode } from 'react'
import { act, renderHook, waitFor } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import type { LogDown, LogEntry, LogPortMeta } from '../../../shared/types/logs'
import { useLogStream, type LogRow, type LogStream, type LogStreamDeps } from './useLogStream'

interface FakePort {
  onmessage: ((event: MessageEvent) => void) | null
  postMessage: ReturnType<typeof vi.fn>
  close: ReturnType<typeof vi.fn>
}

function fakePort(): FakePort {
  return { onmessage: null, postMessage: vi.fn(), close: vi.fn() }
}

function entry(seq: number, message = `line ${seq}`): LogEntry {
  return { timestamp: '01-01 00:00:00.000', level: 'I', tag: 'tag', pid: 1, message, seq, at: seq }
}

/** rows는 이제 버퍼 실물(복사 없음)이라 start부터 잘라야 실제로 살아있는 행이 나온다. */
function liveRows(stream: Pick<LogStream, 'rows' | 'start'>): LogRow[] {
  return stream.rows.slice(stream.start)
}

function harness(openResult: Awaited<ReturnType<LogStreamDeps['openLogs']>> = { ok: true, value: undefined }) {
  let portCallback: ((meta: LogPortMeta, port: MessagePort) => void) | null = null
  const deps: LogStreamDeps = {
    openLogs: vi.fn(async () => openResult),
    closeLogs: vi.fn(async () => ({ ok: true as const, value: undefined })),
    onLogPort: vi.fn((callback) => {
      portCallback = callback
      return () => {
        portCallback = null
      }
    })
  }
  const deliverPort = (serial: string, port: FakePort, sessionId = 's1') =>
    act(() => portCallback?.({ serial, sessionId }, port as unknown as MessagePort))
  const deliver = (port: FakePort, message: LogDown) => act(() => port.onmessage?.({ data: message } as MessageEvent))
  return { deps, deliverPort, deliver }
}

describe('useLogStream', () => {
  it('does not open logs without a serial', () => {
    const h = harness()

    renderHook(() => useLogStream(null, true, h.deps))

    expect(h.deps.openLogs).not.toHaveBeenCalled()
  })

  it('fills rows from snapshot chunks and marks caughtUp on done', async () => {
    const h = harness()
    const { result } = renderHook(() => useLogStream('emulator-5554', true, h.deps))
    await waitFor(() => expect(h.deps.openLogs).toHaveBeenCalledWith('emulator-5554'))
    const port = fakePort()
    h.deliverPort('emulator-5554', port)

    h.deliver(port, { type: 'snapshot', entries: [entry(0), entry(1)], done: false })
    h.deliver(port, { type: 'snapshot', entries: [entry(2), entry(3)], done: true })

    expect(liveRows(result.current)).toHaveLength(4)
    expect(result.current.caughtUp).toBe(true)
  })

  it('appends batches and trims to capacity', () => {
    const h = harness()
    const { result } = renderHook(() => useLogStream('emulator-5554', true, h.deps, 5))
    const port = fakePort()
    h.deliverPort('emulator-5554', port)

    h.deliver(port, {
      type: 'batch',
      entries: Array.from({ length: 8 }, (_, i) => entry(i))
    })

    const rows = liveRows(result.current)
    expect(rows).toHaveLength(5)
    expect(rows.map((r) => (r.kind === 'line' ? r.entry.seq : -1))).toEqual([3, 4, 5, 6, 7])
  })

  it('keeps the same rows array identity across appends and compaction, capped at capacity', () => {
    const h = harness()
    const { result } = renderHook(() => useLogStream('emulator-5554', true, h.deps, 3))
    const port = fakePort()
    h.deliverPort('emulator-5554', port)
    h.deliver(port, { type: 'batch', entries: [entry(0), entry(1)] })
    const rowsRef = result.current.rows

    // 계속 한 줄씩 보내 start가 여러 번 capacity에 닿아 압축(splice)이 일어나게 한다.
    for (let i = 2; i < 20; i++) {
      h.deliver(port, { type: 'batch', entries: [entry(i)] })
    }

    // splice는 배열을 제자리에서 바꾸는 것이라 참조가 그대로다 — 50000줄짜리 배열을
    // 100ms마다 통째로 복사하지 않는다는 게 이 테스트의 핵심이다.
    expect(result.current.rows).toBe(rowsRef)
    expect(result.current.rows.length - result.current.start).toBeLessThanOrEqual(3)
    expect(liveRows(result.current).map((r) => (r.kind === 'line' ? r.entry.seq : -1))).toEqual([17, 18, 19])
  })

  it('ignores a repeated batch and an overlapping snapshot (seq guard)', () => {
    const h = harness()
    const { result } = renderHook(() => useLogStream('emulator-5554', true, h.deps))
    const port = fakePort()
    h.deliverPort('emulator-5554', port)

    const batch: LogDown = { type: 'batch', entries: [entry(0), entry(1), entry(2)] }
    h.deliver(port, batch)
    h.deliver(port, batch) // 같은 batch가 다시 온다(StrictMode 이중 호출·재전송 등)

    expect(liveRows(result.current)).toHaveLength(3)

    // 0..2는 이미 받은 seq다 — snapshot이 겹쳐 와도 3만 새로 들어가야 한다.
    h.deliver(port, { type: 'snapshot', entries: [entry(0), entry(1), entry(2), entry(3)], done: true })

    const rows = liveRows(result.current)
    expect(rows).toHaveLength(4)
    expect(rows.map((r) => (r.kind === 'line' ? r.entry.seq : -1))).toEqual([0, 1, 2, 3])
  })

  it('inserts a gap row', () => {
    const h = harness()
    const { result } = renderHook(() => useLogStream('emulator-5554', true, h.deps))
    const port = fakePort()
    h.deliverPort('emulator-5554', port)

    h.deliver(port, { type: 'gap', fromSeq: 3, toSeq: 9 })

    expect(liveRows(result.current)).toEqual([{ kind: 'gap', fromSeq: 3, toSeq: 9 }])
  })

  it('sends pause and drops caughtUp in the same render it hides, then resumes from lastSeq', () => {
    const h = harness()
    const { result, rerender } = renderHook(({ visible }: { visible: boolean }) => useLogStream('emulator-5554', visible, h.deps), {
      initialProps: { visible: true }
    })
    const port = fakePort()
    h.deliverPort('emulator-5554', port)
    h.deliver(port, { type: 'batch', entries: [entry(0), entry(1), entry(2), entry(3)] })

    rerender({ visible: false })

    expect(port.postMessage).toHaveBeenCalledWith({ type: 'pause' })
    expect(result.current.caughtUp).toBe(false)

    rerender({ visible: true })

    expect(port.postMessage).toHaveBeenCalledWith({ type: 'resume', afterSeq: 3 })
    expect(result.current.caughtUp).toBe(false)

    h.deliver(port, { type: 'resumed', lastSeq: 3 })

    expect(result.current.caughtUp).toBe(true)
  })

  it('drops caughtUp in the very render that hides, without waiting for the effect', () => {
    const h = harness()
    const renders: boolean[] = []
    const { rerender } = renderHook(
      ({ visible }: { visible: boolean }) => {
        const stream = useLogStream('emulator-5554', visible, h.deps)
        renders.push(stream.caughtUp)
        return stream
      },
      { initialProps: { visible: true } }
    )
    const port = fakePort()
    h.deliverPort('emulator-5554', port)
    h.deliver(port, { type: 'snapshot', entries: [entry(0)], done: true })
    renders.length = 0 // 지금까지의 렌더 기록은 지운다 — visible=false로 바뀌는 렌더만 본다.

    rerender({ visible: false })

    // caughtUp은 visible && caughtUpState로 계산되므로, hide effect가 아직 안 돌았어도
    // visible=false로 렌더되는 바로 그 순간부터 false다.
    expect(renders[0]).toBe(false)
  })

  it('ignores a snapshot done that arrives while hidden — caughtUp only becomes true via resumed', () => {
    const h = harness()
    const { result, rerender } = renderHook(({ visible }: { visible: boolean }) => useLogStream('emulator-5554', visible, h.deps), {
      initialProps: { visible: true }
    })
    const port = fakePort()
    h.deliverPort('emulator-5554', port)

    rerender({ visible: false })
    // 숨긴 뒤에도(예: main이 pause를 아직 못 받았을 때) done:true snapshot이 올 수 있다.
    h.deliver(port, { type: 'snapshot', entries: [entry(0)], done: true })
    expect(result.current.caughtUp).toBe(false)

    rerender({ visible: true })
    expect(result.current.caughtUp).toBe(false) // resumed가 오기 전까지는 여전히 false

    h.deliver(port, { type: 'resumed', lastSeq: 0 })
    expect(result.current.caughtUp).toBe(true)
  })

  it('resumes from -1 when nothing was received', () => {
    const h = harness()
    const { rerender } = renderHook(({ visible }: { visible: boolean }) => useLogStream('emulator-5554', visible, h.deps), {
      initialProps: { visible: true }
    })
    const port = fakePort()
    h.deliverPort('emulator-5554', port)

    rerender({ visible: false })
    rerender({ visible: true })

    expect(port.postMessage).toHaveBeenCalledWith({ type: 'resume', afterSeq: -1 })
  })

  it('does not double-append under StrictMode', () => {
    const h = harness()
    const { result } = renderHook(() => useLogStream('emulator-5554', true, h.deps), { wrapper: StrictMode })
    const port = fakePort()
    h.deliverPort('emulator-5554', port)

    h.deliver(port, { type: 'batch', entries: [entry(0), entry(1), entry(2)] })

    expect(liveRows(result.current)).toHaveLength(3)
  })

  it('keeps rows and shows stopped when the device disconnects', () => {
    const h = harness()
    const { result } = renderHook(() => useLogStream('emulator-5554', true, h.deps))
    const port = fakePort()
    h.deliverPort('emulator-5554', port)
    h.deliver(port, { type: 'batch', entries: [entry(0), entry(1)] })

    h.deliver(port, { type: 'status', state: 'stopped' })

    expect(result.current.status).toBe('stopped')
    expect(liveRows(result.current)).toHaveLength(2)
  })

  it('closes the old port and ignores its late messages after the serial changes', () => {
    const h = harness()
    const { result, rerender } = renderHook(({ serial }: { serial: string }) => useLogStream(serial, true, h.deps), {
      initialProps: { serial: 'emulator-5554' }
    })
    const oldPort = fakePort()
    h.deliverPort('emulator-5554', oldPort)
    h.deliver(oldPort, { type: 'batch', entries: [entry(0)] })
    expect(liveRows(result.current)).toHaveLength(1)

    rerender({ serial: 'emulator-5556' })

    // serial 변경 = 새 세션 취급 — 옛 포트는 닫히고 버퍼는 비워진다.
    expect(oldPort.close).toHaveBeenCalledTimes(1)
    expect(liveRows(result.current)).toHaveLength(0)

    // e1 포트 이벤트가 늦게 도착한다 — 새 effect(serial e2)는 이걸 즉시 닫는다.
    h.deliverPort('emulator-5554', oldPort)
    expect(oldPort.close).toHaveBeenCalledTimes(2)

    // e1 포트로 늦게 온 batch는 무시된다.
    h.deliver(oldPort, { type: 'batch', entries: [entry(1), entry(2)] })
    expect(liveRows(result.current)).toHaveLength(0)

    // 반면 e2용으로 새로 온 포트의 메시지는 정상적으로 반영된다.
    const newPort = fakePort()
    h.deliverPort('emulator-5556', newPort)
    h.deliver(newPort, { type: 'batch', entries: [entry(5)] })
    expect(liveRows(result.current)).toHaveLength(1)
  })

  it('keeps rows and shows stopped when the serial goes from a device to null', () => {
    const h = harness()
    const { result, rerender } = renderHook(
      ({ serial }: { serial: string | null }) => useLogStream(serial, true, h.deps),
      { initialProps: { serial: 'emulator-5554' as string | null } }
    )
    const port = fakePort()
    h.deliverPort('emulator-5554', port)
    h.deliver(port, { type: 'batch', entries: [entry(0), entry(1)] })

    // 기기가 끊기면 registry가 active를 null로 돌린다 — 받은 줄은 남긴다.
    rerender({ serial: null })

    expect(port.close).toHaveBeenCalled()
    expect(h.deps.closeLogs).toHaveBeenCalled()
    expect(result.current.status).toBe('stopped')
    expect(liveRows(result.current).map((r) => (r.kind === 'line' ? r.entry.seq : -1))).toEqual([0, 1])
  })

  it('clears the kept rows and opens the new device when a serial comes back after null', async () => {
    const h = harness()
    const { result, rerender } = renderHook(
      ({ serial }: { serial: string | null }) => useLogStream(serial, true, h.deps),
      { initialProps: { serial: 'emulator-5554' as string | null } }
    )
    const port = fakePort()
    h.deliverPort('emulator-5554', port)
    h.deliver(port, { type: 'batch', entries: [entry(0)] })
    rerender({ serial: null })

    rerender({ serial: 'emulator-5556' })

    expect(liveRows(result.current)).toHaveLength(0)
    expect(result.current.status).toBe('idle')
    await waitFor(() => expect(h.deps.openLogs).toHaveBeenLastCalledWith('emulator-5556'))
  })

  it('tracks packages and status', () => {
    const h = harness()
    const { result } = renderHook(() => useLogStream('emulator-5554', true, h.deps))
    const port = fakePort()
    h.deliverPort('emulator-5554', port)

    h.deliver(port, { type: 'packages', packages: ['com.example.app'] })
    h.deliver(port, { type: 'status', state: 'reconnecting' })

    expect(result.current.packages).toEqual(['com.example.app'])
    expect(result.current.status).toBe('reconnecting')
  })

  it('closes logs on unmount', () => {
    const h = harness()
    const { unmount } = renderHook(() => useLogStream('emulator-5554', true, h.deps))
    const port = fakePort()
    h.deliverPort('emulator-5554', port)

    unmount()

    expect(port.close).toHaveBeenCalled()
    expect(h.deps.closeLogs).toHaveBeenCalled()
  })

  it('shows stopped with empty rows when openLogs resolves with an error', async () => {
    const error = { kind: 'no_device' as const, message: '그런 기기가 없다', hint: 'x' }
    const h = harness({ ok: false, error })

    const { result } = renderHook(() => useLogStream('emulator-5554', true, h.deps))

    await waitFor(() => expect(result.current.status).toBe('stopped'))
    expect(liveRows(result.current)).toHaveLength(0)
  })

  it('replaces an older port with a newer one for the same serial, clearing the buffer', () => {
    const h = harness()
    const { result } = renderHook(() => useLogStream('emulator-5554', true, h.deps))
    const older = fakePort()
    h.deliverPort('emulator-5554', older, 's1')
    h.deliver(older, { type: 'batch', entries: [entry(0), entry(1)] })

    const newer = fakePort()
    h.deliverPort('emulator-5554', newer, 's2')

    expect(older.close).toHaveBeenCalled()
    expect(liveRows(result.current)).toHaveLength(0)

    h.deliver(newer, { type: 'snapshot', entries: [entry(0)], done: true })
    expect(liveRows(result.current)).toHaveLength(1)
  })
})
