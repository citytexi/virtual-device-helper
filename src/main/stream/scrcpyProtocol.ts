import { deviceError, type DeviceError } from '../../shared/types/errors'
import type { ControlIntent, DeviceKey, TouchAction } from '../../shared/types/stream'

/**
 * scrcpy v4.1 와이어 포맷. 근거는 v4.1 태그의 `DesktopConnection.java`, `Streamer.java`,
 * `ControlMessageReader.java`다. 이 파일 밖에서는 바이트 오프셋과 플래그를 다루지 않는다.
 * jar 버전을 올리면 이 파일과 그 테스트부터 다시 대조한다.
 */

const DEVICE_NAME_LENGTH = 64
const RECORD_HEADER_LENGTH = 12
const CODEC_ID_LENGTH = 4
/** ASCII "h264" */
const CODEC_ID_H264 = 0x68323634
/** 레코드 첫 바이트의 최상위 비트(= ptsAndFlags의 bit 63). 켜져 있으면 session meta다. */
const SESSION_RECORD_BIT = 0x80
const PACKET_FLAG_CONFIG = 1n << 62n
const PACKET_FLAG_KEY_FRAME = 1n << 61n
const PTS_MASK = (1n << 61n) - 1n

export interface VideoPacket {
  config: boolean
  key: boolean
  /** config 패킷이면 null */
  ptsUs: number | null
  /** 정확히 페이로드 크기의 새 버퍼. 다른 패킷과 메모리를 공유하지 않는다. */
  data: Uint8Array
}

export interface VideoStreamHandlers {
  onDeviceName(name: string): void
  onSession(width: number, height: number): void
  onPacket(packet: VideoPacket): void
  /** 와이어 포맷 위반 또는 서버가 알린 비활성·에러. 이후 입력은 무시한다. */
  onError(error: DeviceError): void
}

export interface VideoStreamParser {
  push(chunk: Uint8Array): void
}

type Stage = 'dummy' | 'deviceName' | 'codec' | 'record' | 'payload' | 'dead'

interface PendingPacket {
  config: boolean
  key: boolean
  ptsUs: number | null
  size: number
}

function protocolError(message: string, details?: Record<string, unknown>): DeviceError {
  return deviceError('command_failed', message, 'scrcpy 서버 버전이 vendor/scrcpy/VERSION과 같은지 확인하고 다시 연결해라', details)
}

/**
 * 비디오 소켓 바이트를 받아 헤더와 패킷을 순서대로 낸다. TCP는 바이트를 아무 데서나
 * 자르므로 어떤 단계에서든 모자라면 다음 push까지 기다린다.
 */
export function createVideoStreamParser(handlers: VideoStreamHandlers): VideoStreamParser {
  let buffer: Buffer = Buffer.alloc(0)
  let stage: Stage = 'dummy'
  let pending: PendingPacket | null = null

  function take(length: number): Buffer {
    const head = buffer.subarray(0, length)
    buffer = buffer.subarray(length)
    return head
  }

  function fail(error: DeviceError): void {
    stage = 'dead'
    buffer = Buffer.alloc(0)
    handlers.onError(error)
  }

  function drain(): void {
    for (;;) {
      if (stage === 'dead') return

      if (stage === 'dummy') {
        if (buffer.length < 1) return
        const dummy = take(1)[0]
        if (dummy !== 0) {
          fail(protocolError(`scrcpy 비디오 소켓의 첫 바이트가 0이 아니라 ${dummy}이다`))
          return
        }
        stage = 'deviceName'
        continue
      }

      if (stage === 'deviceName') {
        if (buffer.length < DEVICE_NAME_LENGTH) return
        const raw = take(DEVICE_NAME_LENGTH)
        const end = raw.indexOf(0)
        handlers.onDeviceName(raw.subarray(0, end === -1 ? DEVICE_NAME_LENGTH : end).toString('utf8'))
        stage = 'codec'
        continue
      }

      if (stage === 'codec') {
        if (buffer.length < CODEC_ID_LENGTH) return
        const raw = take(CODEC_ID_LENGTH)
        const id = raw.readUInt32BE(0)
        if (id === 0) {
          fail(protocolError('scrcpy 서버가 비디오 스트림을 비활성으로 알렸다'))
          return
        }
        if (id === 1) {
          fail(protocolError('scrcpy 서버가 설정 에러로 비디오 스트림을 열지 못했다'))
          return
        }
        if (id !== CODEC_ID_H264) {
          fail(protocolError(`scrcpy 서버가 h264가 아닌 codec을 보냈다: ${raw.toString('latin1')}`, { codecId: id }))
          return
        }
        stage = 'record'
        continue
      }

      if (stage === 'record') {
        if (buffer.length < RECORD_HEADER_LENGTH) return
        const header = take(RECORD_HEADER_LENGTH)

        if (((header[0] ?? 0) & SESSION_RECORD_BIT) !== 0) {
          handlers.onSession(header.readInt32BE(4), header.readInt32BE(8))
          continue
        }

        const ptsAndFlags = header.readBigUInt64BE(0)
        const config = (ptsAndFlags & PACKET_FLAG_CONFIG) !== 0n
        pending = {
          config,
          key: !config && (ptsAndFlags & PACKET_FLAG_KEY_FRAME) !== 0n,
          ptsUs: config ? null : Number(ptsAndFlags & PTS_MASK),
          size: header.readUInt32BE(8)
        }
        stage = 'payload'
        continue
      }

      // stage === 'payload'
      const packet = pending as PendingPacket
      if (buffer.length < packet.size) return
      // Uint8Array.from이 아니라 새 버퍼에 복사한다. take()의 결과는 누적 버퍼의 view다.
      const data = new Uint8Array(packet.size)
      data.set(take(packet.size))
      pending = null
      stage = 'record'
      handlers.onPacket({ config: packet.config, key: packet.key, ptsUs: packet.ptsUs, data })
    }
  }

  return {
    push(chunk) {
      if (stage === 'dead') return
      buffer = buffer.length === 0 ? Buffer.from(chunk) : Buffer.concat([buffer, chunk])
      drain()
    }
  }
}

