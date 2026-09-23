---
id: m2-1-stream-core          # 파일명에서 날짜 접두사를 뺀 slug
title: M2-1 — main 스트림 코어
status: draft                   # draft | in-progress | done | abandoned | superseded
type: work-order                # work-order | handoff
created: 2026-09-23
updated: 2026-09-23
owner: virtual-device-helper 팀
scope: [main, preload, shared, streaming, android, build]
hosts: []                       # windows | macos — 호스트 OS마다 작업이 갈릴 때만 채운다
archived_reason:                # done/abandoned 시 사유 (활성 계획은 비움)
related_adr: [ADR-0002, ADR-0010]
related_spec: m2-live-streaming
related_architecture:
related_plan: [m2-2-renderer-stream, m2-3-gesture-overlay]
related_code: [scrcpyProtocol.ts#createVideoStreamParser, scrcpyProtocol.ts#serializeControl, scrcpySession.ts#createScrcpySession, streamManager.ts#createStreamManager]
tags: [plan, streaming, scrcpy]
---

# M2-1 — main 스트림 코어 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: `superpowers:subagent-driven-development`(권장) 또는
> `superpowers:executing-plans`로 task 단위 구현. 각 단계는 체크박스(`- [ ]`)로 추적한다.

**Goal:** main 프로세스가 기기에서 `scrcpy-server.jar` v4.1을 띄우고, 비디오 패킷을 디코딩하지 않은 채
`MessageChannelMain` 포트로 renderer에 흘려보내며, 포트로 받은 입력 의도를 control 소켓으로 주입한다.

**Architecture:** 와이어 포맷 지식은 순수 모듈 `scrcpyProtocol.ts` 하나에 둔다. `scrcpySession.ts`는 기기 하나의
세션 수명(jar push → forward → 서버 실행 → 소켓 두 개 → 정리)을 맡고, `streamManager.ts`는 renderer 요청에 따라
세션을 갈아 끼우고 포트·재시도·입력 검증을 맡는다. preload는 `startStream`·`stopStream`과 포트 전달 한 줄만 더한다.
renderer 화면은 이 계획의 범위가 아니다(M2-2).

**Tech Stack:** TypeScript, Electron(`MessageChannelMain`, `webContents.postMessage`), Node `net`·`crypto`, Vitest

**Spec:** [`../specs/2026-09-23-m2-live-streaming.md`](../specs/2026-09-23-m2-live-streaming.md)

## Global Constraints

- 답변·주석·문서는 한국어로 쓴다. 기술 용어·API 이름·명령어·에러 문자열은 원문 그대로 둔다.
- scrcpy 서버는 저장소의 `vendor/scrcpy/scrcpy-server.jar`(v4.1)만 쓴다. 호스트에 설치된 scrcpy는 쓰지 않는다.
- 서버 실행 인자의 첫 값은 `4.1`이다. 서버의 버전과 정확히 같아야 서버가 뜬다.
- scrcpy 와이어 포맷(바이트 오프셋, 플래그, 메시지 type 번호)은 `src/main/stream/scrcpyProtocol.ts`에만 둔다.
- main은 H.264를 디코딩하지 않는다. 패킷을 그대로 릴레이한다.
- 실패는 `deviceError`/`ToolError`로 표현한다. 새 `ToolErrorKind`를 만들지 않는다.
- renderer에서 온 값은 main이 모양을 검증한다. preload에 범용 invoke·send·포트 통로를 만들지 않는다.
- 새 npm 의존성을 들이지 않는다.
- 단위 테스트는 실기기 없이 돈다(`npm test`). 실기기 테스트는 `*.integration.test.ts`로 두고 `npm run test:integration`으로만 돈다.
- 각 task 끝에서 `npm test`와 `npm run typecheck`가 통과해야 한다.
- 기존 테스트가 쓰는 텍스트·채널 목록이 바뀌면 그 테스트를 같은 task에서 고친다.
- 문서에는 라인번호, 파일·툴 개수, 진행률을 적지 않는다. 파일명과 심볼명으로 가리킨다.
- 문서를 고치면 `python3 docs/script/docs.py lint`와 `python3 docs/script/docs.py links`를 돌린다.
- 커밋 메시지는 한국어 Conventional Commits(`feat(main): ...한다`)이고, 끝에 다음 줄을 붙인다:
  `Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>`

## Review Focus

- **청크 경계가 아무 데나 떨어짐**: TCP는 바이트를 임의로 자른다. 한 바이트씩 들어와도 같은 패킷이 나와야 한다. → Task 1 테스트.
- **기기를 빠르게 A→B→A로 전환**: 앞선 `open`이 끝나기 전에 다음 `open`이 와도 포트·세션이 고아로 남지 않아야 한다. → Task 5 테스트.
- **서버가 listen 전에 죽음**(jar 손상, 버전 불일치): 10초 기한까지 기다리지 말고 서버 출력 꼬리를 담아 바로 실패해야 한다. → Task 4 테스트.
- **renderer가 망가진 입력을 보냄**(NaN 좌표, 크기 0, 300바이트 넘는 텍스트, 모르는 key): 버리고 main이 죽지 않아야 한다. → Task 5 테스트.
- **재연결 대기 중 앱 종료나 `stop`**: 대기가 끝난 뒤 세션을 새로 열면 안 된다. → Task 5 테스트.

---

### Task 1: 스트림 공유 타입과 비디오 소켓 파서

**Files:**
- Create: `src/shared/types/stream.ts`
- Create: `src/main/stream/scrcpyProtocol.ts`
- Create: `src/main/stream/__fixtures__/scrcpy-v4.1-first-chunks.bin` (복사)
- Test: `src/main/stream/scrcpyProtocol.test.ts`

**Interfaces:**
- Consumes: `deviceError`, `DeviceError`, `ToolError` (`src/shared/types/errors.ts`)
- Produces:
  - `src/shared/types/stream.ts`: `DeviceKey`, `DEVICE_KEYS`, `VideoPoint`, `TouchAction`, `ControlIntent`,
    `SessionStatus`, `StreamDown`, `StreamUp`, `StreamPortMeta` (코드는 Step 3)
  - `scrcpyProtocol.ts`: `interface VideoPacket { config: boolean; key: boolean; ptsUs: number | null; data: Uint8Array }`,
    `interface VideoStreamHandlers { onDeviceName(name: string): void; onSession(width: number, height: number): void; onPacket(packet: VideoPacket): void; onError(error: DeviceError): void }`,
    `createVideoStreamParser(handlers: VideoStreamHandlers): { push(chunk: Uint8Array): void }`

- [ ] **Step 1: 스파이크 fixture를 본 코드 자리로 복사한다**

M1 스파이크가 실제 v4.1 서버의 비디오 소켓에서 뜬 바이트다. dummy byte 1 + 기기 이름 64 + codec id 4 +
session meta 12 + config 패킷(헤더 12 + 38) + 키프레임(헤더 12 + 21927)으로 정확히 22070바이트다.

```bash
mkdir -p src/main/stream/__fixtures__
cp spike/scrcpy/first-chunks.bin src/main/stream/__fixtures__/scrcpy-v4.1-first-chunks.bin
wc -c src/main/stream/__fixtures__/scrcpy-v4.1-first-chunks.bin
```

Expected: `22070`

- [ ] **Step 2: 실패하는 테스트를 쓴다**

`src/main/stream/scrcpyProtocol.test.ts`:

```ts
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import type { DeviceError } from '../../shared/types/errors'
import { createVideoStreamParser, type VideoPacket } from './scrcpyProtocol'

const FIXTURE = readFileSync(join(__dirname, '__fixtures__', 'scrcpy-v4.1-first-chunks.bin'))

function collect() {
  const names: string[] = []
  const sessions: Array<[number, number]> = []
  const packets: VideoPacket[] = []
  const errors: DeviceError[] = []
  const parser = createVideoStreamParser({
    onDeviceName: (name) => names.push(name),
    onSession: (width, height) => sessions.push([width, height]),
    onPacket: (packet) => packets.push(packet),
    onError: (error) => errors.push(error)
  })
  return { parser, names, sessions, packets, errors }
}

function summary(packets: VideoPacket[]) {
  return packets.map((p) => ({ config: p.config, key: p.key, bytes: p.data.length, ptsIsNull: p.ptsUs === null }))
}

/** 기기 이름 64바이트까지의 헤더. codec id부터는 호출부가 붙인다. */
function preamble(): Buffer {
  const name = Buffer.alloc(64)
  name.write('Pixel_7')
  return Buffer.concat([Buffer.from([0]), name])
}

function sessionRecord(width: number, height: number): Buffer {
  const record = Buffer.alloc(12)
  record.writeUInt32BE(0x80000000, 0)
  record.writeInt32BE(width, 4)
  record.writeInt32BE(height, 8)
  return record
}

function frameRecord(ptsAndFlags: bigint, payload: Buffer): Buffer {
  const header = Buffer.alloc(12)
  header.writeBigUInt64BE(ptsAndFlags, 0)
  header.writeUInt32BE(payload.length, 8)
  return Buffer.concat([header, payload])
}

describe('createVideoStreamParser', () => {
  it('reads the real v4.1 capture into name, session, config and key frame', () => {
    const c = collect()

    c.parser.push(FIXTURE)

    expect(c.errors).toEqual([])
    expect(c.names).toEqual(['SM-A356N'])
    expect(c.sessions).toEqual([[472, 1024]])
    expect(summary(c.packets)).toEqual([
      { config: true, key: false, bytes: 38, ptsIsNull: true },
      { config: false, key: true, bytes: 21927, ptsIsNull: false }
    ])
    expect(typeof c.packets[1]?.ptsUs).toBe('number')
  })

  it('yields the same result when bytes arrive one at a time', () => {
    const whole = collect()
    whole.parser.push(FIXTURE)
    const split = collect()

    for (let i = 0; i < FIXTURE.length; i += 1) split.parser.push(FIXTURE.subarray(i, i + 1))

    expect(split.names).toEqual(whole.names)
    expect(split.sessions).toEqual(whole.sessions)
    expect(summary(split.packets)).toEqual(summary(whole.packets))
    expect(Buffer.from(split.packets[1]!.data).equals(Buffer.from(whole.packets[1]!.data))).toBe(true)
  })

  it('yields the same result for odd-sized chunks that cut headers and payloads', () => {
    const split = collect()

    for (let i = 0; i < FIXTURE.length; i += 7) split.parser.push(FIXTURE.subarray(i, i + 7))

    expect(split.sessions).toEqual([[472, 1024]])
    expect(summary(split.packets).map((p) => p.bytes)).toEqual([38, 21927])
  })

  it('gives every packet its own exactly-sized buffer', () => {
    const c = collect()

    c.parser.push(FIXTURE)

    // 풀 버퍼의 view면 structured clone이 풀 전체를 복사한다.
    for (const packet of c.packets) {
      expect(packet.data.byteOffset).toBe(0)
      expect(packet.data.buffer.byteLength).toBe(packet.data.length)
    }
  })

  it('reports a session meta that arrives mid-stream, as after a rotation', () => {
    const c = collect()
    const config = frameRecord(1n << 62n, Buffer.from([0, 0, 0, 1]))

    c.parser.push(Buffer.concat([FIXTURE, sessionRecord(1024, 472), config]))

    expect(c.sessions).toEqual([
      [472, 1024],
      [1024, 472]
    ])
    expect(c.packets).toHaveLength(3)
    expect(c.packets[2]?.config).toBe(true)
  })

  it('reads the pts of a delta frame and leaves key false', () => {
    const c = collect()
    const codec = Buffer.from('h264', 'latin1')

    c.parser.push(Buffer.concat([preamble(), codec, sessionRecord(10, 20), frameRecord(123456n, Buffer.from([9]))]))

    expect(c.packets).toEqual([{ config: false, key: false, ptsUs: 123456, data: new Uint8Array([9]) }])
  })

  it.each([
    [0, '비활성'],
    [1, '설정 에러']
  ])('fails when the server sends codec id %i instead of a codec', (id, text) => {
    const c = collect()
    const codec = Buffer.alloc(4)
    codec.writeUInt32BE(id, 0)

    c.parser.push(Buffer.concat([preamble(), codec]))

    expect(c.errors).toHaveLength(1)
    expect(c.errors[0]?.toolError.message).toContain(text)
  })

  it('fails on a codec other than h264', () => {
    const c = collect()

    c.parser.push(Buffer.concat([preamble(), Buffer.from('h265', 'latin1')]))

    expect(c.errors).toHaveLength(1)
    expect(c.errors[0]?.toolError.message).toContain('h265')
  })

  it('fails when the first byte is not the dummy byte', () => {
    const c = collect()

    c.parser.push(Buffer.from([7]))

    expect(c.errors).toHaveLength(1)
  })

  it('ignores everything after an error', () => {
    const onPacket = vi.fn()
    const onError = vi.fn()
    const parser = createVideoStreamParser({ onDeviceName: vi.fn(), onSession: vi.fn(), onPacket, onError })

    parser.push(Buffer.from([7]))
    parser.push(FIXTURE)

    expect(onError).toHaveBeenCalledTimes(1)
    expect(onPacket).not.toHaveBeenCalled()
  })
})
```

- [ ] **Step 3: 테스트가 실패하는지 확인한다**

Run: `npx vitest run src/main/stream/scrcpyProtocol.test.ts`
Expected: FAIL — `Cannot find module './scrcpyProtocol'`

- [ ] **Step 4: 공유 타입을 쓴다**

`src/shared/types/stream.ts`:

```ts
import type { ToolError } from './errors'

/** 사람이 보낼 수 있는 기기 키. 툴바 버튼과 캔버스 키보드 입력이 같은 목록을 쓴다. */
export type DeviceKey =
  | 'back'
  | 'home'
  | 'app_switch'
  | 'power'
  | 'volume_up'
  | 'volume_down'
  | 'enter'
  | 'backspace'
  | 'forward_delete'
  | 'tab'
  | 'escape'
  | 'up'
  | 'down'
  | 'left'
  | 'right'

/** main이 renderer 입력을 검증할 때 쓰는 목록. DeviceKey와 같은 값을 같은 순서로 둔다. */
export const DEVICE_KEYS: readonly DeviceKey[] = [
  'back',
  'home',
  'app_switch',
  'power',
  'volume_up',
  'volume_down',
  'enter',
  'backspace',
  'forward_delete',
  'tab',
  'escape',
  'up',
  'down',
  'left',
  'right'
]

/**
 * 비디오 프레임 좌표와 그 프레임의 크기. 서버는 width·height가 자기 비디오 크기와 다르면
 * 이벤트를 버린다 — 회전 직후의 오래된 좌표가 엉뚱한 곳을 누르지 않게 하는 장치다.
 */
export interface VideoPoint {
  x: number
  y: number
  width: number
  height: number
}

export type TouchAction = 'down' | 'move' | 'up'

/** 사람 입력의 의도. 바이트로 바꾸는 일은 main의 scrcpyProtocol만 한다. */
export type ControlIntent =
  | { type: 'touch'; action: TouchAction; point: VideoPoint }
  /** hScroll·vScroll는 Android 축 의미다. 양수가 오른쪽·위쪽이고 범위는 [-16, 16]이다. */
  | { type: 'scroll'; point: VideoPoint; hScroll: number; vScroll: number }
  | { type: 'text'; text: string }
  | { type: 'key'; key: DeviceKey }

export type SessionStatus =
  | { state: 'connecting' }
  | { state: 'streaming' }
  | { state: 'reconnecting'; attempt: number }
  | { state: 'failed'; error: ToolError }

/** main → renderer 포트 메시지 */
export type StreamDown =
  | { type: 'status'; status: SessionStatus }
  | { type: 'session'; width: number; height: number }
  | { type: 'packet'; config: boolean; key: boolean; ptsUs: number | null; data: Uint8Array }

/** renderer → main 포트 메시지 */
export type StreamUp = ControlIntent

/** 포트와 함께 오는 꼬리표. renderer는 자기 serial과 같은 포트만 쓴다. */
export interface StreamPortMeta {
  serial: string
  sessionId: string
}
```

- [ ] **Step 5: 파서를 쓴다**

`src/main/stream/scrcpyProtocol.ts`:

```ts
import { deviceError, type DeviceError } from '../../shared/types/errors'

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
```

- [ ] **Step 6: 테스트가 통과하는지 확인한다**

Run: `npx vitest run src/main/stream/scrcpyProtocol.test.ts && npm run typecheck`
Expected: PASS, 타입 에러 없음

- [ ] **Step 7: 커밋한다**

```bash
git add src/shared/types/stream.ts src/main/stream/
git commit -m "feat(main): scrcpy v4.1 비디오 소켓 파서와 스트림 공유 타입을 더한다

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task 2: control message 직렬화

**Files:**
- Modify: `src/main/stream/scrcpyProtocol.ts`
- Test: `src/main/stream/scrcpyProtocol.control.test.ts`

**Interfaces:**
- Consumes: `ControlIntent`, `DeviceKey` (Task 1)
- Produces:
  - `ANDROID_KEYCODES: Record<DeviceKey, number>`
  - `INJECT_TEXT_MAX_BYTES = 300`
  - `serializeControl(intent: ControlIntent): Uint8Array` — 텍스트가 300바이트를 넘으면 `DeviceError`를 던진다

- [ ] **Step 1: 실패하는 테스트를 쓴다**

기대 바이트는 v4.1 `ControlMessageReader`와 scrcpy 클라이언트의 `test_control_msg_serialize.c`에서 확인한 레이아웃이다.

`src/main/stream/scrcpyProtocol.control.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import { isDeviceError } from '../../shared/types/errors'
import { ANDROID_KEYCODES, INJECT_TEXT_MAX_BYTES, serializeControl } from './scrcpyProtocol'

function hex(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString('hex')
}

const point = { x: 100, y: 200, width: 472, height: 1024 }

describe('serializeControl', () => {
  it('writes a key as a down message followed by an up message', () => {
    const bytes = serializeControl({ type: 'key', key: 'home' })

    expect(hex(bytes)).toBe(
      '00' + '00' + '00000003' + '00000000' + '00000000' + // down HOME repeat 0 meta 0
        '00' + '01' + '00000003' + '00000000' + '00000000' // up
    )
  })

  it('maps every device key to its Android keycode', () => {
    expect(ANDROID_KEYCODES).toEqual({
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
    })
  })

  it('writes text as a length-prefixed utf-8 string', () => {
    expect(hex(serializeControl({ type: 'text', text: 'hi' }))).toBe('01' + '00000002' + '6869')
  })

  it('refuses text longer than the server limit instead of letting the server drop the connection', () => {
    const tooLong = 'a'.repeat(INJECT_TEXT_MAX_BYTES + 1)

    let thrown: unknown
    try {
      serializeControl({ type: 'text', text: tooLong })
    } catch (error) {
      thrown = error
    }

    expect(isDeviceError(thrown)).toBe(true)
  })

  it('writes a touch down as a generic finger with full pressure', () => {
    expect(hex(serializeControl({ type: 'touch', action: 'down', point }))).toBe(
      '02' + '00' + 'fffffffffffffffe' + '00000064' + '000000c8' + '01d8' + '0400' + 'ffff' + '00000000' + '00000000'
    )
  })

  it('writes a touch up with zero pressure and a move with action 2', () => {
    const up = hex(serializeControl({ type: 'touch', action: 'up', point }))
    const move = hex(serializeControl({ type: 'touch', action: 'move', point }))

    expect(up.slice(2, 4)).toBe('01')
    expect(up.slice(44, 48)).toBe('0000')
    expect(move.slice(2, 4)).toBe('02')
    expect(move.slice(44, 48)).toBe('ffff')
  })

  it('rounds fractional coordinates to whole pixels', () => {
    const bytes = serializeControl({ type: 'touch', action: 'down', point: { ...point, x: 99.6, y: 200.4 } })

    expect(hex(bytes).slice(20, 36)).toBe('00000064' + '000000c8')
  })

  it('writes scroll amounts as i16 fixed point over the [-16, 16] range', () => {
    const bytes = serializeControl({ type: 'scroll', point: { x: 260, y: 1026, width: 1080, height: 1920 }, hScroll: 16, vScroll: -16 })

    // scrcpy 클라이언트의 test_serialize_inject_scroll_event와 같은 기대값(buttons만 0)
    expect(hex(bytes)).toBe('03' + '00000104' + '00000402' + '0438' + '0780' + '7fff' + '8000' + '00000000')
  })

  it('writes one wheel notch upward as 1/16 of the range', () => {
    const bytes = serializeControl({ type: 'scroll', point, hScroll: 0, vScroll: 1 })

    expect(hex(bytes).slice(26, 34)).toBe('0000' + '0800')
  })

  it('clamps scroll amounts beyond the range', () => {
    const bytes = serializeControl({ type: 'scroll', point, hScroll: 100, vScroll: -100 })

    expect(hex(bytes).slice(26, 34)).toBe('7fff' + '8000')
  })
})
```

- [ ] **Step 2: 테스트가 실패하는지 확인한다**

Run: `npx vitest run src/main/stream/scrcpyProtocol.control.test.ts`
Expected: FAIL — `serializeControl`이 export되지 않았다

- [ ] **Step 3: 직렬화를 쓴다**

`src/main/stream/scrcpyProtocol.ts`의 import 줄을 바꾸고 파일 끝에 더한다.

```ts
import { deviceError, type DeviceError } from '../../shared/types/errors'
import type { ControlIntent, DeviceKey, TouchAction } from '../../shared/types/stream'
```

```ts
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
```

- [ ] **Step 4: 테스트가 통과하는지 확인한다**

Run: `npx vitest run src/main/stream/ && npm run typecheck`
Expected: PASS

- [ ] **Step 5: 커밋한다**

```bash
git add src/main/stream/scrcpyProtocol.ts src/main/stream/scrcpyProtocol.control.test.ts
git commit -m "feat(main): scrcpy control message 직렬화를 더한다

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task 3: jar 경로·서버 버전과 패키징

**Files:**
- Create: `src/main/stream/scrcpyJar.ts`
- Modify: `electron-builder.yml`
- Test: `src/main/stream/scrcpyJar.test.ts`

**Interfaces:**
- Produces:
  - `SCRCPY_SERVER_VERSION = '4.1'`
  - `interface JarLocationInput { isPackaged: boolean; resourcesPath: string; appPath: string }`
  - `resolveScrcpyJar(input: JarLocationInput): string`

- [ ] **Step 1: 실패하는 테스트를 쓴다**

`src/main/stream/scrcpyJar.test.ts`:

```ts
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { resolveScrcpyJar, SCRCPY_SERVER_VERSION } from './scrcpyJar'

const REPO_ROOT = join(__dirname, '..', '..', '..')
const VERSION_FILE = readFileSync(join(REPO_ROOT, 'vendor', 'scrcpy', 'VERSION'), 'utf8').split('\n')

describe('SCRCPY_SERVER_VERSION', () => {
  it('matches the pinned tag in vendor/scrcpy/VERSION', () => {
    // 서버는 첫 인자가 자기 버전과 정확히 같지 않으면 뜨지 않는다.
    expect(`v${SCRCPY_SERVER_VERSION}`).toBe(VERSION_FILE[0]?.trim())
  })

  it('points at a jar whose sha-256 matches the pinned hash', () => {
    const pinned = VERSION_FILE[1]?.split(/\s+/)[0]
    const actual = createHash('sha256')
      .update(readFileSync(join(REPO_ROOT, 'vendor', 'scrcpy', 'scrcpy-server.jar')))
      .digest('hex')

    expect(actual).toBe(pinned)
  })
})

describe('resolveScrcpyJar', () => {
  it('uses the vendor copy while developing', () => {
    expect(resolveScrcpyJar({ isPackaged: false, resourcesPath: '/ignored', appPath: '/repo' })).toBe(
      join('/repo', 'vendor', 'scrcpy', 'scrcpy-server.jar')
    )
  })

  it('uses the resources copy in a packaged app', () => {
    expect(
      resolveScrcpyJar({ isPackaged: true, resourcesPath: '/App.app/Contents/Resources', appPath: '/ignored' })
    ).toBe(join('/App.app/Contents/Resources', 'scrcpy-server.jar'))
  })
})
```

- [ ] **Step 2: 테스트가 실패하는지 확인한다**

Run: `npx vitest run src/main/stream/scrcpyJar.test.ts`
Expected: FAIL — `Cannot find module './scrcpyJar'`

- [ ] **Step 3: 구현하고 패키징에 jar를 싣는다**

`src/main/stream/scrcpyJar.ts`:

```ts
import { join } from 'node:path'

/**
 * 번들한 scrcpy-server.jar의 버전. 서버 실행 인자의 첫 값으로 넘기며 서버의
 * BuildConfig.VERSION_NAME과 정확히 같아야 한다. vendor/scrcpy/VERSION과 테스트로 묶여 있다.
 */
export const SCRCPY_SERVER_VERSION = '4.1'

export interface JarLocationInput {
  isPackaged: boolean
  /** Electron의 process.resourcesPath */
  resourcesPath: string
  /** Electron의 app.getAppPath(). 개발 중에는 package.json이 있는 저장소 루트다. */
  appPath: string
}

/** jar는 asar 안에 두지 않는다. adb push가 읽을 실제 파일 경로가 필요하다. */
export function resolveScrcpyJar(input: JarLocationInput): string {
  if (input.isPackaged) return join(input.resourcesPath, 'scrcpy-server.jar')
  return join(input.appPath, 'vendor', 'scrcpy', 'scrcpy-server.jar')
}
```

`electron-builder.yml`의 `files:` 블록 바로 아래에 더한다.

```yaml
# adb push가 읽을 수 있게 asar 밖(Contents/Resources)에 둔다. 경로는 scrcpyJar.ts의 resolveScrcpyJar.
extraResources:
  - from: vendor/scrcpy/scrcpy-server.jar
    to: scrcpy-server.jar
```

- [ ] **Step 4: 테스트가 통과하는지 확인한다**

Run: `npx vitest run src/main/stream/scrcpyJar.test.ts && npm run typecheck`
Expected: PASS

- [ ] **Step 5: 커밋한다**

```bash
git add src/main/stream/scrcpyJar.ts src/main/stream/scrcpyJar.test.ts electron-builder.yml
git commit -m "build: scrcpy-server.jar를 extraResources로 싣고 경로와 버전을 한곳에 둔다

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task 4: scrcpySession — 세션 하나의 수명

**Files:**
- Create: `src/main/stream/scrcpySession.ts`
- Test: `src/main/stream/scrcpySession.test.ts`

**Interfaces:**
- Consumes: `AdbClient`, `AdbStream` (`src/main/adb/adbClient.ts`), `createVideoStreamParser`, `serializeControl`,
  `VideoPacket` (Task 1·2), `SCRCPY_SERVER_VERSION` (Task 3), `ControlIntent` (Task 1)
- Produces:
  - `DEVICE_JAR_PATH = '/data/local/tmp/scrcpy-server.jar'`, `MAX_VIDEO_SIZE = 1024`
  - `interface SessionSocket { on(event: 'data', listener: (chunk: Buffer) => void): unknown; on(event: 'close', listener: () => void): unknown; on(event: 'error', listener: (error: Error) => void): unknown; write(data: Uint8Array): unknown; destroy(): void }`
  - `type ConnectFn = (port: number) => Promise<SessionSocket>`
  - `connectLoopback: ConnectFn` — `127.0.0.1:<port>`로 TCP 연결
  - `interface SessionHandlers { onSession(width: number, height: number): void; onPacket(packet: VideoPacket): void; onEnded(error: DeviceError): void }`
  - `interface ScrcpySession { readonly serial: string; start(): Promise<void>; sendControl(intent: ControlIntent): void; close(): Promise<void> }`
  - `interface ScrcpySessionDeps { serial: string; adb: AdbClient; jarPath: string; connect: ConnectFn; randomScid?: () => number; sleep?: (ms: number) => Promise<void>; now?: () => number; connectTimeoutMs?: number }`
  - `createScrcpySession(deps: ScrcpySessionDeps, handlers: SessionHandlers): ScrcpySession`
  - `serverArgs(scid: number): string[]`

- [ ] **Step 1: 실패하는 테스트를 쓴다**

가짜 소켓은 첫 `data` 리스너가 붙으면 준비된 청크를 매크로태스크마다 하나씩 흘린다. 실제 서버처럼 첫 청크는
dummy byte 하나뿐이고, 나머지 헤더는 control 소켓이 붙은 뒤에 온다.

`src/main/stream/scrcpySession.test.ts`:

```ts
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import type { AdbClient, AdbStream, ExecResult } from '../adb/adbClient'
import { deviceError, isDeviceError } from '../../shared/types/errors'
import { createScrcpySession, DEVICE_JAR_PATH, serverArgs } from './scrcpySession'

const FIXTURE = readFileSync(join(__dirname, '__fixtures__', 'scrcpy-v4.1-first-chunks.bin'))

type SocketEvent = 'data' | 'close' | 'error'

/**
 * SessionSocket 가짜. 첫 `data` 리스너가 붙으면 준비된 청크를 매크로태스크마다 하나씩 흘린다.
 * script가 'close'면 데이터 없이 바로 닫힌다(서버가 아직 listen 전인 adb forward).
 */
class FakeSocket {
  readonly write = vi.fn()
  readonly destroy = vi.fn(() => {
    if (this.destroyed) return
    this.destroyed = true
    this.emit('close')
  })
  private readonly listeners: Record<SocketEvent, Array<(...args: any[]) => void>> = { data: [], close: [], error: [] }
  private destroyed = false
  private started = false

  constructor(private readonly script: Buffer[] | 'close' = []) {}

  on(event: SocketEvent, listener: (...args: any[]) => void): this {
    this.listeners[event].push(listener)
    if (event === 'data' && !this.started) {
      this.started = true
      this.play()
    }
    return this
  }

  /** 테스트가 스트림을 끊는 자리 */
  hangUp(): void {
    this.destroyed = true
    this.emit('close')
  }

  private emit(event: SocketEvent, ...args: unknown[]): void {
    for (const listener of [...this.listeners[event]]) listener(...args)
  }

  private play(): void {
    if (this.script === 'close') {
      setImmediate(() => this.destroy())
      return
    }
    const chunks = [...this.script]
    const next = (): void => {
      const chunk = chunks.shift()
      if (!chunk || this.destroyed) return
      this.emit('data', chunk)
      setImmediate(next)
    }
    setImmediate(next)
  }
}

function fakeServerStream() {
  const closeCallbacks: Array<(code: number | null) => void> = []
  const lineCallbacks: Array<(line: string) => void> = []
  const stream: AdbStream = {
    onLine: (cb) => lineCallbacks.push(cb),
    onData: () => {},
    onClose: (cb) => closeCallbacks.push(cb),
    onError: () => {},
    close: vi.fn()
  }
  return {
    stream,
    exit(lines: string[] = []) {
      for (const line of lines) lineCallbacks.forEach((cb) => cb(line))
      closeCallbacks.forEach((cb) => cb(1))
    }
  }
}

function ok(stdout = ''): ExecResult {
  return { stdout, stdoutRaw: Buffer.from(stdout), stderr: '', exitCode: 0 }
}

function harness(sockets: FakeSocket[], overrides: { exec?: AdbClient['exec'] } = {}) {
  const server = fakeServerStream()
  const exec = vi.fn(
    overrides.exec ??
      (async (_serial: string | null, args: string[]) => (args[0] === 'forward' && args[1] === 'tcp:0' ? ok('27183\n') : ok()))
  )
  const adb = { exec, stream: vi.fn(() => server.stream) }
  const queue = [...sockets]
  const connect = vi.fn(async () => {
    const next = queue.shift()
    if (!next) throw new Error('ECONNREFUSED')
    return next
  })
  let clock = 0
  const sleep = vi.fn(async (ms: number) => {
    clock += ms
  })
  const handlers = { onSession: vi.fn(), onPacket: vi.fn(), onEnded: vi.fn() }
  const session = createScrcpySession(
    {
      serial: 'emulator-5554',
      adb: adb as unknown as AdbClient,
      jarPath: '/repo/vendor/scrcpy/scrcpy-server.jar',
      connect,
      randomScid: () => 0x1234abcd,
      sleep,
      now: () => clock,
      connectTimeoutMs: 500
    },
    handlers
  )
  return { session, adb, exec, connect, sleep, handlers, server }
}

/** 실제 서버처럼 dummy byte를 먼저, 나머지를 나중에 보내는 비디오 소켓 */
function videoSocket(): FakeSocket {
  return new FakeSocket([FIXTURE.subarray(0, 1), FIXTURE.subarray(1)])
}

describe('serverArgs', () => {
  it('starts the pinned server with a hex scid and our options', () => {
    expect(serverArgs(0x1234abcd)).toEqual([
      'shell',
      `CLASSPATH=${DEVICE_JAR_PATH}`,
      'app_process',
      '/',
      'com.genymobile.scrcpy.Server',
      '4.1',
      'scid=1234abcd',
      'log_level=info',
      'tunnel_forward=true',
      'video=true',
      'audio=false',
      'control=true',
      'clipboard_autosync=false',
      'video_codec=h264',
      'max_size=1024'
    ])
  })
})

describe('createScrcpySession', () => {
  it('pushes the jar, forwards a free port, starts the server and connects video then control', async () => {
    const h = harness([videoSocket(), new FakeSocket()])

    await h.session.start()

    expect(h.exec.mock.calls.map((call) => call[1])).toEqual([
      ['push', '/repo/vendor/scrcpy/scrcpy-server.jar', DEVICE_JAR_PATH],
      ['forward', 'tcp:0', 'localabstract:scrcpy_1234abcd']
    ])
    expect(h.adb.stream).toHaveBeenCalledWith('emulator-5554', serverArgs(0x1234abcd))
    expect(h.connect.mock.calls).toEqual([[27183], [27183]])
    expect(h.handlers.onSession).toHaveBeenCalledWith(472, 1024)
  })

  it('relays packets that arrive after start', async () => {
    const h = harness([videoSocket(), new FakeSocket()])

    await h.session.start()
    await vi.waitFor(() => expect(h.handlers.onPacket).toHaveBeenCalledTimes(2))

    expect(h.handlers.onPacket.mock.calls[1]?.[0]).toMatchObject({ key: true })
  })

  it('reconnects when adb accepts the connection but closes it before the server listens', async () => {
    const h = harness([new FakeSocket('close'), videoSocket(), new FakeSocket()])

    await h.session.start()

    expect(h.connect).toHaveBeenCalledTimes(3)
    expect(h.sleep).toHaveBeenCalledWith(100)
  })

  it('fails as unresponsive after the deadline and cleans up', async () => {
    const closing = Array.from({ length: 20 }, () => new FakeSocket('close'))
    const h = harness(closing)

    const error = await h.session.start().catch((thrown: unknown) => thrown)

    expect(isDeviceError(error) && error.toolError.kind).toBe('device_unresponsive')
    expect(h.server.stream.close).toHaveBeenCalled()
    expect(h.exec).toHaveBeenLastCalledWith('emulator-5554', ['forward', '--remove', 'tcp:27183'])
  })

  it('fails at once with the server output when the server exits before listening', async () => {
    const h = harness([])
    h.connect.mockImplementation(async () => {
      h.server.exit(['[server] ERROR: The server version (4.1) does not match the client (4.0)'])
      throw new Error('ECONNREFUSED')
    })

    const error = await h.session.start().catch((thrown: unknown) => thrown)

    expect(isDeviceError(error)).toBe(true)
    expect(JSON.stringify(isDeviceError(error) && error.toolError.details)).toContain('does not match')
    expect(h.connect).toHaveBeenCalledTimes(1)
  })

  it('fails start when the server reports a disabled stream instead of a codec', async () => {
    const disabled = Buffer.concat([Buffer.from([0]), Buffer.alloc(64), Buffer.alloc(4)])
    const h = harness([new FakeSocket([disabled.subarray(0, 1), disabled.subarray(1)]), new FakeSocket()])

    const error = await h.session.start().catch((thrown: unknown) => thrown)

    expect(isDeviceError(error) && error.toolError.message).toContain('비활성')
    expect(h.handlers.onEnded).not.toHaveBeenCalled()
  })

  it('fails start when a setup step fails and removes nothing it did not create', async () => {
    const h = harness([], {
      exec: async (_serial, args) => {
        if (args[0] === 'push') throw deviceError('command_failed', 'push 실패', 'x')
        return ok()
      }
    })

    await expect(h.session.start()).rejects.toThrow('push 실패')

    expect(h.exec).toHaveBeenCalledTimes(1)
    expect(h.adb.stream).not.toHaveBeenCalled()
  })

  it('reports an unexpected end exactly once', async () => {
    const video = videoSocket()
    const control = new FakeSocket()
    const h = harness([video, control])
    await h.session.start()

    video.hangUp()
    control.hangUp()
    h.server.exit()

    expect(h.handlers.onEnded).toHaveBeenCalledTimes(1)
  })

  it('closes sockets, stops the server and removes the forward without reporting an end', async () => {
    const video = videoSocket()
    const control = new FakeSocket()
    const h = harness([video, control])
    await h.session.start()

    await h.session.close()

    expect(video.destroy).toHaveBeenCalled()
    expect(control.destroy).toHaveBeenCalled()
    expect(h.server.stream.close).toHaveBeenCalled()
    expect(h.exec).toHaveBeenLastCalledWith('emulator-5554', ['forward', '--remove', 'tcp:27183'])
    expect(h.handlers.onEnded).not.toHaveBeenCalled()
  })

  it('keeps cleaning up when removing the forward fails', async () => {
    const h = harness([videoSocket(), new FakeSocket()])
    await h.session.start()
    h.exec.mockImplementation(async () => {
      throw deviceError('no_device', 'gone', 'x')
    })

    await expect(h.session.close()).resolves.toBeUndefined()
  })

  it('writes serialized control messages to the control socket', async () => {
    const control = new FakeSocket()
    const h = harness([videoSocket(), control])
    await h.session.start()

    h.session.sendControl({ type: 'key', key: 'back' })

    expect(control.write).toHaveBeenCalledTimes(1)
    expect(Buffer.from(control.write.mock.calls[0]?.[0] as Uint8Array).toString('hex').slice(0, 12)).toBe('000000000004')
  })

  it('drops a control message it cannot serialize instead of throwing', async () => {
    const control = new FakeSocket()
    const h = harness([videoSocket(), control])
    await h.session.start()

    expect(() => h.session.sendControl({ type: 'text', text: 'a'.repeat(301) })).not.toThrow()
    expect(control.write).not.toHaveBeenCalled()
  })
})
```

- [ ] **Step 2: 테스트가 실패하는지 확인한다**

Run: `npx vitest run src/main/stream/scrcpySession.test.ts`
Expected: FAIL — `Cannot find module './scrcpySession'`

- [ ] **Step 3: 세션을 쓴다**

`src/main/stream/scrcpySession.ts`:

```ts
import { randomInt } from 'node:crypto'
import { createConnection } from 'node:net'
import type { AdbClient, AdbStream } from '../adb/adbClient'
import { deviceError, isDeviceError, type DeviceError } from '../../shared/types/errors'
import type { ControlIntent } from '../../shared/types/stream'
import { createVideoStreamParser, serializeControl, type VideoPacket } from './scrcpyProtocol'
import { SCRCPY_SERVER_VERSION } from './scrcpyJar'

export const DEVICE_JAR_PATH = '/data/local/tmp/scrcpy-server.jar'
/** 비디오 긴 변의 상한. 에이전트를 지켜보는 용도에는 이 정도로 충분하고 패킷이 작아진다. */
export const MAX_VIDEO_SIZE = 1024
const DEFAULT_CONNECT_TIMEOUT_MS = 10_000
const CONNECT_RETRY_MS = 100
const SERVER_OUTPUT_TAIL_LINES = 20

/** net.Socket에서 이 세션이 쓰는 부분. 테스트는 이 모양만 흉내 낸 가짜를 쓴다. */
export interface SessionSocket {
  on(event: 'data', listener: (chunk: Buffer) => void): unknown
  on(event: 'close', listener: () => void): unknown
  on(event: 'error', listener: (error: Error) => void): unknown
  write(data: Uint8Array): unknown
  destroy(): void
}

export type ConnectFn = (port: number) => Promise<SessionSocket>

/** 루프백 TCP 연결. adb forward가 이 포트를 기기의 abstract 소켓으로 잇는다. */
export const connectLoopback: ConnectFn = (port) =>
  new Promise((resolve, reject) => {
    const socket = createConnection({ host: '127.0.0.1', port })
    socket.once('connect', () => resolve(socket))
    socket.once('error', reject)
  })

export interface SessionHandlers {
  onSession(width: number, height: number): void
  onPacket(packet: VideoPacket): void
  /** 예기치 않은 종료. close()로 닫은 경우에는 부르지 않는다. 최대 한 번. */
  onEnded(error: DeviceError): void
}

export interface ScrcpySession {
  readonly serial: string
  /** 비디오·control 소켓이 붙고 첫 session meta를 받으면 끝난다. 실패하면 연 자원을 정리하고 던진다. */
  start(): Promise<void>
  sendControl(intent: ControlIntent): void
  close(): Promise<void>
}

export interface ScrcpySessionDeps {
  serial: string
  adb: AdbClient
  /** 호스트의 scrcpy-server.jar 경로. resolveScrcpyJar의 결과다. */
  jarPath: string
  connect: ConnectFn
  randomScid?: () => number
  sleep?: (ms: number) => Promise<void>
  now?: () => number
  connectTimeoutMs?: number
}

function scidHex(scid: number): string {
  return scid.toString(16).padStart(8, '0')
}

/**
 * 서버 실행 인자. 첫 값은 서버 버전과 정확히 같아야 하고, scid는 16진수로 읽힌다
 * (v4.1 Options.parse). 소켓 이름은 서버가 `scrcpy_<scid 8자리>`로 만든다.
 */
export function serverArgs(scid: number): string[] {
  return [
    'shell',
    `CLASSPATH=${DEVICE_JAR_PATH}`,
    'app_process',
    '/',
    'com.genymobile.scrcpy.Server',
    SCRCPY_SERVER_VERSION,
    `scid=${scidHex(scid)}`,
    'log_level=info',
    'tunnel_forward=true',
    'video=true',
    'audio=false',
    'control=true',
    // 기기 클립보드가 바뀔 때마다 control 소켓으로 메시지가 오지 않게 끈다. 클립보드 동기화는 범위 밖이다.
    'clipboard_autosync=false',
    'video_codec=h264',
    `max_size=${MAX_VIDEO_SIZE}`
  ]
}

function toDeviceError(thrown: unknown): DeviceError {
  if (isDeviceError(thrown)) return thrown
  return deviceError('command_failed', thrown instanceof Error ? thrown.message : String(thrown), '다시 연결해라')
}

/** 첫 청크를 기다린다. 데이터 없이 닫히면 null이다. */
function firstChunk(socket: SessionSocket): Promise<Buffer | null> {
  return new Promise((resolve) => {
    let settled = false
    const finish = (value: Buffer | null): void => {
      if (settled) return
      settled = true
      resolve(value)
    }
    socket.on('data', (chunk) => finish(chunk))
    socket.on('close', () => finish(null))
    socket.on('error', () => finish(null))
  })
}

export function createScrcpySession(deps: ScrcpySessionDeps, handlers: SessionHandlers): ScrcpySession {
  const { serial, adb, jarPath, connect } = deps
  const randomScid = deps.randomScid ?? (() => randomInt(0, 0x7fffffff))
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)))
  const now = deps.now ?? (() => Date.now())
  const connectTimeoutMs = deps.connectTimeoutMs ?? DEFAULT_CONNECT_TIMEOUT_MS

  let port: number | null = null
  let server: AdbStream | null = null
  let video: SessionSocket | null = null
  let control: SessionSocket | null = null
  let started = false
  let closed = false
  let ended = false
  let serverExited = false
  const serverOutput: string[] = []

  function outputTail(): string {
    return serverOutput.join('\n')
  }

  function end(error: DeviceError): void {
    if (!started || closed || ended) return
    ended = true
    handlers.onEnded(error)
  }

  async function cleanup(): Promise<void> {
    const sockets = [video, control]
    video = null
    control = null
    for (const socket of sockets) {
      try {
        socket?.destroy()
      } catch {
        // 이미 닫힌 소켓이다. 나머지 정리를 계속한다.
      }
    }

    server?.close()
    server = null

    if (port !== null) {
      const forwarded = port
      port = null
      try {
        await adb.exec(serial, ['forward', '--remove', `tcp:${forwarded}`])
      } catch {
        // 기기가 사라졌으면 forward도 이미 없다.
      }
    }
  }

  async function connectVideo(forwardedPort: number): Promise<{ socket: SessionSocket; first: Buffer }> {
    const deadline = now() + connectTimeoutMs
    for (;;) {
      if (serverExited) {
        throw deviceError('command_failed', 'scrcpy 서버가 연결을 받기 전에 끝났다', '서버 출력을 확인하고 다시 연결해라', {
          serial,
          output: outputTail()
        })
      }

      let socket: SessionSocket | null = null
      try {
        socket = await connect(forwardedPort)
      } catch {
        socket = null
      }

      if (socket) {
        // adb forward는 서버가 listen하기 전에도 연결을 받은 뒤 곧바로 닫는다.
        // 서버가 받은 연결만 dummy byte를 보내므로 첫 바이트가 곧 성공 신호다.
        const first = await firstChunk(socket)
        if (first) return { socket, first }
        socket.destroy()
      }

      if (serverExited) continue
      if (now() >= deadline) {
        throw deviceError('device_unresponsive', `scrcpy 서버가 ${connectTimeoutMs}ms 안에 비디오 소켓을 열지 않았다`, '기기가 완전히 부팅됐는지 확인하고 다시 연결해라', {
          serial,
          output: outputTail()
        })
      }
      await sleep(CONNECT_RETRY_MS)
    }
  }

  async function start(): Promise<void> {
    let resolveReady: () => void = () => {}
    let rejectReady: (error: DeviceError) => void = () => {}
    const ready = new Promise<void>((resolve, reject) => {
      resolveReady = resolve
      rejectReady = reject
    })
    // 기다리기 전에 거부될 수 있다. 처리됨으로 표시만 하고 아래에서 await로 다시 받는다.
    ready.catch(() => {})

    try {
      await adb.exec(serial, ['push', jarPath, DEVICE_JAR_PATH])

      const scid = randomScid()
      const forwarded = await adb.exec(serial, ['forward', 'tcp:0', `localabstract:scrcpy_${scidHex(scid)}`])
      const parsedPort = Number.parseInt(forwarded.stdout.trim(), 10)
      if (!Number.isInteger(parsedPort) || parsedPort <= 0) {
        throw deviceError('command_failed', 'adb forward가 로컬 포트를 돌려주지 않았다', 'adb 버전을 확인해라', {
          stdout: forwarded.stdout
        })
      }
      port = parsedPort

      const serverStream = adb.stream(serial, serverArgs(scid))
      server = serverStream
      serverStream.onLine((line) => {
        serverOutput.push(line)
        if (serverOutput.length > SERVER_OUTPUT_TAIL_LINES) serverOutput.shift()
      })
      // onError 뒤에는 onClose가 반드시 온다. 종료 처리는 onClose 한곳에서 한다.
      serverStream.onError(() => {})
      serverStream.onClose(() => {
        serverExited = true
        const error = deviceError('command_failed', 'scrcpy 서버가 끝났다', '다시 연결해라', { serial, output: outputTail() })
        rejectReady(error)
        end(error)
      })

      const { socket, first } = await connectVideo(parsedPort)
      video = socket
      const parser = createVideoStreamParser({
        onDeviceName: () => {},
        onSession: (width, height) => {
          handlers.onSession(width, height)
          resolveReady()
        },
        onPacket: (packet) => handlers.onPacket(packet),
        onError: (error) => {
          rejectReady(error)
          end(error)
        }
      })
      socket.on('data', (chunk) => parser.push(chunk))
      socket.on('error', () => {})
      socket.on('close', () => {
        const error = deviceError('command_failed', '비디오 스트림이 끊겼다', '다시 연결해라', { serial, output: outputTail() })
        rejectReady(error)
        end(error)
      })
      parser.push(first)

      // 서버는 비디오 연결을 받은 뒤 같은 소켓 이름으로 control 연결을 기다린다.
      const controlSocket = await connect(parsedPort)
      control = controlSocket
      // control 소켓으로 오는 기기 메시지는 쓰지 않지만 읽어야 버퍼가 차지 않는다.
      controlSocket.on('data', () => {})
      controlSocket.on('error', () => {})
      controlSocket.on('close', () => {
        end(deviceError('command_failed', 'control 연결이 끊겼다', '다시 연결해라', { serial }))
      })

      // 기기 이름·codec·첫 session meta는 control 연결까지 받은 뒤에 온다(DesktopConnection.open).
      await ready
      if (closed) throw deviceError('command_failed', '세션이 시작 중에 닫혔다', '다시 연결해라', { serial })
      started = true
    } catch (thrown) {
      await cleanup()
      throw toDeviceError(thrown)
    }
  }

  return {
    serial,
    start,
    sendControl(intent) {
      if (!control || closed) return
      let bytes: Uint8Array
      try {
        bytes = serializeControl(intent)
      } catch {
        // streamManager가 먼저 걸러야 하는 값이다. 여기까지 와도 연결을 깨지 않고 버린다.
        return
      }
      control.write(bytes)
    },
    async close() {
      if (closed) return
      closed = true
      await cleanup()
    }
  }
}
```

- [ ] **Step 4: 테스트가 통과하는지 확인한다**

Run: `npx vitest run src/main/stream/ && npm run typecheck`
Expected: PASS

기한 초과 테스트가 시간이 오래 걸리면 가짜 `sleep`이 시계를 올리는지, `connectVideo`가 매 반복에서
`now() >= deadline`을 보는지 확인한다.

- [ ] **Step 5: 커밋한다**

```bash
git add src/main/stream/scrcpySession.ts src/main/stream/scrcpySession.test.ts
git commit -m "feat(main): scrcpy 세션의 시작과 정리를 더한다

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task 5: streamManager — 세션 교체, 포트, 재시도, 입력 검증

