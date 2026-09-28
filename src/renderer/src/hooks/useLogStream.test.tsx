// @vitest-environment jsdom
import { StrictMode } from 'react'
import { act, renderHook, waitFor } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import type { LogDown, LogEntry, LogPortMeta } from '../../../shared/types/logs'
import { useLogStream, type LogStreamDeps } from './useLogStream'

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

    expect(result.current.rows).toHaveLength(4)
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

    expect(result.current.rows).toHaveLength(5)
    expect(result.current.rows.map((r) => (r.kind === 'line' ? r.entry.seq : -1))).toEqual([3, 4, 5, 6, 7])
  })

  it('inserts a gap row', () => {
    const h = harness()
    const { result } = renderHook(() => useLogStream('emulator-5554', true, h.deps))
    const port = fakePort()
    h.deliverPort('emulator-5554', port)

    h.deliver(port, { type: 'gap', fromSeq: 3, toSeq: 9 })

    expect(result.current.rows).toEqual([{ kind: 'gap', fromSeq: 3, toSeq: 9 }])
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

    expect(result.current.rows).toHaveLength(3)
  })

  it('keeps rows and shows stopped when the device disconnects', () => {
    const h = harness()
    const { result } = renderHook(() => useLogStream('emulator-5554', true, h.deps))
    const port = fakePort()
    h.deliverPort('emulator-5554', port)
    h.deliver(port, { type: 'batch', entries: [entry(0), entry(1)] })

    h.deliver(port, { type: 'status', state: 'stopped' })

    expect(result.current.status).toBe('stopped')
    expect(result.current.rows).toHaveLength(2)
  })

  it('closes the old port and ignores its late messages after the serial changes', () => {
    const h = harness()
    const { rerender } = renderHook(({ serial }: { serial: string }) => useLogStream(serial, true, h.deps), {
      initialProps: { serial: 'emulator-5554' }
    })
    const oldPort = fakePort()
    h.deliverPort('emulator-5554', oldPort)

    rerender({ serial: 'emulator-5556' })

    expect(oldPort.close).toHaveBeenCalled()

    h.deliverPort('emulator-5554', oldPort)
    expect(oldPort.close).toHaveBeenCalledTimes(2)

    h.deliver(oldPort, { type: 'batch', entries: [entry(0)] })
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
    expect(result.current.rows).toHaveLength(0)
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
    expect(result.current.rows).toHaveLength(0)

    h.deliver(newer, { type: 'snapshot', entries: [entry(0)], done: true })
    expect(result.current.rows).toHaveLength(1)
  })
})
