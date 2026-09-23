---
id: m2-2-renderer-stream          # 파일명에서 날짜 접두사를 뺀 slug
title: M2-2 — renderer 스트리밍 화면과 사람 입력
status: draft                   # draft | in-progress | done | abandoned | superseded
type: work-order                # work-order | handoff
created: 2026-09-23
updated: 2026-09-23
owner: virtual-device-helper 팀
scope: [renderer, streaming, shared]
hosts: []                       # windows | macos — 호스트 OS마다 작업이 갈릴 때만 채운다
archived_reason:                # done/abandoned 시 사유 (활성 계획은 비움)
related_adr: [ADR-0002, ADR-0010]
related_spec: m2-live-streaming
related_architecture:
related_plan: [m2-1-stream-core, m2-3-gesture-overlay]
related_code: [streamDecoder.ts#createStreamDecoder, inputMapper.ts#toVideoPoint, useScrcpyStream.ts#useScrcpyStream, DeviceScreen.tsx#DeviceScreen]
tags: [plan, streaming, webcodecs, renderer]
---

# M2-2 — renderer 스트리밍 화면과 사람 입력 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: `superpowers:subagent-driven-development`(권장) 또는
> `superpowers:executing-plans`로 task 단위 구현. 각 단계는 체크박스(`- [ ]`)로 추적한다.

**Goal:** 기기 화면 영역이 main의 스트림 포트를 받아 WebCodecs로 실시간 화면을 그리고, 마우스·휠·키보드·툴바 입력을
기기로 보내며, 스트림이 끝내 실패하면 M1의 스크린샷 화면으로 강등된다.

**Architecture:** 순수 모듈 세 개(`h264.ts`, `inputMapper.ts`, `streamPort.ts`)와 `VideoDecoder`를 감싼
`streamDecoder.ts`를 먼저 만들고, `useScrcpyStream` 훅이 이들을 포트·캔버스와 잇는다. `DeviceScreen`은 바깥 props를
그대로 두고 안쪽만 캔버스·상태 표시·툴바로 바꾼다. M1의 스크린샷 화면은 `ScreenshotView`로 떼어 강등 화면으로 쓴다.

**Tech Stack:** TypeScript, React 19, WebCodecs(`VideoDecoder`, `EncodedVideoChunk`), Vitest, @testing-library/react, jsdom

**Spec:** [`../specs/2026-09-23-m2-live-streaming.md`](../specs/2026-09-23-m2-live-streaming.md)

**선행 조건:** [M2-1](2026-09-23-m2-1-stream-core.md)이 끝나 있어야 한다. 이 계획은 M2-1이 만든
`src/shared/types/stream.ts`, `IPC_CHANNELS.streamPort`, `RendererApi.startStream`·`stopStream`을 쓴다.

## Global Constraints

- 답변·주석·문서는 한국어로 쓴다. 기술 용어·API 이름·명령어·에러 문자열은 원문 그대로 둔다.
- renderer는 scrcpy 바이트 포맷을 모른다. 입력은 `ControlIntent`로만 보내고, 직렬화는 main이 한다.
- `DeviceScreen`의 props는 `{ serial: string | null }` 그대로다. `App`은 고치지 않는다.
- 브라우저 전역(`window.api`, `VideoDecoder`, `EncodedVideoChunk`)은 기본 의존성 한 곳에서만 만진다.
  테스트는 의존성을 주입하거나 훅을 mock한다. jsdom에는 WebCodecs가 없다.
- 새 npm 의존성을 들이지 않는다.
- 스타일은 `app.css`의 기존 토큰(`--surface`, `--border`, `--text-muted`, `--focus`, `--space-*`, `--radius-sm` 등)만 쓴다.
- 텍스트 입력은 인쇄 가능한 ASCII(`0x20`–`0x7e`)만 보낸다. IME 조합 중(`isComposing`)인 키는 보내지 않는다.
- 각 task 끝에서 `npm test`와 `npm run typecheck`가 통과해야 한다.
- 기존 테스트가 쓰는 텍스트·role·aria가 바뀌면 그 테스트를 같은 task에서 고친다.
- 문서에는 라인번호, 파일·툴 개수, 진행률을 적지 않는다. 파일명과 심볼명으로 가리킨다.
- 커밋 메시지는 한국어 Conventional Commits(`feat(renderer): ...한다`)이고, 끝에 다음 줄을 붙인다:
  `Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>`

## Review Focus

- **드래그 중 포인터가 캔버스 밖으로 나감**: 손을 뗀 위치가 여백이어도 `up`이 가야 한다. 안 가면 기기에 터치가 눌린 채 남는다. → Task 2(clamp)와 Task 6 테스트.
- **디코더가 밀림**: 느린 머신에서 큐가 쌓이면 delta를 버리고 다음 키프레임부터 다시 그려야 한다. 지연이 계속 늘면 안 된다. → Task 3 테스트.
- **기기 전환 직후 이전 기기의 포트가 늦게 도착**: 다른 serial의 포트는 닫고 쓰지 않아야 한다. → Task 4 테스트.
- **한글 입력기 켠 채 타이핑**: 조합 중 키를 ASCII로 오인해 보내면 안 된다. → Task 2 테스트.
- **Cmd·Ctrl 단축키**: 캔버스에 포커스가 있어도 Cmd+R, Cmd+C 같은 호스트 단축키를 기기 텍스트로 가로채지 않아야 한다. → Task 2 테스트.

---

### Task 1: 포트 수신과 codec 문자열

**Files:**
- Create: `src/renderer/src/stream/streamPort.ts`
- Create: `src/renderer/src/stream/h264.ts`
- Test: `src/renderer/src/stream/streamPort.test.ts`, `src/renderer/src/stream/h264.test.ts`

**Interfaces:**
- Consumes: `IPC_CHANNELS.streamPort`, `StreamPortMeta` (M2-1)
- Produces:
  - `interface MessageTarget { addEventListener(type: 'message', listener: (event: MessageEvent) => void): void; removeEventListener(type: 'message', listener: (event: MessageEvent) => void): void }`
  - `onStreamPort(callback: (meta: StreamPortMeta, port: MessagePort) => void, target?: MessageTarget): () => void`
  - `codecFromConfig(config: Uint8Array): string | null`

- [ ] **Step 1: 실패하는 테스트를 쓴다**

`src/renderer/src/stream/streamPort.test.ts`:

```ts
import { describe, expect, it, vi } from 'vitest'
import { IPC_CHANNELS } from '../../../shared/types/ipc'
import { onStreamPort, type MessageTarget } from './streamPort'

function fakeTarget() {
  let listener: ((event: MessageEvent) => void) | null = null
  const target: MessageTarget = {
    addEventListener: (_type, l) => {
      listener = l
    },
    removeEventListener: vi.fn(() => {
      listener = null
    })
  }
  const dispatch = (event: Partial<MessageEvent>) => listener?.(event as MessageEvent)
  return { target, dispatch, isListening: () => listener !== null }
}

const data = { channel: IPC_CHANNELS.streamPort, serial: 'emulator-5554', sessionId: 's1' }

describe('onStreamPort', () => {
  it('hands over the port and meta posted by our preload', () => {
    const t = fakeTarget()
    const callback = vi.fn()
    const port = {} as MessagePort
    onStreamPort(callback, t.target)

    t.dispatch({ source: t.target as unknown as Window, data, ports: [port] })

    expect(callback).toHaveBeenCalledWith({ serial: 'emulator-5554', sessionId: 's1' }, port)
  })

  it.each([
    ['another source', { source: {} as Window, data, ports: [{} as MessagePort] }],
    ['another channel', { data: { ...data, channel: 'x' }, ports: [{} as MessagePort] }],
    ['no port', { data, ports: [] }],
    ['two ports', { data, ports: [{} as MessagePort, {} as MessagePort] }],
    ['a missing serial', { data: { channel: data.channel, sessionId: 's1' }, ports: [{} as MessagePort] }],
    ['a non-object payload', { data: 'hello', ports: [{} as MessagePort] }]
  ])('ignores a message from %s', (_name, event) => {
    const t = fakeTarget()
    const callback = vi.fn()
    onStreamPort(callback, t.target)

    t.dispatch({ source: t.target as unknown as Window, ...event })

    expect(callback).not.toHaveBeenCalled()
  })

  it('stops listening when unsubscribed', () => {
    const t = fakeTarget()
    const stop = onStreamPort(vi.fn(), t.target)

    stop()

    expect(t.isListening()).toBe(false)
  })
})
```

`src/renderer/src/stream/h264.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import { codecFromConfig } from './h264'

/** 실제 v4.1 서버가 보낸 config 패킷(M1 스파이크 fixture의 93번째 바이트부터 38바이트): SPS + PPS */
const REAL_CONFIG = Uint8Array.from(
  Buffer.from('0000000167640020acb40f0103cbcd4040405004c4b4023c346000f142aa0000000168ee0d8b', 'hex')
)

describe('codecFromConfig', () => {
  it('builds the avc1 string from the SPS of a real config packet', () => {
    expect(codecFromConfig(REAL_CONFIG)).toBe('avc1.640020')
  })

  it('reads a 3-byte start code too', () => {
    expect(codecFromConfig(Uint8Array.from([0, 0, 1, 0x67, 0x42, 0xc0, 0x1f, 0xff]))).toBe('avc1.42c01f')
  })

  it('returns null when there is no SPS', () => {
    expect(codecFromConfig(Uint8Array.from([0, 0, 0, 1, 0x68, 0xee, 0x0d, 0x8b]))).toBeNull()
  })

  it('returns null when the SPS is cut short', () => {
    expect(codecFromConfig(Uint8Array.from([0, 0, 0, 1, 0x67, 0x64]))).toBeNull()
  })
})
```

`Buffer`는 테스트 파일에서만 쓴다. vitest는 node 위에서 돌므로 전역에 있다. 타입 검사에서 `Buffer`를 못 찾으면
hex 문자열을 `Uint8Array.from(hex.match(/../g)!.map((b) => parseInt(b, 16)))`로 바꾼다.

- [ ] **Step 2: 테스트가 실패하는지 확인한다**

Run: `npx vitest run src/renderer/src/stream`
Expected: FAIL — 모듈이 없다

- [ ] **Step 3: 구현한다**

`src/renderer/src/stream/streamPort.ts`:

```ts
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
```

`src/renderer/src/stream/h264.ts`:

```ts
const NAL_TYPE_SPS = 7

function hex(value: number): string {
  return value.toString(16).padStart(2, '0')
}

/**
 * config 패킷(Annex-B)에서 SPS를 찾아 WebCodecs codec 문자열 `avc1.PPCCLL`을 만든다.
 * NAL 헤더 다음 세 바이트가 profile_idc·constraint_flags·level_idc다. 해상도는 여기서
 * 읽지 않는다 — 서버의 session meta가 알려 준다.
 */
export function codecFromConfig(config: Uint8Array): string | null {
  for (let i = 0; i + 2 < config.length; i += 1) {
    if (config[i] !== 0 || config[i + 1] !== 0) continue

    let nal = -1
    if (config[i + 2] === 1) nal = i + 3
    else if (config[i + 2] === 0 && config[i + 3] === 1) nal = i + 4
    if (nal < 0 || nal + 3 >= config.length) continue

    if (((config[nal] as number) & 0x1f) !== NAL_TYPE_SPS) continue
    return `avc1.${hex(config[nal + 1] as number)}${hex(config[nal + 2] as number)}${hex(config[nal + 3] as number)}`
  }
  return null
}
```

- [ ] **Step 4: 테스트가 통과하는지 확인한다**

Run: `npx vitest run src/renderer/src/stream && npm run typecheck`
Expected: PASS

- [ ] **Step 5: 커밋한다**

```bash
git add src/renderer/src/stream/
git commit -m "feat(renderer): 스트림 포트 수신과 SPS codec 문자열 추출을 더한다

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task 2: inputMapper — 좌표·휠·키를 입력 의도로

**Files:**
- Create: `src/renderer/src/stream/inputMapper.ts`
- Test: `src/renderer/src/stream/inputMapper.test.ts`

**Interfaces:**
- Consumes: `VideoPoint`, `ControlIntent`, `DeviceKey` (M2-1)
- Produces:
  - `interface Rect { left: number; top: number; width: number; height: number }`
  - `interface VideoSize { width: number; height: number }`
  - `toVideoPoint(clientX: number, clientY: number, rect: Rect, video: VideoSize, opts?: { clamp?: boolean }): VideoPoint | null`
  - `wheelToScroll(deltaX: number, deltaY: number, deltaMode: number): { hScroll: number; vScroll: number } | null`
  - `interface KeyInput { key: string; isComposing: boolean; ctrlKey: boolean; metaKey: boolean; altKey: boolean }`
  - `keyToIntent(event: KeyInput): ControlIntent | null`

- [ ] **Step 1: 실패하는 테스트를 쓴다**

`src/renderer/src/stream/inputMapper.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import { keyToIntent, toVideoPoint, wheelToScroll, type KeyInput } from './inputMapper'

const video = { width: 472, height: 1024 }

describe('toVideoPoint', () => {
  it('scales a click inside an exactly fitting element', () => {
    const rect = { left: 10, top: 20, width: 236, height: 512 }

    expect(toVideoPoint(10 + 50, 20 + 100, rect, video)).toEqual({ x: 100, y: 200, width: 472, height: 1024 })
  })

  it('accounts for the side bars of a letterboxed element', () => {
    // 높이에 맞춰 0.5배로 그려지고 가로로 (600 - 236) / 2 = 182px의 여백이 생긴다.
    const rect = { left: 0, top: 0, width: 600, height: 512 }

    expect(toVideoPoint(182 + 50, 100, rect, video)).toEqual({ x: 100, y: 200, width: 472, height: 1024 })
  })

  it('ignores a click on the letterbox bar', () => {
    const rect = { left: 0, top: 0, width: 600, height: 512 }

    expect(toVideoPoint(20, 100, rect, video)).toBeNull()
  })

  it('clamps to the frame edge when asked, for the end of a drag', () => {
    const rect = { left: 0, top: 0, width: 600, height: 512 }

    expect(toVideoPoint(20, 900, rect, video, { clamp: true })).toEqual({ x: 0, y: 1023, width: 472, height: 1024 })
  })

  it('returns null before the video size is known', () => {
    expect(toVideoPoint(1, 1, { left: 0, top: 0, width: 100, height: 100 }, { width: 0, height: 0 })).toBeNull()
  })
})

describe('wheelToScroll', () => {
  it('turns one pixel-mode notch down into one Android notch down', () => {
    expect(wheelToScroll(0, 100, 0)).toEqual({ hScroll: 0, vScroll: -1 })
  })

  it('keeps the horizontal sign', () => {
    expect(wheelToScroll(100, 0, 0)).toEqual({ hScroll: 1, vScroll: 0 })
  })

  it('treats three lines as one notch', () => {
    expect(wheelToScroll(0, -3, 1)).toEqual({ hScroll: 0, vScroll: 1 })
  })

  it('clamps to the protocol range', () => {
    expect(wheelToScroll(0, 100_000, 0)).toEqual({ hScroll: 0, vScroll: -16 })
  })

  it('returns null for a zero delta', () => {
    expect(wheelToScroll(0, 0, 0)).toBeNull()
  })
})

describe('keyToIntent', () => {
  const plain: KeyInput = { key: 'a', isComposing: false, ctrlKey: false, metaKey: false, altKey: false }

  it('sends a printable ascii character as text', () => {
    expect(keyToIntent(plain)).toEqual({ type: 'text', text: 'a' })
    expect(keyToIntent({ ...plain, key: ' ' })).toEqual({ type: 'text', text: ' ' })
    expect(keyToIntent({ ...plain, key: '~' })).toEqual({ type: 'text', text: '~' })
  })

  it.each([
    ['Enter', 'enter'],
    ['Backspace', 'backspace'],
    ['Delete', 'forward_delete'],
    ['Tab', 'tab'],
    ['Escape', 'escape'],
    ['ArrowUp', 'up'],
    ['ArrowDown', 'down'],
    ['ArrowLeft', 'left'],
    ['ArrowRight', 'right']
  ])('sends %s as the %s key', (key, deviceKey) => {
    expect(keyToIntent({ ...plain, key })).toEqual({ type: 'key', key: deviceKey })
  })

  it.each([
    ['a non-ascii character', { ...plain, key: '한' }],
    ['a key during IME composition', { ...plain, key: 'a', isComposing: true }],
    ['a Cmd shortcut', { ...plain, key: 'r', metaKey: true }],
    ['a Ctrl shortcut', { ...plain, key: 'c', ctrlKey: true }],
    ['an Alt chord', { ...plain, key: 'x', altKey: true }],
    ['a named key we do not map', { ...plain, key: 'F5' }],
    ['a prototype key name', { ...plain, key: 'toString' }]
  ])('sends nothing for %s', (_name, input) => {
    expect(keyToIntent(input)).toBeNull()
  })
})
```

- [ ] **Step 2: 테스트가 실패하는지 확인한다**

Run: `npx vitest run src/renderer/src/stream/inputMapper.test.ts`
Expected: FAIL — 모듈이 없다

- [ ] **Step 3: 구현한다**

`src/renderer/src/stream/inputMapper.ts`:

```ts
import type { ControlIntent, DeviceKey, VideoPoint } from '../../../shared/types/stream'

export interface Rect {
  left: number
  top: number
  width: number
  height: number
}

export interface VideoSize {
  width: number
  height: number
}

/** 픽셀 단위 휠 한 칸의 크기. 대부분의 마우스가 한 칸에 100px 안팎을 보낸다. */
const PIXELS_PER_NOTCH = 100
const LINES_PER_NOTCH = 3
const SCROLL_LIMIT = 16

/**
 * 요소 안의 클라이언트 좌표를 비디오 좌표로 바꾼다. 캔버스는 CSS object-fit: contain으로
 * 그려지므로 요소 크기와 그림 크기가 다르다. 같은 배율과 여백을 여기서 다시 계산한다.
 * 여백을 누르면 null이다. clamp면 여백 쪽 좌표를 프레임 가장자리로 붙인다 — 드래그가
 * 밖에서 끝나도 up을 보내야 기기에 터치가 눌린 채 남지 않는다.
 */
export function toVideoPoint(
  clientX: number,
  clientY: number,
  rect: Rect,
  video: VideoSize,
  opts: { clamp?: boolean } = {}
): VideoPoint | null {
  if (video.width <= 0 || video.height <= 0 || rect.width <= 0 || rect.height <= 0) return null

  const scale = Math.min(rect.width / video.width, rect.height / video.height)
  const offsetX = (rect.width - video.width * scale) / 2
  const offsetY = (rect.height - video.height * scale) / 2
  let x = Math.floor((clientX - rect.left - offsetX) / scale)
  let y = Math.floor((clientY - rect.top - offsetY) / scale)

  const inside = x >= 0 && y >= 0 && x < video.width && y < video.height
  if (!inside) {
    if (!opts.clamp) return null
    x = Math.min(Math.max(x, 0), video.width - 1)
    y = Math.min(Math.max(y, 0), video.height - 1)
  }
  return { x, y, width: video.width, height: video.height }
}

function clampScroll(value: number): number {
  return Math.max(-SCROLL_LIMIT, Math.min(SCROLL_LIMIT, value))
}

/**
 * 브라우저 휠 delta를 Android 스크롤 축 값으로 바꾼다. 브라우저 deltaY는 아래가 양수이고
 * Android AXIS_VSCROLL은 위가 양수라 세로만 부호를 뒤집는다.
 */
export function wheelToScroll(deltaX: number, deltaY: number, deltaMode: number): { hScroll: number; vScroll: number } | null {
  const unit = deltaMode === 1 ? LINES_PER_NOTCH : deltaMode === 2 ? 1 : PIXELS_PER_NOTCH
  const hScroll = clampScroll(deltaX / unit)
  const vScroll = clampScroll(-deltaY / unit)
  if (hScroll === 0 && vScroll === 0) return null
  // -0이 섞이면 테스트 비교와 직렬화가 헷갈린다.
  return { hScroll: hScroll + 0, vScroll: vScroll + 0 }
}

export interface KeyInput {
  key: string
  isComposing: boolean
  ctrlKey: boolean
  metaKey: boolean
  altKey: boolean
}

const NAMED_KEYS: ReadonlyMap<string, DeviceKey> = new Map([
  ['Enter', 'enter'],
  ['Backspace', 'backspace'],
  ['Delete', 'forward_delete'],
  ['Tab', 'tab'],
  ['Escape', 'escape'],
  ['ArrowUp', 'up'],
  ['ArrowDown', 'down'],
  ['ArrowLeft', 'left'],
  ['ArrowRight', 'right']
])

/**
 * 캔버스에 포커스가 있을 때의 키 입력을 의도로 바꾼다. 수정자 키가 눌린 조합은 호스트
 * 단축키로 남겨 둔다. IME 조합 중인 키와 ASCII 밖의 문자는 보내지 않는다(스펙 범위).
 */
export function keyToIntent(event: KeyInput): ControlIntent | null {
  if (event.isComposing) return null
  if (event.metaKey || event.ctrlKey || event.altKey) return null

  const named = NAMED_KEYS.get(event.key)
  if (named) return { type: 'key', key: named }

  if (event.key.length === 1) {
    const code = event.key.charCodeAt(0)
    if (code >= 0x20 && code <= 0x7e) return { type: 'text', text: event.key }
  }
  return null
}
```

- [ ] **Step 4: 테스트가 통과하는지 확인한다**

Run: `npx vitest run src/renderer/src/stream && npm run typecheck`
Expected: PASS

- [ ] **Step 5: 커밋한다**

```bash
git add src/renderer/src/stream/inputMapper.ts src/renderer/src/stream/inputMapper.test.ts
git commit -m "feat(renderer): 캔버스 좌표·휠·키를 입력 의도로 바꾸는 inputMapper를 더한다

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task 3: streamDecoder — `VideoDecoder` 감싸기

**Files:**
- Create: `src/renderer/src/stream/streamDecoder.ts`
- Test: `src/renderer/src/stream/streamDecoder.test.ts`

**Interfaces:**
- Consumes: `codecFromConfig` (Task 1)
- Produces:
  - `DEFAULT_MAX_DECODE_QUEUE = 3`
  - `interface DecoderLike { configure(config: VideoDecoderConfig): void; decode(chunk: EncodedVideoChunk): void; close(): void; readonly decodeQueueSize: number; readonly state: CodecState }`
  - `interface PacketInput { config: boolean; key: boolean; ptsUs: number | null; data: Uint8Array }`
  - `interface StreamDecoderDeps { createDecoder(init: VideoDecoderInit): DecoderLike; createChunk(init: EncodedVideoChunkInit): EncodedVideoChunk; onFrame(frame: VideoFrame): void; onError(error: Error): void; maxQueue?: number }`
  - `interface StreamDecoder { push(packet: PacketInput): void; close(): void }`
  - `createStreamDecoder(deps: StreamDecoderDeps): StreamDecoder`

- [ ] **Step 1: 실패하는 테스트를 쓴다**

`src/renderer/src/stream/streamDecoder.test.ts`:

```ts
import { describe, expect, it, vi } from 'vitest'
import { createStreamDecoder, type DecoderLike } from './streamDecoder'

const CONFIG = Uint8Array.from([0, 0, 0, 1, 0x67, 0x64, 0x00, 0x20, 0, 0, 0, 1, 0x68, 0xee])
const OTHER_CONFIG = Uint8Array.from([0, 0, 0, 1, 0x67, 0x42, 0xc0, 0x1f])

function harness(opts: { maxQueue?: number } = {}) {
  let init: VideoDecoderInit | null = null
  const decoder = {
    configure: vi.fn(),
    decode: vi.fn(),
    close: vi.fn(),
    decodeQueueSize: 0,
    state: 'configured' as CodecState
  }
  const onFrame = vi.fn()
  const onError = vi.fn()
  const stream = createStreamDecoder({
    createDecoder: (i) => {
      init = i
      return decoder as DecoderLike
    },
    // 가짜 chunk는 init을 그대로 담는다. 테스트는 type·timestamp·data만 본다.
    createChunk: (i) => i as unknown as EncodedVideoChunk,
    onFrame,
    onError,
    maxQueue: opts.maxQueue
  })
  const decoded = () => decoder.decode.mock.calls.map((call) => call[0] as EncodedVideoChunkInit)
  return { stream, decoder, onFrame, onError, decoded, init: () => init as unknown as VideoDecoderInit }
}

const key = (bytes: number[], ptsUs = 0) => ({ config: false, key: true, ptsUs, data: Uint8Array.from(bytes) })
const delta = (bytes: number[], ptsUs = 0) => ({ config: false, key: false, ptsUs, data: Uint8Array.from(bytes) })
const config = (data: Uint8Array) => ({ config: true, key: false, ptsUs: null, data })

describe('createStreamDecoder', () => {
  it('configures from the config packet and decodes config plus key frame as one key chunk', () => {
    const h = harness()

    h.stream.push(config(CONFIG))
    h.stream.push(key([9, 9], 1000))

    expect(h.decoder.configure).toHaveBeenCalledWith({ codec: 'avc1.640020', optimizeForLatency: true })
    expect(h.decoded()).toEqual([{ type: 'key', timestamp: 1000, data: Uint8Array.from([...CONFIG, 9, 9]) }])
  })

  it('decodes delta frames after the key frame', () => {
    const h = harness()
    h.stream.push(config(CONFIG))
    h.stream.push(key([1]))

    h.stream.push(delta([2], 2000))

    expect(h.decoded()[1]).toEqual({ type: 'delta', timestamp: 2000, data: Uint8Array.from([2]) })
  })

  it('drops delta frames that arrive before the first key frame', () => {
    const h = harness()
    h.stream.push(config(CONFIG))

    h.stream.push(delta([2]))

    expect(h.decoded()).toEqual([])
  })

  it('ignores media before any config packet', () => {
    const h = harness()

    h.stream.push(key([1]))

    expect(h.decoder.decode).not.toHaveBeenCalled()
  })

  it('drops deltas while the queue is backed up and resumes at the next key frame', () => {
    const h = harness({ maxQueue: 2 })
    h.stream.push(config(CONFIG))
    h.stream.push(key([1]))

    h.decoder.decodeQueueSize = 5
    h.stream.push(delta([2]))
    h.decoder.decodeQueueSize = 0
    h.stream.push(delta([3]))
    h.stream.push(key([4]))
    h.stream.push(delta([5]))

    expect(h.decoded().map((c) => (c.data as Uint8Array).at(-1))).toEqual([1, 4, 5])
  })

  it('reconfigures when a new config arrives and waits for its key frame', () => {
    const h = harness()
    h.stream.push(config(CONFIG))
    h.stream.push(key([1]))

    h.stream.push(config(OTHER_CONFIG))
    h.stream.push(delta([2]))
    h.stream.push(key([3]))

    expect(h.decoder.configure).toHaveBeenLastCalledWith({ codec: 'avc1.42c01f', optimizeForLatency: true })
    expect(h.decoded()).toHaveLength(2)
    expect(h.decoded()[1]?.data).toEqual(Uint8Array.from([...OTHER_CONFIG, 3]))
  })

  it('reports a config packet without an SPS once and then stops', () => {
    const h = harness()

    h.stream.push(config(Uint8Array.from([0, 0, 0, 1, 0x68])))
    h.stream.push(config(CONFIG))

    expect(h.onError).toHaveBeenCalledTimes(1)
    expect(h.decoder.configure).not.toHaveBeenCalled()
  })

  it('reports a decoder error once', () => {
    const h = harness()

    h.init().error(new DOMException('bad', 'EncodingError'))
    h.init().error(new DOMException('again', 'EncodingError'))

    expect(h.onError).toHaveBeenCalledTimes(1)
  })

  it('reports a decode call that throws', () => {
    const h = harness()
    h.decoder.decode.mockImplementation(() => {
      throw new Error('closed codec')
    })
    h.stream.push(config(CONFIG))

    h.stream.push(key([1]))

    expect(h.onError).toHaveBeenCalledTimes(1)
  })

  it('passes frames on, and closes frames that arrive after close', () => {
    const h = harness()
    const frame = { close: vi.fn() } as unknown as VideoFrame
    h.init().output(frame)
    expect(h.onFrame).toHaveBeenCalledWith(frame)

    h.stream.close()
    const late = { close: vi.fn() } as unknown as VideoFrame
    h.init().output(late)

    expect(h.onFrame).toHaveBeenCalledTimes(1)
    expect((late as unknown as { close: ReturnType<typeof vi.fn> }).close).toHaveBeenCalled()
    expect(h.decoder.close).toHaveBeenCalled()
  })
})
```

- [ ] **Step 2: 테스트가 실패하는지 확인한다**

Run: `npx vitest run src/renderer/src/stream/streamDecoder.test.ts`
Expected: FAIL — 모듈이 없다

- [ ] **Step 3: 구현한다**

`src/renderer/src/stream/streamDecoder.ts`:

```ts
import { codecFromConfig } from './h264'

/**
 * decodeQueueSize가 이 값을 넘으면 다음 키프레임까지 delta를 버린다. 에이전트를 지켜보는
 * 용도라 밀린 프레임을 다 그리는 것보다 최신 화면으로 건너뛰는 편이 낫다. 실제 값은
 * 스펙의 열린 질문대로 에뮬레이터에서 지연을 보며 조정한다.
 */
export const DEFAULT_MAX_DECODE_QUEUE = 3

/** VideoDecoder에서 쓰는 부분. 테스트는 가짜를 넘긴다(jsdom에는 WebCodecs가 없다). */
export interface DecoderLike {
  configure(config: VideoDecoderConfig): void
  decode(chunk: EncodedVideoChunk): void
  close(): void
  readonly decodeQueueSize: number
  readonly state: CodecState
}

export interface PacketInput {
  config: boolean
  key: boolean
  ptsUs: number | null
  data: Uint8Array
}

export interface StreamDecoderDeps {
  createDecoder(init: VideoDecoderInit): DecoderLike
  createChunk(init: EncodedVideoChunkInit): EncodedVideoChunk
  /** 받은 쪽이 그린 뒤 frame.close()를 부른다. */
  onFrame(frame: VideoFrame): void
  /** 복구할 수 없는 실패. 한 번만 부른다. 이후 입력은 무시한다. */
  onError(error: Error): void
  maxQueue?: number
}

export interface StreamDecoder {
  push(packet: PacketInput): void
  close(): void
}

function concat(a: Uint8Array, b: Uint8Array): Uint8Array {
  const joined = new Uint8Array(a.length + b.length)
  joined.set(a, 0)
  joined.set(b, a.length)
  return joined
}

export function createStreamDecoder(deps: StreamDecoderDeps): StreamDecoder {
  const maxQueue = deps.maxQueue ?? DEFAULT_MAX_DECODE_QUEUE
  let failed = false
  let closed = false
  let config: Uint8Array | null = null
  let needKey = true

  function fail(thrown: unknown): void {
    if (failed || closed) return
    failed = true
    deps.onError(thrown instanceof Error ? thrown : new Error(String(thrown)))
  }

  const decoder = deps.createDecoder({
    output: (frame) => {
      if (closed) {
        frame.close()
        return
      }
      deps.onFrame(frame)
    },
    error: (error) => fail(error)
  })

  return {
    push(packet) {
      if (failed || closed) return
      try {
        if (packet.config) {
          const codec = codecFromConfig(packet.data)
          if (!codec) {
            fail(new Error('config 패킷에서 SPS를 찾지 못했다'))
            return
          }
          // 회전하면 SPS가 바뀐다. 매번 다시 configure하고 새 키프레임부터 그린다.
          decoder.configure({ codec, optimizeForLatency: true })
          config = packet.data
          needKey = true
          return
        }

        if (!config) return
        if (!packet.key) {
          if (needKey) return
          if (decoder.decodeQueueSize > maxQueue) {
            needKey = true
            return
          }
        }

        // SPS/PPS는 config 패킷에만 있다. 키프레임마다 앞에 붙여 두면 delta를 버린 뒤에도
        // 그 키프레임 하나로 다시 그릴 수 있다(M1 스파이크에서 확인한 방식).
        const data = packet.key ? concat(config, packet.data) : packet.data
        decoder.decode(deps.createChunk({ type: packet.key ? 'key' : 'delta', timestamp: packet.ptsUs ?? 0, data }))
        if (packet.key) needKey = false
      } catch (thrown) {
        fail(thrown)
      }
    },

    close() {
      if (closed) return
      closed = true
      try {
        if (decoder.state !== 'closed') decoder.close()
      } catch {
        // 이미 에러로 닫힌 디코더다.
      }
    }
  }
}
```

- [ ] **Step 4: 테스트가 통과하는지 확인한다**

Run: `npx vitest run src/renderer/src/stream && npm run typecheck`
Expected: PASS

`VideoDecoderConfig`·`CodecState` 같은 WebCodecs 타입을 못 찾으면 `tsconfig.web.json`의 `lib`에 `DOM`이 있는지
확인한다(있다). TypeScript 버전의 `lib.dom`에 WebCodecs 타입이 없을 때만 `src/renderer/src/global.d.ts`에 필요한
최소 선언을 더하고, 그 사실을 커밋 메시지 본문에 적는다.

- [ ] **Step 5: 커밋한다**

```bash
git add src/renderer/src/stream/streamDecoder.ts src/renderer/src/stream/streamDecoder.test.ts
git commit -m "feat(renderer): config 보관·밀림 버리기·재설정을 맡는 streamDecoder를 더한다

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task 4: useScrcpyStream — 포트·디코더·캔버스 연결

**Files:**
- Create: `src/renderer/src/hooks/useScrcpyStream.ts`
- Test: `src/renderer/src/hooks/useScrcpyStream.test.tsx`

**Interfaces:**
- Consumes: `onStreamPort` (Task 1), `createStreamDecoder`, `StreamDecoder` (Task 3), `VideoSize` (Task 2),
  `RendererApi.startStream`·`stopStream`, `ControlIntent`, `SessionStatus`, `StreamDown`, `StreamPortMeta` (M2-1)
- Produces:
  - `interface StreamDecoderHandlers { onFrame(frame: VideoFrame): void; onError(error: Error): void }`
  - `interface ScrcpyStreamDeps { startStream(serial: string): Promise<Outcome<void>>; stopStream(): Promise<Outcome<void>>; onStreamPort(callback: (meta: StreamPortMeta, port: MessagePort) => void): () => void; createDecoder(handlers: StreamDecoderHandlers): StreamDecoder }`
  - `interface ScrcpyStream { status: SessionStatus; video: VideoSize | null; send(intent: ControlIntent): void; reconnect(): void }`
  - `useScrcpyStream(serial: string, canvasRef: RefObject<HTMLCanvasElement | null>, deps?: ScrcpyStreamDeps): ScrcpyStream`

- [ ] **Step 1: 실패하는 테스트를 쓴다**

`src/renderer/src/hooks/useScrcpyStream.test.tsx`:

```tsx
// @vitest-environment jsdom
import { act, renderHook, waitFor } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import type { StreamDown, StreamPortMeta } from '../../../shared/types/stream'
import type { StreamDecoder } from '../stream/streamDecoder'
import { useScrcpyStream, type ScrcpyStreamDeps, type StreamDecoderHandlers } from './useScrcpyStream'

interface FakePort {
  onmessage: ((event: MessageEvent) => void) | null
  postMessage: ReturnType<typeof vi.fn>
  close: ReturnType<typeof vi.fn>
}

function fakePort(): FakePort {
  return { onmessage: null, postMessage: vi.fn(), close: vi.fn() }
}

function harness(startResult: Awaited<ReturnType<ScrcpyStreamDeps['startStream']>> = { ok: true, value: undefined }) {
  let portCallback: ((meta: StreamPortMeta, port: MessagePort) => void) | null = null
  const decoders: Array<StreamDecoder & { push: ReturnType<typeof vi.fn>; close: ReturnType<typeof vi.fn>; handlers: StreamDecoderHandlers }> = []
  const deps: ScrcpyStreamDeps = {
    startStream: vi.fn(async () => startResult),
    stopStream: vi.fn(async () => ({ ok: true as const, value: undefined })),
    onStreamPort: vi.fn((callback) => {
      portCallback = callback
      return () => {
        portCallback = null
      }
    }),
    createDecoder: vi.fn((handlers) => {
      const decoder = { push: vi.fn(), close: vi.fn(), handlers }
      decoders.push(decoder)
      return decoder
    })
  }
  const canvasRef = { current: null }
  const deliverPort = (serial: string, port: FakePort) =>
    act(() => portCallback?.({ serial, sessionId: 'x' }, port as unknown as MessagePort))
  const deliver = (port: FakePort, message: StreamDown) => act(() => port.onmessage?.({ data: message } as MessageEvent))
  return { deps, canvasRef, decoders, deliverPort, deliver }
}

describe('useScrcpyStream', () => {
  it('asks main for a stream and starts as connecting', async () => {
    const h = harness()

    const { result } = renderHook(() => useScrcpyStream('emulator-5554', h.canvasRef, h.deps))

    expect(result.current.status).toEqual({ state: 'connecting' })
    await waitFor(() => expect(h.deps.startStream).toHaveBeenCalledWith('emulator-5554'))
  })

  it('adopts the port for its serial and follows status, session and packets', async () => {
    const h = harness()
    const { result } = renderHook(() => useScrcpyStream('emulator-5554', h.canvasRef, h.deps))
    const port = fakePort()

    h.deliverPort('emulator-5554', port)
    h.deliver(port, { type: 'status', status: { state: 'streaming' } })
    h.deliver(port, { type: 'session', width: 472, height: 1024 })
    h.deliver(port, { type: 'packet', config: true, key: false, ptsUs: null, data: new Uint8Array([1]) })

    expect(result.current.status).toEqual({ state: 'streaming' })
    expect(result.current.video).toEqual({ width: 472, height: 1024 })
    expect(h.decoders[0]?.push).toHaveBeenCalledTimes(1)
  })

  it('closes a port that belongs to another serial', () => {
    const h = harness()
    renderHook(() => useScrcpyStream('emulator-5554', h.canvasRef, h.deps))
    const stale = fakePort()

    h.deliverPort('emulator-5556', stale)

    expect(stale.close).toHaveBeenCalled()
    expect(h.decoders).toHaveLength(0)
  })

  it('replaces an older port with a newer one for the same serial', () => {
    const h = harness()
    renderHook(() => useScrcpyStream('emulator-5554', h.canvasRef, h.deps))
    const older = fakePort()
    const newer = fakePort()

    h.deliverPort('emulator-5554', older)
    h.deliverPort('emulator-5554', newer)

    expect(older.close).toHaveBeenCalled()
    expect(h.decoders[0]?.close).toHaveBeenCalled()
    expect(h.decoders).toHaveLength(2)
  })

  it('reports failed when main refuses to start the stream', async () => {
    const error = { kind: 'no_device' as const, message: '그런 기기가 없다', hint: 'x' }
    const h = harness({ ok: false, error })

    const { result } = renderHook(() => useScrcpyStream('emulator-5554', h.canvasRef, h.deps))

    await waitFor(() => expect(result.current.status).toEqual({ state: 'failed', error }))
  })

  it('sends input through the adopted port', () => {
    const h = harness()
    const { result } = renderHook(() => useScrcpyStream('emulator-5554', h.canvasRef, h.deps))
    const port = fakePort()
    h.deliverPort('emulator-5554', port)

    result.current.send({ type: 'key', key: 'home' })

    expect(port.postMessage).toHaveBeenCalledWith({ type: 'key', key: 'home' })
  })

  it('restarts the stream when the decoder fails', async () => {
    const h = harness()
    renderHook(() => useScrcpyStream('emulator-5554', h.canvasRef, h.deps))
    h.deliverPort('emulator-5554', fakePort())

    act(() => h.decoders[0]?.handlers.onError(new Error('decode')))

    await waitFor(() => expect(h.deps.startStream).toHaveBeenCalledTimes(2))
    expect(h.deps.stopStream).toHaveBeenCalledTimes(1)
  })

  it('restarts the stream on reconnect', async () => {
    const h = harness()
    const { result } = renderHook(() => useScrcpyStream('emulator-5554', h.canvasRef, h.deps))

    act(() => result.current.reconnect())

    await waitFor(() => expect(h.deps.startStream).toHaveBeenCalledTimes(2))
  })

  it('stops the stream and closes the port on unmount', () => {
    const h = harness()
    const { unmount } = renderHook(() => useScrcpyStream('emulator-5554', h.canvasRef, h.deps))
    const port = fakePort()
    h.deliverPort('emulator-5554', port)

    unmount()

    expect(port.close).toHaveBeenCalled()
    expect(h.decoders[0]?.close).toHaveBeenCalled()
    expect(h.deps.stopStream).toHaveBeenCalled()
  })

  it('ignores messages from a port after it was replaced', () => {
    const h = harness()
    const { result } = renderHook(() => useScrcpyStream('emulator-5554', h.canvasRef, h.deps))
    const older = fakePort()
    h.deliverPort('emulator-5554', older)
    const onmessage = older.onmessage
    h.deliverPort('emulator-5554', fakePort())

    act(() => onmessage?.({ data: { type: 'status', status: { state: 'reconnecting', attempt: 1 } } } as MessageEvent))

    expect(result.current.status).toEqual({ state: 'connecting' })
  })
})
```

- [ ] **Step 2: 테스트가 실패하는지 확인한다**

Run: `npx vitest run src/renderer/src/hooks/useScrcpyStream.test.tsx`
Expected: FAIL — 모듈이 없다

- [ ] **Step 3: 구현한다**

`src/renderer/src/hooks/useScrcpyStream.ts`:

```ts
import { useCallback, useEffect, useRef, useState, type RefObject } from 'react'
import type { Outcome } from '../../../shared/types/ipc'
import type { ControlIntent, SessionStatus, StreamDown, StreamPortMeta } from '../../../shared/types/stream'
import type { VideoSize } from '../stream/inputMapper'
import { createStreamDecoder, type StreamDecoder } from '../stream/streamDecoder'
import { onStreamPort } from '../stream/streamPort'

export interface StreamDecoderHandlers {
  onFrame(frame: VideoFrame): void
  onError(error: Error): void
}

/** 브라우저 전역에 닿는 부분. 테스트는 이것을 통째로 넘긴다. */
export interface ScrcpyStreamDeps {
  startStream(serial: string): Promise<Outcome<void>>
  stopStream(): Promise<Outcome<void>>
  onStreamPort(callback: (meta: StreamPortMeta, port: MessagePort) => void): () => void
  createDecoder(handlers: StreamDecoderHandlers): StreamDecoder
}

export interface ScrcpyStream {
  status: SessionStatus
  /** 서버가 알린 비디오 크기. 입력 좌표 변환과 오버레이가 쓴다. 첫 session meta 전에는 null이다. */
  video: VideoSize | null
  send(intent: ControlIntent): void
  /** 스트림을 처음부터 다시 연다. 실패 화면의 "다시 연결" 버튼이 부른다. */
  reconnect(): void
}

function browserDeps(): ScrcpyStreamDeps {
  return {
    startStream: (serial) => window.api.startStream(serial),
    stopStream: () => window.api.stopStream(),
    onStreamPort: (callback) => onStreamPort(callback),
    createDecoder: (handlers) =>
      createStreamDecoder({
        createDecoder: (init) => new VideoDecoder(init),
        createChunk: (init) => new EncodedVideoChunk(init),
        onFrame: handlers.onFrame,
        onError: handlers.onError
      })
  }
}

const CONNECTING: SessionStatus = { state: 'connecting' }

function drawFrame(canvas: HTMLCanvasElement | null, frame: VideoFrame): void {
  try {
    if (!canvas) return
    if (canvas.width !== frame.displayWidth) canvas.width = frame.displayWidth
    if (canvas.height !== frame.displayHeight) canvas.height = frame.displayHeight
    canvas.getContext('2d')?.drawImage(frame, 0, 0)
  } finally {
    // 닫지 않으면 디코더의 프레임 풀이 말라 디코딩이 멈춘다.
    frame.close()
  }
}

/**
 * serial의 실시간 화면을 canvasRef에 그린다. 스트림은 main이 열고, 포트는 따로 온다.
 * 같은 serial의 포트 중 가장 나중에 온 것을 쓴다 — main은 새 포트를 만들기 전에 이전 포트를
 * 닫고, IPC는 순서대로 도착하므로 가장 나중 것이 살아 있는 세션이다.
 */
export function useScrcpyStream(
  serial: string,
  canvasRef: RefObject<HTMLCanvasElement | null>,
  deps?: ScrcpyStreamDeps
): ScrcpyStream {
  const depsRef = useRef<ScrcpyStreamDeps | null>(deps ?? null)
  if (!depsRef.current) depsRef.current = browserDeps()

  const [status, setStatus] = useState<SessionStatus>(CONNECTING)
  const [video, setVideo] = useState<VideoSize | null>(null)
  // 값을 올리면 effect가 다시 돌며 스트림을 처음부터 연다(재연결·디코더 복구).
  const [attempt, setAttempt] = useState(0)
  const portRef = useRef<MessagePort | null>(null)

  useEffect(() => {
    const d = depsRef.current as ScrcpyStreamDeps
    let active = true
    let port: MessagePort | null = null
    let decoder: StreamDecoder | null = null
    setStatus(CONNECTING)
    setVideo(null)

    function release(): void {
      portRef.current = null
      port?.close()
      port = null
      decoder?.close()
      decoder = null
    }

    function adopt(next: MessagePort): void {
      release()
      const adoptedDecoder = d.createDecoder({
        onFrame: (frame) => drawFrame(canvasRef.current, frame),
        onError: () => {
          if (active) setAttempt((n) => n + 1)
        }
      })
      port = next
      decoder = adoptedDecoder
      portRef.current = next
      next.onmessage = (event: MessageEvent) => {
        if (!active || port !== next) return
        const message = event.data as StreamDown
        if (message.type === 'status') setStatus(message.status)
        else if (message.type === 'session') setVideo({ width: message.width, height: message.height })
        else if (message.type === 'packet') adoptedDecoder.push(message)
      }
    }

    const unsubscribe = d.onStreamPort((meta, next) => {
      if (!active || meta.serial !== serial) {
        next.close()
        return
      }
      adopt(next)
    })

    d.startStream(serial).then(
      (outcome) => {
        if (active && !outcome.ok) setStatus({ state: 'failed', error: outcome.error })
      },
      (thrown: unknown) => {
        if (!active) return
        setStatus({
          state: 'failed',
          error: {
            kind: 'command_failed',
            message: thrown instanceof Error ? thrown.message : String(thrown),
            hint: '다시 연결해라'
          }
        })
      }
    )

    return () => {
      active = false
      unsubscribe()
      release()
      void d.stopStream()
    }
  }, [serial, attempt, canvasRef])

  const send = useCallback((intent: ControlIntent) => {
    portRef.current?.postMessage(intent)
  }, [])

  const reconnect = useCallback(() => setAttempt((n) => n + 1), [])

  return { status, video, send, reconnect }
}
```

- [ ] **Step 4: 테스트가 통과하는지 확인한다**

Run: `npx vitest run src/renderer/src/hooks && npm run typecheck`
Expected: PASS

- [ ] **Step 5: 커밋한다**

```bash
git add src/renderer/src/hooks/useScrcpyStream.ts src/renderer/src/hooks/useScrcpyStream.test.tsx
git commit -m "feat(renderer): 포트·디코더·캔버스를 잇는 useScrcpyStream 훅을 더한다

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task 5: ScreenshotView — M1 스크린샷 화면을 떼어 낸다

행동은 바꾸지 않는 이동이다. 기존 `DeviceScreen` 테스트가 그대로 `ScreenshotView`를 지켜야 한다.

**Files:**
- Create: `src/renderer/src/components/ScreenshotView.tsx`
- Move: `src/renderer/src/components/DeviceScreen.test.tsx` → `src/renderer/src/components/ScreenshotView.test.tsx`
- Modify: `src/renderer/src/components/DeviceScreen.tsx`
- Modify: `src/renderer/src/app.css`

**Interfaces:**
- Produces: `ScreenshotView({ serial }: { serial: string }): JSX.Element` — 한 번 캡처하고 "새로고침"으로 다시 캡처한다.
  serial이 바뀌면 이전 화면을 지우고 새로 캡처한다.

- [ ] **Step 1: 테스트를 옮긴다**

```bash
git mv src/renderer/src/components/DeviceScreen.test.tsx src/renderer/src/components/ScreenshotView.test.tsx
```

`ScreenshotView.test.tsx`에서:

- import를 `import { ScreenshotView } from './ScreenshotView'`로 바꾼다.
- 모든 `<DeviceScreen `를 `<ScreenshotView `로 바꾼다.
- `describe('DeviceScreen'`을 `describe('ScreenshotView'`로 바꾼다.
- `asks for no screenshot when there is no device` 테스트를 지운다. `ScreenshotView`는 serial이 반드시 있다.
  이 경우는 Task 6의 새 `DeviceScreen.test.tsx`가 다시 지킨다.

- [ ] **Step 2: 테스트가 실패하는지 확인한다**

Run: `npx vitest run src/renderer/src/components/ScreenshotView.test.tsx`
Expected: FAIL — `./ScreenshotView`가 없다

- [ ] **Step 3: 컴포넌트를 떼어 낸다**

`src/renderer/src/components/ScreenshotView.tsx`는 지금의 `DeviceScreen.tsx`에서 `serial`이 `null`인 분기와
바깥 `<section>`을 뺀 것이다. 상태·요청 번호·`capture`·serial 변경 effect는 한 줄도 바꾸지 않고 옮긴다.

```tsx
import { useCallback, useEffect, useRef, useState } from 'react'
import type { JSX } from 'react'
import type { ToolError } from '../../../shared/types/errors'
import type { ScreenshotResult } from '../../../shared/types/device'

export interface ScreenshotViewProps {
  serial: string
}

/**
 * 정지 스크린샷 화면. M1의 기기 화면이었고, M2에서는 실시간 스트림이 끝내 실패했을 때의
 * 강등 화면이다. 스트림 없이도 기기를 볼 수 있는 마지막 경로라 동작을 바꾸지 않는다.
 */
export function ScreenshotView({ serial }: ScreenshotViewProps): JSX.Element {
  const [shot, setShot] = useState<ScreenshotResult | null>(null)
  const [failure, setFailure] = useState<ToolError | null>(null)
  const [capturing, setCapturing] = useState(false)

  // 요청 번호. serial이 바뀌거나 새 capture가 시작되면 올라간다 — 응답이
  // 돌아왔을 때 이 번호가 최신 요청과 다르면(추월당했으면) 결과를 버린다.
  // unmount 이후 응답도 같은 방식으로 걸러진다.
  const requestId = useRef(0)
  const mounted = useRef(true)

  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
    }
  }, [])

  const capture = useCallback(async (target: string) => {
    const myRequest = (requestId.current += 1)
    setCapturing(true)
    setFailure(null)

    try {
      const result = await window.api.captureScreenshot(target)

      if (!mounted.current || myRequest !== requestId.current) return

      if (result.ok) setShot(result.value)
      else setFailure(result.error)
    } catch (thrown: unknown) {
      if (!mounted.current || myRequest !== requestId.current) return

      setFailure({
        kind: 'command_failed',
        message: thrown instanceof Error ? thrown.message : String(thrown),
        hint: '연결을 확인하고 다시 시도해라'
      })
    } finally {
      if (mounted.current && myRequest === requestId.current) setCapturing(false)
    }
  }, [])

  useEffect(() => {
    // serial이 바뀌면 이전 기기의 화면·실패를 먼저 지운다. 지우지 않으면
    // 새 캡처가 끝나기 전까지 사용자가 이전 기기의 화면을 새 기기의 것으로
    // 착각한다.
    setShot(null)
    setFailure(null)
    void capture(serial)
  }, [serial, capture])

  return (
    <div className="screenshot-view">
      <div className="screen-toolbar">
        <span className="screenshot-label">정지 화면</span>
        <button type="button" className="btn" onClick={() => void capture(serial)} disabled={capturing}>
          새로고침
        </button>
      </div>

      {failure ? (
        <p role="alert" className="notice notice-error">
          {failure.message} — {failure.hint}
        </p>
      ) : null}

      <div className="screen-frame" aria-busy={capturing}>
        {shot ? (
          <img
            src={`data:image/png;base64,${shot.base64}`}
            alt={`${serial}의 화면`}
            width={shot.width}
            height={shot.height}
          />
        ) : null}
      </div>
    </div>
  )
}
```

상태·요청 번호·`capture`는 `DeviceScreen.tsx`의 것을 주석까지 그대로 옮겼다. serial effect만 `if (!serial)` 분기가 빠졌다.

`DeviceScreen.tsx`는 이 task에서 잠시 `ScreenshotView`를 감싸기만 한다. Task 6에서 실시간 화면으로 바뀐다.

```tsx
import type { JSX } from 'react'
import { ScreenshotView } from './ScreenshotView'

export interface DeviceScreenProps {
  serial: string | null
}

export function DeviceScreen({ serial }: DeviceScreenProps): JSX.Element {
  return (
    <section aria-label="기기 화면" className="device-screen">
      {serial ? (
        <>
          <div className="screen-toolbar">
            <h2 className="pane-title">화면</h2>
            <span className="device-serial mono">{serial}</span>
          </div>
          <ScreenshotView serial={serial} />
        </>
      ) : (
        <p className="empty">기기를 선택해라. 왼쪽 목록에서 실행 중인 기기를 누르면 화면이 뜬다.</p>
      )}
    </section>
  )
}
```

`app.css`의 `.screen-frame img` 규칙 아래에 더한다. 기존 `.screen-toolbar .btn { margin-left: auto }`가 새로고침 버튼을
오른쪽으로 민다.

```css
.screenshot-view {
  display: flex;
  flex: 1;
  flex-direction: column;
  gap: var(--space-2);
  min-height: 0;
}

.screenshot-label {
  color: var(--text-muted);
}
```

- [ ] **Step 4: 테스트가 통과하는지 확인한다**

Run: `npm test && npm run typecheck`
Expected: PASS. `App.test.tsx`가 기기 화면의 텍스트·role에 기대는 테스트가 있으면 함께 통과해야 한다.

- [ ] **Step 5: 커밋한다**

```bash
git add src/renderer/src/components/ src/renderer/src/app.css
git commit -m "refactor(renderer): 스크린샷 화면을 ScreenshotView로 떼어 낸다

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task 6: DeviceScreen — 실시간 화면, 입력, 툴바, 강등

**Files:**
- Modify: `src/renderer/src/components/DeviceScreen.tsx`
- Create: `src/renderer/src/components/DeviceScreen.test.tsx`
- Modify: `src/renderer/src/app.css`

**Interfaces:**
- Consumes: `useScrcpyStream`, `ScrcpyStream` (Task 4), `toVideoPoint`, `wheelToScroll`, `keyToIntent` (Task 2),
  `ScreenshotView` (Task 5), `DeviceKey` (M2-1)
- Produces:
  - `DeviceScreen({ serial }: DeviceScreenProps)` — props 불변
  - 캔버스 요소: `aria-label="<serial>의 실시간 화면"`, `className="screen-canvas"`, `tabIndex={0}`
  - 오버레이 자리: `<div className="screen-stage">` 안에서 캔버스 바로 뒤. M2-3이 `GestureOverlay`를 여기에 넣는다.

- [ ] **Step 1: 실패하는 테스트를 쓴다**

`src/renderer/src/components/DeviceScreen.test.tsx`:

```tsx
// @vitest-environment jsdom
import { fireEvent, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { RendererApi } from '../../../shared/types/ipc'
import type { SessionStatus } from '../../../shared/types/stream'
import type { ScrcpyStream } from '../hooks/useScrcpyStream'
import { useScrcpyStream } from '../hooks/useScrcpyStream'
import { DeviceScreen } from './DeviceScreen'

vi.mock('../hooks/useScrcpyStream', () => ({ useScrcpyStream: vi.fn() }))

const send = vi.fn()
const reconnect = vi.fn()
const captureScreenshot = vi.fn(async () => ({ ok: true, value: { base64: 'QUJD', width: 1, height: 1 } }))

function streamWith(status: SessionStatus, video: ScrcpyStream['video'] = { width: 472, height: 1024 }): void {
  vi.mocked(useScrcpyStream).mockReturnValue({ status, video, send, reconnect })
}

// jsdom은 레이아웃을 하지 않는다. 캔버스가 비디오의 절반 크기로 딱 맞게 그려졌다고 둔다.
vi.spyOn(HTMLCanvasElement.prototype, 'getBoundingClientRect').mockReturnValue({
  left: 0,
  top: 0,
  width: 236,
  height: 512,
  right: 236,
  bottom: 512,
  x: 0,
  y: 0,
  toJSON: () => ({})
})

beforeEach(() => {
  send.mockClear()
  reconnect.mockClear()
  captureScreenshot.mockClear()
  vi.mocked(useScrcpyStream).mockClear()
  ;(window as unknown as { api: Partial<RendererApi> }).api = { captureScreenshot } as unknown as RendererApi
})

describe('DeviceScreen', () => {
  it('asks to pick a device when there is none and opens no stream', () => {
    streamWith({ state: 'streaming' })

    render(<DeviceScreen serial={null} />)

    expect(screen.getByText(/기기를 선택해라/)).toBeDefined()
    expect(useScrcpyStream).not.toHaveBeenCalled()
  })

  it('shows the live canvas and takes no screenshot while streaming', () => {
    streamWith({ state: 'streaming' })

    render(<DeviceScreen serial="emulator-5554" />)

    expect(screen.getByLabelText('emulator-5554의 실시간 화면')).toBeDefined()
    expect(captureScreenshot).not.toHaveBeenCalled()
  })

  it('says it is connecting', () => {
    streamWith({ state: 'connecting' }, null)

    render(<DeviceScreen serial="emulator-5554" />)

    expect(screen.getByRole('status').textContent).toContain('연결 중')
  })

  it('says which reconnect attempt it is on', () => {
    streamWith({ state: 'reconnecting', attempt: 2 })

    render(<DeviceScreen serial="emulator-5554" />)

    expect(screen.getByRole('status').textContent).toContain('2/3')
  })

  it('falls back to the screenshot view with the reason and a reconnect button when the stream fails', async () => {
    streamWith({ state: 'failed', error: { kind: 'device_unresponsive', message: '서버가 안 뜬다', hint: '다시 연결해라' } })

    render(<DeviceScreen serial="emulator-5554" />)

    expect(screen.getByText(/서버가 안 뜬다/)).toBeDefined()
    expect(screen.queryByLabelText('emulator-5554의 실시간 화면')).toBeNull()
    expect(captureScreenshot).toHaveBeenCalledWith('emulator-5554')
    await userEvent.click(screen.getByRole('button', { name: '다시 연결' }))
    expect(reconnect).toHaveBeenCalled()
  })

  it('sends a hardware key from the toolbar', async () => {
    streamWith({ state: 'streaming' })
    render(<DeviceScreen serial="emulator-5554" />)

    await userEvent.click(screen.getByRole('button', { name: '홈' }))

    expect(send).toHaveBeenCalledWith({ type: 'key', key: 'home' })
  })

  it('disables the toolbar until the stream is live', () => {
    streamWith({ state: 'connecting' }, null)

    render(<DeviceScreen serial="emulator-5554" />)

    expect(screen.getByRole('button', { name: '뒤로' })).toHaveProperty('disabled', true)
  })

  it('turns a drag into touch down, move and up in video coordinates', () => {
    streamWith({ state: 'streaming' })
    render(<DeviceScreen serial="emulator-5554" />)
    const canvas = screen.getByLabelText('emulator-5554의 실시간 화면')

    fireEvent.pointerDown(canvas, { clientX: 50, clientY: 100, button: 0, pointerId: 1 })
    fireEvent.pointerMove(canvas, { clientX: 60, clientY: 150, pointerId: 1 })
    fireEvent.pointerUp(canvas, { clientX: 500, clientY: 150, pointerId: 1 })

    const point = (x: number, y: number) => ({ x, y, width: 472, height: 1024 })
    expect(send.mock.calls.map((call) => call[0])).toEqual([
      { type: 'touch', action: 'down', point: point(100, 200) },
      { type: 'touch', action: 'move', point: point(120, 300) },
      // 캔버스 밖에서 손을 떼도 가장자리로 붙여 up을 보낸다.
      { type: 'touch', action: 'up', point: point(471, 300) }
    ])
  })

  it('does not send a move without a pressed pointer', () => {
    streamWith({ state: 'streaming' })
    render(<DeviceScreen serial="emulator-5554" />)

    fireEvent.pointerMove(screen.getByLabelText('emulator-5554의 실시간 화면'), { clientX: 60, clientY: 150 })

    expect(send).not.toHaveBeenCalled()
  })

  it('sends the wheel as a scroll at the pointer', () => {
    streamWith({ state: 'streaming' })
    render(<DeviceScreen serial="emulator-5554" />)

    fireEvent.wheel(screen.getByLabelText('emulator-5554의 실시간 화면'), { clientX: 50, clientY: 100, deltaY: 100, deltaMode: 0 })

    expect(send).toHaveBeenCalledWith({
      type: 'scroll',
      point: { x: 100, y: 200, width: 472, height: 1024 },
      hScroll: 0,
      vScroll: -1
    })
  })

  it('sends typed ascii as text and leaves Cmd shortcuts alone', () => {
    streamWith({ state: 'streaming' })
    render(<DeviceScreen serial="emulator-5554" />)
    const canvas = screen.getByLabelText('emulator-5554의 실시간 화면')

    fireEvent.keyDown(canvas, { key: 'a' })
    fireEvent.keyDown(canvas, { key: 'r', metaKey: true })

    expect(send.mock.calls.map((call) => call[0])).toEqual([{ type: 'text', text: 'a' }])
  })
})
```

- [ ] **Step 2: 테스트가 실패하는지 확인한다**

Run: `npx vitest run src/renderer/src/components/DeviceScreen.test.tsx`
Expected: FAIL — 캔버스·툴바가 없다

- [ ] **Step 3: DeviceScreen을 실시간 화면으로 바꾼다**

`src/renderer/src/components/DeviceScreen.tsx`:

```tsx
import { useRef } from 'react'
import type { JSX, KeyboardEvent, PointerEvent, WheelEvent } from 'react'
import type { DeviceKey, SessionStatus } from '../../../shared/types/stream'
import { useScrcpyStream } from '../hooks/useScrcpyStream'
import { keyToIntent, toVideoPoint, wheelToScroll } from '../stream/inputMapper'
import { ScreenshotView } from './ScreenshotView'

export interface DeviceScreenProps {
  serial: string | null
}

const DEVICE_BUTTONS: ReadonlyArray<{ key: DeviceKey; label: string; glyph: string }> = [
  { key: 'back', label: '뒤로', glyph: '◀' },
  { key: 'home', label: '홈', glyph: '●' },
  { key: 'app_switch', label: '최근 앱', glyph: '■' },
  { key: 'volume_down', label: '볼륨 낮추기', glyph: '−' },
  { key: 'volume_up', label: '볼륨 높이기', glyph: '+' },
  { key: 'power', label: '전원', glyph: '⏻' }
]

function statusText(status: SessionStatus): string | null {
  if (status.state === 'connecting') return '연결 중…'
  if (status.state === 'reconnecting') return `다시 연결 중 (${status.attempt}/3)`
  return null
}

/**
 * 기기 화면 영역. 실시간 스트림을 그리고 사람 입력을 기기로 보낸다. 스트림이 끝내 실패하면
 * 스크린샷 화면으로 강등된다. 바깥 경계(props)는 M1 그대로라 App은 이 변화를 모른다.
 */
export function DeviceScreen({ serial }: DeviceScreenProps): JSX.Element {
  if (!serial) {
    return (
      <section aria-label="기기 화면" className="device-screen">
        <p className="empty">기기를 선택해라. 왼쪽 목록에서 실행 중인 기기를 누르면 화면이 뜬다.</p>
      </section>
    )
  }
  // key로 기기마다 새 캔버스를 만든다. 이전 기기의 마지막 프레임이 새 기기 화면처럼 남지 않는다.
  return <LiveScreen key={serial} serial={serial} />
}

function LiveScreen({ serial }: { serial: string }): JSX.Element {
  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  const dragging = useRef(false)
  const stream = useScrcpyStream(serial, canvasRef)
  const { status, video, send } = stream
  const live = status.state === 'streaming'
  const overlayText = statusText(status)

  function pointAt(clientX: number, clientY: number, clamp: boolean) {
    const canvas = canvasRef.current
    if (!canvas || !video) return null
    return toVideoPoint(clientX, clientY, canvas.getBoundingClientRect(), video, { clamp })
  }

  function onPointerDown(event: PointerEvent<HTMLCanvasElement>): void {
    if (event.button !== 0) return
    const point = pointAt(event.clientX, event.clientY, false)
    if (!point) return
    dragging.current = true
    event.currentTarget.setPointerCapture?.(event.pointerId)
    event.currentTarget.focus()
    send({ type: 'touch', action: 'down', point })
  }

  function onPointerMove(event: PointerEvent<HTMLCanvasElement>): void {
    if (!dragging.current) return
    const point = pointAt(event.clientX, event.clientY, true)
    if (point) send({ type: 'touch', action: 'move', point })
  }

  function onPointerEnd(event: PointerEvent<HTMLCanvasElement>): void {
    if (!dragging.current) return
    dragging.current = false
    const point = pointAt(event.clientX, event.clientY, true)
    if (point) send({ type: 'touch', action: 'up', point })
  }

  function onWheel(event: WheelEvent<HTMLCanvasElement>): void {
    const point = pointAt(event.clientX, event.clientY, false)
    const scroll = wheelToScroll(event.deltaX, event.deltaY, event.deltaMode)
    if (point && scroll) send({ type: 'scroll', point, ...scroll })
  }

  function onKeyDown(event: KeyboardEvent<HTMLCanvasElement>): void {
    const intent = keyToIntent({
      key: event.key,
      isComposing: event.nativeEvent.isComposing,
      ctrlKey: event.ctrlKey,
      metaKey: event.metaKey,
      altKey: event.altKey
    })
    if (!intent) return
    // Tab·화살표·Backspace가 페이지 포커스 이동이나 뒤로 가기로 새지 않게 막는다.
    event.preventDefault()
    send(intent)
  }

  return (
    <section aria-label="기기 화면" className="device-screen">
      <div className="screen-toolbar">
        <h2 className="pane-title">화면</h2>
        <span className="device-serial mono">{serial}</span>
        {status.state === 'failed' ? (
          <button type="button" className="btn" onClick={stream.reconnect}>
            다시 연결
          </button>
        ) : null}
      </div>

      {status.state === 'failed' ? (
        <>
          <p role="alert" className="notice notice-error">
            실시간 화면을 열지 못했다: {status.error.message} — {status.error.hint}
          </p>
          <ScreenshotView serial={serial} />
        </>
      ) : (
        <div className="screen-frame">
          <div className="screen-stage">
            <canvas
              ref={canvasRef}
              className="screen-canvas"
              tabIndex={0}
              aria-label={`${serial}의 실시간 화면`}
              onPointerDown={onPointerDown}
              onPointerMove={onPointerMove}
              onPointerUp={onPointerEnd}
              onPointerCancel={onPointerEnd}
              onWheel={onWheel}
              onKeyDown={onKeyDown}
            />
            {overlayText ? (
              <p role="status" className="screen-status">
                {overlayText}
              </p>
            ) : null}
          </div>
        </div>
      )}

      <div className="device-keys" role="toolbar" aria-label="기기 버튼">
        {DEVICE_BUTTONS.map((button) => (
          <button
            key={button.key}
            type="button"
            className="btn device-key"
            aria-label={button.label}
            title={button.label}
            disabled={!live}
            onClick={() => send({ type: 'key', key: button.key })}
          >
            {button.glyph}
          </button>
        ))}
      </div>
    </section>
  )
}
```

`app.css`의 `.screenshot-label` 규칙 아래에 더한다.

```css
.screen-stage {
  position: relative;
  display: flex;
  width: 100%;
  height: 100%;
  min-height: 0;
}

.screen-canvas {
  display: block;
  width: 100%;
  height: 100%;
  object-fit: contain;
  touch-action: none;
  border-radius: var(--radius-sm);
}

.screen-canvas:focus-visible {
  outline: 2px solid var(--focus);
  outline-offset: 2px;
}

.screen-status {
  position: absolute;
  inset: auto 0 var(--space-4) 0;
  margin: 0 auto;
  width: fit-content;
  padding: var(--space-1) var(--space-3);
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  background: var(--surface);
  color: var(--text-muted);
  box-shadow: var(--shadow);
}

.device-keys {
  display: flex;
  justify-content: center;
  gap: var(--space-2);
}

.device-key {
  min-width: 36px;
  justify-content: center;
}
```

`.screen-toolbar .btn { margin-left: auto }`가 "다시 연결" 버튼을 오른쪽으로 민다.

- [ ] **Step 4: 테스트가 통과하는지 확인한다**

Run: `npm test && npm run typecheck`
Expected: PASS

- [ ] **Step 5: 실제 앱에서 확인한다**

M2-1이 끝나 있으므로 앱 전체가 돈다. 에뮬레이터를 하나 띄운 뒤:

Run: `npm run dev`

확인할 것:

1. 기기를 고르면 수 초 안에 실시간 화면이 뜬다. 에뮬레이터 창에서 앱을 움직이면 새로고침 없이 따라온다.
2. 캔버스를 클릭·드래그하면 기기에서 탭·스와이프가 된다. 휠로 목록이 스크롤된다.
3. 검색창을 누른 뒤 캔버스에서 영문을 치면 입력된다. Backspace·Enter가 먹는다. Cmd+R은 앱을 새로고침한다(기기로 가지 않는다).
4. 툴바의 뒤로·홈·최근 앱·볼륨·전원이 먹는다.
5. 에뮬레이터를 회전하면(에뮬레이터 툴바의 회전 버튼) 화면이 가로로 바뀌고 클릭 좌표가 맞는다.
6. 에뮬레이터를 끄면 화면이 비워지고 앱이 죽지 않는다.

지연이 눈에 띄게 쌓이면 `DEFAULT_MAX_DECODE_QUEUE`를 조정하고 그 값과 이유를 스펙의 열린 질문 자리에 적는다(M2-3 Task 4에서 정리).
확인 결과(통과·실패와 관찰)를 커밋 메시지 본문에 적는다.

- [ ] **Step 6: 커밋한다**

```bash
git add src/renderer/src/components/ src/renderer/src/app.css
git commit -m "feat(renderer): 기기 화면을 실시간 스트림·입력·툴바로 바꾸고 실패 시 스크린샷으로 강등한다

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```
