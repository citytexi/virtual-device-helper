// @vitest-environment jsdom
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { AppSnapshot, Outcome, RendererApi } from '../../../shared/types/ipc'
import { DevicePanel } from './DevicePanel'

const selectDevice = vi.fn(async (): Promise<Outcome<void>> => ({ ok: true, value: undefined }))
const bootVirtualDevice = vi.fn(async (): Promise<Outcome<void>> => ({ ok: true, value: undefined }))
const shutdownDevice = vi.fn(async (): Promise<Outcome<void>> => ({ ok: true, value: undefined }))

beforeEach(() => {
  selectDevice.mockClear()
  bootVirtualDevice.mockClear()
  shutdownDevice.mockClear()
  ;(window as unknown as { api: Partial<RendererApi> }).api = {
    selectDevice,
    bootVirtualDevice,
    shutdownDevice
  } as unknown as RendererApi
})

function snapshot(overrides: Partial<AppSnapshot> = {}): AppSnapshot {
  return {
    platforms: {
      android: { ok: true, location: '/opt/sdk', notes: [] },
      ios: { ok: true, location: '/Applications/Xcode.app/Contents/Developer', notes: [] }
    },
    server: null,
    virtualDevices: [
      { platform: 'android', id: 'Pixel_7_API_34', name: 'Pixel_7_API_34', running: true, serial: 'emulator-5554', osVersion: null },
      { platform: 'android', id: 'Pixel_Tablet', name: 'Pixel_Tablet', running: false, serial: null, osVersion: null }
    ],
    devices: ['emulator-5554'],
    activeSerial: 'emulator-5554',
    timeline: [],
    trackingFailures: { android: null, ios: null },
    ...overrides
  }
}

describe('DevicePanel platform notices', () => {
  it('renders each platform note as an info notice', () => {
    render(
      <DevicePanel
        snapshot={snapshot({
          platforms: {
            android: { ok: true, location: '/opt/sdk', notes: [] },
            ios: { ok: true, location: '/Applications/Xcode.app/Contents/Developer', notes: ['AXe가 없어 iOS 입력을 쓸 수 없다'] }
          }
        })}
      />
    )

    const note = screen.getByText('AXe가 없어 iOS 입력을 쓸 수 없다')
    expect(note.className).toContain('notice-info')
  })

  it('shows a one-line Android notice when only iOS is ready', () => {
    render(
      <DevicePanel
        snapshot={snapshot({
          platforms: {
            android: { ok: false, reason: 'Android SDK를 찾지 못했다', searched: ['/opt/a/adb'], hint: null },
            ios: { ok: true, location: '/Applications/Xcode.app/Contents/Developer', notes: [] }
          }
        })}
      />
    )

    expect(screen.getByText('Android SDK를 찾지 못해 AVD는 쓸 수 없다.')).toBeDefined()
  })

  it('shows a one-line iOS notice with the reason when only Android is ready', () => {
    render(
      <DevicePanel
        snapshot={snapshot({
          platforms: {
            android: { ok: true, location: '/opt/sdk', notes: [] },
            ios: { ok: false, reason: 'macOS에서만 iOS 시뮬레이터를 쓸 수 있다', searched: [], hint: null }
          }
        })}
      />
    )

    expect(screen.getByText('macOS에서만 iOS 시뮬레이터를 쓸 수 있다 — iOS 시뮬레이터는 쓸 수 없다.')).toBeDefined()
  })

  it('shows the notice even when there are no virtual devices', () => {
    render(
      <DevicePanel
        snapshot={snapshot({
          virtualDevices: [],
          platforms: {
            android: { ok: false, reason: 'Android SDK를 찾지 못했다', searched: [], hint: null },
            ios: { ok: true, location: '/Applications/Xcode.app/Contents/Developer', notes: [] }
          }
        })}
      />
    )

    expect(screen.getByText('Android SDK를 찾지 못해 AVD는 쓸 수 없다.')).toBeDefined()
  })

  it('shows no platform notice when both are ready', () => {
    render(<DevicePanel snapshot={snapshot()} />)

    expect(screen.queryByText(/쓸 수 없다\./)).toBeNull()
  })
})

