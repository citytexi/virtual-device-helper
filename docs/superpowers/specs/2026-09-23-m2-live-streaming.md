---
id: m2-live-streaming         # 파일명에서 날짜 접두사를 뺀 slug
title: M2 — 실시간 스트리밍과 사람 입력
status: in-progress             # draft | in-progress | implemented | superseded
verified: 2026-09-23          # 코드와 대조해 확인한 날짜
scope: [main, renderer, preload, shared, streaming, android]
hosts: []                       # windows | macos — 호스트 OS마다 동작이 갈릴 때만 채운다
supersedes:                     # 이 스펙이 대체하는 기존 스펙 id (없으면 비움)
superseded_by:                  # 이 스펙을 대체한 새 스펙 id (없으면 비움)
related_adr: [ADR-0002, ADR-0010, ADR-0005]
related_spec: m1-device-core-mcp-server
related_architecture:
related_plan: [m2-1-stream-core, m2-2-renderer-stream, m2-3-gesture-overlay]
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
- 에이전트 동작 오버레이 — `ui_tap`은 퍼지는 원, `ui_swipe`는 궤적 선으로 잠깐 그린다.
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
기기                      main                               preload            renderer
scrcpy-server  ──video──▶ scrcpySession ──▶ streamManager ──┐
(app_process)  ◀─control─ scrcpySession ◀── streamManager ◀─┤ MessagePort ──▶ streamPort ─▶ useScrcpyStream ─▶ streamDecoder ─▶ canvas
                                                             │ (window.postMessage)            inputMapper ◀── 포인터·휠·키
                               startStream / stopStream ◀────┼──────────────── invoke ◀────── useScrcpyStream
               runTool ── tool_call(gesture) ── app:event ───┴─────────────────────────────▶ GestureOverlay
```

- **`scrcpyProtocol.ts`** (main, 순수) — 비디오 소켓 파서와 control message 직렬화. I/O가 없다.
  scrcpy 와이어 포맷 지식은 전부 이 파일에만 둔다.
- **`scrcpySession.ts`** (main) — 기기 하나에 세션 하나. jar push, forward, 서버 실행, 소켓 두 개 연결,
  종료 정리를 맡는다.
- **`scrcpyJar.ts`** (main) — 번들한 jar의 경로 해석과 서버 버전 상수.
- **`streamManager.ts`** (main) — renderer가 요청한 기기로 세션을 열고 닫는다. 포트를 만들어 renderer에
  건네고, 재시도 정책을 가진다. renderer에서 온 입력 메시지를 검증한다.
- **preload** — `startStream`·`stopStream` 두 메서드와, `stream:port`로 받은 포트를 main world로
  넘기는 전달 한 줄을 더한다.
- **`streamPort.ts`** (renderer) — main world에서 `window` message 이벤트로 포트를 받는다.
- **`h264.ts`** (renderer, 순수) — config 패킷의 SPS에서 WebCodecs `codec` 문자열을 뽑는다.
- **`streamDecoder.ts`** (renderer) — `VideoDecoder`를 감싼다. config 보관, 키프레임 합치기, 밀림 시 버리기,
  재설정을 맡는다. 디코더 생성 함수를 주입받아 가짜로 테스트한다.
- **`inputMapper.ts`** (renderer, 순수) — 캔버스 좌표를 비디오 좌표로, 휠·키 이벤트를 입력 의도로 바꾼다.
- **`useScrcpyStream.ts`** (renderer) — 스트림 시작·종료, 포트 수신, 디코더와 캔버스 연결, 상태 노출.
- **`DeviceScreen.tsx`** — 바깥 props(`{ serial }`)는 그대로다. 안쪽만 캔버스·툴바·오버레이·강등 화면으로 바뀐다.
  M1의 스크린샷 화면은 `ScreenshotView.tsx`로 떼어 강등 화면으로 재사용한다.
- **`GestureOverlay.tsx`** — `tool_call` 이벤트의 `gesture`를 캔버스 위에 그린다.

## 인터페이스

### 비디오 소켓 와이어 포맷 (v4.1)

M1 스파이크 결과에 v4.1 소스(`DesktopConnection.java`, `Streamer.java`)에서 확인한 사실을 더한다.

| 순서 | 크기 | 내용 |
|---|---|---|
| 1 | 1 | dummy byte `0x00`. 첫 소켓(비디오)에만 온다 |
| 2 | 64 | 기기 이름, UTF-8, 남는 자리 `0x00` |
| 3 | 4 | codec id. `h264` = ASCII `"h264"`. `0`은 스트림 비활성, `1`은 서버 설정 에러 |
| 4.. | 12 (+N) | 레코드가 반복된다 |

레코드 12바이트의 첫 비트(bit 63)로 종류를 가른다.

- **session meta** (bit 63 = 1) — flags 4 + width 4 + height 4, big-endian. 페이로드가 없다. 인코딩 세션이
  새로 시작될 때마다 온다. 첫 레코드이고, 회전으로 해상도가 바뀔 때도 스트림 중간에 다시 온다.
- **frame** (bit 63 = 0) — `ptsAndFlags` 8 + 페이로드 길이 4. bit 62 = config, bit 61 = 키프레임,
  하위 61비트 = PTS(마이크로초). config 패킷의 `ptsAndFlags`는 config 비트만 켜져 있다.

### scrcpyProtocol

```ts
interface VideoStreamHandlers {
  onDeviceName(name: string): void
  onSession(width: number, height: number): void
  onPacket(packet: VideoPacket): void
  /** 와이어 포맷 위반 또는 서버가 알린 비활성·에러. 이후 입력은 무시한다. */
  onError(error: DeviceError): void
}

