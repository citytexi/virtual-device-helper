// @vitest-environment jsdom
import { act, renderHook, waitFor } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import type { StreamDown, StreamPortMeta } from '../../../shared/types/stream'
import type { JpegRenderer } from '../stream/jpegRenderer'
import type { StreamDecoder } from '../stream/streamDecoder'
import { useScrcpyStream, type ScrcpyStreamDeps, type StreamDecoderHandlers } from './useScrcpyStream'

interface FakePort {
  onmessage: ((event: MessageEvent) => void) | null
  postMessage: ReturnType<typeof vi.fn>
  close: ReturnType<typeof vi.fn>
}

function fakePort(): FakePort {
  return { onmessage: null, postMessage: vi.fn(), close: vi.fn() }
}

function harness(startResult: Awaited<ReturnType<ScrcpyStreamDeps['startStream']>> = { ok: true, value: undefined }) {
  let portCallback: ((meta: StreamPortMeta, port: MessagePort) => void) | null = null
  const decoders: Array<StreamDecoder & { push: ReturnType<typeof vi.fn>; close: ReturnType<typeof vi.fn>; handlers: StreamDecoderHandlers }> = []
  const jpegRenderers: Array<JpegRenderer & { push: ReturnType<typeof vi.fn>; close: ReturnType<typeof vi.fn>; draw: (bitmap: ImageBitmap) => void }> = []
  const deps: ScrcpyStreamDeps = {
    startStream: vi.fn(async () => startResult),
    stopStream: vi.fn(async () => ({ ok: true as const, value: undefined })),
    onStreamPort: vi.fn((callback) => {
      portCallback = callback
      return () => {
        portCallback = null
      }
    }),
    createDecoder: vi.fn((handlers) => {
      const decoder = { push: vi.fn(), close: vi.fn(), handlers }
      decoders.push(decoder)
      return decoder
    }),
    createJpegRenderer: vi.fn((draw) => {
      const renderer = { push: vi.fn(), close: vi.fn(), draw }
      jpegRenderers.push(renderer)
      return renderer
    })
  }
  const canvasRef: { current: HTMLCanvasElement | null } = { current: null }
  const deliverPort = (serial: string, port: FakePort) =>
    act(() => portCallback?.({ serial, sessionId: 'x' }, port as unknown as MessagePort))
  const deliver = (port: FakePort, message: StreamDown) => act(() => port.onmessage?.({ data: message } as MessageEvent))
  return { deps, canvasRef, decoders, jpegRenderers, deliverPort, deliver }
}