**Files:**
- Create: `src/main/stream/streamManager.ts`
- Test: `src/main/stream/streamManager.test.ts`

**Interfaces:**
- Consumes: `ScrcpySession`, `SessionHandlers` (Task 4), `INJECT_TEXT_MAX_BYTES` (Task 2), `DEVICE_KEYS`, `ControlIntent`,
  `StreamDown`, `StreamPortMeta`, `VideoPoint` (Task 1)
- Produces:
  - `RECONNECT_DELAYS_MS = [1000, 2000, 4000]`
  - `interface PortLike { postMessage(message: StreamDown): void; on(event: 'message', listener: (event: { data: unknown }) => void): unknown; start(): void; close(): void }`
  - `interface StreamManagerDeps { createSession(serial: string, handlers: SessionHandlers): ScrcpySession; createChannel(): { local: PortLike; remote: unknown }; postPort(meta: StreamPortMeta, remote: unknown): void; isConnected(serial: string): boolean; sleep?: (ms: number) => Promise<void>; newSessionId?: () => string }`
  - `interface StreamManager { open(serial: string): Promise<void>; stop(): Promise<void>; handleDisconnect(serial: string): Promise<void> }`
  - `createStreamManager(deps: StreamManagerDeps): StreamManager`
  - `toControlIntent(value: unknown): ControlIntent | null`

