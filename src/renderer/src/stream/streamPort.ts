import { IPC_CHANNELS, type SlotRef } from '../../../shared/types/ipc'
import type { StreamPortMeta } from '../../../shared/types/stream'

/** window에서 이 모듈이 쓰는 부분. 테스트는 가짜를 넘긴다. */
export interface MessageTarget {
  addEventListener(type: 'message', listener: (event: MessageEvent) => void): void
  removeEventListener(type: 'message', listener: (event: MessageEvent) => void): void
}

export interface StreamPortRouter {
  /** 이 칸·세대의 포트를 받겠다고 등록한다. 돌려준 함수로 해제한다. */
  subscribe(ref: SlotRef, onPort: (meta: StreamPortMeta, port: MessagePort) => void): () => void
}

type PortHandler = (meta: StreamPortMeta, port: MessagePort) => void

/**
 * preload가 window.postMessage로 넘긴 스트림 포트를 받는다. MessagePort는 contextBridge를
 * 넘지 못해서 이 경로를 쓴다(ADR-0010). 같은 창에서 온 것, 채널이 맞는 것, 포트가 정확히
 * 하나인 것만 받는다.
 *
 * 창의 `message` 리스너를 하나만 걸고, 스트림 포트를 `slotId`와 `epoch`가 모두 맞는 구독자에게만
 * 넘긴다. 받을 구독자가 없는 포트는 여기서 닫는다. 포트를 닫는 곳은 renderer에서 이 라우터뿐이다.
 *
 * 창 하나에 라우터 하나다. 같은 창에 라우터를 둘 만들면 포트를 서로 먼저 닫는다.
 * `target`을 주지 않으면 첫 `subscribe` 때 `window`를 읽는다. import만으로는 `window`를 건드리지 않는다.
 */
export function createStreamPortRouter(target?: MessageTarget): StreamPortRouter {
  const handlers = new Map<string, PortHandler>()
  let attachedTo: MessageTarget | null = null
  const keyOf = (ref: SlotRef): string => `${ref.slotId}\u0000${ref.epoch}`

  const listener = (event: MessageEvent): void => {
    if (event.source !== (attachedTo as unknown)) return
    const data: unknown = event.data
    if (typeof data !== 'object' || data === null) return
    const { channel, serial, sessionId, slotId, epoch } = data as Record<string, unknown>
    if (channel !== IPC_CHANNELS.streamPort) return
    if (typeof serial !== 'string' || typeof sessionId !== 'string') return
    if (typeof slotId !== 'string' || typeof epoch !== 'number') return
    if (event.ports.length !== 1) return
    const port = event.ports[0] as MessagePort
    const handler = handlers.get(keyOf({ slotId, epoch }))
    if (handler) handler({ serial, sessionId, slotId, epoch }, port)
    else port.close()
  }

  return {
    subscribe(ref, onPort) {
      if (!attachedTo) {
        attachedTo = target ?? window
        attachedTo.addEventListener('message', listener)
      }
      const key = keyOf(ref)
      handlers.set(key, onPort)
      // 갈아 끼워진 앞 구독의 해제는 뒤 구독을 지우지 않는다.
      return () => {
        if (handlers.get(key) === onPort) handlers.delete(key)
      }
    }
  }
}

/** 이 창의 라우터. 훅은 이것으로 구독한다. */
export const streamPortRouter: StreamPortRouter = createStreamPortRouter()