describe('DevicePanel', () => {
  it('lists every AVD by name', () => {
    render(<DevicePanel snapshot={snapshot()} />)

    expect(screen.getByText('Pixel_7_API_34')).toBeDefined()
    expect(screen.getByText('Pixel_Tablet')).toBeDefined()
  })

  it('shows the serial of a running AVD', () => {
    render(<DevicePanel snapshot={snapshot()} />)

    expect(screen.getByText('emulator-5554')).toBeDefined()
  })

  it('marks the active device so the user knows where tools will go', () => {
    render(<DevicePanel snapshot={snapshot()} />)

    expect(screen.getByRole('listitem', { current: true })).toBeDefined()
  })

  it('shows a visible text marker on the active row, not just aria-current', () => {
    // R7: aria-current만으로는 색맹이거나 스타일이 없는 환경에서 활성 기기를 알
    // 수 없다. 색에 기대지 않는 텍스트 마커가 있어야 한다.
    render(<DevicePanel snapshot={snapshot()} />)

    const activeItem = screen.getByRole('listitem', { current: true })
    expect(activeItem.textContent).toContain('(대상)')

    const inactiveItem = screen.getByText('Pixel_Tablet').closest('li')
    expect(inactiveItem?.textContent).not.toContain('(대상)')
  })

  it('marks the active device using the derived target when activeSerial is not explicitly set', () => {
    // R2: 명시적 activeSerial이 없어도 기기가 하나뿐이면 그것이 대상이다 (targetSerial).
    render(<DevicePanel snapshot={snapshot({ activeSerial: null })} />)

    const activeItem = screen.getByRole('listitem', { current: true })
    expect(activeItem.textContent).toContain('Pixel_7_API_34')
    expect(activeItem.textContent).toContain('emulator-5554')
  })

  it('offers 부팅 for a stopped AVD and 종료 for a running one', () => {
    render(<DevicePanel snapshot={snapshot()} />)

    expect(screen.getByRole('button', { name: /Pixel_Tablet 부팅/ })).toBeDefined()
    expect(screen.getByRole('button', { name: /Pixel_7_API_34 종료/ })).toBeDefined()
  })

  it('boots the AVD that was clicked', async () => {
    render(<DevicePanel snapshot={snapshot()} />)

    await userEvent.click(screen.getByRole('button', { name: /Pixel_Tablet 부팅/ }))

    expect(bootVirtualDevice).toHaveBeenCalledWith('Pixel_Tablet')
  })

  it('shuts down the serial of the AVD that was clicked', async () => {
    render(<DevicePanel snapshot={snapshot()} />)

    await userEvent.click(screen.getByRole('button', { name: /Pixel_7_API_34 종료/ }))

    expect(shutdownDevice).toHaveBeenCalledWith('emulator-5554')
  })

  it('renders same-name entries with different ids and boots each by id', async () => {
    render(
      <DevicePanel
        snapshot={snapshot({
          virtualDevices: [
            { platform: 'ios', id: 'udid-1', name: 'iPhone 16', running: false, serial: null, osVersion: '18.0' },
            { platform: 'ios', id: 'udid-2', name: 'iPhone 16', running: false, serial: null, osVersion: '26.0' }
          ],
          devices: [],
          activeSerial: null
        })}
      />
    )

    const buttons = screen.getAllByRole('button', { name: /iPhone 16 부팅/ })
    expect(buttons).toHaveLength(2)
    await userEvent.click(buttons[1] as HTMLElement)
    expect(bootVirtualDevice).toHaveBeenCalledWith('udid-2')
    await userEvent.click(buttons[0] as HTMLElement)
    expect(bootVirtualDevice).toHaveBeenCalledWith('udid-1')
  })

  it('shows a platform label next to the name', () => {
    render(
      <DevicePanel
        snapshot={snapshot({
          virtualDevices: [
            { platform: 'android', id: 'Pixel', name: 'Pixel', running: false, serial: null, osVersion: null },
            { platform: 'ios', id: 'udid-1', name: 'iPhone 16', running: false, serial: null, osVersion: '18.0' }
          ],
          devices: [],
          activeSerial: null
        })}
      />
    )

    expect(screen.getByText('Android')).toBeDefined()
    expect(screen.getByText('iOS')).toBeDefined()
  })

  it('selects a device when its row is clicked', async () => {
    render(
      <DevicePanel
        snapshot={snapshot({
          virtualDevices: [
            { platform: 'android', id: 'Pixel_7_API_34', name: 'Pixel_7_API_34', running: true, serial: 'emulator-5554', osVersion: null },
            { platform: 'android', id: 'Pixel_Tablet', name: 'Pixel_Tablet', running: true, serial: 'emulator-5556', osVersion: null }
          ],
          devices: ['emulator-5554', 'emulator-5556']
        })}
      />
    )

    await userEvent.click(screen.getByText('Pixel_Tablet'))

    expect(selectDevice).toHaveBeenCalledWith('emulator-5556')
  })

  it('shows a progress state while an AVD is booting', async () => {
    let resolveBoot: (() => void) | undefined
    bootVirtualDevice.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveBoot = () => resolve({ ok: true, value: undefined })
        })
    )
    render(<DevicePanel snapshot={snapshot()} />)

    await userEvent.click(screen.getByRole('button', { name: /Pixel_Tablet 부팅/ }))

    expect(screen.getByText('부팅 중…')).toBeDefined()

    resolveBoot?.()
    await waitFor(() => expect(screen.queryByText('부팅 중…')).toBeNull())
  })

  it('shows the failure reason when booting fails', async () => {
    bootVirtualDevice.mockResolvedValueOnce({
      ok: false,
      error: { kind: 'command_failed', message: '그런 AVD가 없다', hint: '목록을 확인해라' }
    })
    render(<DevicePanel snapshot={snapshot()} />)

    await userEvent.click(screen.getByRole('button', { name: /Pixel_Tablet 부팅/ }))

    await waitFor(() => expect(screen.getByText(/그런 AVD가 없다/)).toBeDefined())
  })

  it('tells the user when there is no AVD at all', () => {
    render(<DevicePanel snapshot={snapshot({ virtualDevices: [], devices: [], activeSerial: null })} />)

    expect(screen.getByText(/가상 기기가 없다/)).toBeDefined()
  })

  it('shows a tracking failure alert with the error message and hint when tracking stopped with an error', () => {
    // R1: trackingFailures에 항목이 있으면 목록이 오래됐을 수 있다는 경고를 role="alert"로 보여준다.
    render(
      <DevicePanel
        snapshot={snapshot({
          trackingFailures: {
            android: {
              platform: 'android',
              label: 'Android',
              error: { kind: 'command_failed', message: 'adb 서버가 죽었다', hint: 'adb를 재시작해라' },
              exitCode: null
            },
            ios: null
          }
        })}
      />
    )

    const alerts = screen.getAllByRole('alert')
    const trackingAlert = alerts.find((alert) => alert.textContent?.includes('adb 서버가 죽었다'))
    expect(trackingAlert).toBeDefined()
    expect(trackingAlert?.textContent).toContain('adb를 재시작해라')
    expect(trackingAlert?.textContent).toMatch(/추적/)
  })

  it('어느 플랫폼의 추적이 죽었는지 main이 준 label로 말하고, 둘 다 죽으면 각각 알린다', () => {
    render(
      <DevicePanel
        snapshot={snapshot({
          trackingFailures: {
            android: null,
            ios: { platform: 'ios', label: 'iOS', error: null, exitCode: null }
          }
        })}
      />
    )

    const alerts = screen.getAllByRole('alert')
    expect(alerts).toHaveLength(1)
    expect(alerts[0]?.textContent).toContain('iOS')
    expect(alerts[0]?.textContent).not.toContain('Android')
  })

  it('shows a tracking failure alert with the exit code when tracking stopped without an error', () => {
    render(
      <DevicePanel
        snapshot={snapshot({
          trackingFailures: { android: { platform: 'android', label: 'Android', error: null, exitCode: 137 }, ios: null }
        })}
      />
    )

    const alert = screen.getByRole('alert')
    expect(alert.textContent).toContain('137')
    expect(alert.textContent).toMatch(/추적/)
  })

  it('shows that the reason is unknown when tracking stopped with neither an error nor an exit code', () => {
    render(
      <DevicePanel
        snapshot={snapshot({
          trackingFailures: { android: { platform: 'android', label: 'Android', error: null, exitCode: null }, ios: null }
        })}
      />
    )

    const alert = screen.getByRole('alert')
    expect(alert.textContent).toContain('이유를 알 수 없다')
    expect(alert.textContent).not.toContain('null')
  })

  it('disables selecting another device while a boot or shutdown is pending', async () => {
    // R16 defect 1: 다른 기기를 고르는 select 버튼이 busy 중에도 살아 있으면
    // busy를 덮어써서 진행·실패 표시가 거짓말을 하게 된다.
    let resolveShutdown: (() => void) | undefined
    shutdownDevice.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveShutdown = () => resolve({ ok: true, value: undefined })
        })
    )
    render(
      <DevicePanel
        snapshot={snapshot({
          virtualDevices: [
            { platform: 'android', id: 'Pixel_7_API_34', name: 'Pixel_7_API_34', running: true, serial: 'emulator-5554', osVersion: null },
            { platform: 'android', id: 'Pixel_Tablet', name: 'Pixel_Tablet', running: true, serial: 'emulator-5556', osVersion: null }
          ],
          devices: ['emulator-5554', 'emulator-5556']
        })}
      />
    )

    await userEvent.click(screen.getByRole('button', { name: /Pixel_7_API_34 종료/ }))

    const selectButton = screen.getByRole('button', { name: 'Pixel_Tablet' })
    expect(selectButton).toHaveProperty('disabled', true)

    await userEvent.click(selectButton)
    expect(selectDevice).not.toHaveBeenCalled()

    resolveShutdown?.()
    await waitFor(() => expect(selectButton).toHaveProperty('disabled', false))
  })

  it('shows a failure and re-enables the buttons when the boot promise rejects', async () => {
    // R16 defect 2: IPC 프라미스가 reject되면 try/catch 없이는 busy가 영원히
    // 남아 모든 버튼이 잠긴 채로 굳는다.
    bootVirtualDevice.mockRejectedValueOnce(new Error('IPC 채널이 끊겼다'))
    render(<DevicePanel snapshot={snapshot()} />)

    await userEvent.click(screen.getByRole('button', { name: /Pixel_Tablet 부팅/ }))

    await waitFor(() => expect(screen.getByText(/IPC 채널이 끊겼다/)).toBeDefined())
    expect(screen.getByRole('button', { name: /Pixel_Tablet 부팅/ })).toHaveProperty('disabled', false)
    expect(screen.getByRole('button', { name: /Pixel_7_API_34 종료/ })).toHaveProperty('disabled', false)
  })

  it('shows the tracking failure alert even when there is no AVD at all', () => {
    render(
      <DevicePanel
        snapshot={snapshot({
          virtualDevices: [],
          devices: [],
          activeSerial: null,
          trackingFailures: { android: { platform: 'android', label: 'Android', error: null, exitCode: 1 }, ios: null }
        })}
      />
    )

    expect(screen.getByText(/가상 기기가 없다/)).toBeDefined()
    const alert = screen.getByRole('alert')
    expect(alert.textContent).toContain('1')
    expect(alert.textContent).toMatch(/추적/)
  })
})