- [ ] **Step 1: 실패하는 테스트를 쓴다**

`src/main/stream/streamManager.test.ts`:

```ts
import { describe, expect, it, vi } from 'vitest'
import { deviceError } from '../../shared/types/errors'
import type { StreamDown } from '../../shared/types/stream'
import type { ScrcpySession, SessionHandlers } from './scrcpySession'
import { createStreamManager, RECONNECT_DELAYS_MS, toControlIntent, type PortLike } from './streamManager'

class FakePort implements PortLike {
  readonly sent: StreamDown[] = []
  readonly start = vi.fn()
  readonly close = vi.fn()
  private listener: ((event: { data: unknown }) => void) | null = null
  postMessage(message: StreamDown): void {
    this.sent.push(message)
  }
  on(_event: 'message', listener: (event: { data: unknown }) => void): void {
    this.listener = listener
  }
  receive(data: unknown): void {
    this.listener?.({ data })
  }
  statuses(): string[] {
    return this.sent.flatMap((m) => (m.type === 'status' ? [m.status.state] : []))
  }
}

interface FakeSession extends ScrcpySession {
  handlers: SessionHandlers
  start: ReturnType<typeof vi.fn>
  close: ReturnType<typeof vi.fn>
  sendControl: ReturnType<typeof vi.fn>
}

function harness(opts: { startResults?: Array<'ok' | 'fail'>; connected?: () => boolean } = {}) {
  const results = [...(opts.startResults ?? [])]
  const sessions: FakeSession[] = []
  const ports: FakePort[] = []
  const posted: Array<{ serial: string; sessionId: string }> = []
  let resolveSleep: (() => void) | null = null
  const sleeps: number[] = []
  let id = 0

  const manager = createStreamManager({
    createSession: (serial, handlers) => {
      const outcome = results.shift() ?? 'ok'
      const session: FakeSession = {
        serial,
        handlers,
        start: vi.fn(async () => {
          if (outcome === 'fail') throw deviceError('device_unresponsive', 'no server', 'retry')
        }),
        close: vi.fn(async () => {}),
        sendControl: vi.fn()
      }
      sessions.push(session)
      return session
    },
    createChannel: () => {
      const local = new FakePort()
      ports.push(local)
      return { local, remote: { remoteOf: ports.length - 1 } }
    },
    postPort: (meta) => posted.push(meta),
    isConnected: opts.connected ?? (() => true),
    sleep: (ms) => {
      sleeps.push(ms)
      return new Promise<void>((resolve) => {
        resolveSleep = resolve
      })
    },
    newSessionId: () => `s${(id += 1)}`
  })

  async function wake(): Promise<void> {
    await vi.waitFor(() => expect(resolveSleep).not.toBeNull())
    const resolve = resolveSleep as unknown as () => void
    resolveSleep = null
    resolve()
    await new Promise((r) => setImmediate(r))
  }

  return { manager, sessions, ports, posted, sleeps, wake }
}

const endError = deviceError('command_failed', '비디오 스트림이 끊겼다', '다시 연결해라')

describe('createStreamManager', () => {
  it('sends the port before starting, then reports streaming', async () => {
    const h = harness()

    await h.manager.open('emulator-5554')

    expect(h.posted).toEqual([{ serial: 'emulator-5554', sessionId: 's1' }])
    expect(h.ports[0]?.start).toHaveBeenCalled()
    expect(h.ports[0]?.statuses()).toEqual(['connecting', 'streaming'])
  })

  it('relays session and packet events to the port', async () => {
    const h = harness()
    await h.manager.open('emulator-5554')
    const data = new Uint8Array([1, 2, 3])

    h.sessions[0]?.handlers.onSession(472, 1024)
    h.sessions[0]?.handlers.onPacket({ config: false, key: true, ptsUs: 10, data })

    expect(h.ports[0]?.sent.slice(-2)).toEqual([
      { type: 'session', width: 472, height: 1024 },
      { type: 'packet', config: false, key: true, ptsUs: 10, data }
    ])
  })

  it('closes the previous port and session when opening another device', async () => {
    const h = harness()
    await h.manager.open('emulator-5554')

    await h.manager.open('emulator-5556')

    expect(h.ports[0]?.close).toHaveBeenCalled()
    expect(h.sessions[0]?.close).toHaveBeenCalled()
    expect(h.posted.map((m) => m.serial)).toEqual(['emulator-5554', 'emulator-5556'])
  })

  it('leaves no orphan when a second open arrives before the first finishes', async () => {
    const h = harness()

    await Promise.all([h.manager.open('A'), h.manager.open('B'), h.manager.open('A')])

    const openPorts = h.ports.filter((port) => port.close.mock.calls.length === 0)
    expect(openPorts).toHaveLength(1)
    const liveSessions = h.sessions.filter((session) => session.close.mock.calls.length === 0)
    expect(liveSessions).toHaveLength(1)
    expect(liveSessions[0]?.serial).toBe('A')
  })

  it('reports failed when the first start fails and keeps the port for the message', async () => {
    const h = harness({ startResults: ['fail'] })

    await h.manager.open('emulator-5554')

    expect(h.ports[0]?.statuses()).toEqual(['connecting', 'failed'])
    const failed = h.ports[0]?.sent.at(-1)
    expect(failed).toMatchObject({ status: { state: 'failed', error: { kind: 'device_unresponsive' } } })
    expect(h.ports[0]?.close).not.toHaveBeenCalled()
  })

  it('reconnects with 1s, 2s, 4s backoff and then fails', async () => {
    const h = harness({ startResults: ['ok', 'fail', 'fail', 'fail'] })
    await h.manager.open('emulator-5554')

    h.sessions[0]?.handlers.onEnded(endError)
    await h.wake()
    await h.wake()
    await h.wake()

    await vi.waitFor(() => expect(h.ports[0]?.statuses().at(-1)).toBe('failed'))
    expect(h.sleeps).toEqual([...RECONNECT_DELAYS_MS])
    expect(h.ports[0]?.sent.filter((m) => m.type === 'status' && m.status.state === 'reconnecting')).toHaveLength(3)
    expect(h.sessions[0]?.close).toHaveBeenCalled()
  })

  it('goes back to streaming when a reconnect attempt succeeds and routes input to the new session', async () => {
    const h = harness({ startResults: ['ok', 'fail', 'ok'] })
    await h.manager.open('emulator-5554')

    h.sessions[0]?.handlers.onEnded(endError)
    await h.wake()
    await h.wake()
    await vi.waitFor(() => expect(h.ports[0]?.statuses().at(-1)).toBe('streaming'))

    h.ports[0]?.receive({ type: 'key', key: 'home' })
    expect(h.sessions[2]?.sendControl).toHaveBeenCalledWith({ type: 'key', key: 'home' })
    expect(h.sessions[0]?.sendControl).not.toHaveBeenCalled()
  })

  it('does not reconnect when the device is gone', async () => {
    const h = harness({ connected: () => false })
    await h.manager.open('emulator-5554')

    h.sessions[0]?.handlers.onEnded(endError)

    await vi.waitFor(() => expect(h.ports[0]?.close).toHaveBeenCalled())
    expect(h.sleeps).toEqual([])
    expect(h.sessions).toHaveLength(1)
  })

  it('opens nothing after stop is called during a reconnect wait', async () => {
    const h = harness()
    await h.manager.open('emulator-5554')
    h.sessions[0]?.handlers.onEnded(endError)
    await vi.waitFor(() => expect(h.sleeps).toHaveLength(1))

    await h.manager.stop()
    await h.wake()

    expect(h.sessions).toHaveLength(1)
    expect(h.ports[0]?.close).toHaveBeenCalled()
  })

  it('stops the reconnect loop of the old device when another device opens', async () => {
    const h = harness()
    await h.manager.open('A')
    h.sessions[0]?.handlers.onEnded(endError)
    await vi.waitFor(() => expect(h.sleeps).toHaveLength(1))

    await h.manager.open('B')
    await h.wake()

    expect(h.sessions.map((s) => s.serial)).toEqual(['A', 'B'])
  })

  it('closes on disconnect of the streaming device only', async () => {
    const h = harness()
    await h.manager.open('emulator-5554')

    await h.manager.handleDisconnect('emulator-5556')
    expect(h.ports[0]?.close).not.toHaveBeenCalled()

    await h.manager.handleDisconnect('emulator-5554')
    expect(h.ports[0]?.close).toHaveBeenCalled()
  })

  it('forwards valid input and drops malformed input', async () => {
    const h = harness()
    await h.manager.open('emulator-5554')

    h.ports[0]?.receive({ type: 'key', key: 'home' })
    h.ports[0]?.receive({ type: 'key', key: 'self_destruct' })
    h.ports[0]?.receive('garbage')

    expect(h.sessions[0]?.sendControl).toHaveBeenCalledTimes(1)
  })

  it('ignores stale session events after the device changed', async () => {
    const h = harness()
    await h.manager.open('A')
    const stale = h.sessions[0]
    await h.manager.open('B')

    stale?.handlers.onSession(1, 1)

    expect(h.ports[0]?.sent.some((m) => m.type === 'session')).toBe(false)
    expect(h.ports[1]?.sent.some((m) => m.type === 'session')).toBe(false)
  })
})

describe('toControlIntent', () => {
  const point = { x: 10, y: 20, width: 472, height: 1024 }

  it.each([
    [{ type: 'touch', action: 'down', point }],
    [{ type: 'scroll', point, hScroll: 0, vScroll: -1 }],
    [{ type: 'text', text: 'hello' }],
    [{ type: 'key', key: 'volume_up' }]
  ])('accepts %j', (value) => {
    expect(toControlIntent(value)).toEqual(value)
  })

  it.each([
    [null],
    ['key'],
    [{ type: 'touch', action: 'hover', point }],
    [{ type: 'touch', action: 'down', point: { ...point, x: Number.NaN } }],
    [{ type: 'touch', action: 'down', point: { ...point, width: 0 } }],
    [{ type: 'touch', action: 'down', point: { ...point, height: 70000 } }],
    [{ type: 'scroll', point, hScroll: Infinity, vScroll: 0 }],
    [{ type: 'text', text: '' }],
    [{ type: 'text', text: 'a'.repeat(301) }],
    [{ type: 'text', text: 42 }],
    [{ type: 'key', key: 'toString' }],
    [{ type: 'eval', code: 'x' }]
  ])('rejects %j', (value) => {
    expect(toControlIntent(value)).toBeNull()
  })

  it('drops fields it does not know', () => {
    expect(toControlIntent({ type: 'key', key: 'back', extra: true })).toEqual({ type: 'key', key: 'back' })
  })
})
```

