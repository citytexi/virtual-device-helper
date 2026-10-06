// @vitest-environment jsdom
import { act, fireEvent, render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { MainEvent, RendererApi, ScreenSlot } from '../../../shared/types/ipc'
import { DEVICE_KEYS, type DeviceKey, type SessionStatus } from '../../../shared/types/stream'
import type { ScrcpyStream } from '../hooks/useScrcpyStream'
import { useScrcpyStream } from '../hooks/useScrcpyStream'
import { DeviceScreen } from './DeviceScreen'

vi.mock('../hooks/useScrcpyStream', () => ({ useScrcpyStream: vi.fn() }))

/** 임의의 칸 id로 돈다. 화면은 칸 id를 해석하지 않는다. */
function slot(id: string, epoch: number, serial: string): ScreenSlot & { serial: string } {
  return { id, epoch, serial, label: serial }
}

const send = vi.fn()
const onFocusNext = vi.fn()
const onMakeTarget = vi.fn()
const selectDevice = vi.fn()
const handlers = () => ({ isTarget: false, onMakeTarget, onFocusNext })
const reconnect = vi.fn()
const captureScreenshot = vi.fn(async () => ({ ok: true, value: { base64: 'QUJD', width: 1, height: 1 } }))
const eventListeners: Array<(event: MainEvent) => void> = []

function streamWith(
  status: SessionStatus,
  video: ScrcpyStream['video'] = { width: 472, height: 1024 },
  keys: readonly DeviceKey[] = DEVICE_KEYS
): void {
  vi.mocked(useScrcpyStream).mockReturnValue({ status, video, keys: [...keys], send, reconnect })
}

// jsdom은 레이아웃을 하지 않는다. 캔버스가 비디오의 절반 크기로 딱 맞게 그려졌다고 둔다.
vi.spyOn(HTMLCanvasElement.prototype, 'getBoundingClientRect').mockReturnValue({
  left: 0,
  top: 0,
  width: 236,
  height: 512,
  right: 236,
  bottom: 512,
  x: 0,
  y: 0,
  toJSON: () => ({})
})

beforeEach(() => {
  send.mockClear()
  reconnect.mockClear()
  onFocusNext.mockClear()
  onMakeTarget.mockClear()
  selectDevice.mockClear()
  captureScreenshot.mockClear()
  vi.mocked(useScrcpyStream).mockClear()
  eventListeners.length = 0
  ;(window as unknown as { api: Partial<RendererApi> }).api = {
    captureScreenshot,
    selectDevice,
    onEvent: (listener: (event: MainEvent) => void) => {
      eventListeners.push(listener)
      return () => {}
    }
  } as unknown as RendererApi
})

describe('DeviceScreen', () => {
  it('opens the stream with the ref of its slot', () => {
    streamWith({ state: 'streaming' })

    render(<DeviceScreen screen={slot('x', 3, 'emulator-5554')} {...handlers()} />)

    expect(vi.mocked(useScrcpyStream).mock.calls[0]?.[0]).toEqual({ slotId: 'x', epoch: 3 })
  })

  it('shows the live canvas and takes no screenshot while streaming', () => {
    streamWith({ state: 'streaming' })

    render(<DeviceScreen screen={slot('x', 1, 'emulator-5554')} {...handlers()} />)

    expect(screen.getByLabelText('emulator-5554의 실시간 화면')).toBeDefined()
    expect(captureScreenshot).not.toHaveBeenCalled()
  })

  it('says it is connecting', () => {
    streamWith({ state: 'connecting' }, null)

    render(<DeviceScreen screen={slot('x', 1, 'emulator-5554')} {...handlers()} />)

    expect(screen.getByRole('status').textContent).toContain('연결 중')
  })

  it('says which reconnect attempt it is on', () => {
    streamWith({ state: 'reconnecting', attempt: 2 })

    render(<DeviceScreen screen={slot('x', 1, 'emulator-5554')} {...handlers()} />)

    expect(screen.getByRole('status').textContent).toContain('2/3')
  })

  it('falls back to the screenshot view with the reason and a reconnect button when the stream fails', async () => {
    streamWith({ state: 'failed', error: { kind: 'device_unresponsive', message: '서버가 안 뜬다', hint: '다시 연결해라' } })

    render(<DeviceScreen screen={slot('x', 1, 'emulator-5554')} {...handlers()} />)

    expect(screen.getByText(/서버가 안 뜬다/)).toBeDefined()
    expect(screen.queryByLabelText('emulator-5554의 실시간 화면')).toBeNull()
    expect(captureScreenshot).toHaveBeenCalledWith('emulator-5554')
    await userEvent.click(screen.getByRole('button', { name: '다시 연결' }))
    expect(reconnect).toHaveBeenCalled()
  })

  it('sends a hardware key from the toolbar', async () => {
    streamWith({ state: 'streaming' })
    render(<DeviceScreen screen={slot('x', 1, 'emulator-5554')} {...handlers()} />)

    await userEvent.click(screen.getByRole('button', { name: '홈' }))

    expect(send).toHaveBeenCalledWith({ type: 'key', key: 'home' })
  })

  it('세션이 준 keys에 없는 버튼은 그리지 않는다', () => {
    streamWith({ state: 'streaming' }, { width: 590, height: 1278 }, ['home', 'power'])

    render(<DeviceScreen screen={slot('x', 1, 'sim-1')} {...handlers()} />)

    expect(screen.queryByRole('button', { name: '뒤로' })).toBeNull()
    expect(screen.queryByRole('button', { name: '최근 앱' })).toBeNull()
    expect(screen.getByRole('button', { name: '홈' })).toBeDefined()
    expect(screen.getByRole('button', { name: '전원' })).toBeDefined()
  })

  it('첫 session 전(keys가 빈 배열)에는 툴바에 키 버튼이 없다', () => {
    streamWith({ state: 'connecting' }, null, [])

    render(<DeviceScreen screen={slot('x', 1, 'emulator-5554')} {...handlers()} />)

    expect(within(screen.getByRole('toolbar', { name: '기기 버튼 emulator-5554 emulator-5554' })).queryAllByRole('button')).toHaveLength(0)
  })

  it('disables the toolbar until the stream is live', () => {
    streamWith({ state: 'connecting' }, null)

    render(<DeviceScreen screen={slot('x', 1, 'emulator-5554')} {...handlers()} />)

    expect(screen.getByRole('button', { name: '뒤로' })).toHaveProperty('disabled', true)
  })

  it('turns a drag into touch down, move and up in video coordinates', () => {
    streamWith({ state: 'streaming' })
    render(<DeviceScreen screen={slot('x', 1, 'emulator-5554')} {...handlers()} />)
    const canvas = screen.getByLabelText('emulator-5554의 실시간 화면')

    fireEvent.pointerDown(canvas, { clientX: 50, clientY: 100, button: 0, pointerId: 1 })
    fireEvent.pointerMove(canvas, { clientX: 60, clientY: 150, pointerId: 1 })
    fireEvent.pointerUp(canvas, { clientX: 500, clientY: 150, pointerId: 1 })

    const point = (x: number, y: number) => ({ x, y, width: 472, height: 1024 })
    expect(send.mock.calls.map((call) => call[0])).toEqual([
      { type: 'touch', action: 'down', point: point(100, 200) },
      { type: 'touch', action: 'move', point: point(120, 300) },
      // 캔버스 밖에서 손을 떼도 가장자리로 붙여 up을 보낸다.
      { type: 'touch', action: 'up', point: point(471, 300) }
    ])
  })

  it('does not send a move without a pressed pointer', () => {
    streamWith({ state: 'streaming' })
    render(<DeviceScreen screen={slot('x', 1, 'emulator-5554')} {...handlers()} />)

    fireEvent.pointerMove(screen.getByLabelText('emulator-5554의 실시간 화면'), { clientX: 60, clientY: 150 })

    expect(send).not.toHaveBeenCalled()
  })

  it('sends the wheel as a scroll at the pointer', () => {
    streamWith({ state: 'streaming' })
    render(<DeviceScreen screen={slot('x', 1, 'emulator-5554')} {...handlers()} />)

    fireEvent.wheel(screen.getByLabelText('emulator-5554의 실시간 화면'), { clientX: 50, clientY: 100, deltaY: 100, deltaMode: 0 })

    expect(send).toHaveBeenCalledWith({
      type: 'scroll',
      point: { x: 100, y: 200, width: 472, height: 1024 },
      hScroll: 0,
      vScroll: -1
    })
  })

  it('sends typed ascii as text and leaves Cmd shortcuts alone', () => {
    streamWith({ state: 'streaming' })
    render(<DeviceScreen screen={slot('x', 1, 'emulator-5554')} {...handlers()} />)
    const canvas = screen.getByLabelText('emulator-5554의 실시간 화면')

    fireEvent.keyDown(canvas, { key: 'a' })
    fireEvent.keyDown(canvas, { key: 'r', metaKey: true })

    expect(send.mock.calls.map((call) => call[0])).toEqual([{ type: 'text', text: 'a' }])
  })

  it('lets Shift+Tab pass through so focus can leave the canvas (no keyboard trap)', () => {
    streamWith({ state: 'streaming' })
    render(<DeviceScreen screen={slot('x', 1, 'emulator-5554')} {...handlers()} />)
    const canvas = screen.getByLabelText('emulator-5554의 실시간 화면')

    const notPrevented = fireEvent.keyDown(canvas, { key: 'Tab', shiftKey: true })

    // fireEvent는 preventDefault가 호출되지 않았을 때만 true를 돌려준다.
    expect(notPrevented).toBe(true)
    expect(send).not.toHaveBeenCalled()
  })

  it('draws an agent tap over the live canvas', () => {
    streamWith({ state: 'streaming' }, { width: 540, height: 1200 })
    const { container } = render(<DeviceScreen screen={slot('x', 1, 'emulator-5554')} {...handlers()} />)

    act(() =>
      eventListeners.forEach((listener) =>
        listener({
          type: 'timeline',
          entry: {
            kind: 'tool_call',
            id: '1',
            tool: 'ui_tap',
            argsSummary: '{}',
            at: 0,
            durationMs: 1,
            ok: true,
            detail: { args: '{}' },
            gesture: { kind: 'tap', serial: 'emulator-5554', x: 0.5, y: 0.3875 }
          }
        })
      )
    )

    expect(container.querySelector('.screen-stage svg.gesture-overlay circle.gesture-tap')).not.toBeNull()
  })

  it('section과 툴바의 접근성 이름이 label과 serial을 담는다', () => {
    streamWith({ state: 'streaming' })

    render(<DeviceScreen screen={{ id: 'x', epoch: 1, serial: 'sim-1', label: 'iPhone 16' }} {...handlers()} />)

    expect(screen.getByRole('region', { name: '기기 화면 iPhone 16 sim-1' })).toBeDefined()
    expect(screen.getByRole('toolbar', { name: '기기 버튼 iPhone 16 sim-1' })).toBeDefined()
  })

  it('툴바 키 버튼을 누른 뒤 포커스가 그 화면의 캔버스에 있다', async () => {
    streamWith({ state: 'streaming' })
    render(<DeviceScreen screen={slot('x', 1, 'emulator-5554')} {...handlers()} />)

    await userEvent.click(screen.getByRole('button', { name: '홈' }))

    expect(document.activeElement).toBe(screen.getByLabelText('emulator-5554의 실시간 화면'))
  })

  it('머리의 버튼에 포커스가 있을 때 F6을 누르면 onFocusNext가 불리고 기본 동작은 막힌다', () => {
    streamWith({ state: 'streaming' })
    render(<DeviceScreen screen={slot('x', 1, 'emulator-5554')} {...handlers()} />)
    const button = screen.getByRole('button', { name: /대상으로/ })
    button.focus()

    const notPrevented = fireEvent.keyDown(button, { key: 'F6' })

    expect(onFocusNext).toHaveBeenCalledTimes(1)
    expect(notPrevented).toBe(false)
    expect(send).not.toHaveBeenCalled()
  })

  it('캔버스에서 F6을 눌러도 기기로 보내지 않고 onFocusNext를 부른다', () => {
    streamWith({ state: 'streaming' })
    render(<DeviceScreen screen={slot('x', 1, 'emulator-5554')} {...handlers()} />)

    fireEvent.keyDown(screen.getByLabelText('emulator-5554의 실시간 화면'), { key: 'F6' })

    expect(onFocusNext).toHaveBeenCalledTimes(1)
    expect(send).not.toHaveBeenCalled()
  })

  it('캔버스를 클릭하고 타이핑해도 selectDevice를 부르지 않는다', async () => {
    streamWith({ state: 'streaming' })
    render(<DeviceScreen screen={slot('x', 1, 'emulator-5554')} {...handlers()} />)
    const canvas = screen.getByLabelText('emulator-5554의 실시간 화면')

    fireEvent.pointerDown(canvas, { clientX: 50, clientY: 100, button: 0, pointerId: 1 })
    fireEvent.pointerUp(canvas, { clientX: 50, clientY: 100, pointerId: 1 })
    await userEvent.click(canvas)
    fireEvent.keyDown(canvas, { key: 'a' })

    expect(selectDevice).not.toHaveBeenCalled()
    expect(onMakeTarget).not.toHaveBeenCalled()
  })

  it('화면마다 포커스 대상이 하나다: 캔버스가 있으면 캔버스', () => {
    streamWith({ state: 'streaming' })
    const { container } = render(<DeviceScreen screen={slot('x', 1, 'emulator-5554')} {...handlers()} />)

    const targets = container.querySelectorAll('[data-screen-focus]')
    expect(targets).toHaveLength(1)
    expect(targets[0]).toBe(screen.getByLabelText('emulator-5554의 실시간 화면'))
  })

  it('스크린샷으로 강등되면 section이 포커스 대상이다', () => {
    streamWith({ state: 'failed', error: { kind: 'device_unresponsive', message: '서버가 안 뜬다', hint: '다시 연결해라' } })
    const { container } = render(<DeviceScreen screen={slot('x', 1, 'emulator-5554')} {...handlers()} />)

    const targets = container.querySelectorAll('[data-screen-focus]')
    expect(targets).toHaveLength(1)
    expect(targets[0]).toBe(screen.getByRole('region', { name: /기기 화면/ }))
    expect(targets[0]?.getAttribute('tabindex')).toBe('-1')
  })

  it('다시 연결로 캔버스가 다시 마운트되면 캔버스에 포커스가 간다', async () => {
    streamWith({ state: 'failed', error: { kind: 'device_unresponsive', message: '서버가 안 뜬다', hint: '다시 연결해라' } })
    const { rerender } = render(<DeviceScreen screen={slot('x', 1, 'emulator-5554')} {...handlers()} />)

    await userEvent.click(screen.getByRole('button', { name: '다시 연결' }))
    streamWith({ state: 'connecting' }, null)
    rerender(<DeviceScreen screen={slot('x', 1, 'emulator-5554')} {...handlers()} />)

    expect(document.activeElement).toBe(screen.getByLabelText('emulator-5554의 실시간 화면'))
  })
})
