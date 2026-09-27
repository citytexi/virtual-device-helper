import { IPC_CHANNELS } from '../../../shared/types/ipc'
import type { StreamPortMeta } from '../../../shared/types/stream'

/** window에서 이 모듈이 쓰는 부분. 테스트는 가짜를 넘긴다. */
export interface MessageTarget {
  addEventListener(type: 'message', listener: (event: MessageEvent) => void): void
  removeEventListener(type: 'message', listener: (event: MessageEvent) => void): void
}

/**
 * preload가 window.postMessage로 넘긴 스트림 포트를 받는다. MessagePort는 contextBridge를
 * 넘지 못해서 이 경로를 쓴다(ADR-0010). 같은 창에서 온 것, 채널이 맞는 것, 포트가 정확히
 * 하나인 것만 받는다.
 */
export function onStreamPort(
  callback: (meta: StreamPortMeta, port: MessagePort) => void,
  target: MessageTarget = window
): () => void {
  const listener = (event: MessageEvent): void => {
    if (event.source !== (target as unknown)) return
    const data: unknown = event.data
    if (typeof data !== 'object' || data === null) return
    const { channel, serial, sessionId } = data as Record<string, unknown>
    if (channel !== IPC_CHANNELS.streamPort) return
    if (typeof serial !== 'string' || typeof sessionId !== 'string') return
    if (event.ports.length !== 1) return
    callback({ serial, sessionId }, event.ports[0] as MessagePort)
  }
  target.addEventListener('message', listener)
  return () => target.removeEventListener('message', listener)
}