- [ ] **Step 2: 테스트가 실패하는지 확인한다**

Run: `npx vitest run src/main/stream/streamManager.test.ts`
Expected: FAIL — `Cannot find module './streamManager'`

- [ ] **Step 3: 매니저를 쓴다**

`src/main/stream/streamManager.ts`:

```ts
import { randomUUID } from 'node:crypto'
import { isDeviceError, type ToolError } from '../../shared/types/errors'
import {
  DEVICE_KEYS,
  type ControlIntent,
  type DeviceKey,
  type StreamDown,
  type StreamPortMeta,
  type VideoPoint
} from '../../shared/types/stream'
import type { ScrcpySession, SessionHandlers } from './scrcpySession'
import { INJECT_TEXT_MAX_BYTES } from './scrcpyProtocol'

export const RECONNECT_DELAYS_MS = [1000, 2000, 4000] as const

/** MessagePortMain에서 쓰는 부분. index.ts가 실제 포트를 이 모양으로 감싼다. */
export interface PortLike {
  postMessage(message: StreamDown): void
  on(event: 'message', listener: (event: { data: unknown }) => void): unknown
  start(): void
  close(): void
}

export interface StreamManagerDeps {
  createSession(serial: string, handlers: SessionHandlers): ScrcpySession
  /** remote는 renderer로 건넬 반대쪽 포트다. 매니저는 그 내용을 모른다. */
  createChannel(): { local: PortLike; remote: unknown }
  postPort(meta: StreamPortMeta, remote: unknown): void
  isConnected(serial: string): boolean
  sleep?: (ms: number) => Promise<void>
  newSessionId?: () => string
}

export interface StreamManager {
  /** 이전 세션을 닫고 serial로 새 세션을 연다. 실패는 던지지 않고 포트의 status로 알린다. */
  open(serial: string): Promise<void>
  stop(): Promise<void>
  /** 기기가 사라졌을 때. 그 기기의 세션이면 재시도 없이 닫는다. */
  handleDisconnect(serial: string): Promise<void>
}

interface Entry {
  serial: string
  sessionId: string
  port: PortLike
  session: ScrcpySession | null
}

const DEVICE_KEY_SET: ReadonlySet<string> = new Set(DEVICE_KEYS)
const MAX_DIMENSION = 0xffff

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value)
}

function toVideoPoint(value: unknown): VideoPoint | null {
  if (typeof value !== 'object' || value === null) return null
  const { x, y, width, height } = value as Record<string, unknown>
  if (!isFiniteNumber(x) || !isFiniteNumber(y)) return null
  if (!Number.isInteger(width) || !Number.isInteger(height)) return null
  const w = width as number
  const h = height as number
  if (w < 1 || h < 1 || w > MAX_DIMENSION || h > MAX_DIMENSION) return null
  return { x, y, width: w, height: h }
}

/**
 * renderer가 보낸 값을 입력 의도로 바꾼다. 모양이 하나라도 어긋나면 null이다.
 * 모르는 필드는 버리고 새 객체를 만든다 — renderer 입력을 그대로 흘리지 않는다.
 */
export function toControlIntent(value: unknown): ControlIntent | null {
  if (typeof value !== 'object' || value === null) return null
  const record = value as Record<string, unknown>

  switch (record.type) {
    case 'touch': {
      const point = toVideoPoint(record.point)
      const action = record.action
      if (!point || (action !== 'down' && action !== 'move' && action !== 'up')) return null
      return { type: 'touch', action, point }
    }
    case 'scroll': {
      const point = toVideoPoint(record.point)
      if (!point || !isFiniteNumber(record.hScroll) || !isFiniteNumber(record.vScroll)) return null
      return { type: 'scroll', point, hScroll: record.hScroll, vScroll: record.vScroll }
    }
    case 'text': {
      const text = record.text
      if (typeof text !== 'string' || text.length === 0) return null
      if (Buffer.byteLength(text, 'utf8') > INJECT_TEXT_MAX_BYTES) return null
      return { type: 'text', text }
    }
    case 'key': {
      const key = record.key
      if (typeof key !== 'string' || !DEVICE_KEY_SET.has(key)) return null
      return { type: 'key', key: key as DeviceKey }
    }
    default:
      return null
  }
}

function toToolError(thrown: unknown): ToolError {
  if (isDeviceError(thrown)) return thrown.toolError
  return {
    kind: 'command_failed',
    message: thrown instanceof Error ? thrown.message : String(thrown),
    hint: '다시 연결해라'
  }
}

export function createStreamManager(deps: StreamManagerDeps): StreamManager {
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)))
  const newSessionId = deps.newSessionId ?? (() => randomUUID())
  let current: Entry | null = null

  function post(entry: Entry, message: StreamDown): void {
    if (current !== entry) return
    try {
      entry.port.postMessage(message)
    } catch {
      // 창이 닫혀 포트가 끊겼다. 다음 open이나 stop이 정리한다.
    }
  }

  async function closeEntry(entry: Entry): Promise<void> {
    try {
      entry.port.close()
    } catch {
      // 이미 닫힌 포트다.
    }
    const session = entry.session
    entry.session = null
    await session?.close()
  }

  async function closeIfCurrent(entry: Entry): Promise<void> {
    if (current !== entry) return
    current = null
    await closeEntry(entry)
  }

  function handlersFor(entry: Entry): SessionHandlers {
    return {
      onSession: (width, height) => post(entry, { type: 'session', width, height }),
      onPacket: (packet) =>
        post(entry, { type: 'packet', config: packet.config, key: packet.key, ptsUs: packet.ptsUs, data: packet.data }),
      onEnded: (error) => void recover(entry, error.toolError)
    }
  }

  /** 세션 하나를 시작한다. 실패하면 던진다. 시작하는 사이 기기가 바뀌었으면 조용히 닫는다. */
  async function startSession(entry: Entry): Promise<void> {
    const session = deps.createSession(entry.serial, handlersFor(entry))
    // start()는 실패하면 스스로 정리하고 던진다.
    await session.start()
    if (current !== entry) {
      await session.close()
      return
    }
    entry.session = session
    post(entry, { type: 'status', status: { state: 'streaming' } })
  }

  async function recover(entry: Entry, reason: ToolError): Promise<void> {
    if (current !== entry) return
    const ended = entry.session
    entry.session = null
    await ended?.close()

    let lastError = reason
    for (let attempt = 1; attempt <= RECONNECT_DELAYS_MS.length; attempt += 1) {
      if (current !== entry) return
      if (!deps.isConnected(entry.serial)) {
        await closeIfCurrent(entry)
        return
      }
      post(entry, { type: 'status', status: { state: 'reconnecting', attempt } })
      await sleep(RECONNECT_DELAYS_MS[attempt - 1] as number)
      if (current !== entry) return
      try {
        await startSession(entry)
        return
      } catch (thrown) {
        lastError = toToolError(thrown)
      }
    }
    post(entry, { type: 'status', status: { state: 'failed', error: lastError } })
  }

  return {
    async open(serial) {
      // current를 await보다 먼저 바꾼다. 앞선 open이 아직 끝나지 않았어도 그 entry는
      // 더 이상 current가 아니므로 post·startSession이 스스로 물러난다.
      const previous = current
      const channel = deps.createChannel()
      const entry: Entry = { serial, sessionId: newSessionId(), port: channel.local, session: null }
      current = entry
      if (previous) await closeEntry(previous)
      if (current !== entry) {
        // 이전 세션을 닫는 사이 또 다른 open이 왔다. 이 포트는 renderer에 보내지도 않고 닫는다.
        channel.local.close()
        return
      }

      channel.local.on('message', (event) => {
        const intent = toControlIntent(event.data)
        if (intent && current === entry) entry.session?.sendControl(intent)
      })
      channel.local.start()
      // 시작 실패도 이 포트로 알리므로 세션보다 먼저 보낸다.
      deps.postPort({ serial, sessionId: entry.sessionId }, channel.remote)
      post(entry, { type: 'status', status: { state: 'connecting' } })

      try {
        await startSession(entry)
      } catch (thrown) {
        post(entry, { type: 'status', status: { state: 'failed', error: toToolError(thrown) } })
      }
    },

    async stop() {
      const entry = current
      current = null
      if (entry) await closeEntry(entry)
    },

    async handleDisconnect(serial) {
      if (current?.serial === serial) await closeIfCurrent(current)
    }
  }
}
```