interface VideoPacket {
  config: boolean
  key: boolean
  /** config 패킷이면 null */
  ptsUs: number | null
  /** 정확히 페이로드 크기의 새 버퍼. 다른 패킷과 메모리를 공유하지 않는다. */
  data: Uint8Array
}

function createVideoStreamParser(handlers: VideoStreamHandlers): { push(chunk: Uint8Array): void }

function serializeControl(intent: ControlIntent): Uint8Array
```

control message 바이트 레이아웃 (v4.1 `ControlMessageReader`, 전부 big-endian):

| 의도 | 레이아웃 |
|---|---|
| key | type `0` (1) + action (1, down `0`·up `1`) + keycode (4) + repeat (4, `0`) + metaState (4, `0`). down·up 두 메시지를 잇는다 |
| text | type `1` (1) + 길이 (4) + UTF-8 바이트. 서버 상한 300바이트 |
| touch | type `2` (1) + action (1, down `0`·up `1`·move `2`) + pointerId (8, `-2` = generic finger) + x (4) + y (4) + width (2) + height (2) + pressure (2, u16 고정소수점, up이면 `0` 아니면 `0xffff`) + actionButton (4, `0`) + buttons (4, `0`) |
| scroll | type `3` (1) + x (4) + y (4) + width (2) + height (2) + hScroll (2) + vScroll (2) + buttons (4, `0`). 스크롤 값은 `/16` 후 [-1, 1]로 자르고 i16 고정소수점(`× 2^15`, 버림, 상한 `0x7fff`)으로 만든다 |

- `touch`·`scroll`의 `width`·`height`는 renderer가 지금 그리고 있는 비디오 프레임 크기다. 서버는 이 값이
  자기 비디오 크기와 다르면 이벤트를 버리므로, 회전 직후의 오래된 좌표는 기기에 닿지 않는다.
- pointerId를 generic finger로 두면 서버가 터치스크린 이벤트로 주입한다. 마우스 버튼 의미는 쓰지 않는다.

### shared/types/stream.ts

```ts
type DeviceKey =
  | 'back' | 'home' | 'app_switch' | 'power' | 'volume_up' | 'volume_down'
  | 'enter' | 'backspace' | 'forward_delete' | 'tab' | 'escape' | 'up' | 'down' | 'left' | 'right'

/** 비디오 프레임 좌표와 그 프레임의 크기 */
interface VideoPoint { x: number; y: number; width: number; height: number }

type ControlIntent =
  | { type: 'touch'; action: 'down' | 'move' | 'up'; point: VideoPoint }
  | { type: 'scroll'; point: VideoPoint; hScroll: number; vScroll: number }
  | { type: 'text'; text: string }
  | { type: 'key'; key: DeviceKey }

