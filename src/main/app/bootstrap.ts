import type { IpcMain } from 'electron'
import type { VirtualDeviceCatalog } from '../device/virtualDeviceCatalog'
import { createDeviceRegistry, type DeviceRegistry } from '../device/registry'
import type { LogManager } from '../logs/logManager'
import type { TailState } from '../../shared/types/logs'
import type { McpServerHandle, StartMcpHttpServerOpts } from '../mcp/httpServer'
import type { IosToolsResult } from '../ios/locateIosTools'
import type { LocateSdkResult, SdkPaths } from '../sdk/locateSdk'
import type { StreamLifecycle, StreamManager } from '../stream/streamManager'
import { deviceError } from '../../shared/types/errors'
import type { DeviceTimelineEvent, PlatformStatuses } from '../../shared/types/ipc'
import { createAppState, type AppState } from './appState'
import { registerIpcBridge, type BridgeActions, type SendToRenderer } from './ipcBridge'

export interface DeviceStack {
  registry: DeviceRegistry
  catalog: VirtualDeviceCatalog
}

/** 스트림 매니저가 상태 변화를 앱 상태로 알리는 통로. 팩토리가 매니저 deps로 그대로 넘긴다. */
export interface StreamManagerHooks {
  onState(serial: string, state: StreamLifecycle): void
}

/** 로그 매니저가 tail 상태 변화를 앱 상태로 알리는 통로. 팩토리가 매니저 deps로 그대로 넘긴다. */
export interface LogManagerHooks {
  onTailState(serial: string, state: TailState): void
}

