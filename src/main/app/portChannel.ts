import { MessageChannelMain, type MessagePortMain } from 'electron'

/**
 * postMessage로 나가는 하향 메시지 타입을 Down으로 파라미터화한 포트 모양.
 * 스트림 포트(StreamDown)와 로그 포트(LogDown)가 이 모양을 그대로 공유한다 — 감싸는
 * 로직은 완전히 같고 오가는 메시지 타입만 다르기 때문이다.
 */
export interface PortChannelLocal<Down> {
  postMessage(message: Down): void
  on(event: 'message', listener: (event: { data: unknown }) => void): unknown
  /** 반대쪽(renderer) 포트가 끊겼을 때. 창 닫힘·reload·크래시가 여기로 온다. */
  on(event: 'close', listener: () => void): unknown
  start(): void
  close(): void
}

export interface PortChannel<Down> {
  local: PortChannelLocal<Down>
  remote: MessagePortMain
}

/**
 * `MessageChannelMain`을 `PortChannelLocal` 모양으로 감싼다. 스트림(streamManager)과
 * 로그(logManager)의 createChannel이 이 구현을 공유한다.
 */
export function createPortChannel<Down>(): PortChannel<Down> {
  const { port1, port2 } = new MessageChannelMain()
  return {
    local: {
      postMessage: (message) => port1.postMessage(message),
      on: (event: 'message' | 'close', listener: (event: { data: unknown }) => void) => {
        if (event === 'close') port1.on('close', () => listener({ data: undefined }))
        else port1.on('message', (message) => listener({ data: message.data }))
      },
      start: () => port1.start(),
      close: () => port1.close()
    },
    remote: port2
  }
}
