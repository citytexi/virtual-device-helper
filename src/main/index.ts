import { app, BrowserWindow, dialog, ipcMain, nativeTheme, type MessagePortMain } from 'electron'
import { join } from 'node:path'
import { execFile, spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { promisify } from 'node:util'
import { createAdbClient } from './adb/adbClient'
import { trackDevices } from './adb/trackDevices'
import { createAndroidDevice } from './device/androidDevice'
import { createAvdController } from './device/avdController'
import { createVirtualDeviceCatalog, type VirtualDeviceSource } from './device/virtualDeviceCatalog'
import { createDeviceRegistry } from './device/registry'
import { electronResizeImage } from './device/resizeImage'
import { createIosDevice } from './device/iosDevice'
import { createAxeClient } from './ios/axeClient'
import { locateAxe } from './ios/locateAxe'
import { createSimctlClient } from './ios/simctlClient'
import { createSimulatorCatalog } from './ios/simulatorCatalog'
import { defaultLocateIosToolsDeps, locateIosTools } from './ios/locateIosTools'
import { trackSimulators } from './ios/trackSimulators'
import { createLogManager } from './logs/logManager'
import { createLogTail } from './logs/logTail'
import { createPidof, createSeedPids } from './logs/adbLogDeps'
import { createIosLogTail } from './logs/iosLogTail'
import { createIosPidof, createIosSeedPids } from './logs/iosLogDeps'
import { createPlatformLogDeps } from './logs/platformLogDeps'
import { startMcpHttpServer } from './mcp/httpServer'
import { defaultLocateSdkDeps, locateSdk } from './sdk/locateSdk'
import { resolveScrcpyJar } from './stream/scrcpyJar'
import { connectLoopback, createScrcpySession } from './stream/scrcpySession'
import { createPlatformStreamSession } from './stream/rejectingSession'
import { createStreamManager } from './stream/streamManager'
import { bootstrapApp, rendererSender, type BootstrappedApp } from './app/bootstrap'
import { createPortChannel } from './app/portChannel'
import { deviceError } from '../shared/types/errors'
import { IPC_CHANNELS } from '../shared/types/ipc'
import type { LogDown } from '../shared/types/logs'
import type { StreamDown } from '../shared/types/stream'

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

/**
 * isDestroyed() 확인과 postMessage 호출 사이에 창이 닫힐 수 있다. streamManager.open()·
 * logManager.open()은 이 호출을 try/catch로 감싸지 않으므로 여기서 절대 던지지 않는다 —
 * 실패하면 그냥 포트가 보이지 않을 뿐이고, 다음 open이 그 포트를 대체한다.
 * 건네지 못한 포트는 닫는다. 그러면 local 쪽에 close가 와서 매니저가 세션을 정리한다.
 * 스트림 포트와 로그 포트가 이 규칙을 공유한다.
 */
function postPortToRenderer(channel: string, meta: unknown, remote: unknown): void {
  const port = remote as MessagePortMain
  try {
    if (window && !window.isDestroyed()) {
      window.webContents.postMessage(channel, meta, [port])
      return
    }
  } catch (thrown) {
    console.error(`포트를 renderer에 건네지 못했다 (${channel})`, thrown)
  }
  try {
    port.close()
  } catch {
    // 이미 닫힌 포트다.
  }
}

app
  .whenReady()
  .then(async () => {
    // AXe는 iOS 입력·노드·실시간 화면에만 필요하다. 없어도 iOS 자체는 조립하고 안내만 남긴다.
    const axePath = await locateAxe({
      fileExists: existsSync,
      which: async () => {
        try {
          const { stdout } = await promisify(execFile)('which', ['axe'], { timeout: 5_000 })
          return stdout.trim() || null
        } catch {
          return null
        }
      }
    })
    running = await bootstrapApp({
      located: locateSdk(defaultLocateSdkDeps()),
      iosTools: await locateIosTools(defaultLocateIosToolsDeps()),
      axePath,
      ipcMain,
      send: rendererSender(() => window),
      createDeviceStack: (paths, ios) => {
        // 준비된 플랫폼의 추적·소스만 넣는다. iOS는 locateIosTools가 ok일 때만 조립한다 —
        // Xcode 없는 Mac에서 simctl 추적을 시작하면 tracking_failed만 남는다.
        const adb = paths ? createAdbClient(paths.adb) : null
        const simctl = ios ? createSimctlClient() : null
        const axe = axePath ? createAxeClient(axePath) : null
        const registry = createDeviceRegistry({
          track: (onChange, onFailure) => {
            const stopAdb = adb ? trackDevices(adb, (serial, connected) => onChange(serial, connected, 'android'), onFailure) : () => {}
            const stopSimulators = simctl
              ? trackSimulators(simctl, (serial, connected) => onChange(serial, connected, 'ios'), onFailure)
              : () => {}
            return () => {
              stopAdb()
              stopSimulators()
            }
          },
          createDevice: (serial, platform) => {
            if (platform === 'ios' && simctl) return createIosDevice({ udid: serial, simctl, axe, resizeImage: electronResizeImage })
            if (platform === 'android' && adb) return createAndroidDevice({ serial, adb, resizeImage: electronResizeImage })
            // 추적하지 않는 플랫폼의 기기는 생기지 않는다. 만일을 위한 방어다.
            throw deviceError('no_device', `${platform} 기기를 조립하지 않았다: ${serial}`, '앱을 다시 실행해라')
          }
        })
        const sources: VirtualDeviceSource[] = []
        if (paths && adb) sources.push(createAvdController({ adb, emulatorPath: paths.emulator, spawn }))
        if (simctl) sources.push(createSimulatorCatalog({ simctl }))
        return { registry, catalog: createVirtualDeviceCatalog(sources) }
      },
      createStreamManager: (registry, paths, hooks) => {
        const adb = paths ? createAdbClient(paths.adb) : null
        const jarPath = resolveScrcpyJar({
          isPackaged: app.isPackaged,
          resourcesPath: process.resourcesPath,
          appPath: app.getAppPath()
        })
        return createStreamManager({
          // iOS 기기는 M4-3 전까지 unsupported로 거절하는 세션을 받는다. 판단은 라우터가 한다.
          createSession: createPlatformStreamSession({
            platformOf: (serial) => registry.resolve(serial).platform,
            android: adb
              ? (serial, handlers) => createScrcpySession({ serial, adb, jarPath, connect: connectLoopback }, handlers)
              : null
          }),
          createChannel: () => createPortChannel<StreamDown>(),
          postPort: (meta, remote) => postPortToRenderer(IPC_CHANNELS.streamPort, meta, remote),
          isConnected: (serial) => registry.serials().includes(serial),
          onState: hooks.onState
        })
      },
      createLogManager: (registry, paths, hooks) => {
        const adb = paths ? createAdbClient(paths.adb) : null
        // simctl은 상태가 없어 로그용으로 따로 만들어도 된다. iOS 기기가 없으면 불리지 않는다.
        const simctl = createSimctlClient()
        const platformDeps = createPlatformLogDeps({
          platformOf: (serial) => registry.resolve(serial).platform,
          android: adb
            ? {
                createTail: (serial, handlers) =>
                  createLogTail({ serial, adb, isConnected: () => registry.serials().includes(serial) }, handlers),
                seedPids: createSeedPids(adb),
                pidof: createPidof(adb)
              }
            : null,
          ios: {
            createTail: (udid, handlers) =>
              createIosLogTail({ udid, simctl, isConnected: () => registry.serials().includes(udid) }, handlers),
            seedPids: createIosSeedPids(simctl),
            pidof: createIosPidof(simctl)
          }
        })
        return createLogManager({
          ...platformDeps,
          createChannel: () => createPortChannel<LogDown>(),
          postPort: (meta, remote) => postPortToRenderer(IPC_CHANNELS.logPort, meta, remote),
          onTailState: hooks.onTailState
        })
      },
      startServer: (opts) => startMcpHttpServer({ ...opts, version: app.getVersion() })
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