export interface BootstrapDeps {
  /** Android SDK를 찾은 결과. */
  located: LocateSdkResult
  /** iOS 도구(xcode-select·xcrun simctl)를 찾은 결과. */
  iosTools: IosToolsResult
  /** AXe 실행 파일 경로. 못 찾았으면 null이고, iOS 입력·노드·실시간 화면만 못 쓴다. */
  axePath: string | null
  ipcMain: IpcMain
  send: SendToRenderer
  /**
   * adb·에뮬레이터·simctl에 실제로 닿는 부품들. 테스트에서 가짜로 바꾼다.
   * android는 SDK가 없으면 null, ios는 iOS 도구가 준비됐는지다. 준비된 플랫폼의 추적·소스만 넣는다.
   */
  createDeviceStack: (android: SdkPaths | null, ios: boolean) => DeviceStack
  /** 화면 스트림 세션을 관리한다. 실제 adb·소켓·Electron 포트에 닿으므로 테스트에서 가짜로 바꾼다. paths는 Android SDK가 없으면 null. */
  createStreamManager: (registry: DeviceRegistry, paths: SdkPaths | null, hooks: StreamManagerHooks) => StreamManager
  /** 기기별 로그 tail·버퍼·로그 포트를 관리한다. 실제 adb·simctl·Electron 포트에 닿으므로 테스트에서 가짜로 바꾼다. paths는 Android SDK가 없으면 null. */
  createLogManager: (registry: DeviceRegistry, paths: SdkPaths | null, hooks: LogManagerHooks) => LogManager
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

const STREAM_EVENTS = {
  started: 'stream_started',
  reconnecting: 'stream_reconnecting',
  stopped: 'stream_stopped'
} as const satisfies Record<StreamLifecycle, DeviceTimelineEvent>

const AXE_MISSING_NOTE = 'AXe가 없어 iOS 입력·노드·실시간 화면을 쓸 수 없다. brew install cameroncooke/axe/axe로 설치하고 앱을 다시 켜라'

function sdkMissingError() {
  return deviceError(
    'sdk_not_found',
    'Android SDK를 찾지 못했다',
    'ANDROID_HOME을 SDK 경로로 설정하고 앱을 다시 실행해라'
  )
}

/** 두 탐색 결과를 스냅샷의 플랫폼 상태로 옮긴다. */
function platformStatuses(located: LocateSdkResult, iosTools: IosToolsResult, axePath: string | null): PlatformStatuses {
  const iosNotes = axePath === null ? [AXE_MISSING_NOTE] : []
  return {
    android: located.ok
      ? { ok: true, location: located.paths.sdkRoot, notes: [] }
      : { ok: false, reason: 'Android SDK를 찾지 못했다', searched: located.searched },
    ios: iosTools.ok ? { ok: true, location: iosTools.developerDir, notes: iosNotes } : { ok: false, reason: iosTools.reason, searched: [] }
  }
}

/**
 * Android·iOS 어느 쪽도 준비되지 않았을 때의 조립. MCP 서버를 열지 않는다. 툴이 전부 실패할
 * 서버를 여는 것은 거짓말이다. 그래도 스냅샷은 내줘야 renderer가 안내 화면을 띄울 수 있다.
 */
function assembleWithoutPlatforms(platforms: PlatformStatuses): { state: AppState; actions: BridgeActions } {
  const registry = createDeviceRegistry({
    track: () => () => {},
    createDevice: () => {
      throw sdkMissingError()
    }
  })
  const catalog: VirtualDeviceCatalog = {
    list: async () => [],
    boot: async () => {
      throw sdkMissingError()
    },
    shutdown: async () => {
      throw sdkMissingError()
    }
  }
  const state = createAppState({ platforms, registry, catalog, server: null })
  const reject = async (): Promise<never> => {
    throw sdkMissingError()
  }
  const actions: BridgeActions = {
    selectDevice: () => {
      throw sdkMissingError()
    },
    bootVirtualDevice: reject,
    shutdownDevice: reject,
    captureScreenshot: reject,
    startStream: reject,
    stopStream: async () => {},
    openLogs: () => {
      throw sdkMissingError()
    },
    closeLogs: () => {
      throw sdkMissingError()
    }
  }
  return { state, actions }
}

/**
 * main 프로세스를 조립한다. 순서가 이렇게 되는 이유는 하나다. MCP 서버를 열려면
 * 툴 컨텍스트가 필요하고, 툴 컨텍스트의 onToolCall은 AppState가 가지고 있다. 그래서
 * AppState를 먼저 만들고 서버를 연 뒤 setServer로 이어 붙인다.
 */
export async function bootstrapApp(deps: BootstrapDeps): Promise<BootstrappedApp> {
  const { located, iosTools } = deps
  const platforms = platformStatuses(located, iosTools, deps.axePath)

  // 플랫폼마다 따로 조립한다. 하나라도 준비되면 전체 조립과 MCP 서버를 연다.
  if (!located.ok && !iosTools.ok) {
    const { state, actions } = assembleWithoutPlatforms(platforms)
    registerIpcBridge(deps.ipcMain, state, actions, deps.send)
    return { state, server: null, stop: async () => {} }
  }

  const androidPaths = located.ok ? located.paths : null
  const { registry, catalog } = deps.createDeviceStack(androidPaths, iosTools.ok)
  const state = createAppState({ platforms, registry, catalog, server: null })

  const stream = deps.createStreamManager(registry, androidPaths, {
    onState: (serial, streamState) => state.recordDeviceEvent(serial, STREAM_EVENTS[streamState])
  })
  const logs = deps.createLogManager(registry, androidPaths, {
    onTailState: (serial, tailState) => {
      // 끊김으로 멈춘 tail은 disconnected 항목이 이미 말한다. 기기가 아직 붙어 있는데 멈춘 것만 남긴다.
      if (tailState === 'stopped' && registry.serials().includes(serial)) state.recordDeviceEvent(serial, 'log_stopped')
    }
  })
  // 기기가 사라지면 그 기기의 스트림은 재시도하지 않고 닫는다. 재시도 루프의 isConnected
  // 확인만으로는 대기 시간만큼 늦게 닫힌다. 로그 tail·버퍼의 수명도 기기 연결을 그대로 따른다
  // (logs.handleConnect·handleDisconnect) — 이 구독을 registry.start()보다 먼저 걸어야
  // 처음부터 붙어 있던 기기도 tail을 받는다.
  registry.on((event) => {
    if (event.type === 'device_connected') logs.handleConnect(event.serial)
    if (event.type === 'device_disconnected') {
      void stream.handleDisconnect(event.serial)
      logs.handleDisconnect(event.serial)
    }
  })

  // 상태가 registry를 구독한 뒤에 추적을 시작한다. 그래야 처음 붙어 있던 기기의
  // device_connected도 상태를 거쳐 renderer까지 간다.
  registry.start()

  let server: McpServerHandle | null = null
  try {
    server = await deps.startServer({
      context: {
        registry,
        catalog,
        pidHistory: (serial, pkg) => logs.pidHistory(serial, pkg),
        onToolCall: (record) => state.recordToolCall(record)
      }
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
      bootVirtualDevice: async (id) => {
        await catalog.boot(id)
      },
      // IPC는 serial만 준다. 소스 라우팅에 쓸 platform은 registry가 아는 기기에서 꺼낸다.
      shutdownDevice: (serial) => catalog.shutdown(serial, registry.resolve(serial).platform),
      captureScreenshot: (serial) => {
        const device = registry.resolve(serial)
        return registry.run(device.serial, () => device.screenshot())
      },
      startStream: async (serial) => {
        // 모르는 serial이면 여기서 no_device로 끝낸다. 세션을 열어 adb가 실패하기를 기다리지 않는다.
        registry.resolve(serial)
        await stream.open(serial)
      },
      stopStream: () => stream.stop(),
      openLogs: (serial) => {
        // 모르는 serial이면 여기서 no_device로 끝낸다. logs.open은 serial을 검증하지 않는다.
        registry.resolve(serial)
        logs.open(serial)
      },
      closeLogs: () => logs.close()
    },
    deps.send
  )

  return {
    state,
    server,
    async stop() {
      // 스트림 정리가 던져도 로그 tail·기기 추적·MCP 서버는 멈춰야 한다. 에러는 호출자에게 그대로 넘긴다.
      try {
        await stream.stop()
      } finally {
        try {
          logs.stopAll()
        } finally {
          try {
            registry.stop()
          } finally {
            await server?.close()
          }
        }
      }
    }
  }
}
