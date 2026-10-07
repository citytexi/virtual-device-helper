// @vitest-environment jsdom
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { AppSnapshot, MainEvent, RendererApi, ScreenSlot } from '../../shared/types/ipc'
import { App } from './App'

// 한 serial('BOOM')에서만 던지는 DeviceScreen. 나머지는 진짜 DeviceScreen이다.
vi.mock('./components/DeviceScreen', async () => {
  const actual = await vi.importActual<typeof import('./components/DeviceScreen')>('./components/DeviceScreen')
  return {
    ...actual,
    DeviceScreen: (props: Parameters<typeof actual.DeviceScreen>[0]) => {
      if (props.screen.serial === 'BOOM') throw new Error('그리다 터졌다')
      return actual.DeviceScreen(props)
    }
  }
})

const eventListeners: Array<(event: MainEvent) => void> = []
const fire = (event: MainEvent): void => act(() => eventListeners.forEach((listener) => listener(event)))

function mockApi(snapshot: AppSnapshot): void {
  eventListeners.length = 0
  ;(window as unknown as { api: Partial<RendererApi> }).api = {
    getSnapshot: vi.fn(async () => snapshot),
    onEvent: (listener: (event: MainEvent) => void) => {
      eventListeners.push(listener)
      return () => {
        const at = eventListeners.indexOf(listener)
        if (at >= 0) eventListeners.splice(at, 1)
      }
    },
    captureScreenshot: vi.fn(async () => ({ ok: true, value: { base64: 'QUJD', width: 1, height: 1 } })),
    selectDevice: vi.fn(),
    bootVirtualDevice: vi.fn(),
    shutdownDevice: vi.fn(),
    startStream: vi.fn(async () => ({ ok: true, value: undefined })),
    stopStream: vi.fn(async () => ({ ok: true, value: undefined })),
    openLogs: vi.fn(async () => ({ ok: true, value: undefined })),
    closeLogs: vi.fn(async () => ({ ok: true, value: undefined }))
  } as unknown as RendererApi
}

function mockApiRejecting(reason: string): void {
  ;(window as unknown as { api: Partial<RendererApi> }).api = {
    getSnapshot: vi.fn(async () => {
      throw new Error(reason)
    }),
    onEvent: () => () => {},
    captureScreenshot: vi.fn(),
    selectDevice: vi.fn(),
    bootVirtualDevice: vi.fn(),
    shutdownDevice: vi.fn(),
    startStream: vi.fn(async () => ({ ok: true, value: undefined })),
    stopStream: vi.fn(async () => ({ ok: true, value: undefined })),
    openLogs: vi.fn(async () => ({ ok: true, value: undefined })),
    closeLogs: vi.fn(async () => ({ ok: true, value: undefined }))
  } as unknown as RendererApi
}

const ready: AppSnapshot = {
  platforms: {
    android: { ok: true, location: '/opt/sdk', notes: [] },
    ios: { ok: true, location: '/Applications/Xcode.app/Contents/Developer', notes: [] }
  },
  server: { url: 'http://127.0.0.1:9321/mcp', port: 9321, token: 'token-value' },
  virtualDevices: [{ platform: 'android', id: 'Pixel_7_API_34', name: 'Pixel_7_API_34', running: true, serial: 'emulator-5554', osVersion: null }],
  devices: ['emulator-5554'],
  activeSerial: 'emulator-5554',
  screens: [],
  timeline: [],
  trackingFailures: { android: null, ios: null }
}

beforeEach(() => {
  mockApi(ready)
})

