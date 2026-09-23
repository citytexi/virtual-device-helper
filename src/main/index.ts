import { app, BrowserWindow, dialog, ipcMain } from 'electron'
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
  window = new BrowserWindow({
    width: 1280,
    height: 860,
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
  void stopping.then(() => app.quit())
})
