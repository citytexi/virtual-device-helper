import { beforeEach, describe, expect, it, vi } from 'vitest'

const whenReady = vi.fn()
const appOn = vi.fn()
const appQuit = vi.fn()
const showErrorBox = vi.fn()
const browserWindowInstances: unknown[] = []

vi.mock('electron', () => {
  class BrowserWindow {
    on = vi.fn()
    loadURL = vi.fn()
    loadFile = vi.fn()

    static getAllWindows = vi.fn(() => [])

    constructor() {
      browserWindowInstances.push(this)
    }
  }

  return {
    app: {
      whenReady,
      on: appOn,
      quit: appQuit
    },
    BrowserWindow,
    ipcMain: {},
    nativeTheme: { shouldUseDarkColors: false },
    dialog: { showErrorBox },
    nativeImage: { createFromBuffer: vi.fn(() => ({ resize: vi.fn(), getSize: vi.fn(() => ({})) })) }
  }
})

const bootstrapApp = vi.fn()
const rendererSender = vi.fn(() => vi.fn())

vi.mock('./app/bootstrap', () => ({ bootstrapApp, rendererSender }))

beforeEach(() => {
  vi.resetModules()
  whenReady.mockReset()
  appOn.mockReset()
  appQuit.mockReset()
  showErrorBox.mockReset()
  bootstrapApp.mockReset()
  browserWindowInstances.length = 0
})

describe('main/index 시작 실패 처리', () => {
  it('bootstrapApp이 실패하면 에러 다이얼로그를 띄우고 앱을 종료한다', async () => {
    whenReady.mockResolvedValue(undefined)
    bootstrapApp.mockRejectedValue(new Error('부트스트랩 실패'))
    const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})

    await import('./index')

    await vi.waitFor(() => {
      expect(showErrorBox).toHaveBeenCalled()
    })

    expect(consoleErrorSpy).toHaveBeenCalled()
    expect(showErrorBox).toHaveBeenCalledWith(
      '앱을 시작하지 못했다',
      expect.stringContaining('부트스트랩 실패')
    )
    expect(appQuit).toHaveBeenCalledTimes(1)
    // 창을 열지 않는다 — bootstrapApp이 없으면 IPC 브릿지도 없어 조작 불가능한
    // 빈 창만 뜨게 된다.
    expect(browserWindowInstances).toHaveLength(0)

    consoleErrorSpy.mockRestore()
  })
})

describe('main/index before-quit', () => {
  it('정리가 끝날 때까지 종료를 미루고, 끝나면 한 번만 quit한다', async () => {
    whenReady.mockResolvedValue(undefined)
    let resolveStop: (() => void) | undefined
    const stop = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          resolveStop = resolve
        })
    )
    bootstrapApp.mockResolvedValue({ state: {}, server: null, stop })

    await import('./index')
    await vi.waitFor(() => expect(browserWindowInstances).toHaveLength(1))

    const beforeQuitCall = appOn.mock.calls.find(([channel]) => channel === 'before-quit')
    expect(beforeQuitCall).toBeDefined()
    const handler = beforeQuitCall?.[1] as (event: { preventDefault: () => void }) => void

    const preventDefault1 = vi.fn()
    handler({ preventDefault: preventDefault1 })

    // 첫 before-quit: 기본 종료를 막고 정리를 시작한다.
    expect(preventDefault1).toHaveBeenCalledTimes(1)
    expect(stop).toHaveBeenCalledTimes(1)
    expect(appQuit).not.toHaveBeenCalled()

    resolveStop?.()

    // stop()이 resolve된 직후의 마이크로태스크 큐 안에서는 아직 quit을 부르지
    // 않는다 — 같은 틱에서 재호출하면 Electron이 종료를 끝까지 못 마치는
    // 현상이 관찰됐다(SIGTERM으로 시작된 종료에서 window-all-closed까지만
    // 오고 will-quit/quit이 오지 않음). 마이크로태스크만 여러 번 비워서
    // 확인한다(setTimeout 기반 폴링을 쓰면 매크로태스크가 먼저 돌아버린다).
    for (let i = 0; i < 5; i += 1) {
      await Promise.resolve()
    }
    expect(appQuit).not.toHaveBeenCalled()

    // 매크로태스크(setImmediate)로 한 틱 미룬 뒤에는 quit이 불린다.
    await new Promise<void>((resolve) => setImmediate(resolve))
    expect(appQuit).toHaveBeenCalledTimes(1)

    // 두 번째 before-quit(정리가 끝난 뒤 app.quit()이 다시 보낸 것): 이번엔
    // 막지 않고 그대로 종료되게 둔다. 다시 stop을 부르지도 않는다(루프 방지).
    const preventDefault2 = vi.fn()
    handler({ preventDefault: preventDefault2 })

    expect(preventDefault2).not.toHaveBeenCalled()
    expect(stop).toHaveBeenCalledTimes(1)
    expect(appQuit).toHaveBeenCalledTimes(1)
  })

  it('정리가 실패해도 콘솔에 남기고 결국 quit한다', async () => {
    whenReady.mockResolvedValue(undefined)
    const stop = vi.fn(async () => {
      throw new Error('정리 실패')
    })
    bootstrapApp.mockResolvedValue({ state: {}, server: null, stop })
    const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})

    await import('./index')
    await vi.waitFor(() => expect(browserWindowInstances).toHaveLength(1))

    const beforeQuitCall = appOn.mock.calls.find(([channel]) => channel === 'before-quit')
    const handler = beforeQuitCall?.[1] as (event: { preventDefault: () => void }) => void

    handler({ preventDefault: vi.fn() })

    await vi.waitFor(() => expect(appQuit).toHaveBeenCalledTimes(1))
    expect(consoleErrorSpy).toHaveBeenCalledWith('종료 정리에 실패했다', expect.any(Error))

    consoleErrorSpy.mockRestore()
  })
})
