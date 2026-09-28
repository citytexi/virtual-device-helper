---
id: m3-node-control-logs-events # 파일명에서 날짜 접두사를 뺀 slug
title: M3 — 노드 기반 제어와 로그·이벤트 패널
status: draft                   # draft | in-progress | implemented | superseded
verified: 2026-09-28          # 코드와 대조해 확인한 날짜
scope: [main, renderer, preload, mcp, shared, android]
hosts: []                       # windows | macos — 호스트 OS마다 동작이 갈릴 때만 채운다
supersedes:                     # 이 스펙이 대체하는 기존 스펙 id (없으면 비움)
superseded_by:                  # 이 스펙을 대체한 새 스펙 id (없으면 비움)
related_adr: [ADR-0011, ADR-0012, ADR-0013, ADR-0004, ADR-0008, ADR-0010]
related_spec: [m1-device-core-mcp-server, m2-live-streaming, agent-guide]
related_architecture: main-layers
related_plan:
related_code: [ui.ts#registerUiTools, uiDump.ts#parseUiDump, device.ts#UiNode, device.ts#Device, runTool.ts#runTool, ipc.ts#ToolCallRecord, ipc.ts#Gesture, ipc.ts#MainEvent, appState.ts#createAppState, logcat.ts#parseLogcat, observe.ts#registerObserveTools, ActivityTab.tsx#ActivityTab, WorkArea.tsx#WorkArea, GestureOverlay.tsx#GestureOverlay, agentGuide.ts]
tags: [spec, node, logs, timeline]
---

# M3 — 노드 기반 제어와 로그·이벤트 패널

> 상태·날짜·관련 문서는 위 frontmatter가 단일 출처. 본문은 설계 내용에 집중한다.

## 목표

세 가지를 한다.

1. **노드 기반 제어** — 에이전트가 픽셀이 아니라 노드 ref로 요소를 가리킨다. 서버는 동작 직전에 노드를 다시
   찾는다. 화면이 바뀐 뒤 엉뚱한 곳을 누르는 틀린 성공을 없앤다.
2. **로그 패널** — 활성 기기의 logcat을 실시간으로 보여 주고, 레벨·텍스트·정규식·태그·앱으로 거른다.
3. **이벤트 타임라인** — 툴 호출과 기기 이벤트를 한 타임라인에 쌓는다. 호출 상세를 펼치고, 그 시점 로그로
   바로 간다.

이 앱의 주 사용자는 MCP로 기기를 조작하는 에이전트다. 사람은 그 모습을 지켜보고 디버깅한다. 1은 에이전트가
덜 틀리게 하고, 2와 3은 에이전트가 틀렸을 때 사람이 원인을 찾게 한다.

## 전체 마일스톤에서의 위치

M1 스펙 로드맵의 M3 자리다. 로드맵의 M3는 "logcat 실시간 tail, 필터, 툴 호출 타임라인 상세"였다.
노드 기반 제어는 이번 라운드에서 나온 요구다. Orca emulator(`orca emulator ax`)가 접근성 트리를 노드 단위로
다루는 것을 보고 가져왔다. 로그·타임라인과 서로 의존하지 않지만 MCP 툴 표면을 바꾸는 일이라 같은
마일스톤에서 끝낸다.

## 범위

**포함**

- `ui_find` 응답을 ref·부모 ref·정규화 bounds·상태 플래그로 바꾼다.
- ref 해석기와 `stale_ref` 에러.
- `ui_tap`·`ui_swipe`·`ui_text`의 ref 입력. `ui_swipe`는 ref와 방향으로 노드 안을 스크롤한다.
- MCP 툴 좌표를 0..1 정규화 좌표로 바꾼다. `Gesture`도 정규화한다.
- 기기별 logcat tail, 링 버퍼, pid→패키지 추적.
- 로그 전용 포트 `app:log-port`.
- 로그 탭: 가상 스크롤, 최소 레벨, 텍스트·정규식, 태그 칩, 앱 필터, 따라가기, 행 상세.
- `log_read`의 `package` 인자.
- 툴 호출 기록을 타임라인 항목으로 넓히고 기기 이벤트를 함께 기록한다.
- 활동 탭의 필터·검색·상세 펼침·로그 점프.
- 에이전트 안내 갱신.

**제외**

- 사람용 노드 인스펙터(스트리밍 화면 위 노드 경계 표시). 에이전트가 주 사용자라 이번에는 넣지 않는다.
- 로그 파일 내보내기와 세션 전체 디스크 기록.
- 크래시·ANR 자동 감지와 타임라인 표시.
- 툴 결과 전문 보관(노드 목록, 로그 본문, 스크린샷).
- 여러 기기 로그 동시 보기. 로그 탭은 활성 기기를 따라간다.
- iOS. 구조는 M4를 막지 않게 둔다.

## 구조

main 층 구조는 [main-layers](../../architecture/main-layers.md)를 따른다. 이번에 바뀌는 곳은 이렇다.

```
                 main                                                     preload          renderer
기기 구현   androidDevice ── dumpUi() → UiNode(부모·정규화 bounds·지문)
            androidDevice ── displayFrame() / readLogs({ pids })
MCP 툴      nodeRefs(스냅샷·재검증) ── ui.ts(ref | 0..1 좌표) ── runTool(serial·detail)
앱 상태     appState(timeline 링) ◀── registry 이벤트, streamManager 상태, runTool 기록
                                   └──── app:event { timeline } ────────────────────────▶ ActivityTab
로그        logManager ── logTail(adb logcat) ── logBuffer ── pidTracker
                       └──── app:log-port (기기별 포트) ─────────────▶ logPort ──▶ useLogStream ─▶ LogTab
```

- **노드 제어**는 기기 구현 층과 MCP 툴 층에서 끝난다. 파서가 노드마다 부모와 정규화 bounds와 지문 재료를
  만든다. MCP 툴 층의 `nodeRefs`가 스냅샷과 재검증을 맡는다. 근거는 [ADR-0011](../../adr/0011-node-ref-revalidation.md),
  [ADR-0012](../../adr/0012-normalized-tool-coordinates.md).
- **로그**는 층 옆에 붙는 파이프라인이다. 스트림과 같은 자리다. tail과 버퍼의 수명은 기기 연결을 따르고,
  포트는 전달만 맡는다. 근거는 [ADR-0013](../../adr/0013-log-transport-dedicated-port.md).
- **타임라인**은 앱 상태 층의 기존 툴 호출 링을 넓힌 것이다. 새 통로가 없다.
- MCP 툴 층은 여전히 `adbClient`를 모른다. `log_read`의 앱 필터는 pid 기록을 `ToolContext`로 받는다.

## 인터페이스

### UiNode와 Device

```ts
// shared/types/device.ts
interface NormalizedRect { x: number; y: number; w: number; h: number }  // 0..1, 소수 4자리

interface UiNode {
  /** 이 덤프 안에서의 순번. ref의 뒷부분이 된다. */
  index: number
  /** 남은 노드 중 가장 가까운 조상의 index. 없으면 null. */
  parentIndex: number | null
  text: string | null
  contentDesc: string | null
  resourceId: string | null
  className: string
  bounds: NormalizedRect
  clickable: boolean
  enabled: boolean
  focused: boolean
  scrollable: boolean
}

interface DisplayFrame { width: number; height: number }  // 현재 방향 기기 픽셀

interface Device {
  // 기존 멤버 유지. tap·swipe는 계속 기기 픽셀을 받는다 — 변환은 MCP 툴 층의 몫이다.
  dumpUi(): Promise<UiDump>
  displayFrame(): Promise<DisplayFrame>
  readLogs(opts?: LogOpts): Promise<LogReadResult>   // LogOpts에 pids?: number[] 추가
}

interface UiDump {
  nodes: UiNode[]
  /** 덤프 루트 bounds. 회전을 반영한 현재 방향 크기다. ref 경로의 픽셀 변환에 쓴다. */
  frame: DisplayFrame
}
```

- 노드를 남기는 기준은 M1 그대로다. 텍스트·설명·id가 있거나 클릭할 수 있는 노드다. 여기에 `scrollable`을
  더한다. 크기가 없거나 중심이 화면 밖인 노드는 뺀다.
- `x`, `y`는 없앤다. 중심은 `bounds`에서 구한다.
- `displayFrame()`은 `wm size`의 자연 방향 크기에 `dumpsys display`의 현재 회전을 적용한다. 캐시하지 않는다.

### ui_find

```ts
// 응답
{
  generation: number,
  nodes: Array<{
    ref: string,              // "g<generation>:<index>"
    parentRef: string | null, // 같은 세대의 ref. query로 걸러져 응답에 없는 노드를 가리킬 수 있다
    text, contentDesc, resourceId, className,
    bounds: NormalizedRect,
    clickable, enabled, focused, scrollable
  }>,
  truncated: boolean,
  droppedCount: number
}
```

- `query` 인자와 `UI_FIND_MAX_NODES` 상한은 그대로다.

### nodeRefs

`src/main/mcp/nodeRefs.ts`. MCP 툴 층 모듈이다.

```ts
interface NodeRefs {
  /** 덤프를 스냅샷으로 저장하고 세대를 붙인다. */
  remember(device: Device, dump: UiDump): number
  /** ref를 새 덤프 기준 노드로 푼다. 실패하면 stale_ref DeviceError를 던진다. */
  resolve(device: Device, ref: string): Promise<{ node: UiNode; frame: DisplayFrame }>
}
```

- 기기 인스턴스별로 최근 스냅샷 8개를 `WeakMap`에 둔다. 재연결하면 새 인스턴스라 옛 ref가 통하지 않는다.
- 지문은 `className`, `resourceId`, `contentDesc`, `text`와, 남은 조상들의 `className`·`resourceId` 체인이다.
- `resolve` 순서:
  1. ref 형식을 확인한다. 형식이 틀렸거나 세대가 버려졌으면 `stale_ref`.
  2. `dumpUi()`를 다시 부른다. 이 재검증 덤프는 새 세대를 만들지 않는다.
  3. 옛 노드와 지문이 같은 노드를 새 덤프에서 찾는다.
  4. 여럿이면 옛 스냅샷의 같은 지문 노드들 사이에서 몇 번째였는지를 보고 같은 순번을 고른다.
     새 덤프에 그 순번이 없으면 `stale_ref`.
  5. 없으면 `stale_ref`.
  6. 찾은 노드와 새 덤프의 `frame`을 돌려준다.
- 기기 직렬 실행(`registry.run`) 안에서 `resolve`와 실제 동작을 함께 돌린다. 그 사이에 다른 툴이 끼지 않는다.

### ui_tap · ui_swipe · ui_text

| 툴 | ref 경로 | 좌표 경로 |
|---|---|---|
| `ui_tap` | `{ ref }` | `{ x, y }` |
| `ui_swipe` | `{ ref, direction, durationMs? }` | `{ x1, y1, x2, y2, durationMs }` |
| `ui_text` | `{ ref, text }` | `{ text }` |

- 좌표는 전부 0 이상 1 이하다. 범위 밖이면 인자 오류다.
- ref와 좌표를 둘 다 주거나 둘 다 빼면 인자 오류다. `ui_text`는 `ref`가 선택이다.
- 좌표 경로는 `displayFrame()`으로 기기 픽셀을 구한다. ref 경로는 `resolve`가 돌려준 `frame`을 쓴다.
- `direction`은 `up | down | left | right`이고 **보고 싶은 쪽**이다. `down`은 아래 콘텐츠를 본다는 뜻이다.
  손가락은 위로 간다. 툴 설명에 이 뜻을 적는다.
- ref 스와이프 궤적은 노드 bounds 안쪽 80% 구간이다. 방향 축을 따라 한쪽 끝에서 반대쪽 끝으로, 다른 축은
  중심에 둔다. `durationMs` 기본값은 300이다.
- ref `ui_text`는 노드 중심을 탭해 포커스를 준 뒤 입력한다. 텍스트는 M1처럼 ASCII만 받는다.
- 응답은 사용한 정규화 좌표를 담는다. 예: `{ tapped: { ref, x, y } }`.

### Gesture

```ts
type Gesture =
  | { kind: 'tap'; serial: string; x: number; y: number }                       // 0..1
  | { kind: 'swipe'; serial: string; x1: number; y1: number; x2: number; y2: number }
```

- `screen` 필드를 없앤다. `GestureOverlay.tsx`는 비디오 크기를 곱하기만 한다. 회전 추정 로직은 사라진다.
- 좌표 경로는 인자를, ref 경로는 해석된 bounds에서 구한 좌표를 그대로 담는다. 화면 크기 조회가 필요 없으므로
  `runTool.ts`의 `GESTURE_TIMEOUT_MS` 대기와 `screenSize.ts`는 쓸 곳이 없어지면 지운다.

### ToolErrorKind

`stale_ref`를 추가한다. hint는 "`ui_find`를 다시 불러 새 ref를 받아라"다.

### log_read

- `package?: string` 인자를 추가한다. 그 패키지가 이 연결 동안 가졌던 pid 전부로 거른다.
- pid 기록은 `ToolContext`의 `pidHistory(serial, pkg): number[]`로 받는다. 기록이 비었으면 `pidof` 결과를 쓴다.
  둘 다 비었으면 `package_not_found`.
- 응답 모양은 [ADR-0008](../../adr/0008-log-read-response-shape.md) 그대로다.

### 로그 파이프라인

`src/main/logs/`.

```ts
interface LogEntry extends LogLine {
  /** 기기별 단조 증가. 연결마다 0부터. */
  seq: number
  /** main이 줄을 받은 호스트 시각(epoch ms). 타임라인과 맞출 때 쓴다. */
  receivedAt: number
}
```

- **`logTail.ts`** — `adb logcat -v threadtime -T 2000`을 `adbClient.stream`으로 띄운다. 청크를 줄로 자르고
  `parseLogcatLine`으로 파싱한다. 파싱 못 하는 줄은 버린다.
- **`logBuffer.ts`** — 기기별 링 버퍼. 5만 줄. `seq` 범위 조회와 `receivedAt` 기준 탐색을 준다.
- **`pidTracker.ts`** — 기기별 pid→패키지 맵과 패키지→pid 기록. 시작할 때 `ps -A -o PID,NAME`으로 채우고,
  이후 `ActivityManager`의 `Start proc <pid>:<pkg>/` 줄로 갱신한다. 죽은 pid도 기록으로 남긴다.
- **`logManager.ts`** — registry 이벤트로 기기별 tail을 시작·종료한다. 포트를 만들고 renderer에 건넨다.
  `pidHistory`를 MCP 툴 층에 제공한다.
- `logcat.ts`의 `parseLogcat`은 `parseLogcatLine`을 줄마다 부르는 모양으로 바꾼다. 기존 동작은 그대로다.

### 로그 포트 메시지

```ts
// shared/types/logs.ts
type LogDown =
  | { type: 'snapshot'; entries: LogEntry[]; pids: Record<number, string> }
  | { type: 'batch'; entries: LogEntry[] }
  | { type: 'pids'; pids: Record<number, string> }
  | { type: 'status'; state: 'running' | 'reconnecting' | 'stopped' }

type LogUp =
  | { type: 'pause' }
  | { type: 'resume'; afterSeq: number }

interface LogPortMeta { serial: string; sessionId: string }
```

- renderer가 `openLogs(serial)`을 부르면 main이 `MessageChannelMain`을 만들어 `app:log-port`로 보낸다.
  이전 로그 포트는 main이 닫는다.
- `batch`는 100ms마다, 새 줄이 있을 때만 보낸다.
- `resume`의 `afterSeq` 이후 줄 중 버퍼에 남은 것을 이어 보낸다. 이미 밀려난 구간은 건너뛴다.
- `RendererApi`에 `openLogs(serial)`, `closeLogs()`를 추가한다. `IPC_CHANNELS`에 `openLogs`, `closeLogs`, `logPort`를 추가한다.

### 타임라인

```ts
// shared/types/ipc.ts
interface ToolCallDetail {
  /** 원본 인자 JSON. 8KB를 넘으면 자르고 잘렸다고 표시한다. */
  args: string
  /** 실패했을 때. details는 같은 상한으로 자른다. */
  error?: ToolError
  /** 성공했을 때 툴이 준 요약. 예: "노드 23개", "로그 180줄", "1080×2400 PNG". */
  resultSummary?: string
}

type TimelineEntry =
  | {
      kind: 'tool_call'; id: string; at: number; serial?: string
      tool: string; argsSummary: string; durationMs: number; ok: boolean
      errorKind?: ToolErrorKind; gesture?: Gesture; detail: ToolCallDetail
    }
  | {
      kind: 'device'; id: string; at: number; serial: string | null
      event: 'connected' | 'disconnected' | 'active_changed'
           | 'stream_started' | 'stream_stopped' | 'stream_reconnecting'
    }
```

- `ToolCallRecord`는 `TimelineEntry`의 `tool_call`로 바뀐다. `serial`은 핸들러가 resolve한 기기다.
  resolve 전에 실패했으면 비운다.
- `RunToolOpts`에 `summarise?: (payload) => string`과 `serial?: () => string | undefined`를 추가한다.
  `serial`은 핸들러가 resolve한 기기를 돌려준다. 지금 `ui.ts`가 gesture용으로 `target`을 잡아 두는 방식과 같다.
  둘 다 던지면 그 필드 없이 기록한다.
- `AppSnapshot.toolCalls`는 `timeline`이 된다. `MainEvent`의 `tool_call`은 `timeline`(항목 하나)이 된다.
- `streamManager`에 세션 상태 변화를 알리는 콜백을 추가한다. 앱 상태가 이 콜백으로 스트림 이벤트를 기록한다.

## 동작 / 상태

### ref 수명

- 세대는 `ui_find`를 부를 때마다 하나 늘어난다. 재검증 덤프는 세대를 만들지 않는다.
- 최근 8세대의 ref만 유효하다. 더 오래된 ref는 `stale_ref`다.
- 기기가 끊겼다 다시 붙으면 모든 옛 ref가 무효다.

### 로그 tail 상태

기기별로 셋 중 하나다.

- `running` — tail 프로세스가 줄을 내고 있다.
- `reconnecting` — 연결 중인데 프로세스가 끝났다. `RECONNECT_DELAYS_MS` 간격으로 다시 띄운다.
  다시 띄울 때는 `-T <마지막 timestamp>`로 이어 받는다. 같은 밀리초 경계에서 줄이 겹칠 수 있다.
- `stopped` — 재시도가 다 실패했거나 기기가 끊겼다. 기기가 다시 연결되면 `running`부터 새로 시작한다.

버퍼는 기기 연결 동안 유지된다. 끊기면 버린다.

### 로그 탭

- 로그 탭은 활성 기기를 따라간다. 활성 기기가 바뀌면 옛 포트를 닫고 새로 연다.
- 탭이 숨겨지면 `pause`, 다시 보이면 `resume`을 보낸다.
- 필터는 전부 renderer에서 적용한다. 필터를 바꾸면 받은 줄 전체를 다시 거른다.
  - 최소 레벨: V/D/I/W/E/F.
  - 텍스트: 태그·메시지 부분일치. 정규식 토글을 켜면 정규식으로 본다.
  - 태그 칩: 받은 줄에서 많이 나온 태그를 칩으로 보여 준다. 누를 때마다 포함 → 제외 → 해제로 돈다.
    포함 칩이 하나라도 있으면 포함 칩 태그만 보인다. 제외 칩은 언제나 뺀다.
  - 앱: pid 맵의 패키지 중 하나를 고른다. 그 패키지가 가졌던 pid 전부의 줄이 보인다.
- 행 높이는 고정이다. 메시지는 한 줄로 자른다. 가상 스크롤은 직접 만든다. 행을 누르면 아래 상세 영역에 전문을
  보여 준다.
- 따라가기: 목록 맨 아래에 있으면 새 줄을 따라간다. 사용자가 위로 스크롤하면 멈추고 "맨 아래로" 버튼이 나온다.
- `reconnecting`이면 탭 위에 띠를 띄운다.
- `WorkArea` 탭 순서는 활동 → 로그 → 에이전트다.

### 활동 탭

- 타임라인 링 버퍼 상한은 1000개다. 오래된 항목부터 버린다.
- 툴 호출은 지금 모양의 행이다. 기기 이벤트는 흐린 구분선 행으로 끼운다.
- 행을 누르면 그 자리에서 펼친다. 전체 인자(들여쓰기한 JSON), 실패면 message와 hint, 성공이면 결과 요약을
  보여 준다. 가상 스크롤은 쓰지 않는다.
- 필터: 툴 이름, 성공·실패, 기기 이벤트 표시, 텍스트 검색(툴 이름·인자·에러 message).

### 로그 점프

- 툴 호출 상세의 "이 시점 로그 보기"를 누르면 로그 탭으로 바꾼다.
- `receivedAt >= at - 2000`인 첫 줄로 스크롤하고 따라가기를 멈춘다. `[at, at + durationMs]` 구간의 줄은 강조한다.
- 호출의 `serial`이 활성 기기가 아니거나 비어 있으면 버튼을 끄고 이유를 보여 준다. 점프 때문에 활성 기기를
  바꾸지 않는다. 활성 기기는 에이전트의 기본 대상이다.
- 그 시각이 버퍼에서 밀려났으면 "로그 버퍼에서 밀려난 구간이다"라고 알린다.

## 실패 처리

| 상황 | 결과 |
|---|---|
| ref 형식 오류, 버려진 세대, 지문 불일치 | `stale_ref`. hint는 `ui_find`를 다시 부르라는 것 |
| ref와 좌표를 둘 다 줌, 둘 다 뺌 | 인자 오류 |
| 좌표가 0..1 밖 | zod 인자 오류. 픽셀을 넣던 옛 클라이언트가 여기서 멈춘다 |
| `displayFrame()`이 회전을 못 읽음 | `command_failed`. 추측으로 누르지 않는다 |
| 재검증 덤프 실패 | `dumpUi`의 기존 에러를 그대로 올린다 |
| `log_read`의 패키지 pid를 못 찾음 | `package_not_found` |
| logcat tail 비정상 종료 | 재시도, 포트에 `reconnecting`. 다 실패하면 `stopped`와 타임라인 기기 이벤트 |
| 닫힌 로그 포트로 늦게 온 배치 | 포트와 함께 사라진다 |
| renderer가 보낸 모양이 틀린 `LogUp` | main이 버린다 |
| 잘못된 정규식 | 입력칸에 에러를 띄우고 텍스트 필터를 적용하지 않는다 |
| `summarise` 실패, 상세 직렬화 실패 | 요약 없이 기록한다. 툴 결과는 바꾸지 않는다 |

## 파일 구성

**M3-1 노드 기반 제어**

- `src/shared/types/device.ts` — `UiNode`, `UiDump`, `NormalizedRect`, `DisplayFrame`, `Device.displayFrame`.
- `src/shared/types/errors.ts` — `stale_ref`.
- `src/shared/types/ipc.ts` — 정규화된 `Gesture`.
- `src/main/device/parsers/uiDump.ts` — 부모 index, 정규화 bounds, 상태 플래그, 루트 frame.
- `src/main/device/androidDevice.ts` — `dumpUi`의 새 반환 모양, `displayFrame`.
- `src/main/mcp/nodeRefs.ts` — 스냅샷, 지문, 재검증.
- `src/main/mcp/coordinates.ts` — 정규화 좌표와 기기 픽셀 변환, ref 스와이프 궤적.
- `src/main/mcp/tools/ui.ts` — 새 입력과 응답.
- `src/main/mcp/tools/app.ts` — `app_reset_and_launch`의 `waitForSettle`이 `UiDump.nodes`를 보게 한다.
- `src/main/mcp/runTool.ts` — gesture 대기 정리.
- `src/renderer/src/components/GestureOverlay.tsx` — 회전 추정 제거.
- `src/shared/agentGuide.ts` — 안내 갱신.

**M3-2 로그 파이프라인과 로그 패널**

- `src/shared/types/logs.ts` — `LogEntry`, `LogDown`, `LogUp`, `LogPortMeta`.
- `src/main/device/parsers/logcat.ts` — `parseLogcatLine`.
- `src/main/logs/logTail.ts`, `logBuffer.ts`, `pidTracker.ts`, `logManager.ts`.
- `src/main/mcp/tools/observe.ts`, `src/main/mcp/toolContext.ts` — `log_read`의 `package`, `pidHistory`.
- `src/main/app/bootstrap.ts`, `ipcBridge.ts` — 로그 매니저 조립과 `openLogs`·`closeLogs`.
- `src/preload/index.ts` — `openLogs`·`closeLogs`, `app:log-port` 전달.
- `src/renderer/src/logs/logPort.ts` — 포트 수신.
- `src/renderer/src/logs/logFilter.ts` — 필터 조합(순수).
- `src/renderer/src/logs/virtualRange.ts` — 고정 높이 가상 스크롤 범위 계산(순수).
- `src/renderer/src/hooks/useLogStream.ts` — 포트 연결, 버퍼, pause/resume.
- `src/renderer/src/components/LogTab.tsx`, `LogFilters.tsx`.
- `src/renderer/src/components/WorkArea.tsx` — 로그 탭 추가.

**M3-3 이벤트 타임라인**

- `src/shared/types/ipc.ts` — `TimelineEntry`, `ToolCallDetail`, `AppSnapshot.timeline`, `MainEvent.timeline`.
- `src/main/mcp/runTool.ts` — `serial`, `detail`, `summarise`.
- `src/main/mcp/tools/*.ts` — 툴별 `summarise`.
- `src/main/app/appState.ts` — 타임라인 링과 기기 이벤트 기록.
- `src/main/stream/streamManager.ts` — 세션 상태 콜백.
- `src/renderer/src/components/ActivityTab.tsx`, `TimelineDetail.tsx`, `TimelineFilters.tsx`.
- `src/renderer/src/state/useAppState.ts` — 타임라인 상태, 로그 점프 요청.

## 테스트

vitest와 TDD로 간다. 실기기가 필요한 테스트는 `*.integration.test.ts`로 나눈다.

- **노드**
  - `uiDump`: 부모 index, 정규화 bounds, 래퍼 제거, `scrollable`. 가로 화면 덤프 픽스처를 추가한다.
  - `nodeRefs`: 세대 만료, 지문 일치·불일치, 같은 지문 여럿일 때 순번 선택, 이동한 노드의 새 bounds, 재연결 무효.
  - `coordinates`: 네 방향 회전, 범위 경계, ref 스와이프 네 방향 궤적.
  - `ui.ts`: ref와 좌표의 배타 검증, 0..1 범위 검증, ref `ui_text`의 탭 후 입력 순서.
  - `GestureOverlay`: 정규화 좌표를 비디오 크기로 그린다.
- **로그**
  - `parseLogcatLine`, 청크 경계에서 끊긴 줄의 분할.
  - `logBuffer`: 링 동작, `seq`, `receivedAt` 탐색.
  - `pidTracker`: `ps` 초기화, `Start proc` 갱신, 죽은 pid 보존.
  - `logManager`: 연결·끊김에 따른 tail 시작·종료, 재시작 간격, `-T` 이어 받기.
  - 포트 프로토콜: `snapshot` → `batch`, `pause` 중 버퍼 누적, `resume`의 `afterSeq` 이어 보내기, 잘못된 `LogUp` 무시.
  - `log_read`의 `package` 필터와 `package_not_found`.
  - renderer: `virtualRange`, `logFilter` 조합, 태그 칩 3상태, 따라가기와 멈춤, 잘못된 정규식.
- **타임라인**
  - `runTool`: `serial`, `detail` 상한, `summarise` 실패 격리.
  - `appState`: 링 상한, registry 이벤트와 스트림 상태의 기록.
  - renderer: 필터 조합, 상세 펼침, 로그 점프 위치와 강조, 비활성 기기에서 버튼 비활성, 밀려난 구간 안내.
- **가이드 일관성**: `guideConsistency.test.ts`가 새 툴 설명과 안내를 대조한다.
- **통합**: 실제 에뮬레이터에서 `ui_find` → `ui_tap({ ref })`, 화면 전환 뒤 옛 ref의 `stale_ref`, logcat tail이
  실제 줄을 받는지.

## 완료 조건

각 계획의 마지막 태스크에서 실기기로 확인한다.

- **M3-1** — 에이전트가 좌표 없이 ref만으로 앱의 로그인 흐름을 끝낸다. 화면이 바뀐 뒤 옛 ref로 누르면 엉뚱한
  곳을 누르지 않고 `stale_ref`로 멈춘다. 가로 화면에서 좌표 탭이 의도한 위치에 맞고 오버레이도 그 위치에 뜬다.
- **M3-2** — 앱을 크래시시킨 뒤 앱 필터로 크래시 스택이 보인다. 프로세스가 죽은 뒤에도 보인다. 초당 수백 줄이
  나와도 로그 탭 스크롤이 버틴다. `log_read({ package })`가 같은 크래시 스택을 준다.
- **M3-3** — 실패한 툴 호출의 상세에서 "이 시점 로그 보기"로 그때 로그에 도착한다. 기기를 끊었다 붙이면
  타임라인에 기기 이벤트가 끼인다.

## 계획 분할

- **M3-1 노드 기반 제어** — 로그·타임라인과 독립이다.
- **M3-2 로그 파이프라인과 로그 패널** — M3-1과 독립이다. 계획을 쓰다 너무 커지면 로그 코어(main·preload·
  `log_read`)와 로그 UI(renderer)로 나눈다.
- **M3-3 이벤트 타임라인** — 로그 점프 때문에 M3-2 뒤에 온다.

실행 순서는 M3-1 → M3-2 → M3-3이다. M3-1과 M3-2는 순서를 바꿔도 된다.

## 열린 질문

- ref 동작마다 덤프가 한 번 더 들어 1~2초 느려진다. 실사용에서 문제가 되면 "직전 덤프가 아주 최근이면
  재사용"을 얹는다. 기준 시간은 실측 뒤에 정한다.
- 로그 버퍼 5만 줄과 배치 100ms는 출발값이다. M3-2 완료 검증에서 메모리와 스크롤을 보고 조정한다.
- 태그 칩으로 보여 줄 태그 수는 로그 탭 폭을 보고 M3-2에서 정한다.