const TYPE_INJECT_KEYCODE = 0
const TYPE_INJECT_TEXT = 1
const TYPE_INJECT_TOUCH_EVENT = 2
const TYPE_INJECT_SCROLL_EVENT = 3
const KEY_ACTION_DOWN = 0
const KEY_ACTION_UP = 1
const MOTION_ACTIONS: Record<TouchAction, number> = { down: 0, up: 1, move: 2 }
/** scrcpy의 SC_POINTER_ID_GENERIC_FINGER. 서버가 터치스크린 이벤트로 주입한다. */
const POINTER_ID_GENERIC_FINGER = -2n
/** 서버 ControlMessageReader.INJECT_TEXT_MAX_LENGTH. 넘으면 서버가 연결을 끊는다. */
export const INJECT_TEXT_MAX_BYTES = 300

export const ANDROID_KEYCODES: Record<DeviceKey, number> = {
  back: 4,
  home: 3,
  app_switch: 187,
  power: 26,
  volume_up: 24,
  volume_down: 25,
  enter: 66,
  backspace: 67,
  forward_delete: 112,
  tab: 61,
  escape: 111,
  up: 19,
  down: 20,
  left: 21,
  right: 22
}

function keyMessage(action: number, keycode: number): Buffer {
  const bytes = Buffer.alloc(14)
  bytes.writeUInt8(TYPE_INJECT_KEYCODE, 0)
  bytes.writeUInt8(action, 1)
  bytes.writeInt32BE(keycode, 2)
  bytes.writeInt32BE(0, 6) // repeat
  bytes.writeInt32BE(0, 10) // metaState
  return bytes
}

/** scrcpy의 sc_float_to_i16fp. [-16, 16]을 [-1, 1]로 줄인 뒤 2^15를 곱하고 버린다. */
function scrollToI16(value: number): number {
  const normalized = Math.max(-1, Math.min(1, value / 16))
  const fixed = Math.trunc(normalized * 0x8000)
  return fixed >= 0x7fff ? 0x7fff : fixed
}

function writePosition(bytes: Buffer, offset: number, point: { x: number; y: number; width: number; height: number }): void {
  bytes.writeInt32BE(Math.round(point.x), offset)
  bytes.writeInt32BE(Math.round(point.y), offset + 4)
  bytes.writeUInt16BE(point.width, offset + 8)
  bytes.writeUInt16BE(point.height, offset + 10)
}

/** 입력 의도를 control 소켓에 쓸 바이트로 바꾼다. 모든 정수는 big-endian이다. */
export function serializeControl(intent: ControlIntent): Uint8Array {
  switch (intent.type) {
    case 'key': {
      const keycode = ANDROID_KEYCODES[intent.key]
      return Buffer.concat([keyMessage(KEY_ACTION_DOWN, keycode), keyMessage(KEY_ACTION_UP, keycode)])
    }

    case 'text': {
      const text = Buffer.from(intent.text, 'utf8')
      if (text.length > INJECT_TEXT_MAX_BYTES) {
        throw deviceError('command_failed', `입력 텍스트가 ${INJECT_TEXT_MAX_BYTES}바이트를 넘는다`, '텍스트를 나눠서 보내라', {
          bytes: text.length
        })
      }
      const bytes = Buffer.alloc(5 + text.length)
      bytes.writeUInt8(TYPE_INJECT_TEXT, 0)
      bytes.writeUInt32BE(text.length, 1)
      text.copy(bytes, 5)
      return bytes
    }

    case 'touch': {
      const bytes = Buffer.alloc(32)
      bytes.writeUInt8(TYPE_INJECT_TOUCH_EVENT, 0)
      bytes.writeUInt8(MOTION_ACTIONS[intent.action], 1)
      bytes.writeBigInt64BE(POINTER_ID_GENERIC_FINGER, 2)
      writePosition(bytes, 10, intent.point)
      bytes.writeUInt16BE(intent.action === 'up' ? 0 : 0xffff, 22) // pressure
      bytes.writeInt32BE(0, 24) // actionButton
      bytes.writeInt32BE(0, 28) // buttons
      return bytes
    }

    case 'scroll': {
      const bytes = Buffer.alloc(21)
      bytes.writeUInt8(TYPE_INJECT_SCROLL_EVENT, 0)
      writePosition(bytes, 1, intent.point)
      bytes.writeInt16BE(scrollToI16(intent.hScroll), 13)
      bytes.writeInt16BE(scrollToI16(intent.vScroll), 15)
      bytes.writeInt32BE(0, 17) // buttons
      return bytes
    }
  }
}