- [ ] **Step 4: 테스트가 통과하는지 확인한다**

Run: `npx vitest run src/main/stream/ && npm run typecheck`
Expected: PASS

- [ ] **Step 5: 커밋한다**

```bash
git add src/main/stream/streamManager.ts src/main/stream/streamManager.test.ts
git commit -m "feat(main): 스트림 세션 교체·재시도·입력 검증을 맡는 streamManager를 더한다

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task 6: IPC·preload·main 조립

**Files:**
- Modify: `src/shared/types/ipc.ts`
- Modify: `src/preload/index.ts`, `src/preload/index.test.ts`
- Modify: `src/main/app/ipcBridge.ts`, `src/main/app/ipcBridge.test.ts`
- Modify: `src/main/app/bootstrap.ts`, `src/main/app/bootstrap.test.ts`
- Modify: `src/main/index.ts`

**Interfaces:**
- Consumes: `StreamManager`, `createStreamManager`, `PortLike` (Task 5), `createScrcpySession`, `connectLoopback` (Task 4),
  `resolveScrcpyJar` (Task 3), `StreamPortMeta` (Task 1)
- Produces:
  - `IPC_CHANNELS.startStream = 'app:start-stream'`, `IPC_CHANNELS.stopStream = 'app:stop-stream'`, `IPC_CHANNELS.streamPort = 'app:stream-port'`
  - `RendererApi.startStream(serial: string): Promise<Outcome<void>>`, `RendererApi.stopStream(): Promise<Outcome<void>>`
  - preload가 main world로 보내는 메시지: `window.postMessage({ channel: 'app:stream-port', serial, sessionId }, '*', [port])`
  - `BridgeActions.startStream(serial: string): Promise<void>`, `BridgeActions.stopStream(): Promise<void>`
  - `BootstrapDeps.createStreamManager: (registry: DeviceRegistry, paths: SdkPaths) => StreamManager`

- [ ] **Step 1: 실패하는 테스트를 쓴다 — preload**

`src/preload/index.test.ts`에서 화이트리스트 목록과 라우팅 표를 고치고, 포트 전달 테스트를 더한다.

```ts
    expect(Object.keys(api).sort()).toEqual(
      ['bootAvd', 'captureScreenshot', 'getSnapshot', 'onEvent', 'selectDevice', 'shutdownDevice', 'startStream', 'stopStream'].sort()
    )
