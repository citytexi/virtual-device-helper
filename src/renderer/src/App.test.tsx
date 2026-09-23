// @vitest-environment jsdom
import { render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { AppSnapshot, RendererApi } from '../../shared/types/ipc'
import { App } from './App'

function mockApi(snapshot: AppSnapshot): void {
  ;(window as unknown as { api: Partial<RendererApi> }).api = {
    getSnapshot: vi.fn(async () => snapshot),
    onEvent: () => () => {},
    captureScreenshot: vi.fn(async () => ({ ok: true, value: { base64: 'QUJD', width: 1, height: 1 } })),
    selectDevice: vi.fn(),
    bootAvd: vi.fn(),
    shutdownDevice: vi.fn()
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
    bootAvd: vi.fn(),
    shutdownDevice: vi.fn()
  } as unknown as RendererApi
}

const ready: AppSnapshot = {
  sdk: { ok: true, sdkRoot: '/opt/sdk' },
  server: { url: 'http://127.0.0.1:9321/mcp', port: 9321, token: 'token-value' },
  avds: [{ name: 'Pixel_7_API_34', running: true, serial: 'emulator-5554' }],
  devices: ['emulator-5554'],
  activeSerial: 'emulator-5554',
  toolCalls: [],
  trackingFailure: null
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

  it('replaces the whole screen with the SDK guidance when no SDK was found', async () => {
    mockApi({ ...ready, sdk: { ok: false, searched: ['/opt/a/adb'] }, server: null, avds: [] })

    render(<App />)

    await waitFor(() => expect(screen.getByText(/Android Studio/)).toBeDefined())
    expect(screen.queryByRole('region', { name: '작업 영역' })).toBeNull()
  })

  it('derives the screen target from the single connected device when nothing is explicitly active', async () => {
    // R2: activeSerial이 명시적으로 null이어도 연결된 기기가 하나뿐이면
    // DeviceScreen에는 raw activeSerial이 아니라 targetSerial(snapshot)이 가야
    // 한다. 그래야 기기가 하나뿐일 때도 화면이 뜬다.
    mockApi({
      ...ready,
      activeSerial: null,
      devices: ['emulator-5554'],
      avds: [{ name: 'Pixel_7_API_34', running: true, serial: 'emulator-5554' }]
    })

    render(<App />)

    await waitFor(() =>
      expect(screen.getByRole('img', { name: 'emulator-5554의 화면' })).toBeDefined()
    )
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