describe('App', () => {
  it('shows a loading state before the snapshot arrives', () => {
    render(<App />)

    expect(screen.getByText(/불러오는 중/)).toBeDefined()
  })

  it('renders the device panel, screen area, work area and endpoint card once ready', async () => {
    render(<App />)

    await waitFor(() => expect(screen.getByRole('region', { name: '기기' })).toBeDefined())
    expect(screen.getByRole('region', { name: '기기 화면' })).toBeDefined()
    expect(screen.getByRole('region', { name: '작업 영역' })).toBeDefined()
    expect(screen.getByText('http://127.0.0.1:9321/mcp')).toBeDefined()
  })

  it('replaces the whole screen with the guidance when neither platform is ready', async () => {
    mockApi({
      ...ready,
      platforms: {
        android: { ok: false, reason: 'Android SDK를 찾지 못했다', searched: ['/opt/a/adb'], hint: 'Android Studio를 설치해라' },
        ios: { ok: false, reason: 'macOS에서만 iOS 시뮬레이터를 쓸 수 있다', searched: [], hint: null }
      },
      server: null,
      virtualDevices: []
    })

    render(<App />)

    await waitFor(() => expect(screen.getByText(/Android Studio/)).toBeDefined())
    expect(screen.queryByRole('region', { name: '작업 영역' })).toBeNull()
  })

  it('keeps the device panel and shows a one-line Android notice when only Android is missing', async () => {
    mockApi({
      ...ready,
      platforms: {
        android: { ok: false, reason: 'Android SDK를 찾지 못했다', searched: ['/opt/a/adb'], hint: null },
        ios: { ok: true, location: '/Applications/Xcode.app/Contents/Developer', notes: [] }
      }
    })

    render(<App />)

    await waitFor(() => expect(screen.getByRole('region', { name: '기기' })).toBeDefined())
    expect(screen.getByText('Android SDK를 찾지 못했다')).toBeDefined()
    expect(screen.queryByRole('main', { name: '기기 도구를 찾지 못했다' })).toBeNull()
  })

  const api = () => (window as unknown as { api: { startStream: ReturnType<typeof vi.fn>; stopStream: ReturnType<typeof vi.fn> } }).api
  const slot = (id: string, epoch: number, serial: string | null): ScreenSlot => ({ id, epoch, serial, label: serial ?? '' })

  it('draws every occupied slot, opening each stream by slot and epoch', async () => {
    mockApi({ ...ready, activeSerial: null, screens: [slot('x', 0, null), slot('y', 2, 'emulator-5554'), slot('z', 1, 'SIM-1')] })

    render(<App />)

    await waitFor(() => expect(screen.getByLabelText('emulator-5554의 실시간 화면')).toBeDefined())
    expect(screen.getByLabelText('SIM-1의 실시간 화면')).toBeDefined()
    await waitFor(() => expect(api().startStream).toHaveBeenCalledWith({ slotId: 'y', epoch: 2 }))
    await waitFor(() => expect(api().startStream).toHaveBeenCalledWith({ slotId: 'z', epoch: 1 }))
    expect(api().startStream).toHaveBeenCalledTimes(2)
  })

  it('draws the screen again when the epoch of that slot rises', async () => {
    mockApi({ ...ready, screens: [slot('x', 1, 'emulator-5554')] })
    render(<App />)
    await waitFor(() => expect(api().startStream).toHaveBeenCalledWith({ slotId: 'x', epoch: 1 }))

    fire({ type: 'screens_changed', screens: [slot('x', 2, 'emulator-5556')] })

    await waitFor(() => expect(api().startStream).toHaveBeenCalledWith({ slotId: 'x', epoch: 2 }))
    expect(api().startStream).toHaveBeenCalledTimes(2)
    expect(api().stopStream).toHaveBeenCalledWith({ slotId: 'x', epoch: 1 })
    expect(screen.getByLabelText('emulator-5556의 실시간 화면')).toBeDefined()
  })

  it('shows the empty message when no slot holds a device', async () => {
    mockApi({ ...ready, screens: [slot('x', 0, null), slot('y', 0, null)] })

    render(<App />)

    await waitFor(() => expect(screen.getByText('연결된 기기가 없다. 왼쪽 목록에서 기기를 부팅해라')).toBeDefined())
    expect(screen.getByRole('region', { name: '기기 화면' })).toBeDefined()
    expect(api().startStream).not.toHaveBeenCalled()
  })

  it('does not restart the stream when a timeline event redraws the app', async () => {
    mockApi({ ...ready, screens: [slot('x', 1, 'emulator-5554')] })
    render(<App />)
    await waitFor(() => expect(api().startStream).toHaveBeenCalledTimes(1))

    fire({
      type: 'timeline',
      entry: { kind: 'device', id: 'e1', at: 1, serial: 'emulator-5554', event: 'stream_started' }
    })
    fire({
      type: 'timeline',
      entry: { kind: 'device', id: 'e2', at: 2, serial: 'emulator-5554', event: 'stream_stopped' }
    })

    expect(api().startStream).toHaveBeenCalledTimes(1)
    expect(api().stopStream).not.toHaveBeenCalled()
  })

  it('shows an alert with a restart hint when the app state fails to load', async () => {
    mockApiRejecting('IPC 채널이 끊어졌다')

    render(<App />)

    await waitFor(() => expect(screen.getByRole('alert')).toBeDefined())
    const alert = screen.getByRole('alert')
    expect(alert.textContent).toContain('IPC 채널이 끊어졌다')
    expect(alert.textContent).toMatch(/다시 시작/)
    expect(screen.queryByText(/불러오는 중/)).toBeNull()
  })

  const occupied = (id: string, epoch: number, serial: string, label = serial): ScreenSlot => ({ id, epoch, serial, label })
  const twoScreens = (): ScreenSlot[] => [occupied('x', 1, 'emulator-5554', 'Pixel 7'), occupied('y', 1, 'SIM-1', 'iPhone 16')]

  it('찬 칸이 둘이면 이름이 서로 다른 화면 region이 둘이다', async () => {
    mockApi({ ...ready, screens: twoScreens() })

    render(<App />)

    await waitFor(() => expect(screen.getAllByRole('region', { name: /^기기 화면/ })).toHaveLength(2))
    const names = screen.getAllByRole('region', { name: /^기기 화면/ }).map((r) => r.getAttribute('aria-label'))
    expect(new Set(names).size).toBe(2)
  })

  it('찬 칸이 하나면 화면 region이 하나다', async () => {
    mockApi({ ...ready, screens: [occupied('x', 1, 'emulator-5554')] })

    render(<App />)

    await waitFor(() => expect(screen.getAllByRole('region', { name: /^기기 화면/ })).toHaveLength(1))
  })

  const NO_TARGET = '대상 기기가 없다. 화면 머리의 "대상으로"를 누르거나 툴 호출에 serial을 넘겨라'

  it.each([1, 2])('화면이 %i개이고 대상이 없으면 안내가 보인다', async (n) => {
    mockApi({ ...ready, activeSerial: null, devices: ['emulator-5554', 'SIM-1'], screens: twoScreens().slice(0, n) })

    render(<App />)

    await waitFor(() => expect(screen.getByText(NO_TARGET)).toBeDefined())
  })

  it('대상이 있으면 안내가 없다', async () => {
    mockApi({ ...ready, screens: twoScreens() })

    render(<App />)

    await waitFor(() => expect(screen.getAllByRole('region', { name: /^기기 화면/ })).toHaveLength(2))
    expect(screen.queryByText(NO_TARGET)).toBeNull()
  })

  it('화면이 없으면 대상 없음 안내를 띄우지 않는다', async () => {
    mockApi({ ...ready, activeSerial: null, devices: [], screens: [] })

    render(<App />)

    await waitFor(() => expect(screen.getByText(/연결된 기기가 없다/)).toBeDefined())
    expect(screen.queryByText(NO_TARGET)).toBeNull()
  })

  it('한 화면의 DeviceScreen이 던져도 다른 화면 region이 남는다', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
    mockApi({ ...ready, screens: [occupied('x', 1, 'BOOM'), occupied('y', 1, 'SIM-1', 'iPhone 16')] })

    render(<App />)

    await waitFor(() => expect(screen.getByText('이 화면을 그리지 못했다')).toBeDefined())
    expect(screen.getByRole('region', { name: '기기 화면 iPhone 16 SIM-1' })).toBeDefined()
    spy.mockRestore()
  })

  it('한 칸의 세대만 오르면 그 화면만 다시 마운트된다', async () => {
    mockApi({ ...ready, screens: twoScreens() })
    render(<App />)
    await waitFor(() => expect(screen.getAllByRole('region', { name: /^기기 화면/ })).toHaveLength(2))
    const x1 = screen.getByLabelText('emulator-5554의 실시간 화면')
    const y1 = screen.getByLabelText('SIM-1의 실시간 화면')
    const xRegion = screen.getByRole('region', { name: '기기 화면 Pixel 7 emulator-5554' })
    const yRegion = screen.getByRole('region', { name: '기기 화면 iPhone 16 SIM-1' })

    // 같은 기기가 빠르게 내려갔다 올라온 경우: serial이 같아도 세대가 오르면 새 노드다.
    fire({ type: 'screens_changed', screens: [occupied('x', 1, 'emulator-5554', 'Pixel 7'), occupied('y', 2, 'SIM-1', 'iPhone 16')] })

    await waitFor(() => expect(screen.getByLabelText('SIM-1의 실시간 화면')).not.toBe(y1))
    expect(screen.getByRole('region', { name: '기기 화면 iPhone 16 SIM-1' })).not.toBe(yRegion)
    expect(screen.getByLabelText('emulator-5554의 실시간 화면')).toBe(x1)
    expect(screen.getByRole('region', { name: '기기 화면 Pixel 7 emulator-5554' })).toBe(xRegion)
  })

  it('대상으로를 누르면 그 칸의 serial로 selectDevice가 불린다', async () => {
    mockApi({ ...ready, screens: twoScreens() })
    render(<App />)
    await waitFor(() => expect(screen.getAllByRole('region', { name: /^기기 화면/ })).toHaveLength(2))

    await userEvent.click(screen.getByRole('button', { name: 'iPhone 16 SIM-1 대상으로' }))

    const select = (window as unknown as { api: { selectDevice: ReturnType<typeof vi.fn> } }).api.selectDevice
    expect(select).toHaveBeenCalledTimes(1)
    expect(select).toHaveBeenCalledWith('SIM-1')
  })

  it('F6이 화면 사이로 포커스를 옮기고 끝에서 처음으로 돈다', async () => {
    mockApi({ ...ready, screens: twoScreens() })
    render(<App />)
    await waitFor(() => expect(screen.getAllByRole('region', { name: /^기기 화면/ })).toHaveLength(2))
    const x = screen.getByLabelText('emulator-5554의 실시간 화면')
    const y = screen.getByLabelText('SIM-1의 실시간 화면')
    x.focus()

    fireEvent.keyDown(x, { key: 'F6' })
    expect(document.activeElement).toBe(y)
    fireEvent.keyDown(y, { key: 'F6' })
    expect(document.activeElement).toBe(x)
  })

  it('화면이 하나면 F6은 아무것도 하지 않는다', async () => {
    mockApi({ ...ready, screens: [occupied('x', 1, 'emulator-5554')] })
    render(<App />)
    await waitFor(() => expect(screen.getByLabelText('emulator-5554의 실시간 화면')).toBeDefined())
    const x = screen.getByLabelText('emulator-5554의 실시간 화면')
    x.focus()

    fireEvent.keyDown(x, { key: 'F6' })

    expect(document.activeElement).toBe(x)
  })
})