```

```ts
    ['captureScreenshot', IPC_CHANNELS.captureScreenshot, ['emulator-5554']],
    ['startStream', IPC_CHANNELS.startStream, ['emulator-5554']],
    ['stopStream', IPC_CHANNELS.stopStream, []]
```

파일 끝에 더한다.

```ts
describe('stream port forwarding', () => {
  function portListener(): (event: { ports: unknown[] }, meta: unknown) => void {
    const call = on.mock.calls.find((args) => args[0] === IPC_CHANNELS.streamPort)
    return call?.[1] as (event: { ports: unknown[] }, meta: unknown) => void
  }

  it('hands a stream port to the main world with its meta', async () => {
    const postMessage = vi.fn()
    vi.stubGlobal('window', { postMessage })
    await loadPreload()
    const port = { fake: 'port' }

    portListener()({ ports: [port] }, { serial: 'emulator-5554', sessionId: 's1' })

    expect(postMessage).toHaveBeenCalledWith(
      { channel: IPC_CHANNELS.streamPort, serial: 'emulator-5554', sessionId: 's1' },
      '*',
      [port]
    )
    vi.unstubAllGlobals()
  })

  it('forwards nothing when the message carries no single port', async () => {
    const postMessage = vi.fn()
    vi.stubGlobal('window', { postMessage })
    await loadPreload()

    portListener()({ ports: [] }, { serial: 'emulator-5554', sessionId: 's1' })
    portListener()({ ports: [{}, {}] }, { serial: 'emulator-5554', sessionId: 's1' })

    expect(postMessage).not.toHaveBeenCalled()
    vi.unstubAllGlobals()
  })
})
```

`loadPreload()`가 모듈을 다시 불러오므로 `on`이 여러 번 불린다. `portListener()`는 첫 호출을 쓰지만 모두 같은 함수
코드이므로 결과가 같다. 헷갈리면 `beforeEach`에서 `on.mockClear()`가 이미 도는지 확인한다(기존 `beforeEach`가 한다).

- [ ] **Step 2: 실패하는 테스트를 쓴다 — ipcBridge와 bootstrap**

`src/main/app/ipcBridge.test.ts`의 가짜 `actions`에 `startStream: vi.fn(async () => {})`, `stopStream: vi.fn(async () => {})`를
더하고, 등록 채널 목록 기대값에 `IPC_CHANNELS.startStream`, `IPC_CHANNELS.stopStream`을 더한다. 테스트를 더한다.

```ts
  it('routes startStream with a serial and rejects a missing one', async () => {
    const h = harness()
    const handler = h.handlers.get(IPC_CHANNELS.startStream)!

    await expect(handler({}, 'emulator-5554')).resolves.toEqual({ ok: true, value: undefined })
    expect(h.actions.startStream).toHaveBeenCalledWith('emulator-5554')

    const rejected = (await handler({}, 42)) as { ok: boolean }
    expect(rejected.ok).toBe(false)
  })

  it('routes stopStream without arguments', async () => {
    const h = harness()

    await h.handlers.get(IPC_CHANNELS.stopStream)!({})

    expect(h.actions.stopStream).toHaveBeenCalledTimes(1)
  })