describe('useScrcpyStream', () => {
  it('asks main for a stream and starts as connecting', async () => {
    const h = harness()

    const { result } = renderHook(() => useScrcpyStream('emulator-5554', h.canvasRef, h.deps))

    expect(result.current.status).toEqual({ state: 'connecting' })
    await waitFor(() => expect(h.deps.startStream).toHaveBeenCalledWith('emulator-5554'))
  })

  it('adopts the port for its serial and follows status, session and packets', async () => {
    const h = harness()
    const { result } = renderHook(() => useScrcpyStream('emulator-5554', h.canvasRef, h.deps))
    const port = fakePort()

    h.deliverPort('emulator-5554', port)
    h.deliver(port, { type: 'status', status: { state: 'streaming' } })
    h.deliver(port, { type: 'session', width: 472, height: 1024, codec: 'h264', keys: ['home', 'back'] })
    h.deliver(port, { type: 'packet', config: true, key: false, ptsUs: null, data: new Uint8Array([1]) })

    expect(result.current.status).toEqual({ state: 'streaming' })
    expect(result.current.video).toEqual({ width: 472, height: 1024 })
    expect(result.current.keys).toEqual(['home', 'back'])
    expect(h.decoders[0]?.push).toHaveBeenCalledTimes(1)
  })

  it('closes a port that belongs to another serial', () => {
    const h = harness()
    renderHook(() => useScrcpyStream('emulator-5554', h.canvasRef, h.deps))
    const stale = fakePort()

    h.deliverPort('emulator-5556', stale)

    expect(stale.close).toHaveBeenCalled()
    expect(h.decoders).toHaveLength(0)
  })

  it('replaces an older port with a newer one for the same serial', () => {
    const h = harness()
    renderHook(() => useScrcpyStream('emulator-5554', h.canvasRef, h.deps))
    const older = fakePort()
    const newer = fakePort()

    h.deliverPort('emulator-5554', older)
    h.deliverPort('emulator-5554', newer)

    expect(older.close).toHaveBeenCalled()
    expect(h.decoders[0]?.close).toHaveBeenCalled()
    expect(h.decoders).toHaveLength(2)
  })

  it('reports failed when main refuses to start the stream', async () => {
    const error = { kind: 'no_device' as const, message: '그런 기기가 없다', hint: 'x' }
    const h = harness({ ok: false, error })

    const { result } = renderHook(() => useScrcpyStream('emulator-5554', h.canvasRef, h.deps))

    await waitFor(() => expect(result.current.status).toEqual({ state: 'failed', error }))
  })

  it('sends input through the adopted port', () => {
    const h = harness()
    const { result } = renderHook(() => useScrcpyStream('emulator-5554', h.canvasRef, h.deps))
    const port = fakePort()
    h.deliverPort('emulator-5554', port)

    result.current.send({ type: 'key', key: 'home' })

    expect(port.postMessage).toHaveBeenCalledWith({ type: 'key', key: 'home' })
  })

  it('restarts the stream when the decoder fails', async () => {
    const h = harness()
    renderHook(() => useScrcpyStream('emulator-5554', h.canvasRef, h.deps))
    h.deliverPort('emulator-5554', fakePort())

    act(() => h.decoders[0]?.handlers.onError(new Error('decode')))

    await waitFor(() => expect(h.deps.startStream).toHaveBeenCalledTimes(2))
    expect(h.deps.stopStream).toHaveBeenCalledTimes(1)
  })

  it('restarts the stream on reconnect', async () => {
    const h = harness()
    const { result } = renderHook(() => useScrcpyStream('emulator-5554', h.canvasRef, h.deps))

    act(() => result.current.reconnect())

    await waitFor(() => expect(h.deps.startStream).toHaveBeenCalledTimes(2))
  })

  it('stops the stream and closes the port on unmount', () => {
    const h = harness()
    const { unmount } = renderHook(() => useScrcpyStream('emulator-5554', h.canvasRef, h.deps))
    const port = fakePort()
    h.deliverPort('emulator-5554', port)

    unmount()

    expect(port.close).toHaveBeenCalled()
    expect(h.decoders[0]?.close).toHaveBeenCalled()
    expect(h.deps.stopStream).toHaveBeenCalled()
  })

  it('ignores messages from a port after it was replaced', () => {
    const h = harness()
    const { result } = renderHook(() => useScrcpyStream('emulator-5554', h.canvasRef, h.deps))
    const older = fakePort()
    h.deliverPort('emulator-5554', older)
    const onmessage = older.onmessage
    h.deliverPort('emulator-5554', fakePort())

    act(() => onmessage?.({ data: { type: 'status', status: { state: 'reconnecting', attempt: 1 } } } as MessageEvent))

    expect(result.current.status).toEqual({ state: 'connecting' })
  })

  it('demotes to failed after exceeding the decoder-restart limit, without restarting again', async () => {
    const h = harness()
    const { result } = renderHook(() => useScrcpyStream('emulator-5554', h.canvasRef, h.deps))
    await waitFor(() => expect(h.deps.startStream).toHaveBeenCalledTimes(1))

    // 한도(3)까지는 실패마다 재시작한다.
    for (let i = 0; i < 3; i++) {
      h.deliverPort('emulator-5554', fakePort())
      act(() => h.decoders[i]?.handlers.onError(new Error(`decode ${i}`)))
      await waitFor(() => expect(h.deps.startStream).toHaveBeenCalledTimes(i + 2))
    }

    // 한도를 넘긴 네 번째 실패는 재시작하지 않고 바로 failed로 강등한다.
    h.deliverPort('emulator-5554', fakePort())
    act(() => h.decoders[3]?.handlers.onError(new Error('decode 4th')))

    expect(h.deps.startStream).toHaveBeenCalledTimes(4)
    expect(result.current.status).toEqual({
      state: 'failed',
      error: { kind: 'command_failed', message: 'decode 4th', hint: '다시 연결해라' }
    })
  })

  it('releases the port and stops the stream when the decoder-restart limit is hit, so a late status cannot overwrite failed', async () => {
    const h = harness()
    const { result } = renderHook(() => useScrcpyStream('emulator-5554', h.canvasRef, h.deps))
    await waitFor(() => expect(h.deps.startStream).toHaveBeenCalledTimes(1))

    for (let i = 0; i < 3; i++) {
      h.deliverPort('emulator-5554', fakePort())
      act(() => h.decoders[i]?.handlers.onError(new Error(`decode ${i}`)))
      await waitFor(() => expect(h.deps.startStream).toHaveBeenCalledTimes(i + 2))
    }

    const lastPort = fakePort()
    h.deliverPort('emulator-5554', lastPort)
    act(() => h.decoders[3]?.handlers.onError(new Error('decode 4th')))

    expect(result.current.status).toEqual({
      state: 'failed',
      error: { kind: 'command_failed', message: 'decode 4th', hint: '다시 연결해라' }
    })
    expect(lastPort.close).toHaveBeenCalled()
    expect(h.decoders[3]?.close).toHaveBeenCalled()
    expect(h.deps.stopStream).toHaveBeenCalled()

    // main은 이 실패를 모른다 — 그래도 늦게 온 status가 failed를 덮어쓰지 못한다.
    h.deliver(lastPort, { type: 'status', status: { state: 'streaming' } })

    expect(result.current.status).toEqual({
      state: 'failed',
      error: { kind: 'command_failed', message: 'decode 4th', hint: '다시 연결해라' }
    })
  })

  it('a decoded frame resets the consecutive-failure count', async () => {
    const h = harness()
    renderHook(() => useScrcpyStream('emulator-5554', h.canvasRef, h.deps))
    await waitFor(() => expect(h.deps.startStream).toHaveBeenCalledTimes(1))

    // 한도까지 실패를 채운다.
    for (let i = 0; i < 3; i++) {
      h.deliverPort('emulator-5554', fakePort())
      act(() => h.decoders[i]?.handlers.onError(new Error(`decode ${i}`)))
      await waitFor(() => expect(h.deps.startStream).toHaveBeenCalledTimes(i + 2))
    }

    // 새 포트에서 프레임이 그려졌다 — 실패 카운트가 씻긴다.
    h.deliverPort('emulator-5554', fakePort())
    const frame = { close: vi.fn() } as unknown as VideoFrame
    act(() => h.decoders[3]?.handlers.onFrame(frame))

    // 카운트가 씻겼으니 다음 실패는 바로 failed로 가지 않고 다시 재시작한다.
    act(() => h.decoders[3]?.handlers.onError(new Error('decode after frame')))

    await waitFor(() => expect(h.deps.startStream).toHaveBeenCalledTimes(5))
  })

  it('reconnect after a decoder-limit failure starts the stream again', async () => {
    const h = harness()
    const { result } = renderHook(() => useScrcpyStream('emulator-5554', h.canvasRef, h.deps))
    await waitFor(() => expect(h.deps.startStream).toHaveBeenCalledTimes(1))

    for (let i = 0; i < 3; i++) {
      h.deliverPort('emulator-5554', fakePort())
      act(() => h.decoders[i]?.handlers.onError(new Error(`decode ${i}`)))
      await waitFor(() => expect(h.deps.startStream).toHaveBeenCalledTimes(i + 2))
    }
    h.deliverPort('emulator-5554', fakePort())
    act(() => h.decoders[3]?.handlers.onError(new Error('decode 4th')))
    expect(result.current.status.state).toBe('failed')

    act(() => result.current.reconnect())
    await waitFor(() => expect(h.deps.startStream).toHaveBeenCalledTimes(5))

    const port = fakePort()
    h.deliverPort('emulator-5554', port)
    h.deliver(port, { type: 'status', status: { state: 'streaming' } })

    expect(result.current.status).toEqual({ state: 'streaming' })
  })

  it('closes the port and demotes to failed when creating the decoder throws', async () => {
    const h = harness()
    vi.mocked(h.deps.createDecoder).mockImplementationOnce(() => {
      throw new Error('코덱을 못 만든다')
    })
    const { result } = renderHook(() => useScrcpyStream('emulator-5554', h.canvasRef, h.deps))
    await waitFor(() => expect(h.deps.startStream).toHaveBeenCalledTimes(1))
    const port = fakePort()

    h.deliverPort('emulator-5554', port)

    expect(port.close).toHaveBeenCalled()
    expect(result.current.status).toEqual({
      state: 'failed',
      error: { kind: 'command_failed', message: '코덱을 못 만든다', hint: '다시 연결해라' }
    })
    expect(h.deps.stopStream).toHaveBeenCalled()
  })

  it('closes the frame after drawing even when canvasRef is empty', () => {
    const h = harness()
    renderHook(() => useScrcpyStream('emulator-5554', h.canvasRef, h.deps))
    h.deliverPort('emulator-5554', fakePort())
    const frame = { close: vi.fn() } as unknown as VideoFrame

    act(() => h.decoders[0]?.handlers.onFrame(frame))

    expect(frame.close).toHaveBeenCalled()
  })

  it('sizes the canvas to the frame, draws it, then closes the frame', () => {
    const h = harness()
    const drawImage = vi.fn()
    const canvas = {
      width: 0,
      height: 0,
      getContext: vi.fn(() => ({ drawImage }))
    } as unknown as HTMLCanvasElement
    h.canvasRef.current = canvas
    renderHook(() => useScrcpyStream('emulator-5554', h.canvasRef, h.deps))
    const port = fakePort()
    h.deliverPort('emulator-5554', port)
    h.deliver(port, { type: 'session', width: 472, height: 1024, codec: 'h264', keys: [] })
    const frame = { displayWidth: 472, displayHeight: 1024, close: vi.fn() } as unknown as VideoFrame

    act(() => h.decoders[0]?.handlers.onFrame(frame))

    expect(canvas.width).toBe(472)
    expect(canvas.height).toBe(1024)
    expect(drawImage).toHaveBeenCalledWith(frame, 0, 0)
    expect(frame.close).toHaveBeenCalled()
    const drawOrder = drawImage.mock.invocationCallOrder[0]
    const closeOrder = vi.mocked(frame.close).mock.invocationCallOrder[0]
    expect(drawOrder).toBeLessThan(closeOrder as number)
  })

  it('closes a stale port for the previous serial after switching devices, and stops before starting the next stream', async () => {
    const h = harness()
    const { rerender } = renderHook(({ serial }: { serial: string }) => useScrcpyStream(serial, h.canvasRef, h.deps), {
      initialProps: { serial: 'emulator-5554' }
    })
    await waitFor(() => expect(h.deps.startStream).toHaveBeenCalledWith('emulator-5554'))

    rerender({ serial: 'emulator-5556' })
    await waitFor(() => expect(h.deps.startStream).toHaveBeenCalledWith('emulator-5556'))

    const stalePort = fakePort()
    h.deliverPort('emulator-5554', stalePort)

    expect(stalePort.close).toHaveBeenCalled()
    expect(h.decoders).toHaveLength(0)

    const stopOrder = vi.mocked(h.deps.stopStream).mock.invocationCallOrder[0]
    const startBOrder = vi.mocked(h.deps.startStream).mock.invocationCallOrder[1]
    expect(stopOrder).toBeLessThan(startBOrder as number)
  })

  describe('jpeg codec', () => {
    function canvasWith(drawImage = vi.fn()) {
      return { width: 0, height: 0, getContext: vi.fn(() => ({ drawImage })) } as unknown as HTMLCanvasElement
    }

    it('frame 메시지를 jpeg 경로로 보내고 VideoDecoder 쪽은 쓰지 않는다', () => {
      const h = harness()
      renderHook(() => useScrcpyStream('sim-1', h.canvasRef, h.deps))
      const port = fakePort()
      h.deliverPort('sim-1', port)
      h.deliver(port, { type: 'session', width: 590, height: 1278, codec: 'jpeg', keys: ['home'] })
      const data = new Uint8Array([0xff, 0xd8])

      h.deliver(port, { type: 'frame', data })

      expect(h.jpegRenderers).toHaveLength(1)
      expect(h.jpegRenderers[0]?.push).toHaveBeenCalledWith(data)
      expect(h.decoders[0]?.push).not.toHaveBeenCalled()
      expect(h.decoders[0]?.close).toHaveBeenCalled()
    })

    it('codec이 h264에서 jpeg로 바뀌면 이전 디코더를 닫는다', () => {
      const h = harness()
      renderHook(() => useScrcpyStream('sim-1', h.canvasRef, h.deps))
      const port = fakePort()
      h.deliverPort('sim-1', port)
      h.deliver(port, { type: 'session', width: 472, height: 1024, codec: 'h264', keys: [] })
      expect(h.decoders[0]?.close).not.toHaveBeenCalled()

      h.deliver(port, { type: 'session', width: 590, height: 1278, codec: 'jpeg', keys: [] })

      expect(h.decoders[0]?.close).toHaveBeenCalled()
      expect(h.jpegRenderers).toHaveLength(1)
    })

    it('codec이 jpeg에서 h264로 바뀌면 jpeg 경로를 닫고 새 디코더를 만든다', () => {
      const h = harness()
      renderHook(() => useScrcpyStream('sim-1', h.canvasRef, h.deps))
      const port = fakePort()
      h.deliverPort('sim-1', port)
      h.deliver(port, { type: 'session', width: 590, height: 1278, codec: 'jpeg', keys: [] })

      h.deliver(port, { type: 'session', width: 472, height: 1024, codec: 'h264', keys: [] })

      expect(h.jpegRenderers[0]?.close).toHaveBeenCalled()
      expect(h.decoders).toHaveLength(2)
    })

    it('같은 codec의 session이 다시 오면 경로를 새로 만들지 않는다', () => {
      const h = harness()
      renderHook(() => useScrcpyStream('sim-1', h.canvasRef, h.deps))
      const port = fakePort()
      h.deliverPort('sim-1', port)
      h.deliver(port, { type: 'session', width: 590, height: 1278, codec: 'jpeg', keys: [] })
      h.deliver(port, { type: 'session', width: 1278, height: 590, codec: 'jpeg', keys: [] })

      expect(h.jpegRenderers).toHaveLength(1)
    })

    it('회전해 width/height가 다른 session이 오면 캔버스 크기와 video가 따라간다', () => {
      const h = harness()
      const canvas = canvasWith()
      h.canvasRef.current = canvas
      const { result } = renderHook(() => useScrcpyStream('sim-1', h.canvasRef, h.deps))
      const port = fakePort()
      h.deliverPort('sim-1', port)
      h.deliver(port, { type: 'session', width: 590, height: 1278, codec: 'jpeg', keys: [] })
      expect([canvas.width, canvas.height]).toEqual([590, 1278])

      h.deliver(port, { type: 'session', width: 1278, height: 590, codec: 'jpeg', keys: [] })

      expect([canvas.width, canvas.height]).toEqual([1278, 590])
      expect(result.current.video).toEqual({ width: 1278, height: 590 })
    })

    it('bitmap을 캔버스(session 크기)에 맞춰 그리고 닫는다', () => {
      const h = harness()
      const drawImage = vi.fn()
      const canvas = canvasWith(drawImage)
      h.canvasRef.current = canvas
      renderHook(() => useScrcpyStream('sim-1', h.canvasRef, h.deps))
      const port = fakePort()
      h.deliverPort('sim-1', port)
      h.deliver(port, { type: 'session', width: 590, height: 1278, codec: 'jpeg', keys: [] })
      const bitmap = { close: vi.fn() } as unknown as ImageBitmap

      act(() => h.jpegRenderers[0]?.draw(bitmap))

      expect(drawImage).toHaveBeenCalledWith(bitmap, 0, 0, 590, 1278)
      expect(bitmap.close).toHaveBeenCalled()
    })

    it('unmount하면 jpeg 경로도 닫는다', () => {
      const h = harness()
      const { unmount } = renderHook(() => useScrcpyStream('sim-1', h.canvasRef, h.deps))
      const port = fakePort()
      h.deliverPort('sim-1', port)
      h.deliver(port, { type: 'session', width: 590, height: 1278, codec: 'jpeg', keys: [] })

      unmount()

      expect(h.jpegRenderers[0]?.close).toHaveBeenCalled()
    })
  })
})
