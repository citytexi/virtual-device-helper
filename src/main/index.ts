import { app, BrowserWindow, ipcMain } from 'electron'
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

app.whenReady().then(async () => {
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

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})

app.on('before-quit', () => {
  void running?.stop()
})