```

`src/main/app/bootstrap.test.ts`의 `harness`에 가짜 스트림 매니저를 더한다.

```ts
  const stream = {
    open: vi.fn(async () => {}),
    stop: vi.fn(async () => {}),
    handleDisconnect: vi.fn(async () => {})
  }
```

`deps`에 `createStreamManager: vi.fn(() => stream)`을 넣고 `harness`의 반환값에 `stream`을 더한다. 테스트를 더한다.

```ts
  it('starts a stream for a known serial', async () => {
    const h = harness()
    await bootstrapApp(h.deps)

    const result = await h.invoke<Outcome<void>>(IPC_CHANNELS.startStream, 'emulator-5554')

    expect(result.ok).toBe(true)
    expect(h.stream.open).toHaveBeenCalledWith('emulator-5554')
  })

  it('refuses a stream for a serial the registry does not know', async () => {
    const h = harness()
    ;(h.stack.registry.resolve as ReturnType<typeof vi.fn>).mockImplementation(() => {
      throw deviceError('no_device', 'gone', 'x')
    })
    await bootstrapApp(h.deps)

    const result = await h.invoke<Outcome<void>>(IPC_CHANNELS.startStream, 'emulator-9999')

    expect(result.ok).toBe(false)
    expect(h.stream.open).not.toHaveBeenCalled()
  })

  it('closes the stream when its device disconnects', async () => {
    const h = harness()
    await bootstrapApp(h.deps)

    h.fireRegistry({ type: 'device_disconnected', serial: 'emulator-5554' })

    expect(h.stream.handleDisconnect).toHaveBeenCalledWith('emulator-5554')
  })

  it('stops the stream on shutdown', async () => {
    const h = harness()
    const app = await bootstrapApp(h.deps)

    await app.stop()

    expect(h.stream.stop).toHaveBeenCalled()
  })

  it('refuses a stream without an SDK and never builds a stream manager', async () => {
    const h = harness({ located: missing })
    await bootstrapApp(h.deps)

    const result = await h.invoke<Outcome<void>>(IPC_CHANNELS.startStream, 'emulator-5554')

    expect(result.ok).toBe(false)
    expect(h.deps.createStreamManager).not.toHaveBeenCalled()
  })
```

하네스에는 이미 `invoke<T>(channel, ...args)`가 있다. `fireRegistry(event)`를 더한다 — `registry.on`에 등록된
모든 리스너를 부른다. `harness` 안에서 `stack`을 만든 뒤 가짜 `on`을 리스너를 모으는 구현으로 바꾸고, 반환값에
`stream`과 `fireRegistry`를 더한다.

```ts
  const registryListeners: Array<(event: unknown) => void> = []
  ;(stack.registry.on as ReturnType<typeof vi.fn>).mockImplementation((listener: (event: unknown) => void) => {
    registryListeners.push(listener)
    return () => {}
  })
  // ...
  fireRegistry: (event: unknown) => registryListeners.forEach((listener) => listener(event)),
