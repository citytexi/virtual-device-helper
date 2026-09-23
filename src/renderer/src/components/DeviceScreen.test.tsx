// @vitest-environment jsdom
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Outcome, RendererApi } from '../../../shared/types/ipc'
import type { ScreenshotResult } from '../../../shared/types/device'
import { DeviceScreen } from './DeviceScreen'

const captureScreenshot = vi.fn(
  async (): Promise<Outcome<ScreenshotResult>> => ({
    ok: true,
    value: { base64: 'QUJD', width: 360, height: 800 }
  })
)

beforeEach(() => {
  captureScreenshot.mockClear()
  ;(window as unknown as { api: Partial<RendererApi> }).api = {
    captureScreenshot
  } as unknown as RendererApi
})

describe('DeviceScreen', () => {
  it('asks for no screenshot when there is no device', () => {
    render(<DeviceScreen serial={null} />)

    expect(captureScreenshot).not.toHaveBeenCalled()
    expect(screen.getByText(/기기를 선택해라/)).toBeDefined()
  })

  it('captures once for the given serial on mount', async () => {
    render(<DeviceScreen serial="emulator-5554" />)

    await waitFor(() => expect(captureScreenshot).toHaveBeenCalledWith('emulator-5554'))
    expect(captureScreenshot).toHaveBeenCalledTimes(1)
  })

  it('renders the captured png as an image', async () => {
    render(<DeviceScreen serial="emulator-5554" />)

    const image = (await screen.findByRole('img')) as HTMLImageElement
    expect(image.src).toBe('data:image/png;base64,QUJD')
  })

  it('recaptures when the refresh button is pressed', async () => {
    render(<DeviceScreen serial="emulator-5554" />)
    await screen.findByRole('img')

    await userEvent.click(screen.getByRole('button', { name: '새로고침' }))

    await waitFor(() => expect(captureScreenshot).toHaveBeenCalledTimes(2))
  })

  it('recaptures when the serial changes', async () => {
    const { rerender } = render(<DeviceScreen serial="emulator-5554" />)
    await screen.findByRole('img')

    rerender(<DeviceScreen serial="emulator-5556" />)

    await waitFor(() => expect(captureScreenshot).toHaveBeenLastCalledWith('emulator-5556'))
  })

  it('shows the failure reason instead of a blank frame', async () => {
    captureScreenshot.mockResolvedValueOnce({
      ok: false,
      error: { kind: 'device_unresponsive', message: '응답이 없다', hint: '다시 부팅해라' }
    } as never)

    render(<DeviceScreen serial="emulator-5554" />)

    await waitFor(() => expect(screen.getByText(/응답이 없다/)).toBeDefined())
  })

  it('shows the reason and re-enables refresh when the capture promise rejects', async () => {
    captureScreenshot.mockRejectedValueOnce(new Error('연결 끊김'))

    render(<DeviceScreen serial="emulator-5554" />)

    await waitFor(() => expect(screen.getByText(/연결 끊김/)).toBeDefined())
    expect(screen.getByRole('button', { name: '새로고침' })).toHaveProperty('disabled', false)
  })

  it('ignores a superseded capture result from a stale serial', async () => {
    let resolveA: ((result: Outcome<ScreenshotResult>) => void) | undefined
    let resolveB: ((result: Outcome<ScreenshotResult>) => void) | undefined
    let call = 0

    captureScreenshot.mockImplementation(
      () =>
        new Promise<Outcome<ScreenshotResult>>((resolve) => {
          call += 1
          if (call === 1) resolveA = resolve
          else resolveB = resolve
        })
    )

    const { rerender } = render(<DeviceScreen serial="emulator-5554" />)
    await waitFor(() => expect(captureScreenshot).toHaveBeenCalledTimes(1))

    rerender(<DeviceScreen serial="emulator-5556" />)
    await waitFor(() => expect(captureScreenshot).toHaveBeenCalledTimes(2))

    // B(새 serial)가 먼저 끝나고, A(오래된 serial)가 뒤늦게 끝난다.
    resolveB?.({ ok: true, value: { base64: 'Qg==', width: 100, height: 200 } })
    await waitFor(() => {
      const image = screen.getByRole('img') as HTMLImageElement
      expect(image.src).toBe('data:image/png;base64,Qg==')
    })

    resolveA?.({ ok: true, value: { base64: 'QQ==', width: 1, height: 1 } })

    // A의 뒤늦은 결과가 B의 화면을 덮어쓰지 않아야 한다.
    await new Promise((r) => setTimeout(r, 0))
    const image = screen.getByRole('img') as HTMLImageElement
    expect(image.src).toBe('data:image/png;base64,Qg==')
  })

  it('clears the previous device shot when the serial changes, before the new capture resolves', async () => {
    let resolveSecond: ((result: Outcome<ScreenshotResult>) => void) | undefined
    let call = 0

    captureScreenshot.mockImplementation(() => {
      call += 1
      if (call === 1) {
        return Promise.resolve({
          ok: true,
          value: { base64: 'QUJD', width: 360, height: 800 }
        } as Outcome<ScreenshotResult>)
      }
      return new Promise<Outcome<ScreenshotResult>>((resolve) => {
        resolveSecond = resolve
      })
    })

    const { rerender } = render(<DeviceScreen serial="emulator-5554" />)
    await screen.findByRole('img')

    rerender(<DeviceScreen serial="emulator-5556" />)

    // 새 serial의 캡처가 아직 끝나지 않았으면 이전 기기 화면을 보여주면 안 된다.
    await waitFor(() => expect(screen.queryByRole('img')).toBeNull())

    resolveSecond?.({ ok: true, value: { base64: 'Qg==', width: 100, height: 200 } })

    const image = await screen.findByRole('img')
    expect((image as HTMLImageElement).src).toBe('data:image/png;base64,Qg==')
  })
})