type SessionStatus =
  | { state: 'connecting' }
  | { state: 'streaming' }
  | { state: 'reconnecting'; attempt: number }
  | { state: 'failed'; error: ToolError }

/** main → renderer */
type StreamDown =
  | { type: 'status'; status: SessionStatus }
  | { type: 'session'; width: number; height: number }
  | { type: 'packet'; config: boolean; key: boolean; ptsUs: number | null; data: Uint8Array }

/** renderer → main */
type StreamUp = ControlIntent

interface StreamPortMeta { serial: string; sessionId: string }
```

- `hScroll`·`vScroll`는 Android 축 의미를 따른다. 양수가 오른쪽·위쪽이다. 브라우저 `deltaY`는 부호가 반대라
  `inputMapper`가 뒤집는다.

### scrcpySession

```ts
interface SessionHandlers {
  onSession(width: number, height: number): void
  onPacket(packet: VideoPacket): void
  /** 예기치 않은 종료. close()로 닫은 경우에는 부르지 않는다. 최대 한 번. */
  onEnded(error: DeviceError): void
}

interface ScrcpySession {
  readonly serial: string
  /** 비디오·control 소켓이 모두 붙으면 끝난다. 실패하면 이미 연 자원을 정리하고 던진다. */
  start(): Promise<void>
  sendControl(intent: ControlIntent): void
  close(): Promise<void>
}
```

- `adbClient`와 소켓 연결 함수를 주입받는다. 테스트는 이 둘만 가짜로 바꾼다.
- 시작 순서:
  1. jar를 `/data/local/tmp/scrcpy-server.jar`로 push한다.
  2. 세션마다 무작위 31비트 `scid`를 만든다. 소켓 이름은 `scrcpy_<scid 8자리 hex>`다.
  3. `adb forward tcp:0 localabstract:<소켓 이름>`으로 빈 로컬 포트를 받는다.
  4. `adb shell CLASSPATH=... app_process / com.genymobile.scrcpy.Server 4.1 scid=<hex> tunnel_forward=true
     audio=false control=true clipboard_autosync=false video_codec=h264 max_size=1024`로 서버를 띄운다.
     첫 인자 `4.1`은 서버의 버전과 정확히 같아야 한다. `scid`는 16진수로 읽힌다.
  5. 비디오 소켓을 연결하고 첫 바이트를 기다린다. adb forward는 서버가 listen하기 전에도 연결을 받아 준 뒤
     곧바로 닫으므로, 첫 바이트 없이 닫히면 잠깐 쉬고 다시 연결한다. 기한을 넘기면 실패다.
  6. control 소켓을 연결한다. control 소켓으로 오는 기기 메시지는 읽어서 버린다. 읽지 않으면 버퍼가 찬다.
- `close()`는 두 소켓을 닫고, `adb shell` 자식 프로세스를 끝내고, forward를 제거한다. 중간 단계가 실패해도
  나머지 정리는 계속한다.

### scrcpyJar

- `SCRCPY_SERVER_VERSION = '4.1'`. `vendor/scrcpy/VERSION`의 태그와 테스트로 묶는다.
- 개발 중에는 `<appPath>/vendor/scrcpy/scrcpy-server.jar`, 패키징된 앱에서는
  `<resourcesPath>/scrcpy-server.jar`를 쓴다. `electron-builder.yml`의 `extraResources`로 jar를 싣는다.

### streamManager

```ts
interface StreamManager {
  /** 이전 세션을 닫고 serial로 새 세션을 연다. 포트는 세션을 시작하기 전에 renderer로 보낸다. */
  open(serial: string): Promise<void>
  /** 지금 세션을 닫는다. 없으면 아무 일도 하지 않는다. */
  stop(): Promise<void>
  /** 기기가 사라졌을 때 bootstrap이 부른다. 그 기기의 세션이면 재시도 없이 닫는다. */
  handleDisconnect(serial: string): Promise<void>
}
```

- 포트는 `webContents.postMessage('stream:port', { serial, sessionId }, [port])`로 건넨다.
- `MessagePortMain`은 `ArrayBuffer` transfer를 지원하지 않는다. 패킷은 structured clone으로 복사된다.
  `VideoPacket.data`를 정확한 크기의 새 버퍼로 만드는 이유가 이것이다. 큰 풀 버퍼의 view를 보내면 풀 전체가 복사된다.
- 시작 실패도 포트의 `status` 메시지로 알린다. 포트를 세션보다 먼저 보내는 이유다.
- renderer에서 온 메시지는 `ControlIntent` 모양인지 필드까지 검증하고, 아니면 버린다. renderer 입력을
  신뢰하지 않는다는 M1 IPC 원칙(`ipcBridge.ts`의 `withText`)과 같다.

### preload와 renderer의 포트 수신

```ts
interface RendererApi {
  // 기존 메서드는 그대로
  startStream(serial: string): Promise<Outcome<void>>
  stopStream(): Promise<Outcome<void>>
}
```

- `MessagePort`는 contextBridge를 넘지 못한다. preload는 `ipcRenderer.on('stream:port')`로 받은 포트를
  `window.postMessage({ channel: 'stream:port', serial, sessionId }, '*', [port])`로 main world에 넘긴다.
  Electron 문서의 방식이다.
- main world에서는 `streamPort.ts`가 `window`의 message 이벤트를 듣는다. `event.source === window`이고
  `channel`이 맞고 포트가 정확히 하나일 때만 받는다.
- 범용 포트 통로는 만들지 않는다.
- 다시 연결(재시도 소진 뒤 버튼)과 디코더 복구는 renderer가 `startStream(serial)`을 다시 부르는 것으로 한다.
  별도 메시지를 두지 않는다.

### ToolCallRecord.gesture

```ts
type Gesture =
  | { kind: 'tap'; serial: string; screen: { width: number; height: number }; x: number; y: number }
  | { kind: 'swipe'; serial: string; screen: { width: number; height: number }; x1: number; y1: number; x2: number; y2: number }