```

`deviceError` import가 없으면 `../../shared/types/errors`에서 더한다.

- [ ] **Step 3: 테스트가 실패하는지 확인한다**

Run: `npx vitest run src/preload src/main/app`
Expected: FAIL — `startStream`이 없다

- [ ] **Step 4: IPC 타입과 preload를 고친다**

`src/shared/types/ipc.ts`:

```ts
export const IPC_CHANNELS = {
  getSnapshot: 'app:get-snapshot',
  selectDevice: 'app:select-device',
  bootAvd: 'app:boot-avd',
  shutdownDevice: 'app:shutdown-device',
  captureScreenshot: 'app:capture-screenshot',
  startStream: 'app:start-stream',
  stopStream: 'app:stop-stream',
  /** main → renderer. 스트림 포트 하나를 싣는다. preload가 main world로 다시 건넨다. */
  streamPort: 'app:stream-port',
  event: 'app:event'
} as const
```

`RendererApi`에 더한다.

```ts
  /** 이 기기로 스트림을 연다. 이전 스트림은 main이 닫는다. 포트는 IPC_CHANNELS.streamPort로 따로 온다. */
  startStream(serial: string): Promise<Outcome<void>>
  stopStream(): Promise<Outcome<void>>
```

`src/preload/index.ts`의 import에 `type StreamPortMeta`(`../shared/types/stream`)를 더하고, `api`에 두 메서드를 더한다.

```ts
  startStream: (serial) => ipcRenderer.invoke(IPC_CHANNELS.startStream, serial) as Promise<Outcome<void>>,
  stopStream: () => ipcRenderer.invoke(IPC_CHANNELS.stopStream) as Promise<Outcome<void>>,
```

`contextBridge.exposeInMainWorld` 호출 위에 더한다.

```ts
/**
 * MessagePort는 contextBridge를 넘지 못한다. Electron 문서의 방식대로 window.postMessage로
 * main world에 건넨다. renderer의 streamPort.ts가 channel·출처·포트 개수를 보고 받는다.
 * 여기서는 포트가 정확히 하나일 때만 넘긴다 — 이 채널이 범용 포트 통로가 되지 않게 한다.
 */
ipcRenderer.on(IPC_CHANNELS.streamPort, (event: IpcRendererEvent, meta: StreamPortMeta) => {
  if (event.ports.length !== 1) return
  window.postMessage({ channel: IPC_CHANNELS.streamPort, serial: meta.serial, sessionId: meta.sessionId }, '*', [...event.ports])
})
```

- [ ] **Step 5: ipcBridge와 bootstrap을 고친다**

`src/main/app/ipcBridge.ts`의 `BridgeActions`에 더한다.

```ts
  startStream(serial: string): Promise<void>
  stopStream(): Promise<void>
```

`registerIpcBridge`에 더한다.

```ts
  ipcMain.handle(IPC_CHANNELS.startStream, withText('serial', (serial) => actions.startStream(serial)))
  ipcMain.handle(IPC_CHANNELS.stopStream, () => outcome(() => actions.stopStream()))
```

`src/main/app/bootstrap.ts`:

- import에 `type StreamManager`(`../stream/streamManager`)와 `type DeviceRegistry`를 더한다(`DeviceRegistry`는 이미 있다).
- `BootstrapDeps`에 더한다.

```ts
  /** 화면 스트림 세션을 관리한다. 실제 adb·소켓·Electron 포트에 닿으므로 테스트에서 가짜로 바꾼다. */
  createStreamManager: (registry: DeviceRegistry, paths: SdkPaths) => StreamManager
```

- `assembleWithoutSdk`의 `actions`에 `startStream: reject`, `stopStream: async () => {}`를 더한다.
- `bootstrapApp`의 SDK 경로에서 `registry.start()` 앞에 스트림을 만들고 연결 해제를 잇는다.

```ts
  const stream = deps.createStreamManager(registry, located.paths)
  // 기기가 사라지면 그 기기의 스트림은 재시도하지 않고 닫는다. 재시도 루프의 isConnected
  // 확인만으로는 대기 시간만큼 늦게 닫힌다.
  registry.on((event) => {
    if (event.type === 'device_disconnected') void stream.handleDisconnect(event.serial)
  })
```

- `registerIpcBridge`에 넘기는 액션에 더한다.

```ts
      startStream: async (serial) => {
        // 모르는 serial이면 여기서 no_device로 끝낸다. 세션을 열어 adb가 실패하기를 기다리지 않는다.
        registry.resolve(serial)
        await stream.open(serial)
      },
      stopStream: () => stream.stop(),
```

- `stop()`의 첫 줄에 `await stream.stop()`을 더한다.

- [ ] **Step 6: index.ts에서 실제 부품을 잇는다**

`src/main/index.ts`의 import에 더한다.

```ts
import { app, BrowserWindow, dialog, ipcMain, MessageChannelMain, nativeTheme } from 'electron'
import { IPC_CHANNELS } from '../shared/types/ipc'
import { resolveScrcpyJar } from './stream/scrcpyJar'
import { connectLoopback, createScrcpySession } from './stream/scrcpySession'
import { createStreamManager } from './stream/streamManager'
```

`bootstrapApp` 인자에 `createStreamManager`를 더한다.

```ts
      createStreamManager: (registry, paths) => {
        const adb = createAdbClient(paths.adb)
        const jarPath = resolveScrcpyJar({
          isPackaged: app.isPackaged,
          resourcesPath: process.resourcesPath,
          appPath: app.getAppPath()
        })
        return createStreamManager({
          createSession: (serial, handlers) => createScrcpySession({ serial, adb, jarPath, connect: connectLoopback }, handlers),
          createChannel: () => {
            const { port1, port2 } = new MessageChannelMain()
            return {
              local: {
                postMessage: (message) => port1.postMessage(message),
                on: (_event, listener) => port1.on('message', (event) => listener({ data: event.data })),
                start: () => port1.start(),
                close: () => port1.close()
              },
              remote: port2
            }
          },
          postPort: (meta, remote) => {
            if (window && !window.isDestroyed()) {
              window.webContents.postMessage(IPC_CHANNELS.streamPort, meta, [remote as Electron.MessagePortMain])
            }
          },
          isConnected: (serial) => registry.serials().includes(serial)
        })
      },
```

- [ ] **Step 7: 테스트와 타입 검사, 빌드를 돌린다**

Run: `npm test && npm run typecheck && npm run build`
Expected: PASS, 빌드 성공

- [ ] **Step 8: 커밋한다**

```bash
git add src/shared/types/ipc.ts src/preload src/main/app src/main/index.ts
git commit -m "feat(main): startStream·stopStream IPC와 스트림 포트 전달을 잇는다

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task 7: 실제 에뮬레이터로 세션을 확인한다

**Files:**
- Create: `src/main/stream/scrcpySession.integration.test.ts`
- Modify: `docs/superpowers/specs/2026-09-23-m2-live-streaming.md` (frontmatter `related_plan`, `status`)

**Interfaces:**
- Consumes: `createScrcpySession`, `connectLoopback` (Task 4), `resolveScrcpyJar` (Task 3), `createAdbClient`, `locateSdk`, `parseDevices`

- [ ] **Step 1: 통합 테스트를 쓴다**

에뮬레이터가 하나 이상 떠 있어야 한다. 없으면 `emulator -avd <이름>`으로 먼저 띄운다.

`src/main/stream/scrcpySession.integration.test.ts`:

```ts
import { beforeAll, describe, expect, it, vi } from 'vitest'
import { createAdbClient, type AdbClient } from '../adb/adbClient'
import { parseDevices } from '../device/parsers/devices'
import { defaultLocateSdkDeps, locateSdk } from '../sdk/locateSdk'
import { resolveScrcpyJar } from './scrcpyJar'
import { connectLoopback, createScrcpySession } from './scrcpySession'
import type { VideoPacket } from './scrcpyProtocol'

let adb: AdbClient
let serial: string
const jarPath = resolveScrcpyJar({ isPackaged: false, resourcesPath: '', appPath: process.cwd() })

async function topActivity(): Promise<string> {
  const { stdout } = await adb.exec(serial, ['shell', 'dumpsys', 'activity', 'activities'])
  return stdout.split('\n').find((line) => /topResumedActivity|mResumedActivity/.test(line)) ?? ''
}

beforeAll(async () => {
  const located = locateSdk(defaultLocateSdkDeps())
  if (!located.ok) throw new Error(`Android SDK를 찾지 못했다: ${located.searched.join(', ')}`)
  adb = createAdbClient(located.paths.adb)
  const devices = parseDevices((await adb.exec(null, ['devices'])).stdout).filter((d) => d.state === 'device')
  if (devices.length === 0) throw new Error('실행 중인 기기가 없다. 에뮬레이터를 먼저 띄워라')
  serial = devices[0]!.serial
})

describe('scrcpy session on a real device', () => {
  it('streams a key frame, injects HOME and leaves no forward behind', async () => {
    const packets: VideoPacket[] = []
    const sessions: Array<[number, number]> = []
    const onEnded = vi.fn()
    const session = createScrcpySession(
      { serial, adb, jarPath, connect: connectLoopback },
      { onSession: (w, h) => sessions.push([w, h]), onPacket: (p) => packets.push(p), onEnded }
    )

    await session.start()
    await vi.waitFor(() => expect(packets.some((p) => p.key)).toBe(true), { timeout: 15_000 })
    expect(packets[0]?.config).toBe(true)
    expect(Math.max(...(sessions[0] ?? [0]))).toBeLessThanOrEqual(1024)

    await adb.exec(serial, ['shell', 'am', 'start', '-a', 'android.settings.SETTINGS'])
    await vi.waitFor(async () => expect(await topActivity()).toMatch(/settings/i), { timeout: 10_000 })

    session.sendControl({ type: 'key', key: 'home' })
    await vi.waitFor(async () => expect(await topActivity()).toMatch(/launcher/i), { timeout: 10_000 })

    await session.close()
    const { stdout } = await adb.exec(null, ['forward', '--list'])
    expect(stdout).not.toMatch(/localabstract:scrcpy_/)
    expect(onEnded).not.toHaveBeenCalled()
  })
})
```

- [ ] **Step 2: 통합 테스트를 돌린다**

Run: `npm run test:integration -- src/main/stream/scrcpySession.integration.test.ts`
Expected: PASS

실패하면 추측으로 고치지 않는다. 서버 출력은 `start()`가 던진 에러의 `details.output`에 있다. 첫 인자 버전 불일치,
`scid` 형식, 소켓 연결 순서를 v4.1 소스(`Server.java`, `Options.java`, `DesktopConnection.java`)와 대조한다.
런처 액티비티 이름이 `launcher`를 포함하지 않는 이미지라면 `topActivity()` 출력을 보고 정규식을 그 이미지에 맞춘다.

- [ ] **Step 3: 스펙 상태를 올린다**

`docs/superpowers/specs/2026-09-23-m2-live-streaming.md`의 frontmatter에서 `status: draft`를 `status: in-progress`로 바꾼다.

Run: `python3 docs/script/docs.py lint && python3 docs/script/docs.py links`
Expected: 문제 0건

- [ ] **Step 4: 전체 테스트를 돌리고 커밋한다**

Run: `npm test && npm run typecheck`
Expected: PASS

```bash
git add src/main/stream/scrcpySession.integration.test.ts docs/superpowers/specs/2026-09-23-m2-live-streaming.md
git commit -m "test(main): 실제 에뮬레이터로 scrcpy 세션의 스트림·입력·정리를 확인한다

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```
