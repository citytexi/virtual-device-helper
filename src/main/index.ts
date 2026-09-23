import { app, BrowserWindow, dialog, ipcMain, nativeTheme } from 'electron'
import { join } from 'node:path'
import { spawn } from 'node:child_process'
import { createAdbClient } from './adb/adbClient'
import { trackDevices } from './adb/trackDevices'
import { createAndroidDevice } from './device/androidDevice'
import { createAvdController } from './device/avdController'
import { createDeviceRegistry } from './device/registry'
import { electronResizeImage } from './device/resizeImage'
import { startMcpHttpServer } from './mcp/httpServer'
import { defaultLocateSdkDeps, locateSdk } from './sdk/locateSdk'
import { bootstrapApp, rendererSender, type BootstrappedApp } from './app/bootstrap'

let window: BrowserWindow | null = null
let running: BootstrappedApp | null = null

function createWindow(): void {
  // 3단 레이아웃(기기 목록 · 기기 화면 · 작업 영역)이 스크롤 없이 들어가는 크기.
  // min 값보다 작아지면 가운데 기기 화면이 읽을 수 없을 만큼 줄어든다.
  // backgroundColor는 renderer가 뜨기 전 흰 화면이 번쩍이지 않도록 app.css의
  // --bg와 맞춘다. 사용자가 앱 안에서 고른 테마는 여기서 알 수 없어 OS 설정을 따른다.
  window = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 1100,
    minHeight: 700,
    backgroundColor: nativeTheme.shouldUseDarkColors ? '#0b1120' : '#f1f5f9',
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  })
  window.on('closed', () => {
    window = null
  })

  if (process.env.ELECTRON_RENDERER_URL) {
    void window.loadURL(process.env.ELECTRON_RENDERER_URL)
  } else {
    void window.loadFile(join(__dirname, '../renderer/index.html'))
  }
}

app
  .whenReady()
  .then(async () => {
    running = await bootstrapApp({
      located: locateSdk(defaultLocateSdkDeps()),
      ipcMain,
      send: rendererSender(() => window),
      createDeviceStack: (paths) => {
        const adb = createAdbClient(paths.adb)
        const registry = createDeviceRegistry({
          track: (onChange, onFailure) => trackDevices(adb, onChange, onFailure),
          createDevice: (serial) => createAndroidDevice({ serial, adb, resizeImage: electronResizeImage })
        })
        const avd = createAvdController({ adb, emulatorPath: paths.emulator, spawn })
        return { registry, avd }
      },
      startServer: startMcpHttpServer
    })

    createWindow()

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow()
    })
  })
  .catch((thrown: unknown) => {
    // 여기서 못 잡으면 창이 하나도 안 뜬 채 unhandled rejection만 남는다.
    // macOS에서는 Dock 아이콘만 죽어 있고, Windows에서는 프로세스가 안 끝나고 남는다.
    const reason = thrown instanceof Error ? thrown.message : String(thrown)
    console.error('앱을 시작하지 못했다', thrown)
    dialog.showErrorBox('앱을 시작하지 못했다', reason)
    app.quit()
  })

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})

let stopping: Promise<void> | null = null

app.on('before-quit', (event) => {
  // before-quit은 여러 번 올 수 있다. 정리가 끝나기 전에 프로세스가 먼저
  // 죽으면 server.close()가 마무리되지 않을 수 있어, 첫 번째 호출에서는
  // 기본 종료를 막고 정리가 끝난 뒤 직접 app.quit()을 다시 부른다. 그렇게
  // 온 두 번째 before-quit은 stopping이 이미 채워져 있으니 그냥 통과시킨다
  // (다시 막지도, stop을 또 부르지도 않는다 — 안 그러면 무한히 반복된다).
  if (!running || stopping) return
  event.preventDefault()
  stopping = running.stop().catch((thrown) => console.error('종료 정리에 실패했다', thrown))
  void stopping.then(() => {
    // SIGTERM으로 시작된 종료를 preventDefault로 막은 뒤, 같은 틱(마이크로태스크)
    // 안에서 app.quit()을 다시 부르면 Electron이 종료를 끝까지 못 마친다(관찰됨:
    // before-quit이 두 번 온 뒤 window-all-closed까지만 오고 will-quit·quit은
    // 오지 않음). setImmediate로 매크로태스크까지 한 틱 미뤄서 다시 불러야
    // 정상적으로 종료된다.
    setImmediate(() => app.quit())
  })
})
