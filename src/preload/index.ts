import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron'
import {
  IPC_CHANNELS,
  type AppSnapshot,
  type MainEvent,
  type Outcome,
  type RendererApi
} from '../shared/types/ipc'
import type { ScreenshotResult } from '../shared/types/device'
import type { StreamPortMeta } from '../shared/types/stream'

/**
 * renderer에 노출하는 전부. 범용 invoke를 만들지 않는다 —
 * 그 하나만 뚫려 있어도 화이트리스트가 의미를 잃는다.
 */
const api: RendererApi = {
  getSnapshot: () => ipcRenderer.invoke(IPC_CHANNELS.getSnapshot) as Promise<AppSnapshot>,
  selectDevice: (serial) =>
    ipcRenderer.invoke(IPC_CHANNELS.selectDevice, serial) as Promise<Outcome<void>>,
  bootAvd: (name) => ipcRenderer.invoke(IPC_CHANNELS.bootAvd, name) as Promise<Outcome<void>>,
  shutdownDevice: (serial) =>
    ipcRenderer.invoke(IPC_CHANNELS.shutdownDevice, serial) as Promise<Outcome<void>>,
  captureScreenshot: (serial) =>
    ipcRenderer.invoke(IPC_CHANNELS.captureScreenshot, serial) as Promise<Outcome<ScreenshotResult>>,
  startStream: (serial) => ipcRenderer.invoke(IPC_CHANNELS.startStream, serial) as Promise<Outcome<void>>,
  stopStream: () => ipcRenderer.invoke(IPC_CHANNELS.stopStream) as Promise<Outcome<void>>,
  onEvent: (callback) => {
    // IpcRendererEvent를 renderer로 넘기지 않는다. sender를 통해 더 많은 것이 새어 나간다.
    const listener = (_event: IpcRendererEvent, payload: MainEvent): void => callback(payload)
    ipcRenderer.on(IPC_CHANNELS.event, listener)
    return () => ipcRenderer.removeListener(IPC_CHANNELS.event, listener)
  }
}

/**
 * MessagePort는 contextBridge를 넘지 못한다. Electron 문서의 방식대로 window.postMessage로
 * main world에 건넨다. renderer의 streamPort.ts가 channel·출처·포트 개수를 보고 받는다.
 * 여기서는 포트가 정확히 하나일 때만 넘긴다 — 이 채널이 범용 포트 통로가 되지 않게 한다.
 */
ipcRenderer.on(IPC_CHANNELS.streamPort, (event: IpcRendererEvent, meta: StreamPortMeta) => {
  if (event.ports.length !== 1) return
  window.postMessage({ channel: IPC_CHANNELS.streamPort, serial: meta.serial, sessionId: meta.sessionId }, '*', [...event.ports])
})

contextBridge.exposeInMainWorld('api', api)
