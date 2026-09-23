import type { IpcMain } from 'electron'
import type { AvdController } from '../device/avdController'
import { createDeviceRegistry, type DeviceRegistry } from '../device/registry'
import type { McpServerHandle, StartMcpHttpServerOpts } from '../mcp/httpServer'
import type { LocateSdkResult, SdkPaths } from '../sdk/locateSdk'
import type { StreamManager } from '../stream/streamManager'
import { deviceError } from '../../shared/types/errors'
import { createAppState, type AppState } from './appState'
import { registerIpcBridge, type BridgeActions, type SendToRenderer } from './ipcBridge'

export interface DeviceStack {
  registry: DeviceRegistry
  avd: AvdController
}

export interface BootstrapDeps {
  located: LocateSdkResult
  ipcMain: IpcMain
  send: SendToRenderer
  /** adb·에뮬레이터에 실제로 닿는 부품들. 테스트에서 가짜로 바꾼다. */
  createDeviceStack: (paths: SdkPaths) => DeviceStack
  /** 화면 스트림 세션을 관리한다. 실제 adb·소켓·Electron 포트에 닿으므로 테스트에서 가짜로 바꾼다. */
  createStreamManager: (registry: DeviceRegistry, paths: SdkPaths) => StreamManager
  startServer: (opts: StartMcpHttpServerOpts) => Promise<McpServerHandle>
}

export interface BootstrappedApp {
  state: AppState
  server: McpServerHandle | null
  stop(): Promise<void>
}

/** renderer가 보는 창. 테스트에서 BrowserWindow 대신 쓸 수 있게 필요한 부분만 적는다. */
export interface RendererWindow {
  isDestroyed(): boolean
  webContents: { send(channel: string, payload: unknown): void }
}

/**
 * 창이 아직 없거나 이미 닫혔으면 보내지 않는다. 창이 닫힌 뒤에도 기기 이벤트는
 * 계속 오고, 파괴된 webContents에 send하면 main 프로세스에서 예외가 난다.
 */
export function rendererSender(getWindow: () => RendererWindow | null): SendToRenderer {
  return (channel, payload) => {
    const window = getWindow()
    if (window && !window.isDestroyed()) window.webContents.send(channel, payload)
  }
}

function sdkMissingError() {
  return deviceError(
    'sdk_not_found',
    'Android SDK를 찾지 못했다',
    'ANDROID_HOME을 SDK 경로로 설정하고 앱을 다시 실행해라'
  )
}

/**
 * SDK가 없을 때의 조립. MCP 서버를 열지 않는다. 툴이 전부 실패할 서버를 여는 것은
 * 거짓말이다. 그래도 스냅샷은 내줘야 renderer가 안내 화면을 띄울 수 있다.
 */
function assembleWithoutSdk(searched: string[]): { state: AppState; actions: BridgeActions } {
  const registry = createDeviceRegistry({
    track: () => () => {},
    createDevice: () => {
      throw sdkMissingError()
    }
  })
  const avd: AvdController = {
    list: async () => [],
    boot: async () => {
      throw sdkMissingError()
    },
    shutdown: async () => {
      throw sdkMissingError()
    }
  }
  const state = createAppState({ sdk: { ok: false, searched }, registry, avd, server: null })
  const reject = async (): Promise<never> => {
    throw sdkMissingError()
  }
  const actions: BridgeActions = {
    selectDevice: () => {
      throw sdkMissingError()
    },
    bootAvd: reject,
    shutdownDevice: reject,
    captureScreenshot: reject,
    startStream: reject,
    stopStream: async () => {}
  }
  return { state, actions }
}

/**
 * main 프로세스를 조립한다. 순서가 이렇게 되는 이유는 하나다. MCP 서버를 열려면
 * 툴 컨텍스트가 필요하고, 툴 컨텍스트의 onToolCall은 AppState가 가지고 있다. 그래서
 * AppState를 먼저 만들고 서버를 연 뒤 setServer로 이어 붙인다.
 */
export async function bootstrapApp(deps: BootstrapDeps): Promise<BootstrappedApp> {
  const { located } = deps

  if (!located.ok) {
    const { state, actions } = assembleWithoutSdk(located.searched)
    registerIpcBridge(deps.ipcMain, state, actions, deps.send)
    return { state, server: null, stop: async () => {} }
  }

  const { registry, avd } = deps.createDeviceStack(located.paths)
  const state = createAppState({
    sdk: { ok: true, sdkRoot: located.paths.sdkRoot },
    registry,
    avd,
    server: null
  })

  const stream = deps.createStreamManager(registry, located.paths)
  // 기기가 사라지면 그 기기의 스트림은 재시도하지 않고 닫는다. 재시도 루프의 isConnected
  // 확인만으로는 대기 시간만큼 늦게 닫힌다.
  registry.on((event) => {
    if (event.type === 'device_disconnected') void stream.handleDisconnect(event.serial)
  })

  // 상태가 registry를 구독한 뒤에 추적을 시작한다. 그래야 처음 붙어 있던 기기의
  // device_connected도 상태를 거쳐 renderer까지 간다.
  registry.start()

  let server: McpServerHandle | null = null
  try {
    server = await deps.startServer({
      context: { registry, avd, onToolCall: (record) => state.recordToolCall(record) }
    })
    state.setServer(server)
  } catch (thrown) {
    // 서버가 못 떠도 창은 띄운다. 기기 화면과 조작은 서버 없이도 쓸 수 있고,
    // 스냅샷의 server가 null이라 renderer는 엔드포인트가 없다고 보여 준다.
    console.error('MCP 서버를 열지 못했다', thrown)
  }

  registerIpcBridge(
    deps.ipcMain,
    state,
    {
      selectDevice: (serial) => registry.setActive(serial),
      bootAvd: async (name) => {
        await avd.boot(name)
      },
      shutdownDevice: (serial) => avd.shutdown(serial),
      captureScreenshot: (serial) => {
        const device = registry.resolve(serial)
        return registry.run(device.serial, () => device.screenshot())
      },
      startStream: async (serial) => {
        // 모르는 serial이면 여기서 no_device로 끝낸다. 세션을 열어 adb가 실패하기를 기다리지 않는다.
        registry.resolve(serial)
        await stream.open(serial)
      },
      stopStream: () => stream.stop()
    },
    deps.send
  )

  return {
    state,
    server,
    async stop() {
      await stream.stop()
      registry.stop()
      await server?.close()
    }
  }
}
