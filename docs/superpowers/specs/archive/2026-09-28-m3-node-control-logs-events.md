---
id: m3-node-control-logs-events # 파일명에서 날짜 접두사를 뺀 slug
title: M3 — 노드 기반 제어와 로그·이벤트 패널
status: implemented             # draft | in-progress | implemented | superseded
verified: 2026-09-29          # 코드와 대조해 확인한 날짜
scope: [main, renderer, preload, mcp, shared, android]
hosts: []                       # windows | macos — 호스트 OS마다 동작이 갈릴 때만 채운다
supersedes:                     # 이 스펙이 대체하는 기존 스펙 id (없으면 비움)
superseded_by:                  # 이 스펙을 대체한 새 스펙 id (없으면 비움)
related_adr: [ADR-0011, ADR-0012, ADR-0013, ADR-0004, ADR-0008, ADR-0010]
related_spec: [m1-device-core-mcp-server, m2-live-streaming, agent-guide]
related_architecture: main-layers
related_plan: [m3-1-node-control, m3-2a-log-core, m3-2b-log-panel, m3-3-event-timeline]
related_code: [ui.ts#registerUiTools, uiDump.ts#parseUiDump, device.ts#UiNode, device.ts#Device, runTool.ts#runTool, toolContext.ts#ToolCallSink, ipc.ts#ToolCallRecord, ipc.ts#Gesture, ipc.ts#MainEvent, appState.ts#createAppState, useAppState.ts#reduce, logcat.ts#parseLogcat, adbClient.ts#AdbStream, observe.ts#registerObserveTools, app.ts#waitForSettle, ActivityTab.tsx#ActivityTab, WorkArea.tsx#WorkArea, GestureOverlay.tsx#GestureOverlay, agentGuide.ts]
tags: [spec, node, logs, timeline]
---

# M3 — 노드 기반 제어와 로그·이벤트 패널

> 상태·날짜·관련 문서는 위 frontmatter가 단일 출처. 본문은 설계 내용에 집중한다.

## 목표

세 가지를 한다.

1. **노드 기반 제어** — 에이전트가 픽셀이 아니라 노드 ref로 요소를 가리킨다. 서버는 동작 직전에 노드를 다시
   찾는다. 화면이 바뀐 뒤 엉뚱한 곳을 누르는 틀린 성공이 생길 창을 `ui_find`에서 동작까지의 전체 구간에서
   재검증 덤프와 동작 사이의 짧은 구간으로 좁힌다.
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
- 기기별 logcat tail, 링 버퍼, pid→패키지 추적, 기기 시계 보정.
- 로그 전용 포트 `app:log-port`.
- 로그 탭: 가상 스크롤, 최소 레벨, 텍스트·정규식, 태그 칩, 앱 필터, 따라가기, 행 상세.
- `log_read`의 `package` 인자.
- 툴 호출 기록을 타임라인 항목으로 넓히고 기기 이벤트를 함께 기록한다. `ui_text`의 입력 텍스트는 가린다.
- 활동 탭의 필터·검색·상세 펼침·로그 점프.
- 에이전트 안내 갱신.

**제외**

- 사람용 노드 인스펙터(스트리밍 화면 위 노드 경계 표시). 에이전트가 주 사용자라 이번에는 넣지 않는다.
- 로그 파일 내보내기와 세션 전체 디스크 기록.
- 크래시·ANR 자동 감지와 타임라인 표시.
- 툴 결과 전문 보관(노드 목록, 로그 본문, 스크린샷).
- 여러 기기 로그 동시 보기. 로그 탭은 활성 기기를 따라간다.
- 재검증 덤프와 실제 동작 사이에 앱이 스스로 화면을 바꾸는 경우. 이 구간은 막지 않는다.
- iOS. 구조는 M4를 막지 않게 둔다.

## 구조

main 층 구조는 [main-layers](../../../architecture/main-layers.md)를 따른다. 이번에 바뀌는 곳은 이렇다.

```
                 main                                                     preload          renderer
기기 구현   androidDevice ── dumpUi() → UiDump(노드·frame)  displayFrame()      [M3-1]
MCP 툴      nodeRefs(스냅샷·재검증) ── ui.ts(ref | 0..1 좌표)                  [M3-1]
            observe.ts(log_read package) ◀── ToolContext.pidHistory           [M3-2]
            runTool(serial·detail·redact)                                      [M3-3]
앱 상태     appState(timeline 링) ◀── registry 이벤트, streamManager·logManager 상태
                                   └──── app:event { timeline } ─────────────────▶ ActivityTab  [M3-3]
로그        logManager ── logTail(adb logcat) ── logBuffer ── pidTracker
                       └──── app:log-port (기기별 포트) ──────────────▶ logPort ─▶ useLogStream ─▶ LogTab  [M3-2]
```

- **노드 제어**는 기기 구현 층과 MCP 툴 층에서 끝난다. 파서가 노드마다 부모와 정규화 bounds를 만든다.
  MCP 툴 층의 `nodeRefs`가 스냅샷과 재검증을 맡는다. 근거는 [ADR-0011](../../../adr/0011-node-ref-revalidation.md),
  [ADR-0012](../../../adr/0012-normalized-tool-coordinates.md).
- **로그**는 층 옆에 붙는 파이프라인이다. 스트림과 같은 자리다. tail과 버퍼의 수명은 기기 연결을 따르고,
  포트는 전달만 맡는다. 근거는 [ADR-0013](../../../adr/0013-log-transport-dedicated-port.md).
- **타임라인**은 앱 상태 층의 기존 툴 호출 링을 넓힌 것이다. 새 통로가 없다.
- MCP 툴 층은 여전히 adb를 모른다. `log_read`의 앱 필터는 `ToolContext`에 선언한 함수 시그니처
  `pidHistory`로 pid를 받는다. `ToolContext`는 `src/main/logs/`의 타입을 import하지 않는다.

## 인터페이스

### UiDump와 Device

```ts
// shared/types/device.ts
interface NormalizedRect { x: number; y: number; w: number; h: number }  // 0..1, 소수 4자리

interface UiNode {
  /** 이 덤프 안에서의 순번. 필터 뒤 남은 노드 기준이다. ref의 뒷부분이 된다. */
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

/** 현재 방향 기준 디스플레이 전체 크기(기기 픽셀). */
interface DisplayFrame { width: number; height: number }

interface UiDump {
  nodes: UiNode[]
  /** 덤프 시점의 디스플레이 크기. 정규화 기준이자 ref 경로의 픽셀 변환 기준이다. */
  frame: DisplayFrame
}

interface Device {
  // 기존 멤버 유지. tap·swipe는 계속 기기 픽셀을 받는다 — 변환은 MCP 툴 층의 몫이다.
  dumpUi(): Promise<UiDump>
  displayFrame(): Promise<DisplayFrame>
  readLogs(opts?: LogOpts): Promise<LogReadResult>   // LogOpts에 pids?: number[] 추가
}
```

- **정규화 기준은 디스플레이 전체 크기다. 덤프 루트 bounds가 아니다.** `uiautomator dump`는 활성 창 하나만
  덤프한다. 다이얼로그가 떠 있으면 루트 bounds가 다이얼로그 사각형이 된다.
- 디스플레이 크기는 `wm size`의 자연 방향 크기에 회전을 적용해서 구한다. 회전이 90°·270°면 가로·세로를 바꾼다.
  - `wm size` 결과는 `Device` 인스턴스 안에서 캐시한다. 자연 방향 크기는 연결 동안 바뀌지 않는다.
  - `dumpUi`는 덤프 XML의 `<hierarchy rotation="N">`에서 회전을 읽는다. 덤프와 같은 순간의 값이다.
  - `displayFrame()`은 `dumpsys window displays`에서 `mDisplayId=0` 디스플레이의 `mDisplayRotation=ROTATION_N`을
    읽는다. `dumpsys display`는 쓰지 않는다. 스트리밍 중에는 scrcpy 가상 디스플레이 블록이 섞여 `rotation`이
    여러 번 나오기 때문이다. 회전은 캐시하지 않는다.
- 덤프 루트 bounds는 "중심이 화면 밖인 노드 빼기" 판정에만 쓴다. `uiDump.ts`의 `screenRect`가 이 역할로 남는다.
- 노드를 남기는 기준은 M1 그대로다. 텍스트·설명·id가 있거나 클릭할 수 있는 노드다. 여기에 `scrollable`을
  더한다. 크기가 없거나 중심이 화면 밖인 노드는 뺀다.
- `x`, `y`는 없앤다. 중심은 `bounds`에서 구한다.
- `app.ts`의 `waitForSettle`은 `UiDump.nodes`를 본다. 판정 규칙은 그대로다.

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
- ref의 index는 덤프의 `UiNode.index` 그대로다. 지금 `ui.ts`는 걸러진 목록에 index를 다시 매긴다. 이 코드를 없앤다.

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

- **세대 번호는 프로세스 전역 단조 카운터다.** 기기마다 0부터 세지 않는다. 그래서 같은 세대 번호가 두 스냅샷에
  붙는 일이 없다.
- 스냅샷은 `Device` 인스턴스별로 최근 8개를 `WeakMap`에 둔다. `resolve`는 **대상 기기의 목록에서만** 세대를
  찾는다. 다른 기기에서 받은 ref, 재연결 전 인스턴스에서 받은 ref는 목록에 없으므로 `stale_ref`다.
- **지문**은 네 필드와 조상 체인으로 만든다.
  - 네 필드: `className`, `resourceId`, `contentDesc`, `text`.
  - `className`이 `EditText`로 끝나는 노드는 `text`를 지문에서 뺀다. 입력하면 바뀌는 값이고, 빈 필드는 hint를
    text로 내기도 한다.
  - 조상 체인: 필터 뒤 남은 조상들의 `className`·`resourceId`. 조상의 text는 넣지 않는다.
  - 조상이 텍스트를 잃어 필터에서 빠지면 체인이 달라져 `stale_ref`가 된다. 받아들인다.
- `resolve` 순서:
  1. ref 형식을 확인한다. 형식이 틀렸거나 대상 기기 목록에 그 세대가 없으면 `stale_ref`.
  2. `dumpUi()`를 다시 부른다. 이 재검증 덤프는 새 세대를 만들지 않는다.
  3. 새 덤프에서 옛 노드와 지문이 같은 노드를 모은다. 하나도 없으면 `stale_ref`.
  4. 하나면 그 노드다. 위치가 바뀌어도 받아들인다.
  5. 여럿이면 두 조건이 모두 맞을 때만 받아들인다.
     - 옛 스냅샷에서 같은 지문 노드의 개수와 새 덤프에서의 개수가 같다.
     - 옛 스냅샷에서의 순번으로 고른 노드가, 옛 bounds 중심에 가장 가까운 노드와 같다.
     하나라도 어긋나면 `stale_ref`. 스크롤이나 항목 추가로 순번이 다른 행을 가리키는 틀린 성공을 막는다.
  6. 찾은 노드와 새 덤프의 `frame`을 돌려준다.
- 기기 직렬 실행(`registry.run`) 안에서 `resolve`와 실제 동작을 함께 돌린다. 그 사이에 우리 툴이 끼지 않는다.
  앱이 스스로 화면을 바꾸는 것은 막지 못한다.

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
- ref `ui_text`는 노드 중심을 탭해 포커스를 준 뒤 입력한다. 텍스트는 M1처럼 ASCII만 받는다. 선행 탭은
  `tap` gesture로 기록한다.
- 응답은 사용한 정규화 좌표를 담는다. 예: `{ tapped: { ref, x, y } }`.

### Gesture

```ts
type Gesture =
  | { kind: 'tap'; serial: string; x: number; y: number }                       // 0..1
  | { kind: 'swipe'; serial: string; x1: number; y1: number; x2: number; y2: number }
```

- `screen` 필드와 `ipc.ts`의 `ScreenSize` 타입을 없앤다.
- 좌표 경로는 인자를, ref 경로는 해석된 bounds에서 구한 좌표를 담는다. 화면 크기 조회가 필요 없다.
- `src/main/mcp/screenSize.ts`와 `runTool.ts`의 `GESTURE_TIMEOUT_MS`·`withGestureTimeout`을 지운다.
  `RunToolOpts.gesture` 콜백은 남긴다.
- `GestureOverlay.tsx`는 비디오 크기를 곱하기만 한다. 회전 추정 로직은 사라진다.

### ToolErrorKind

`stale_ref`를 추가한다. hint는 "`ui_find`를 다시 불러 새 ref를 받아라"다.

### log_read

- `package?: string` 인자를 추가한다. 그 패키지의 pid로 `logcat -d` 결과를 거른다.
- pid는 `ToolContext.pidHistory(serial, pkg): Promise<number[]>`로 받는다. `logManager`가 구현한다.
  - 이 연결 동안 그 패키지가 가졌던 pid 전부에, 지금 `pidof` 결과를 더해 돌려준다.
  - `pidof`는 `logManager`가 adb로 부른다. MCP 툴 층은 adb를 부르지 않는다.
- 결과가 비었으면 `package_not_found`다. hint는 "설치돼 있지 않으면 app_install, 실행한 적이 없으면
  app_launch로 먼저 실행해라"다. 설치만 확인하는 기존 hint와 구분한다.
- pid가 재사용되면 같은 pid의 다른 프로세스 줄이 섞일 수 있다. `log_read`에서는 받아들인다. 로그 탭은 아래
  `LogEntry.pkg`로 이 문제를 피한다.
- 응답 모양은 [ADR-0008](../../../adr/0008-log-read-response-shape.md) 그대로다.

### 로그 파이프라인

`src/main/logs/`.

```ts
// shared/types/logs.ts
interface LogEntry extends LogLine {
  /** 기기별 단조 증가. 연결마다 0부터. */
  seq: number
  /** 기기 timestamp를 호스트 epoch ms로 바꾼 값. 타임라인과 맞출 때 쓴다. */
  at: number
  /** 이 줄을 받은 순간 pid의 주인 패키지. 모르면 없다. */
  pkg?: string
}
```

- **`logTail.ts`** — `adb logcat -v threadtime -T 2000`을 `adbClient.stream`으로 띄운다. 줄은 `AdbStream.onLine`이
  잘라 준다. `parseLogcatLine`으로 파싱하고, 파싱 못 하는 줄은 버린다.
- **시계 보정** — tail을 시작할 때 `date +%s%3N%z`를 한 번 불러 기기 epoch ms와 기기 tz offset(`+0900` 등)을
  함께 잰다. `%3N`과 `%z` 사이에 공백을 두지 않는다 — `adb shell`이 인자를 이어 붙여 기기 셸이 다시 나누기
  때문이다. 시계 차이는 호스트의 왕복 중간 시각에서 기기 epoch를 뺀 값이다. logcat timestamp(`MM-DD HH:mm:ss.SSS`)는
  기기 tz의 벽시계이므로 기기 tz로 해석해 epoch로 바꾸고(UTC 필드에서 tz offset을 뺀다), 이 차이를 더해 `at`을
  만든다. 연도는 작년·올해·내년 중 결과가 호스트 현재 시각에 가장 가까운 쪽을 고른다. 그래서 12월과 1월 사이에서도,
  기기와 호스트의 tz가 달라도 `at`이 맞는다. `%z`를 못 읽으면 호스트 tz로 해석한다. epoch가 13자리 숫자가 아니거나
  측정이 실패하면 `at`은 줄을 받은 호스트 시각이다.
- **`logBuffer.ts`** — 기기별 링 버퍼. 5만 줄. `seq` 범위 조회와 `at` 기준 탐색을 준다.
- **`pidTracker.ts`** — 기기별 pid→패키지 맵과 패키지→pid 기록.
  - 시작할 때 `ps -A -o PID,NAME`으로 채운다.
  - 이후 `ActivityManager`의 `Start proc` 줄로 갱신한다. 형식은 `Start proc <pid>:<프로세스명>/<uid> for ...`다.
  - 패키지명은 프로세스명에서 첫 `:` 앞이다. 예: `com.android.chrome:sandboxed_process0:...`는 `com.android.chrome`.
    `ps` 이름에도 같은 규칙을 쓴다.
  - pid가 재사용되면 맵은 새 주인으로 바뀐다. 이미 받은 줄의 `pkg`는 바꾸지 않는다.
  - 죽은 pid도 패키지→pid 기록에 남긴다. 크래시 직후 로그를 볼 때 그 프로세스는 이미 없다.
- **`logManager.ts`** — registry 이벤트로 기기별 tail을 시작·종료한다. 포트를 만들고 renderer에 건넨다.
  `pidHistory`를 구현한다. tail 상태 변화를 콜백으로 알린다.
- `logcat.ts`의 `parseLogcat`은 `parseLogcatLine`을 줄마다 부르는 모양으로 바꾼다. 기존 동작은 그대로다.

### 로그 포트 메시지

```ts
// shared/types/logs.ts
type LogDown =
  | { type: 'snapshot'; entries: LogEntry[]; done: boolean }
  | { type: 'batch'; entries: LogEntry[] }
  | { type: 'gap'; fromSeq: number; toSeq: number }
  | { type: 'packages'; packages: string[] }
  | { type: 'status'; state: 'running' | 'reconnecting' | 'stopped' }
  | { type: 'resumed'; lastSeq: number }

type LogUp =
  | { type: 'pause' }
  | { type: 'resume'; afterSeq: number }

interface LogPortMeta {
  serial: string
  /** 포트 하나를 가리킨다. renderer는 마지막으로 받은 sessionId의 포트만 쓰고 이전 포트는 닫는다. */
  sessionId: string
}
```

- renderer가 `openLogs(serial)`을 부르면 main이 `MessageChannelMain`을 만들어 `app:log-port`로 보낸다.
  이전 로그 포트는 main이 닫는다.
- 연결 직후 버퍼 전체를 `snapshot`으로 보낸다. 한 메시지에 5000줄씩 나눠 보내고 마지막 메시지에 `done: true`를
  단다. 5만 줄을 한 번에 structured clone하지 않기 위해서다.
- `batch`는 100ms마다, 새 줄이 있을 때만 보낸다.
- `resume`을 받으면 `afterSeq` 이후 줄 중 버퍼에 남은 것을 `batch`로 이어 보낸다. 이미 밀려난 구간이 있으면 먼저
  `gap`을 보낸다. 다 보내면 `resumed`를 보낸다.
- `packages`는 pid 맵에 새 패키지가 생길 때 보낸다. 앱 필터 목록에 쓴다.
- `RendererApi`에 `openLogs(serial)`, `closeLogs()`를 추가한다. `IPC_CHANNELS`에 `openLogs`, `closeLogs`, `logPort`를 추가한다.

### 타임라인

```ts
// shared/types/ipc.ts
interface ToolCallDetail {
  /** 가린 뒤의 인자 JSON. 2KB를 넘으면 자르고 잘렸다고 표시한다. */
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
           | 'log_stopped'
    }
```

- `ToolCallRecord`에 `serial`과 `detail`이 붙는다. `toolContext.ts`의 `ToolCallSink`는 계속 `ToolCallRecord`를 받고, 앱 상태가 이것을 `TimelineEntry`의 `tool_call`로 감싼다.
- `RunToolOpts`에 세 가지를 추가한다. 각각 던지면 그 필드 없이 기록한다. 툴 결과는 바꾸지 않는다.
  - `serial?: () => string | undefined` — 핸들러가 resolve한 기기. 지금 `ui.ts`가 gesture용으로 `target`을 잡아
    두는 방식과 같다. resolve 전에 실패했으면 비운다.
  - `summarise?: (payload) => string` — 결과 요약.
  - `redact?: (args) => unknown` — 기록 전에 인자를 가린다. `argsSummary`와 `detail.args`가 모두 가린 값을 쓴다.
    `ui_text`는 `text`를 `"<N자 가림>"`으로 바꾼다. 비밀번호가 타임라인에 남지 않게 하기 위해서다.
  - `redactError?: (error) => ToolError` — 실패 기록의 `detail.error`에만 적용한다. 에이전트에게 돌려주는 MCP
    에러 결과는 바꾸지 않는다. 던지면 `details`를 버리고 message를 `"<가림 실패>"`로 둔다. `ui_text`는 원문이
    에러의 message·details에 원문 또는 adb용으로 이스케이프한 형태로 섞여 들어오므로(`escapeInputText` 거부,
    adb 명령 실패·타임아웃), 찾아 바꾸지 않고 `details`를 버리고 message를 통째로 갈아 끼운다. `kind`·`hint`는 남긴다.
  - 기록용 에러의 message도 `details`와 같은 2KB 상한으로 자른다.
- `AppSnapshot.toolCalls`는 `timeline`이 된다. `MainEvent`의 `tool_call`은 `timeline`(항목 하나)이 된다.
- `streamManager`와 `logManager`에 상태 변화 콜백을 둔다. 앱 상태가 이 콜백으로 스트림 이벤트와 `log_stopped`를
  기록한다.

## 동작 / 상태

### ref 수명

- 세대는 `ui_find`를 부를 때마다 전역으로 하나 늘어난다. 재검증 덤프는 세대를 만들지 않는다.
- 기기마다 최근 8세대의 ref만 유효하다. 더 오래된 ref는 `stale_ref`다.
- 기기가 끊겼다 다시 붙으면 모든 옛 ref가 무효다. 다른 기기의 ref도 무효다.

### 로그 tail 상태

기기별로 셋 중 하나다.

- `running` — tail 프로세스가 줄을 내고 있다.
- `reconnecting` — 연결 중인데 프로세스가 끝났다. `RECONNECT_DELAYS_MS` 간격으로 다시 띄운다.
  다시 띄울 때는 `-T '<마지막 timestamp>'`로 이어 받는다(셸 표기다. `adbClient.stream`에는 따옴표 없이 인자 하나로 넘긴다). 이 방식은 마지막 timestamp와 같은 시각의 줄을 다시 준다.
  버퍼 끝에서 그 timestamp를 가진 줄과 `(timestamp, pid, tag, message)`가 같은 줄은 버린다. 버린 줄은 `seq`를
  받지 않으므로 `seq`는 끊김 없이 이어진다.
- `stopped` — 재시도가 다 실패했거나 기기가 끊겼다. 기기가 다시 연결되면 `running`부터 새로 시작한다.

버퍼는 기기 연결 동안 유지된다. 끊기면 버린다.

### 로그 탭

- 로그 탭은 활성 기기를 따라간다. 활성 기기가 바뀌면 옛 포트를 닫고 새로 연다.
- renderer 버퍼 상한은 main과 같은 5만 줄이다. `gap`을 받으면 그 자리에 "밀려난 구간" 행을 끼운다.
- 탭이 숨겨지면 `pause`, 다시 보이면 `resume`을 보낸다.
- 필터는 전부 renderer에서 적용한다. 필터를 바꾸면 받은 줄 전체를 다시 거른다.
  - 최소 레벨: V/D/I/W/E/F.
  - 텍스트: 태그·메시지 부분일치. 정규식 토글을 켜면 정규식으로 본다.
  - 태그 칩: 받은 줄에서 많이 나온 태그를 칩으로 보여 준다. 누를 때마다 포함 → 제외 → 해제로 돈다.
    포함 칩이 하나라도 있으면 포함 칩 태그만 보인다. 제외 칩은 언제나 뺀다.
  - 앱: `packages` 목록에서 하나를 고른다. `LogEntry.pkg`가 그 패키지인 줄이 보인다.
- 행 높이는 고정이다. 메시지는 한 줄로 자른다. 행을 누르면 아래 상세 영역에 전문을 보여 준다.
- 가상 스크롤은 직접 만든다. 행 높이가 고정이라 보이는 범위 계산이 짧은 순수 함수로 끝난다. 라이브러리를 들이면
  의존성과 ADR만 늘고 얻는 것이 없다.
- 따라가기: 목록 맨 아래에 있으면 새 줄을 따라간다. 사용자가 위로 스크롤하면 멈추고 "맨 아래로" 버튼이 나온다.
- `reconnecting`이면 탭 위에 띠를 띄운다.
- `WorkArea` 탭 순서는 활동 → 로그 → 에이전트다.

### 활동 탭

- 타임라인 상한은 1000개다. main 링 버퍼와 renderer `useAppState.ts`의 `reduce`가 같은 상한으로 오래된 항목부터 버린다.
- 툴 호출은 지금 모양의 행이다. 기기 이벤트는 흐린 구분선 행으로 끼운다.
- 행을 누르면 그 자리에서 펼친다. 전체 인자(들여쓰기한 JSON), 실패면 message와 hint, 성공이면 결과 요약을
  보여 준다. 가상 스크롤은 쓰지 않는다. 펼친 행 높이가 제각각이라 고정 높이 가상화와 맞지 않는다.
- 필터: 툴 이름, 성공·실패, 기기 이벤트 표시, 텍스트 검색(툴 이름·`detail.args`·에러 message).
- 타임라인은 기록한 순서대로 쌓는다. 툴 호출은 끝날 때 기록되므로 `at`이 앞 항목보다 이를 수 있다.

### 로그 점프

- 툴 호출 상세의 "이 시점 로그 보기"를 누르면 로그 탭으로 바꾼다.
- 점프 요청은 `WorkArea`가 들고 로그 탭에 prop으로 넘긴다. 로그 탭이 숨겨져 있었다면 `resume`을 보내고 `resumed`를 받은 뒤에 점프한다. 그전에 점프하면 아직 오지 않은
  줄 때문에 위치가 틀린다.
- `at >= 호출.at - 2000`인 첫 줄로 스크롤하고 따라가기를 멈춘다. `[호출.at, 호출.at + durationMs]` 구간의 줄은 강조한다.
- 호출의 `serial`이 로그 탭의 기기(`targetSerial`)가 아니거나 비어 있으면 버튼을 끄고 이유를 보여 준다. 점프 때문에 활성 기기를
  바꾸지 않는다. 활성 기기는 에이전트의 기본 대상이다. `serial`이 비어 있으면 "대상 기기가 정해지기 전에 끝난
  호출"이라는 이유를, 다른 기기면 "활성 기기의 호출만" 이유를 따로 보여 준다.
- 점프 요청(`LogJump`)은 호출의 `serial`을 싣는다. 적용 전에 로그 탭의 기기가 바뀌거나 끊기면 `WorkArea`가 요청을
  버리고, 로그 탭도 기기가 다른 요청은 적용하지 않고 `onJumpDone(id, 'skipped')`로 치운다. 새 기기 로그에 옛 호출
  시각·강조를 대거나 한참 뒤에 스크롤을 빼앗지 않게 하기 위해서다.
- 밀려남은 renderer 버퍼로 판단한다. renderer 버퍼는 main과 같은 상한이고 `gap`을 받으므로 같은 구간을 든다.
  그 시각이 renderer 버퍼의 가장 오래된 줄보다 앞이면 "로그 버퍼에서 밀려난 구간이다"라고 알린다.

## 실패 처리

| 상황 | 결과 |
|---|---|
| ref 형식 오류, 대상 기기에 없는 세대, 지문 불일치, 같은 지문 판정 실패 | `stale_ref`. hint는 `ui_find`를 다시 부르라는 것 |
| ref와 좌표를 둘 다 줌, 둘 다 뺌 | 인자 오류 |
| 좌표가 0..1 밖 | zod 인자 오류. 픽셀을 넣던 옛 클라이언트가 여기서 멈춘다 |
| `displayFrame()`이나 `dumpUi()`가 회전을 못 읽음 | `command_failed`. 추측으로 누르지 않는다 |
| 재검증 덤프 실패 | `dumpUi`의 기존 에러를 그대로 올린다 |
| `log_read`의 패키지 pid를 못 찾음 | `package_not_found`. 설치·실행 두 경우를 함께 안내한다 |
| 시계 차이 측정 실패 | `at`을 호스트 수신 시각으로 쓴다. tail은 계속한다 |
| logcat tail 비정상 종료 | 재시도, 포트에 `reconnecting`. 다 실패하면 포트에 `stopped`. M3-3 이후에는 타임라인에 `log_stopped` |
| 닫힌 로그 포트로 늦게 온 메시지 | 포트와 함께 사라진다 |
| renderer가 보낸 모양이 틀린 `LogUp` | main이 버린다 |
| 잘못된 정규식 | 입력칸에 에러를 띄우고 텍스트 필터를 적용하지 않는다 |
| `serial`·`summarise`·`redact` 콜백 실패, 상세 직렬화 실패 | 그 필드 없이 기록한다. `redact`가 실패하면 인자를 통째로 `"<가림 실패>"`로 둔다. 툴 결과는 바꾸지 않는다 |

## 파일 구성

**M3-1 노드 기반 제어**

- `src/shared/types/device.ts` — `UiNode`, `UiDump`, `NormalizedRect`, `DisplayFrame`, `Device.displayFrame`.
- `src/shared/types/errors.ts` — `stale_ref`.
- `src/shared/types/ipc.ts` — 정규화된 `Gesture`, `ScreenSize` 삭제.
- `src/main/device/parsers/uiDump.ts` — 부모 index, 정규화 bounds(0..1 clamp), 상태 플래그, `<hierarchy rotation>` 읽기. 파서 안의 `query` 옵션은 없앤다.
- `src/main/device/androidDevice.ts` — `dumpUi`의 새 반환 모양, `wm size` 캐시, `displayFrame`.
- `src/main/mcp/nodeRefs.ts` — 스냅샷, 지문, 재검증.
- `src/main/mcp/coordinates.ts` — 정규화 좌표와 기기 픽셀 변환, ref 스와이프 궤적.
- `src/main/mcp/tools/ui.ts` — 새 입력과 응답, index 재부여 제거.
- `src/main/mcp/tools/app.ts` — `waitForSettle`이 `UiDump.nodes`를 보게 한다.
- `src/main/mcp/runTool.ts` — `GESTURE_TIMEOUT_MS`·`withGestureTimeout` 삭제.
- `src/main/mcp/screenSize.ts` — 삭제.
- `src/renderer/src/components/GestureOverlay.tsx` — 회전 추정 제거.
- `src/shared/agentGuide.ts` — 안내 갱신.

**M3-2 로그 파이프라인과 로그 패널**

- `src/shared/types/logs.ts` — `LogEntry`, `LogDown`, `LogUp`, `LogPortMeta`.
- `src/shared/types/device.ts` — `LogOpts.pids`.
- `src/main/device/parsers/logcat.ts` — `parseLogcatLine`.
- `src/main/device/androidDevice.ts` — `readLogs`의 `pids` 필터.
- `src/main/logs/logTail.ts`, `logBuffer.ts`, `pidTracker.ts`, `logManager.ts`.
- `src/main/mcp/tools/observe.ts` — `log_read`의 `package`.
- `src/main/mcp/toolContext.ts`, `src/main/mcp/testHarness.ts` — `pidHistory`.
- `src/main/app/bootstrap.ts`, `ipcBridge.ts` — 로그 매니저 조립과 `openLogs`·`closeLogs`.
- `src/preload/index.ts` — `openLogs`·`closeLogs`, `app:log-port` 전달.
- `src/renderer/src/logs/logPort.ts` — 포트 수신.
- `src/renderer/src/logs/logFilter.ts` — 필터 조합(순수).
- `src/renderer/src/logs/virtualRange.ts` — 고정 높이 가상 스크롤 범위 계산(순수).
- `src/renderer/src/hooks/useLogStream.ts` — 포트 연결, 버퍼, pause/resume, gap.
- `src/renderer/src/components/LogTab.tsx`, `LogFilters.tsx`.
- `src/renderer/src/components/WorkArea.tsx` — 로그 탭 추가.

**M3-3 이벤트 타임라인**

- `src/shared/types/ipc.ts` — `TimelineEntry`, `ToolCallDetail`, `AppSnapshot.timeline`, `MainEvent.timeline`.
- `src/main/mcp/runTool.ts` — `serial`, `detail`, `summarise`, `redact`.
- `src/main/mcp/tools/*.ts` — 툴별 `serial`·`summarise`, `ui_text`의 `redact`.
- `src/main/app/appState.ts` — 타임라인 링과 기기·스트림·로그 이벤트 기록.
- `src/main/stream/streamManager.ts`, `src/main/logs/logManager.ts` — 상태 콜백.
- `src/renderer/src/state/useAppState.ts` — `reduce`의 `timeline` 분기와 상한.
- `src/renderer/src/components/GestureOverlay.tsx` — `timeline` 이벤트 구독.
- `src/renderer/src/components/WorkArea.tsx` — `snapshot.timeline` 전달.
- `src/renderer/src/components/ActivityTab.tsx`, `TimelineDetail.tsx`, `TimelineFilters.tsx`.

## 테스트

vitest와 TDD로 간다. 실기기가 필요한 테스트는 `*.integration.test.ts`로 나눈다.

- **노드**
  - `uiDump`: 부모 index, 정규화 bounds, 래퍼 제거, `scrollable`, `<hierarchy rotation>` 읽기. 가로 화면 덤프와
    다이얼로그 덤프 픽스처를 추가한다. 다이얼로그 덤프에서 bounds가 디스플레이 기준인지 확인한다.
  - `androidDevice`: `wm size` 캐시, `dumpsys window displays`의 `mDisplayRotation` 파싱. scrcpy 가상 디스플레이가
    섞인 출력 픽스처를 쓴다. 회전을 못 읽으면 `command_failed`.
  - `nodeRefs`: 전역 세대, 세대 만료, 다른 기기 ref와 재연결 전 ref의 `stale_ref`, 지문 일치·불일치, EditText의
    text 제외, 이동한 단일 노드의 새 bounds, 같은 지문 여럿에서 개수 불일치와 최근접 불일치의 `stale_ref`.
  - `coordinates`: 네 방향 회전, 범위 경계, ref 스와이프 네 방향 궤적.
  - `ui.ts`: `ui_find` 응답 모양(`generation`, `ref`, `parentRef`), ref와 좌표의 배타 검증, 0..1 범위 검증,
    ref `ui_text`의 탭 후 입력 순서와 tap gesture.
  - `app.ts`: `waitForSettle`이 새 덤프 모양에서 같은 판정을 한다.
  - `GestureOverlay`: 정규화 좌표를 비디오 크기로 그린다.
- **로그**
  - `parseLogcatLine`.
  - 시계 보정: 차이 적용, 연도 경계, 측정 실패 시 수신 시각.
  - `logBuffer`: 링 동작, `seq`, `at` 탐색.
  - `pidTracker`: `ps` 초기화, `Start proc`의 `:suffix` 프로세스명, pid 재사용, 죽은 pid 보존, `pkg` 부여.
  - `logManager`: 연결·끊김에 따른 tail 시작·종료, 재시작 간격, `-T` 이어 받기와 경계 중복 제거, `pidHistory`의
    `pidof` 폴백.
  - 포트 프로토콜: 청크 `snapshot`과 `done`, `batch`, `pause` 중 버퍼 누적, `resume`의 `gap`·이어 보내기·`resumed`,
    `openLogs` 시 이전 포트 닫기, 잘못된 `LogUp` 무시.
  - `log_read`의 `package` 필터와 `package_not_found` hint.
  - renderer: `virtualRange`, `logFilter` 조합, 태그 칩 3상태, 따라가기와 멈춤, 잘못된 정규식, 활성 기기 변경 시
    포트 재연결, 탭 숨김 시 `pause`, `gap` 행, `reconnecting` 띠.
- **타임라인**
  - `runTool`: `serial`, `detail` 상한, `summarise`·`redact` 실패 격리, `ui_text`의 가림.
  - `appState`: 링 상한, registry 이벤트·스트림 상태·`log_stopped` 기록.
  - renderer: `reduce` 상한, 필터 조합, 상세 펼침, 숨겨진 로그 탭에서 `resumed` 뒤 점프, 점프 위치와 강조,
    비활성 기기에서 버튼 비활성, 밀려난 구간 안내.
- **가이드 일관성**: `guideConsistency.test.ts`가 새 툴 설명과 안내를 대조한다.
- **통합**: 실제 에뮬레이터에서 `ui_find` → `ui_tap({ ref })`, 화면 전환 뒤 옛 ref의 `stale_ref`, logcat tail이
  실제 줄을 받는지.

## 완료 조건

각 계획의 마지막 태스크에서 실기기로 확인한다. 대상 앱은 모든 에뮬레이터에 있는 설정 앱(`com.android.settings`)이다.

- **M3-1**
  - 에이전트가 좌표 없이 ref만으로 설정 앱에서 검색창을 누르고, 검색어를 입력하고, 결과 항목을 누른다.
  - `ui_swipe({ ref, direction: 'down' })`로 설정 메인 목록이 아래로 스크롤된다.
  - 화면을 바꾼 뒤 옛 ref로 누르면 아무것도 누르지 않고 `stale_ref`로 멈춘다.
  - 가로 화면에서 좌표 탭이 의도한 위치에 맞고 오버레이도 그 위치에 뜬다.
  - 다이얼로그가 떠 있을 때 `ui_find`의 bounds로 다이얼로그 버튼을 누를 수 있다.

- **M3-2a**
  - `adb shell am crash com.android.settings`로 크래시시킨 뒤 `log_read({ package: 'com.android.settings' })`가
    크래시 스택을 준다. 프로세스가 죽은 뒤에도 준다.
- **M3-2b**
  - 같은 크래시 뒤 로그 탭의 앱 필터로 크래시 스택이 보인다. 프로세스가 죽은 뒤에도 보인다.
  - `adb shell 'while true; do log -t M3LOAD load; done'`로 부하를 거는 동안 스크롤, 필터 입력, 탭 전환이 멈추지
    않는다. main 버퍼와 renderer 버퍼가 5만 줄에서 더 늘지 않는다.
- **M3-3**
  - 실패한 툴 호출의 상세에서 "이 시점 로그 보기"로 그 호출 시각 근처 로그에 도착한다.
  - 기기를 끊었다 붙이면 타임라인에 기기 이벤트가 끼인다.
  - `ui_text`로 넣은 텍스트가 타임라인 어디에도 원문으로 남지 않는다.

### M3-1 검증 결과 (2026-09-28)

- **통합 테스트** (`npm run test:integration -- src/main/device/androidDevice.nodeRefs.integration.test.ts`, PASS,
  대상 emulator-5554): 설정 앱에서 `ui_find`로 얻은 ref를 `nodeRefs.resolve`로 동작 직전 재검증한 뒤
  `androidDevice.tap`으로 누르면 실제로 화면이 바뀐다는 것, 그리고 화면이 바뀐 뒤 옛 ref로 `resolve`를 부르면
  아무것도 누르지 않고 `stale_ref`로 거절한다는 것을 실기기로 확인했다. `nodeRefs.ts`의 재검증·지문 규칙과
  `coordinates.ts`의 `centerOf`·`toPixel` 변환이 실제 uiautomator 덤프·탭 위에서 맞물려 동작함을 보인다.
- 에이전트가 좌표 없이 ref만으로 설정 앱에서 검색창을 누르고, 검색어를 입력하고, 결과 항목을 누른다 —
  미검증 — 앱+MCP 클라이언트로 사용자 확인 필요
- `ui_swipe({ ref, direction: 'down' })`로 설정 메인 목록이 아래로 스크롤된다 —
  미검증 — 앱+MCP 클라이언트로 사용자 확인 필요
- 화면을 바꾼 뒤 옛 ref로 누르면 아무것도 누르지 않고 `stale_ref`로 멈춘다(MCP `ui_tap` 툴 경로) —
  미검증 — 앱+MCP 클라이언트로 사용자 확인 필요
- 가로 화면에서 좌표 탭이 의도한 위치에 맞고 오버레이도 그 위치에 뜬다 —
  미검증 — 앱+MCP 클라이언트로 사용자 확인 필요
- 다이얼로그가 떠 있을 때 `ui_find`의 bounds로 다이얼로그 버튼을 누를 수 있다 —
  미검증 — 앱+MCP 클라이언트로 사용자 확인 필요

### M3-2a 검증 결과 (2026-09-28)

- **통합 테스트** (`npm run test:integration -- src/main/logs/logTail.integration.test.ts`, PASS,
  대상 emulator-5554):
  - `createLogTail`이 실제 logcat 스트림에서 `adb shell log -t VDH_M3 <메시지>`로 쓴 줄을 5초 안에 받고,
    `parseDeviceClock(adb shell date +%s%3N%z)`로 잰 기기 epoch와 tz offset이 폴백 없이 읽힌다는 것을 실기기로 확인했다.
  - MCP 클라이언트 없이 `log_read({ package })` 경로를 그대로 재현한 두 번째 케이스: `createLogTail`이 먹이는
    `createPidTracker`가 `ps -A -o PID,NAME` seed와 `ActivityManager`의 `Start proc` 줄로 설정 앱 pid를 배우고,
    `adb shell am crash com.android.settings`로 죽인 뒤 `adb shell pidof com.android.settings`가 빈 값이 된
    상태에서도 tracker가 기억한 pid로 `androidDevice.ts`의 `readLogs({ pids })`를 부르면 `FATAL EXCEPTION`
    또는 태그 `AndroidRuntime`인 크래시 스택이 돌아온다는 것을 확인했다. `pidTracker.ts`의 pid 기록과
    `readLogs`의 pid 필터가 실제 크래시 위에서 맞물려 동작함을 보인다.
- **통합 테스트** (`npm run test:integration -- src/main/logs/logRead.integration.test.ts`, PASS,
  대상 emulator-5554): `index.ts`와 같은 조각 — `trackDevices` 기반 `createDeviceRegistry`, 실제 `createLogTail`을
  쓰는 `createLogManager`, `adbLogDeps.ts`의 `createSeedPids`·`createPidof` — 을 묶고, MCP 툴 층은
  `testHarness.ts`의 `createToolHarness`(인메모리 전송)에 `pidHistory: logs.pidHistory`로 붙였다. 설정 앱을 띄워
  tail이 `Start proc` 줄을 받은 뒤 `adb shell am crash com.android.settings`로 죽이고, `pidof`가 빈 값이 된 뒤
  MCP `log_read({ package: 'com.android.settings' })`를 부르면 크래시 스택이 돌아온다는 것을 확인했다.
- `adb shell am crash com.android.settings`로 크래시시킨 뒤 `log_read({ package: 'com.android.settings' })`가
  크래시 스택을 준다. 프로세스가 죽은 뒤에도 준다 — MCP 툴 경로는 위 통합 테스트로 프로세스 안에서 검증됨.
  HTTP 전송과 앱 조립(`bootstrap.ts`)을 거친 경로만 미검증 — 앱+MCP 클라이언트로 사용자 확인 필요

### M3-2b 검증 결과 (2026-09-28)

- 설정 앱을 크래시시킨 뒤 로그 탭의 앱 필터로 크래시 스택이 보이고, `pidof`가 빈 뒤에도 보인다 —
  미검증 — 앱에서 사용자 확인 필요
- `adb shell 'while true; do log -t M3LOAD load; done'`로 부하를 거는 동안 스크롤·필터 입력·탭 전환이 멈추지
  않는다 — 미검증 — 앱에서 사용자 확인 필요
- 같은 부하에서 로그 탭의 줄 수가 5만에서 더 늘지 않는다 — 미검증 — 앱에서 사용자 확인 필요
- 로그 탭을 숨겼다가 다시 열면 빠진 줄이 채워지거나 "밀려난 구간" 행이 보인다 — 미검증 — 앱에서 사용자 확인 필요
- 자동화 테스트가 덮는 범위: renderer 단위 테스트가 버퍼 상한·pause/resume와 `gap`(`useLogStream.test.tsx`),
  따라가기·스크롤(`LogTab.test.tsx`), 필터 조합(`logFilter.test.ts`, `LogFilters.test.tsx`)을 실기기 부하 없이
  확인하고, M3-2a의 크래시 로그 경로는 `logRead.integration.test.ts` 통합 테스트가 확인한다.

### M3-3 검증 결과 (2026-09-29)

- 옛 ref로 `ui_tap`을 불러 일부러 실패시킨 뒤(`stale_ref`) 활동 탭에서 그 행을 펼쳐 "이 시점 로그 보기"를
  누르면 로그 탭이 그 호출 시각 근처로 스크롤되고 강조가 보인다 — 확인됨 (`Pixel_7_API_36` 에뮬레이터)
- 로그 탭을 숨긴 상태에서 같은 조작을 반복해도 같은 위치로 간다 — 확인됨
- 에뮬레이터를 끊었다 붙이면(`adb disconnect`/`adb connect` 또는 재시작) 타임라인에 연결 끊김·연결됨 행이
  끼인다 — 확인됨 (`adb -s emulator-5554 reconnect`로 끊음. 연결 끊김·연결됨·활성 기기 해제됨 행이 끼인다)
- `ui_text`로 `hunter2`를 넣은 뒤 활동 탭 상세와 `getSnapshot` 결과 어디에도 `hunter2`가 없다 —
  확인됨 (성공한 `hunter2`와 `%` 때문에 거부된 `hunter2%` 두 호출 모두 상세에 가림 문구만 보이고, 활동 탭
  텍스트 검색에 `hunter2`를 넣어도 걸리는 행이 없다. `getSnapshot`은 renderer IPC라 화면과 검색으로 대신 확인했다)
- 자동화 테스트가 덮는 범위: 입력 텍스트를 가리는 것은 `runTool.test.ts`(`argsSummary`·`detail.args` 모두
  가림, `redact`가 던지면 `<가림 실패>`, `redactError`는 기록용 에러에만 적용되고 던지면 `details`를 버리고
  message를 `<가림 실패>`로 둠, 기록용 에러 message의 2KB 상한)와 `ui.test.ts`(`ui_text`가 성공할 때, 그리고
  `escapeInputText` 거부·adb 명령 실패·adb 타임아웃 모양의 `DeviceError`로 실패할 때 `ToolCallRecord`를
  직렬화한 결과에 원문도 adb용으로 이스케이프한 형태도 없고, 에이전트가 받는 에러 message는 그대로임)가
  실기기 없이 확인한다. 실패 경로는 가짜 기기가 그 모양의 에러를 던지게 해서 확인한다. 그중 `escapeInputText`
  거부는 위의 앱 확인에서 실제 경로로도 확인했고, adb 명령 실패와 타임아웃은 `adbClient.ts`가 실제로 만드는
  에러로는 확인하지 않았다. 활동 탭 화면에 원문이 없는지는 위의 앱 확인 항목이다. 타임라인에 툴 호출과 기기·스트림·로그 이벤트가 함께 쌓이는 것은 `appState.test.ts`
  (1000개 상한, registry의 연결·해제·활성 전환 기록), `bootstrap.test.ts`(스트림·로그 훅이 기기 이벤트로
  이어짐), `streamManager.test.ts`(started·reconnecting·stopped 보고), `logManager.test.ts`(tail 상태 보고)가
  확인하고, 창을 연 직후 스냅샷과 겹쳐 온 이벤트의 중복 제거와 1000개로 자르기는 `useAppState.test.tsx`가
  확인한다. 활동 탭의 기기 이벤트 행·상세 펼침·필터는 `ActivityTab.test.tsx`·`TimelineDetail.test.tsx`·
  `timelineFilter.test.ts`가 확인하고, 호출 시점 로그 점프는 로그 탭이 숨겨진 채 점프를 받았다가 `caughtUp`이
  된 뒤에야 적용되는 경로, 다른 기기용 요청을 적용하지 않고 치우는 경로, 치운 뒤 같은 호출을 다시 누르면
  다시 점프하는 경로를 포함해 `LogTab.test.tsx`가, 적용 전에 활성 기기가 바뀌면 요청을 버리는 것은
  `WorkArea.test.tsx`가 확인한다.

## 계획 분할

- **M3-1 노드 기반 제어** — 로그·타임라인과 독립이다.
- **M3-2 로그 파이프라인과 로그 패널** — M3-1과 독립이다. 계획은 둘로 나눈다.
  - **M3-2a 로그 코어** — main의 tail·버퍼·pid 추적·포트, preload, `log_read`의 `package`.
  - **M3-2b 로그 패널** — renderer의 포트 수신, 로그 탭 UI. M3-2a에 기댄다.
- **M3-3 이벤트 타임라인** — 두 계획 모두에 기댄다. 로그 점프와 `log_stopped`는 M3-2에, `Gesture` 모양과
  `GestureOverlay` 수정은 M3-1에 기댄다.

실행 순서는 M3-1 → M3-2a → M3-2b → M3-3이다. M3-1과 M3-2a는 순서를 바꿔도 된다. `toolContext.ts`와 `testHarness.ts`는 M3-2a가 고친다.

## 열린 질문

- ref 동작마다 덤프가 한 번 더 들어 1~2초 느려진다. 실사용에서 문제가 되면 "직전 덤프가 아주 최근이면
  재사용"을 얹는다. 기준 시간은 실측 뒤에 정한다.
- 로그 버퍼 5만 줄, 배치 100ms, snapshot 청크 5000줄은 아직 출발값이다. M3-2b 완료 검증(위 "M3-2b 검증 결과"
  참고)이 앱에서 아직 끝나지 않아, 메모리와 스크롤을 보고 조정할지는 정해지지 않았다.
- 태그 칩으로 보여 줄 태그 수도 아직 출발값이다. 같은 M3-2b 앱 확인 뒤 로그 탭 폭을 보고 정한다.