interface ToolCallRecord {
  // 기존 필드는 그대로
  gesture?: Gesture
}
```

- 좌표는 툴이 받은 기기 픽셀 그대로다. `screen`은 `wm size`가 돌려주는 자연 방향 화면 크기다.
- 정규화는 renderer가 한다. 비디오의 가로·세로 방향이 `screen`과 뒤집혀 있으면 회전된 것으로 보고
  가로·세로를 바꿔 나눈다. main은 회전 상태를 모른다.
- 화면 크기는 `Device` 인스턴스별로 한 번 조회해 `WeakMap`에 캐시한다. 기기가 다시 연결되면 registry가
  새 인스턴스를 만들므로 캐시도 자연히 새로 채워진다.
- `ui_tap`·`ui_swipe`만 `gesture`를 싣는다. `runTool`에 gesture를 만드는 선택 인자를 더하고, 성공한 호출에만 싣는다.
  크기 조회가 실패해도 툴 결과는 바꾸지 않고 gesture만 뺀다.

## 동작 / 상태

### 세션 상태

| 상태 | 진입 | 화면 |
|---|---|---|
| `connecting` | `startStream` | 연결 중 표시 |
| `streaming` | 비디오·control 소켓 연결 완료 | 캔버스 |
| `reconnecting` | 예기치 않은 종료 후 기기가 아직 연결돼 있음 | 마지막 프레임 위에 재연결 중 표시 |
| `failed` | 시작 실패, 재시도 소진, `startStream` invoke 실패 | 스크린샷 화면 + "다시 연결" 버튼 |

### 수명

- `DeviceScreen`의 `serial`이 바뀌면 renderer가 `startStream(serial)`을 부른다. main은 이전 세션을 닫고
  포트를 닫은 뒤 새로 연다. `serial`이 `null`이 되거나 컴포넌트가 사라지면 `stopStream()`을 부른다.
- 화면에 보이는 기기는 `App`의 `targetSerial()`이 파생한다. main이 `active_changed`를 따로 따라가지 않는 이유다.
  기기가 하나뿐이라 활성 기기가 `null`이어도 화면에는 그 기기가 보인다.
- renderer는 자기 `serial`과 같은 포트 중 가장 나중에 온 것을 쓴다. main은 새 포트를 만들기 전에 이전 포트를
  닫고, IPC 메시지는 순서대로 도착하므로 가장 나중 것이 살아 있는 세션이다.
- 창이 가려지거나 최소화돼도 스트림을 유지한다.
- 앱 종료 시 세션을 닫는다.

### 디코딩

- config 패킷이 오면 `codec` 문자열을 읽어 `VideoDecoder.configure({ codec, optimizeForLatency: true })`를 다시 부르고,
  다음 키프레임까지 delta를 버린다. 회전으로 SPS가 바뀌어도 이 경로로 이어진다.
- config 패킷은 보관했다가 매 키프레임 앞에 붙여 key `EncodedVideoChunk` 하나로 넣는다. M1 스파이크에서 확인한 방식이다.
- `decodeQueueSize`가 임계값을 넘으면 다음 키프레임까지 delta를 버린다. 지켜보는 용도라 지연보다 최신 화면이 중요하다.
- 캔버스 크기는 프레임의 `displayWidth`·`displayHeight`를 따른다. 화면에는 CSS `object-fit: contain`으로 맞춘다.

### 입력

- 캔버스가 letterbox로 그려지므로 좌표 변환은 요소의 bounding rect와 비디오 크기에서 contain 배율을 계산한다.
  여백 클릭은 무시한다.
- 포인터 down·move·up을 `touch` 의도로 보낸다. 드래그가 곧 스와이프다. move는 버튼이 눌린 동안만 보낸다.
- 휠은 `scroll` 의도로 보낸다. 픽셀 단위 delta는 100으로, 줄 단위는 3으로 나눈다.
- 캔버스에 포커스가 있을 때 길이 1인 인쇄 가능한 ASCII(`0x20`–`0x7e`) 키는 `text`로, Enter·Backspace·Delete·Tab·
  Escape·화살표는 대응하는 `key`로 보낸다. 그 밖은 보내지 않는다. 한글 조합 중(`isComposing`)인 키도 보내지 않는다.
- 툴바 버튼은 `key` 의도를 보낸다.
- 에이전트와 사람 입력 사이에 잠금은 없다. MCP 툴은 지금처럼 `adb input`과 기기별 명령 직렬화를 쓰고,
  사람 입력은 control 소켓으로 따로 간다.

### 오버레이

- `GestureOverlay`는 `window.api.onEvent`를 직접 구독한다. 이미 지난 툴 호출은 다시 그리지 않고, 구독 뒤에 온
  `tool_call` 중 `gesture.serial`이 지금 기기와 같은 것만 그린다.
- 캔버스와 같은 박스에 SVG를 겹치고 `viewBox`를 비디오 크기로, `preserveAspectRatio="xMidYMid meet"`로 둔다.
  캔버스의 `object-fit: contain`과 같은 letterbox가 되므로 비디오 좌표를 그대로 쓴다.
- 탭은 퍼지다 사라지는 원, 스와이프는 시작점에서 끝점으로 가는 선과 끝점 원으로 그린다. 표시 시간이 지나면 지운다.

## 실패 처리

| 실패 | 사용자에게 보이는 결과 | 복구 |
|---|---|---|
| jar push 실패, 서버가 뜨지 않음 | `failed`. 메시지에 서버 출력 꼬리 | 스크린샷 화면, 다시 연결 버튼 |
| 비디오 소켓이 기한 안에 첫 바이트를 못 받음 | `failed` (`device_unresponsive`) | 같음 |
| codec id가 `0`·`1`이거나 `h264`가 아님 | `failed` | 재시도하지 않는다. 버전 고정 위반이거나 서버 설정 에러다 |
| 스트림이 예기치 않게 끊김, 기기는 연결돼 있음 | `reconnecting` | 1s, 2s, 4s 간격으로 최대 3번 다시 연다. 소진하면 `failed` |
| 스트림이 끊김, 기기가 사라짐 | 기존 기기 목록 흐름대로 화면이 비워진다 | 재시도하지 않는다 |
| `VideoDecoder` error, 알 수 없는 codec | 잠깐 `connecting` | renderer가 `startStream(serial)`을 다시 부른다 |
| `startStream` invoke 실패 | `failed` | 스크린샷 화면, 다시 연결 버튼 |

- 디코더 복구는 scrcpy의 `RESET_VIDEO` 같은 control message에 기대지 않고 세션을 다시 연다. 버전마다 바뀌는
  프로토콜 표면을 줄이기 위해서다.
- 실패는 기존 `ToolError` 형태(`kind`·`message`·`hint`)로 싣는다. 새 `ToolErrorKind`는 만들지 않는다.

## 파일 구성

- `src/shared/types/stream.ts` — 포트 메시지와 입력 의도 타입
- `src/main/stream/scrcpyProtocol.ts` — 비디오 파서, control 직렬화
- `src/main/stream/scrcpyJar.ts` — jar 경로, 서버 버전
- `src/main/stream/scrcpySession.ts` — 세션 수명
- `src/main/stream/streamManager.ts` — 세션 교체, 포트, 재시도, 입력 검증
- `src/main/stream/__fixtures__/` — 실제 v4.1 비디오 소켓에서 뜬 바이트 (M1 스파이크의 `first-chunks.bin`)
- `src/main/app/bootstrap.ts`, `src/main/app/ipcBridge.ts`, `src/main/index.ts` — 조립
- `src/preload/index.ts`, `src/shared/types/ipc.ts` — `startStream`·`stopStream`, `stream:port`, `Gesture`
- `src/main/mcp/runTool.ts`, `src/main/mcp/tools/ui.ts` — gesture 기록
- `electron-builder.yml` — jar를 `extraResources`로
- `src/renderer/src/stream/streamPort.ts`, `h264.ts`, `streamDecoder.ts`, `inputMapper.ts`
- `src/renderer/src/hooks/useScrcpyStream.ts`
- `src/renderer/src/components/DeviceScreen.tsx`, `ScreenshotView.tsx`, `GestureOverlay.tsx`

## 테스트

- **프로토콜 fixture** — 비디오 파서는 실제 v4.1 비디오 소켓에서 뜬 바이트로 검증한다. 한 바이트씩 잘라 넣어도,
  헤더·레코드·페이로드 중간에서 잘려도 같은 결과여야 한다. 스트림 중간의 session meta, codec id `0`·`1`도 확인한다.
- **control 직렬화** — v4.1 `ControlMessageReader`에서 확인한 바이트 레이아웃과 대조해 고정한다.
- **jar** — `SCRCPY_SERVER_VERSION`이 `vendor/scrcpy/VERSION`의 태그와 같고, jar의 SHA-256이 그 파일에 적힌 값과 같다.
- **세션** — 가짜 `adbClient`와 소켓으로 시작 순서, 첫 바이트 없이 닫히는 연결의 재시도, 기한 초과,
  `close()` 정리(중간 실패 포함), 예기치 않은 종료의 `onEnded` 한 번을 확인한다.
- **streamManager** — 세션 교체 시 이전 세션과 포트 close, 재시도 간격과 횟수, 기기가 사라지면 재시도하지 않음,
  `failed` 전이, 잘못된 renderer 메시지 버림을 확인한다. 시계를 주입한다.
- **preload·streamPort** — 포트가 main world로 넘어가고, 출처·채널·포트 개수가 맞지 않는 메시지는 버린다.
- **h264** — SPS에서 `codec` 문자열 추출. 3바이트·4바이트 start code 모두.
- **streamDecoder** — 가짜 `VideoDecoder`로 config와 키프레임 합치기, 키프레임 전 delta 버림, 큐 밀림 시 버림,
  config가 바뀌면 재설정을 확인한다.
- **inputMapper** — letterbox 좌표 변환, 여백 클릭 무시, 휠 부호와 단위, ASCII·제어 키 필터, 조합 중 키 무시.
- **renderer 컴포넌트** — testing-library로 `failed` 시 스크린샷 강등, 다시 연결 버튼, 툴바 key 의도,
  오버레이의 serial 필터와 회전 보정을 확인한다.
- **gesture** — `ui_tap`·`ui_swipe` 성공 시 gesture가 실리고, 실패 시 실리지 않고, 크기 조회 실패가 툴 결과를 바꾸지 않는다.
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
