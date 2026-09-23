import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron'
import {
  IPC_CHANNELS,
  type AppSnapshot,
  type MainEvent,
  type Outcome,
  type RendererApi
} from '../shared/types/ipc'
import type { ScreenshotResult } from '../shared/types/device'

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
  onEvent: (callback) => {
    // IpcRendererEvent를 renderer로 넘기지 않는다. sender를 통해 더 많은 것이 새어 나간다.
    const listener = (_event: IpcRendererEvent, payload: MainEvent): void => callback(payload)
    ipcRenderer.on(IPC_CHANNELS.event, listener)
    return () => ipcRenderer.removeListener(IPC_CHANNELS.event, listener)
  }
}

contextBridge.exposeInMainWorld('api', api)
