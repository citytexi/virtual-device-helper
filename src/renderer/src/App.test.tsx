// @vitest-environment jsdom
import { act, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { AppSnapshot, MainEvent, RendererApi, ScreenSlot } from '../../shared/types/ipc'
import { App } from './App'

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

  it('draws the first occupied slot, opening its stream by slot and epoch', async () => {
    mockApi({ ...ready, activeSerial: null, screens: [slot('x', 0, null), slot('y', 2, 'emulator-5554'), slot('z', 1, 'SIM-1')] })

    render(<App />)

    await waitFor(() => expect(screen.getByLabelText('emulator-5554의 실시간 화면')).toBeDefined())
    expect(screen.queryByLabelText('SIM-1의 실시간 화면')).toBeNull()
    await waitFor(() => expect(api().startStream).toHaveBeenCalledWith({ slotId: 'y', epoch: 2 }))
    expect(api().startStream).toHaveBeenCalledTimes(1)
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
})
