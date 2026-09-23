---
id: m2-live-streaming         # 파일명에서 날짜 접두사를 뺀 slug
title: M2 — 실시간 스트리밍과 사람 입력
status: draft                   # draft | in-progress | implemented | superseded
verified: 2026-09-23          # 코드와 대조해 확인한 날짜
scope: [main, renderer, preload, shared, streaming, android]
hosts: []                       # windows | macos — 호스트 OS마다 동작이 갈릴 때만 채운다
supersedes:                     # 이 스펙이 대체하는 기존 스펙 id (없으면 비움)
superseded_by:                  # 이 스펙을 대체한 새 스펙 id (없으면 비움)
related_adr: [ADR-0002, ADR-0010, ADR-0005]
related_spec: m1-device-core-mcp-server
related_architecture:
related_plan:
related_code: [DeviceScreen.tsx#DeviceScreen, runTool.ts#runTool, ui.ts#registerUiTools, ipc.ts#ToolCallRecord, preload/index.ts#api]
tags: [spec, streaming, scrcpy, webcodecs, input]
---

# M2 — 실시간 스트리밍과 사람 입력

> 상태·날짜·관련 문서는 위 frontmatter가 단일 출처. 본문은 설계 내용에 집중한다.

## 목표

활성 기기의 화면을 새로고침 없이 실시간으로 보여 준다. 이 앱의 주 용도는 **에이전트가 MCP로 기기를
조작하는 모습을 사람이 지켜보는 것**이다. 그래서 스트림이 먼저이고, 에이전트의 탭·스와이프를 화면 위에
표시하는 오버레이가 그다음이다. 사람이 화면을 직접 조작하는 입력은 보조 기능이라 최소한으로 넣는다.

구현 방식은 [ADR-0002](../../adr/0002-screen-streaming-via-scrcpy-server.md)를 따른다.
`scrcpy-server.jar` v4.1(`vendor/scrcpy/VERSION`)을 기기에서 띄우고, main은 H.264 패킷을 디코딩하지 않고
릴레이하며, renderer가 WebCodecs `VideoDecoder`로 디코딩한다. main과 renderer 사이 전송은
[ADR-0010](../../adr/0010-stream-transport-message-port.md)의 전용 포트다.

## 전체 마일스톤에서의 위치

M1 스펙의 로드맵에서 M2 자리다. 기기가 0개인 사용자를 위한 **AVD 생성 플로우**는 이번 라운드에서
나온 요구이지만 이 스펙과 서로 의존하지 않으므로 별도 스펙으로 다룬다.

## 범위

**포함**

- 활성 기기 **한 대**의 실시간 화면 스트리밍. 기기를 바꾸면 이전 스트림을 닫고 새로 붙는다.
- 에이전트 동작 오버레이 — `ui_tap`은 퍼지는 원, `ui_swipe`는 궤적 화살표로 잠깐 그린다.
- 사람 입력 — 마우스 탭·드래그, 휠 스크롤, ASCII 텍스트, 하드웨어 버튼 툴바
  (Back, Home, 최근 앱, 전원, 볼륨 업·다운).
- 화면 회전 대응.
- 스트리밍 실패 시 M1의 스크린샷·새로고침 경로로 강등.

**제외**

- 여러 기기 동시 스트리밍.
- 오디오 (`audio=false`).
- 클립보드 동기화.
- 한글 등 IME 조합 입력. 텍스트는 ASCII만 보낸다.
- 화면 녹화.
- 사람 입력의 활동 탭 기록. 활동 탭은 에이전트 툴 호출 기록으로만 둔다.
- AVD 생성 (별도 스펙).

## 구조

```
기기                      main                              preload        renderer
scrcpy-server  ──video──▶ scrcpySession ──▶ streamManager ─┐
(app_process)  ◀─control─ scrcpySession ◀── streamManager ◀┤ MessagePort ─▶ useScrcpyStream ─▶ VideoDecoder ─▶ canvas
                                                            │                inputMapper ◀── 포인터·휠·키
               runTool ── tool_call(gesture) ── app:event ──┴──────────────▶ GestureOverlay
```

- **`scrcpyProtocol.ts`** (main, 순수) — 스트림 헤더 파서, 패킷 프레이머, control message 직렬화.
  I/O가 없다. scrcpy 프로토콜 지식은 전부 이 파일에만 둔다.
- **`scrcpySession.ts`** (main) — 기기 하나에 세션 하나. jar push, forward, 서버 실행, 소켓 두 개 연결,
  종료 정리를 맡는다.
- **`streamManager.ts`** (main) — 활성 기기를 따라 세션을 열고 닫는다. 포트를 만들어 renderer에 건네고,
  재시도 정책을 가진다.
- **preload** — `stream:port` 채널로 받은 포트를 main world로 넘기는 통로 하나만 더한다.
- **`useScrcpyStream.ts`** (renderer) — 포트에서 패킷을 받아 디코딩하고 캔버스에 그린다. 세션 상태를
  컴포넌트에 알린다.
- **`h264.ts`** (renderer, 순수) — config 패킷의 SPS에서 WebCodecs `codec` 문자열과 해상도를 뽑는다.
- **`inputMapper.ts`** (renderer, 순수) — 캔버스 좌표를 비디오 좌표로 바꾸고, 포인터·휠·키 이벤트를
  입력 의도로 바꾼다.
- **`DeviceScreen.tsx`** — 바깥 props(`{ serial }`)는 그대로다. 안쪽만 캔버스·툴바·오버레이로 바뀐다.
- **`GestureOverlay.tsx`** — `tool_call` 이벤트의 `gesture`를 캔버스 위에 그린다.

## 인터페이스

### scrcpyProtocol

```ts
interface StreamHeader {
  deviceName: string
  codec: 'h264'
  width: number
  height: number
}

interface VideoPacket {
  config: boolean
  key: boolean
  /** config 패킷이면 null */
  ptsUs: bigint | null
  data: Uint8Array
}

/** 조각난 바이트를 받아 헤더 한 번, 그다음 패킷을 순서대로 낸다. */
interface VideoStreamParser {
  push(chunk: Uint8Array): void
  onHeader(callback: (header: StreamHeader) => void): void
  onPacket(callback: (packet: VideoPacket) => void): void
}

type ControlIntent =
  | { type: 'touch'; action: 'down' | 'move' | 'up'; x: number; y: number; width: number; height: number }
  | { type: 'scroll'; x: number; y: number; width: number; height: number; dx: number; dy: number }
  | { type: 'text'; text: string }
  | { type: 'key'; key: HardwareKey }

type HardwareKey = 'back' | 'home' | 'app_switch' | 'power' | 'volume_up' | 'volume_down'

function serializeControl(intent: ControlIntent): Uint8Array
```

- 헤더 순서와 패킷 헤더 12바이트는 M1 스파이크 결과(M1 스펙의 "스파이크 결과" 절)를 따른다.
  dummy byte는 비디오 소켓에만 온다.
- `touch`·`scroll`의 `width`·`height`는 renderer가 지금 그리고 있는 비디오 프레임 크기다. 서버는 이 값이
  자기 화면 크기와 다르면 이벤트를 버리므로, 회전 직후의 오래된 좌표는 기기에 닿지 않는다.
- `key`는 `KEYCODE_*` down·up 두 메시지로 직렬화한다. `text`는 inject text 메시지 하나다.
- control message의 바이트 레이아웃은 v4.1 태그 소스(`ControlMessageReader`)와 대조해 고정한다. 추측으로
  쓰지 않는다.

### scrcpySession

```ts
type SessionStatus =
  | { state: 'connecting' }
  | { state: 'streaming'; header: StreamHeader }
  | { state: 'reconnecting'; attempt: number }
  | { state: 'failed'; error: ToolError }

interface ScrcpySession {
  readonly serial: string
  start(): Promise<StreamHeader>
  onPacket(callback: (packet: VideoPacket) => void): void
  /** 예기치 않은 종료. close()로 닫은 경우에는 부르지 않는다. */
  onEnded(callback: (error: ToolError) => void): void
  sendControl(intent: ControlIntent): void
  close(): Promise<void>
}
```

- `adbClient`와 소켓 연결 함수를 주입받는다. 테스트는 이 둘만 가짜로 바꾼다.
- 시작 순서:
  1. jar를 `/data/local/tmp/scrcpy-server.jar`로 push한다.
  2. 세션마다 무작위 31비트 `scid`를 만든다.
     `adb forward tcp:0 localabstract:scrcpy_<scid 8자리 hex>`로 빈 로컬 포트를 받는다.
  3. `adb shell CLASSPATH=... app_process / com.genymobile.scrcpy.Server 4.1 scid=<scid>
     tunnel_forward=true audio=false control=true max_size=1024 ...`로 서버를 띄운다.
  4. 같은 로컬 포트로 비디오 소켓, control 소켓을 순서대로 연결한다. 서버가 아직 listen하지 않았으면
     짧은 간격으로 연결을 다시 시도한다.
- `close()`는 두 소켓을 닫고, `adb shell` 자식 프로세스를 종료하고, forward를 제거한다. 중간 단계가
  실패해도 나머지 정리는 계속한다.

### streamManager ↔ renderer 포트 메시지

main → renderer:

```ts
type StreamDown =
  | { type: 'status'; status: SessionStatus }
  | { type: 'packet'; config: boolean; key: boolean; ptsUs: number | null; data: ArrayBuffer }
```

renderer → main:

```ts
type StreamUp = ControlIntent | { type: 'restart' } | { type: 'reconnect' }
```

- 포트는 `webContents.postMessage('stream:port', { serial, sessionId }, [port])`로 건넨다.
  `data`는 transfer list로 넘겨 복사하지 않는다.
- `ptsUs`는 포트를 넘기 전에 `number`로 바꾼다. 마이크로초 단위라 안전 정수 범위 안이다.
- main은 renderer에서 온 메시지를 타입과 필드 모양으로 검증하고, 맞지 않으면 버린다. renderer 입력을
  신뢰하지 않는다는 M1 IPC 원칙(`ipcBridge.ts`의 `withText`)과 같다.

### preload

```ts
interface RendererApi {
  // 기존 메서드는 그대로
  /** 새 스트림 포트가 오면 부른다. 해제 함수를 돌려준다. */
  onStreamPort(callback: (meta: { serial: string; sessionId: string }, port: MessagePort) => void): () => void
}
```

- `MessagePort`는 contextBridge로 넘길 수 없다. preload는 `ipcRenderer.on('stream:port')`로 받은 포트를
  `window.postMessage({ channel: 'stream:port', ...meta }, '*', [port])`로 main world에 넘기고,
  `onStreamPort`는 main world 쪽에서 그 메시지를 걸러 콜백을 부른다. 채널 이름이 맞는 메시지만 받는다.
- 범용 포트 통로는 만들지 않는다. 이 채널 하나뿐이다.

### ToolCallRecord.gesture

```ts
type Gesture =
  | { kind: 'tap'; serial: string; x: number; y: number }
  | { kind: 'swipe'; serial: string; x1: number; y1: number; x2: number; y2: number; durationMs: number }

interface ToolCallRecord {
  // 기존 필드는 그대로
  gesture?: Gesture
}
```

- 좌표는 0..1로 정규화한다. main이 기기 화면 크기로 나눈다. renderer는 비디오 크기만 알면 되고
  기기 물리 해상도를 몰라도 된다.
- 기기 화면 크기는 세션마다 `Device.info()`를 한 번 불러 캐시한다. 툴 호출마다 adb를 한 번 더 부르지 않는다.
- `ui_tap`·`ui_swipe`만 `gesture`를 싣는다. `runTool`에 선택 인자로 gesture를 받는 자리를 만들고,
  성공한 호출에만 싣는다. 실패한 탭은 그리지 않는다.
- 오버레이는 `gesture.serial`이 지금 스트리밍 중인 기기와 같을 때만 그린다.

## 동작 / 상태

### 세션 상태

| 상태 | 진입 | 화면 |
|---|---|---|
| `connecting` | 기기 선택, 재연결 버튼, `restart` | 이전 프레임을 지우고 연결 중 표시 |
| `streaming` | 헤더를 받음 | 캔버스 |
| `reconnecting` | 예기치 않은 종료 후 기기가 아직 연결돼 있음 | 마지막 프레임 위에 재연결 중 표시 |
| `failed` | 시작 실패, 재시도 소진 | 스크린샷·새로고침 화면 + "다시 연결" 버튼 |

### 수명

- `active_changed`가 오면 이전 세션을 `close()`하고 포트를 닫은 뒤 새 세션을 연다. 선택이 해제되면
  닫기만 한다.
- 세션마다 포트가 따로다. 전환 직후 늦게 도착한 이전 기기의 패킷은 닫힌 포트와 함께 사라진다.
  세션 ID로 거를 필요가 없다.
- 창이 가려지거나 최소화돼도 스트림을 유지한다.
- 앱 종료 시 모든 세션을 닫는다.

### 디코딩

- config 패킷이 오면 SPS에서 `codec` 문자열과 해상도를 읽고 `VideoDecoder.configure`를 다시 부른다.
  회전으로 해상도가 바뀌어도 이 경로로 이어진다.
- config 패킷은 보관했다가 다음 키프레임 앞에 붙여 key `EncodedVideoChunk` 하나로 넣는다. M1 스파이크에서
  확인한 방식이다.
- `decodeQueueSize`가 임계값을 넘으면 다음 키프레임까지 delta 프레임을 버린다. 지켜보는 용도라
  지연보다 최신 화면이 중요하다.

### 입력

- 캔버스는 비디오 비율을 유지하며 letterbox로 그린다. 여백 클릭은 무시한다.
- 포인터 down·move·up을 `touch` 의도로 보낸다. 드래그가 곧 스와이프다.
- 휠은 `scroll` 의도로 보낸다.
- 캔버스에 포커스가 있을 때 인쇄 가능한 ASCII 키 입력은 `text`로, Backspace·Enter 같은 제어 키는
  대응하는 keycode로 보낸다. 그 밖의 문자는 보내지 않는다.
- 툴바 버튼은 `key` 의도를 보낸다.
- 에이전트와 사람 입력 사이에 잠금은 없다. MCP 툴은 지금처럼 `adb input`과 기기별 명령 직렬화를 쓰고,
  사람 입력은 control 소켓으로 따로 간다.

### 오버레이

- `tool_call` 이벤트에 `gesture`가 있고 serial이 맞으면 비디오 좌표로 되돌려 그린다.
- 탭은 짧게 퍼지다 사라지는 원, 스와이프는 시작점에서 끝점으로 가는 화살표를 그린다.
- 비디오의 가로·세로 비율이 캐시한 기기 화면 크기와 뒤집혀 있으면 회전된 것으로 보고 정규화 축을 바꿔 적용한다.

## 실패 처리

| 실패 | 사용자에게 보이는 결과 | 복구 |
|---|---|---|
| jar push 실패, 서버가 뜨지 않음 | `failed`. 메시지에 서버 stderr 요지 | 스크린샷 모드, 다시 연결 버튼 |
| 소켓 연결 시간 초과 | `failed` | 같음 |
| 스트림이 예기치 않게 끊김, 기기는 연결돼 있음 | `reconnecting` | 1s, 2s, 4s 간격으로 최대 3번 다시 연다. 소진하면 `failed` |
| 스트림이 끊김, 기기가 사라짐 | 기존 기기 목록 흐름대로 선택 해제 | 재시도하지 않는다 |
| `VideoDecoder` error | 잠깐 `connecting` | renderer가 `restart`를 보내고 main이 세션을 다시 연다 |
| 헤더의 codec이 `h264`가 아님 | `failed` | 버전 고정 위반이므로 재시도하지 않는다 |

- 디코더 복구는 scrcpy의 reset 계열 control message에 기대지 않고 세션을 다시 연다. 버전마다 바뀌는
  프로토콜 표면을 줄이기 위해서다.
- 실패는 기존 `ToolError` 형태(`kind`·`message`·`hint`)로 싣는다.

## 파일 구성

- `src/main/stream/scrcpyProtocol.ts` — 헤더·패킷 파서, control 직렬화
- `src/main/stream/scrcpySession.ts` — 세션 수명
- `src/main/stream/streamManager.ts` — 활성 기기 추적, 포트, 재시도
- `src/main/stream/__fixtures__/` — 실제 v4.1 비디오 소켓에서 뜬 바이트
- `src/preload/index.ts` — `onStreamPort` 추가
- `src/shared/types/ipc.ts` — `Gesture`, `ToolCallRecord.gesture`, 포트 채널 이름
- `src/shared/types/stream.ts` — `StreamDown`, `StreamUp`, `ControlIntent`, `SessionStatus`
- `src/main/mcp/runTool.ts`, `src/main/mcp/tools/ui.ts` — gesture 기록
- `src/renderer/src/stream/h264.ts` — SPS 파싱
- `src/renderer/src/stream/inputMapper.ts` — 좌표·입력 변환
- `src/renderer/src/hooks/useScrcpyStream.ts` — 포트·디코더·캔버스
- `src/renderer/src/components/DeviceScreen.tsx` — 캔버스·툴바·강등 화면
- `src/renderer/src/components/GestureOverlay.tsx` — 에이전트 동작 표시

## 테스트

- **프로토콜 fixture** — 헤더·패킷 파싱은 실제 v4.1 비디오 소켓에서 뜬 바이트로 검증한다. 헤더 중간,
  패킷 헤더 중간, 페이로드 중간에서 잘린 청크도 확인한다.
- **control 직렬화** — v4.1 소스에서 확인한 바이트 레이아웃과 대조해 고정한다.
- **세션** — 가짜 `adbClient`와 소켓으로 시작 순서, `close()` 정리(중간 실패 포함), 시작 실패의 에러 형태를 확인한다.
- **streamManager** — 기기 전환 시 이전 세션 close, 재시도 간격과 횟수, 기기가 사라지면 재시도하지 않음,
  `failed` 전이, renderer 메시지 검증을 확인한다. 시계를 주입한다.
- **h264** — SPS에서 `codec` 문자열과 해상도 추출.
- **inputMapper** — letterbox 좌표 변환, 여백 클릭 무시, 드래그를 down·move·up으로, ASCII 필터.
- **renderer 컴포넌트** — testing-library와 가짜 `VideoDecoder`로 `failed` 시 스크린샷 강등, 툴바 key 의도,
  오버레이의 serial 필터를 확인한다.
- **gesture** — `ui_tap`·`ui_swipe` 성공 시 정규화된 gesture가 실리고, 실패 시 실리지 않는다.
- **통합** (`test:integration`, 로컬 전용) — 실제 에뮬레이터로 세션을 열고 정해진 시간 안에 키프레임을 받는지,
  control로 보낸 HOME이 먹는지, `close()` 뒤 `adb forward --list`에 우리 forward가 남지 않는지 확인한다.

## 완료 조건

1. 기기를 고르면 수 초 안에 실시간 화면이 뜬다. 에이전트가 MCP로 조작하는 모습이 새로고침 없이 보인다.
2. 에이전트의 `ui_tap`·`ui_swipe`가 화면 위 오버레이로 표시된다.
3. 마우스 탭·드래그·휠, ASCII 텍스트, Back·Home·최근 앱·전원·볼륨이 기기에 먹는다.
4. 기기를 회전해도 화면이 새 해상도로 이어지고 입력 좌표가 맞는다.
5. 기기를 전환하거나 종료해도 우리 forward나 서버 프로세스가 남지 않는다.
6. 스트림을 강제로 끊으면 재연결되고, 끝내 실패하면 스크린샷 모드로 떨어진다.

## 열린 질문

- `decodeQueueSize` 임계값. 실제 에뮬레이터에서 지연을 보며 정한다.
- `max_size=1024`가 에이전트를 지켜보기에 충분한 선명도인지. 부족하면 설정으로 뺄지 이때 정한다.
