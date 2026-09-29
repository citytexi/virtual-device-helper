---
id: m3-3-event-timeline         # 파일명에서 날짜 접두사를 뺀 slug
title: M3-3 — 이벤트 타임라인
status: done                    # draft | in-progress | done | abandoned | superseded
type: work-order                # work-order | handoff
created: 2026-09-28
updated: 2026-09-29
owner: virtual-device-helper 팀
scope: [main, mcp, renderer, shared, docs]
hosts: []                       # windows | macos — 호스트 OS마다 작업이 갈릴 때만 채운다
archived_reason:                # done/abandoned 시 사유 (활성 계획은 비움)
related_adr: [ADR-0013]
related_spec: m3-node-control-logs-events
related_architecture: main-layers
related_plan: [m3-1-node-control, m3-2a-log-core, m3-2b-log-panel]
related_code: [runTool.ts#runTool, toolContext.ts#ToolCallSink, appState.ts#createAppState, streamManager.ts#createStreamManager, useAppState.ts#reduce, ActivityTab.tsx#ActivityTab, WorkArea.tsx#WorkArea, GestureOverlay.tsx#GestureOverlay]
tags: [plan, timeline, renderer, mcp]
---

# M3-3 — 이벤트 타임라인 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: `superpowers:subagent-driven-development`(권장) 또는
> `superpowers:executing-plans`로 task 단위 구현. 각 단계는 체크박스(`- [ ]`)로 추적한다.

**Goal:** 툴 호출과 기기·스트림·로그 이벤트를 한 타임라인에 쌓고, 활동 탭에서 거르고 펼쳐 보며, 호출 시점의 로그로
바로 가게 한다.

**Architecture:** `runTool`이 호출마다 대상 기기·가린 인자·에러·결과 요약을 기록한다. 앱 상태 층의 툴 호출 링을
`TimelineEntry` 링으로 넓히고, registry·`streamManager`·`logManager`의 상태 변화를 같은 링에 넣는다. renderer는
`timeline` 이벤트 하나로 활동 탭과 제스처 오버레이를 채우고, 로그 점프는 `LogTab`의 `jump` prop과 M3-2b의 `findJumpIndex`로 한다.

**Tech Stack:** TypeScript, React 19, `@modelcontextprotocol/sdk` 1.30, Vitest, @testing-library/react

**Spec:** [`../specs/2026-09-28-m3-node-control-logs-events.md`](../specs/2026-09-28-m3-node-control-logs-events.md)
— "타임라인", "활동 탭", "로그 점프" 절.

**선행 조건:** [M3-1](2026-09-28-m3-1-node-control.md), [M3-2a](2026-09-28-m3-2a-log-core.md),
[M3-2b](2026-09-28-m3-2b-log-panel.md)가 끝나 있어야 한다. 이 계획은 M3-1의 정규화 `Gesture`와 `GestureOverlay`,
M3-2a의 `createLogManager`·`TailState`, M3-2b의 `LogTab`·`findJumpIndex`·`LogStream.caughtUp`을 쓴다.

## Global Constraints

- 답변·주석·문서는 한국어로 쓴다. 기술 용어·API 이름·명령어·에러 문자열은 원문 그대로 둔다.
- 타임라인 상한은 1000개다. main 링과 renderer `reduce`가 같은 상한으로 오래된 항목부터 버린다.
- `ToolCallDetail.args`는 가린 인자의 JSON이고 2KB를 넘으면 자른다. `error.details`도 같은 상한이다.
- `ui_text`의 `text`는 `"<N자 가림>"`으로 기록한다(N은 코드포인트 수). `argsSummary`와 `detail.args`가 모두 가린 값을 쓴다.
- `serial`·`summarise`·`redact` 콜백이 던져도 툴 결과는 바꾸지 않는다. `redact`가 던지면 인자를 통째로 `"<가림 실패>"`로 둔다.
- 로그 점프는 활성 기기를 바꾸지 않는다. 버튼 기준 기기는 로그 탭과 같은 `useAppState.ts#targetSerial(snapshot)`이다. 호출의 `serial`이 그것과 다르면 버튼을 끈다.
- 타임라인은 기록한 순서대로 쌓는다(`at`으로 다시 정렬하지 않는다). 툴 호출은 끝날 때 기록되므로 `at`(=`startedAt`)이 앞 항목보다 이를 수 있다.
- MCP 툴 층(`src/main/mcp/`)은 `src/main/logs/`와 adb를 import하지 않는다(`layering.test.ts`).
- 점프 대상 시각은 `호출.at - 2000`, 강조 구간은 `[호출.at, 호출.at + durationMs]`다.
- 새 npm 의존성을 들이지 않는다. 스타일은 `app.css`의 기존 토큰만 쓴다.
- 각 task 끝에서 `npm test`와 `npm run typecheck`가 통과해야 한다. 바뀐 모양 때문에 깨지는 기존 테스트는 같은 task에서 고친다.
- 문서에는 라인번호, 파일·툴 개수, 진행률을 적지 않는다. 파일명과 심볼명으로 가리킨다.
- 문서를 고치면 `python3 docs/script/docs.py lint`와 `python3 docs/script/docs.py links`를 돌린다.
- 커밋 메시지는 한국어 Conventional Commits(`feat(renderer): ...한다`)이고, 끝에 다음 줄을 붙인다:
  `Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>`

## Review Focus

- **비밀번호 입력**: `ui_text`로 넣은 문자열이 활동 탭, 상세, 스냅샷 어디에도 원문으로 남으면 안 된다. → Task 1·2 테스트.
- **스냅샷보다 먼저 온 이벤트**: 창을 연 직후 `timeline` 이벤트가 스냅샷보다 먼저 와도 같은 항목이 두 번 쌓이면 안 된다. → Task 3 테스트.
- **필터가 점프 대상을 가림**: 로그 탭에 필터가 걸려 있으면 대상 시각 이후의 첫 "보이는" 줄로 가야 한다. 빈 화면에 멈추면 안 된다. → Task 5 테스트.
- **숨겨진 로그 탭에서의 점프**: `resumed`가 오기 전에 점프하면 위치가 틀린다. → Task 5 테스트.
- **거대한 인자**: 긴 `filter`·`query` 인자가 스냅샷 IPC를 부풀리면 안 된다. → Task 1 테스트.

---

### Task 1: 툴 호출 기록에 기기·가린 인자·에러·요약을 싣는다

**Files:**
- Modify: `src/shared/types/ipc.ts` (`ToolCallDetail`, `ToolCallRecord.serial?`, `ToolCallRecord.detail`)
- Modify: `src/main/mcp/runTool.ts`
- Modify (`detail`이 필수가 되어 깨지는 `ToolCallRecord` 리터럴): `src/main/app/appState.test.ts`, `src/main/app/bootstrap.test.ts`, `src/renderer/src/state/useAppState.test.tsx`, `src/renderer/src/components/ActivityTab.test.tsx`, `src/renderer/src/components/GestureOverlay.test.tsx`, `src/renderer/src/components/DeviceScreen.test.tsx`
- Test: `src/main/mcp/runTool.test.ts`

**Interfaces:**
- Consumes: `ToolError`
- Produces:
  - `interface ToolCallDetail { args: string; error?: ToolError; resultSummary?: string }`
  - `ToolCallRecord`에 `serial?: string`, `detail: ToolCallDetail` 추가
  - `RunToolOpts`에 `serial?: () => string | undefined`, `summarise?: (payload: unknown) => string`, `redact?: (args: unknown) => unknown` 추가
  - `const DETAIL_LIMIT_BYTES = 2048`
  - `redactText(text: string): string` → `"<N자 가림>"` — `src/main/mcp/runTool.ts`에서 export
  - `error.details`가 2KB를 넘으면 `{ truncated: '<앞부분 JSON>…(잘림)' }`으로 바꾼다(`Record<string, unknown>` 모양 유지)

- [ ] **Step 1: 실패하는 테스트를 쓴다**

```ts
it('records the serial the handler resolved', async () => {
  await runTool(sink, 't', {}, async () => ({}), { serial: () => 'emulator-5554' })
  expect(sink.records[0]?.serial).toBe('emulator-5554')
})
it('records the full args json in detail', async () => {})
it('truncates detail args past 2KB and marks it', async () => {
  await runTool(sink, 't', { q: 'x'.repeat(5000) }, async () => ({}))
  const args = sink.records[0]!.detail.args
  expect(Buffer.byteLength(args)).toBeLessThanOrEqual(2048)
  expect(args.endsWith('…(잘림)')).toBe(true)
})
it('applies redact to both argsSummary and detail.args', async () => {
  await runTool(sink, 'ui_text', { text: 'hunter2' }, async () => ({}), { redact: (a) => ({ ...(a as object), text: redactText('hunter2') }) })
  const r = sink.records[0]!
  expect(r.argsSummary).not.toContain('hunter2')
  expect(r.detail.args).toContain('<7자 가림>')
})
it('replaces args with <가림 실패> when redact throws', async () => {})
it('stores the ToolError in detail on failure', async () => { /* message·hint 그대로 */ })
it('replaces oversized error details with a truncated string field', async () => {})
it('records without detail.args when the args cannot be serialized', async () => {
  const args: Record<string, unknown> = {}; args.self = args
  // 순환 참조 → 툴 결과는 그대로, detail.args는 '<직렬화 실패>'
})
it('stores a result summary on success and none when summarise throws', async () => {})
it('keeps the tool result unchanged when serial or summarise throws', async () => {})
```

- [ ] **Step 2: 실패를 확인한다**

Run: `npx vitest run src/main/mcp/runTool.test.ts`
Expected: FAIL

- [ ] **Step 3: 구현한다**

`redact`를 먼저 적용하고 그 결과로 `summariseArgs`와 `detail.args`를 만든다. 자르기는 UTF-8 바이트 기준이고 코드포인트 경계에서 자른다(`observe.ts`의 `truncateMessage`와 같은 이유). 표식은 `…(잘림)`. 콜백은 각각 try/catch로 감싼다.

- [ ] **Step 4: 통과를 확인한다**

Run: `npm test && npm run typecheck`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add -A src
git commit -m "feat(mcp): 툴 호출 기록에 대상 기기와 가린 인자, 에러, 결과 요약을 싣는다"
```

---

### Task 2: 툴마다 대상 기기·요약·가림을 알린다

**Files:**
- Modify: `src/main/mcp/tools/device.ts`, `app.ts`, `ui.ts`, `observe.ts`
- Test: `src/main/mcp/tools/*.test.ts`

**Interfaces:**
- Consumes: `RunToolOpts.serial`·`summarise`·`redact`, `redactText` (Task 1)
- Produces: 없음 (기록 내용만 바뀐다)

- [ ] **Step 1: 실패하는 테스트를 쓴다**

```ts
// ui.test.ts
it('never records typed text in the clear', async () => {
  await harness.call('ui_text', { text: 'hunter2' })
  expect(JSON.stringify(harness.records)).not.toContain('hunter2')
  expect(harness.records[0]?.detail.args).toContain('<7자 가림>')
})
it('records the serial of ui_tap', async () => {})
it('summarises ui_find as 노드 N개', async () => {})
// observe.test.ts
it('summarises log_read as 로그 N줄 and screenshot as W×H PNG', async () => {})
// device.test.ts / app.test.ts
it('records the resolved serial for app_launch', async () => {})
it('records no serial when resolve fails', async () => {})
```

- [ ] **Step 2: 실패를 확인한다**

Run: `npx vitest run src/main/mcp/tools`
Expected: FAIL

- [ ] **Step 3: 구현한다**

기기를 resolve하는 모든 툴이 `let target: Device | null`을 잡고 `serial: () => target?.serial`을 넘긴다(`ui.ts`에 이미 있는 방식). 요약: `ui_find` → `노드 ${nodes.length}개`, `log_read` → `로그 ${lines.length}줄`, `screenshot` → `${width}×${height} PNG`. `screenshot`의 payload에는 크기가 없으므로 핸들러가 `shot`을 클로저에 잡아 두고 `summarise`가 그것을 읽는다. `ui_text`만 `redact`로 `text`를 가린다.

- [ ] **Step 4: 통과를 확인한다**

Run: `npm test && npm run typecheck`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/main/mcp/tools
git commit -m "feat(mcp): 툴마다 대상 기기와 결과 요약을 기록하고 입력 텍스트를 가린다"
```

---

### Task 3: 타임라인 링과 이벤트 전환

**Files:**
- Modify: `src/shared/types/ipc.ts` (`TimelineEntry`, `AppSnapshot.timeline`, `MainEvent`의 `tool_call`을 `{ type: 'timeline'; entry: TimelineEntry }`로)
- Modify: `src/main/app/appState.ts`
- Modify: `src/main/stream/streamManager.ts` (`StreamManagerDeps.onState?: (serial: string, state: 'started' | 'reconnecting' | 'stopped') => void`)
- Modify: `src/main/logs/logManager.ts` (`LogManagerDeps.onTailState?: (serial: string, state: TailState) => void`)
- Modify: `src/main/app/bootstrap.ts`, `src/main/index.ts` — 매니저 팩토리에 훅을 넘긴다:
  `BootstrapDeps.createStreamManager(registry, paths, hooks: { onState(serial, state): void })`,
  `BootstrapDeps.createLogManager(registry, paths, hooks: { onTailState(serial, state): void })`.
  `index.ts`는 받은 훅을 `createStreamManager`·`createLogManager`의 deps로 그대로 넘긴다.
- Modify (`toolCalls`→`timeline`, `tool_call`→`timeline` 이벤트): `src/renderer/src/App.test.tsx`, `src/renderer/src/components/DevicePanel.test.tsx`, `src/renderer/src/components/WorkArea.test.tsx`, `src/renderer/src/components/DeviceScreen.test.tsx`, `src/main/app/bootstrap.test.ts`의 스냅샷·이벤트 fixture
- Modify: `src/renderer/src/state/useAppState.ts`, `src/renderer/src/components/GestureOverlay.tsx`, `src/renderer/src/components/WorkArea.tsx`, `src/renderer/src/components/ActivityTab.tsx`
- Test: `src/main/app/appState.test.ts`, `src/main/stream/streamManager.test.ts`, `src/main/logs/logManager.test.ts`, `src/main/app/bootstrap.test.ts`, `src/renderer/src/state/useAppState.test.tsx`, `src/renderer/src/components/GestureOverlay.test.tsx`, `src/renderer/src/components/ActivityTab.test.tsx`

**Interfaces:**
- Consumes: `ToolCallRecord` (Task 1), `TailState` (M3-2a)
- Produces:
  - 스펙 "타임라인" 절의 `TimelineEntry` 그대로. `tool_call` 항목의 `at`은 `ToolCallRecord.startedAt`이다.
  - `AppState.recordToolCall(record: ToolCallRecord): void` (이름 유지), `AppState.recordDeviceEvent(serial: string | null, event: DeviceTimelineEvent): void`
  - `type DeviceTimelineEvent = 'connected' | 'disconnected' | 'active_changed' | 'stream_started' | 'stream_stopped' | 'stream_reconnecting' | 'log_stopped'`
  - `const TIMELINE_LIMIT = 1000` (`src/shared/limits.ts`)
  - `ToolCallSink.onToolCall(record: ToolCallRecord)`는 그대로다. 앱 상태가 `TimelineEntry`로 감싼다(`toolContext.ts`·`testHarness.ts`는 바꾸지 않는다).

- [ ] **Step 1: 실패하는 테스트를 쓴다**

```ts
// appState.test.ts
it('keeps at most 1000 timeline entries', () => {})
it('records registry connect, disconnect and active change as device entries', () => {})
it('emits a timeline event for a tool call and puts it in the snapshot', async () => {})

// streamManager.test.ts
it('reports started when streaming, reconnecting on retry, stopped on close and failure', async () => {})

// logManager.test.ts
it('reports tail state through onTailState', () => {})

// bootstrap.test.ts
it('records log_stopped when a tail stops while the device is still connected', async () => {})

// useAppState.test.tsx
it('does not duplicate an entry that arrives before and inside the snapshot', async () => {})
it('trims the renderer timeline to 1000', async () => {})

// GestureOverlay.test.tsx
it('draws the gesture of a timeline tool_call entry', () => {})
```

기존 `tool_call` 이벤트 기반 테스트는 `timeline` 이벤트로 옮긴다.

- [ ] **Step 2: 실패를 확인한다**

Run: `npm test`
Expected: FAIL

- [ ] **Step 3: 구현한다**

- `appState`는 `toolCalls` 배열을 `timeline: TimelineEntry[]`로 바꾸고 기본 상한을 `TIMELINE_LIMIT`로 한다. registry 구독에서 `device_connected`·`device_disconnected`·`active_changed`를 기록한다(`tracking_failed`는 기록하지 않는다). 기록할 때마다 `{ type: 'timeline', entry }`를 낸다.
- `streamManager`는 `streaming` → `started`, `reconnecting` → `reconnecting`, 세션 닫힘·`failed` → `stopped`로 `onState`를 부른다.
- `bootstrap`은 팩토리에 넘긴 훅에서 `onState`를 `stream_*`로, `onTailState`의 `stopped`를 기기가 아직 연결돼 있을 때만 `log_stopped`로 기록한다(끊김으로 멈춘 것은 `disconnected`가 이미 말한다).
- `useAppState.ts#reduce`는 `timeline` 이벤트를 id로 중복 제거하고 `TIMELINE_LIMIT`로 자른다.
- `GestureOverlay`는 `event.type === 'timeline' && event.entry.kind === 'tool_call'`의 `gesture`를 그린다.
- `WorkArea`는 `snapshot.timeline`을 넘기고, `ActivityTab`은 이 task에서는 `tool_call` 항목만 지금 모양으로 그린다.

- [ ] **Step 4: 통과를 확인한다**

Run: `npm test && npm run typecheck`
Expected: PASS. `grep -rn "'tool_call'" src` 결과는 `TimelineEntry` 정의와 `kind === 'tool_call'` 비교만 남는다. `grep -rn "toolCalls" src` 결과가 없다.

- [ ] **Step 5: Commit**

```bash
git add -A src
git commit -m "feat(main): 툴 호출과 기기·스트림·로그 이벤트를 한 타임라인에 쌓는다"
```

---

### Task 4: 활동 탭 — 기기 이벤트 행, 상세 펼침, 필터

**Files:**
- Create: `src/renderer/src/timeline/timelineFilter.ts`
- Create: `src/renderer/src/components/TimelineDetail.tsx`, `src/renderer/src/components/TimelineFilters.tsx`
- Modify: `src/renderer/src/components/ActivityTab.tsx`, `src/renderer/src/app.css`
- Test: `src/renderer/src/timeline/timelineFilter.test.ts`, `src/renderer/src/components/ActivityTab.test.tsx`, `src/renderer/src/components/TimelineDetail.test.tsx`

**Interfaces:**
- Consumes: `TimelineEntry` (Task 3)
- Produces:
  - `interface TimelineFilter { tool: string | null; result: 'all' | 'ok' | 'fail'; showDevice: boolean; text: string }`
  - `const EMPTY_TIMELINE_FILTER: TimelineFilter` — `{ tool: null, result: 'all', showDevice: true, text: '' }`
  - `matchTimeline(entry: TimelineEntry, filter: TimelineFilter): boolean`
  - `ActivityTab({ entries, targetSerial, onJumpToLogs }: { entries: TimelineEntry[]; targetSerial: string | null; onJumpToLogs?: (entry: ToolCallEntry) => void })` — `WorkArea`가 `targetSerial(snapshot)`을 넘긴다
  - `TimelineDetail({ entry, targetSerial, onJumpToLogs })`
  - `type ToolCallEntry = Extract<TimelineEntry, { kind: 'tool_call' }>`

- [ ] **Step 1: 실패하는 테스트를 쓴다**

```ts
// timelineFilter.test.ts
it('filters by tool name and result', () => {})
it('hides device entries when showDevice is off, and tool filter never hides them otherwise', () => {})
it('searches tool name, detail.args and error message case-insensitively', () => {
  // argsSummary는 120자로 잘리므로 뒤쪽 인자는 detail.args에서만 찾힌다
})

// ActivityTab.test.tsx
it('renders device entries as muted separator rows with a Korean label', () => {
  // 'disconnected' → 'emulator-5554 연결 끊김', 'log_stopped' → '로그 수집 멈춤'
})
it('expands a tool call row in place and collapses it again', () => {
  // 행 버튼 aria-expanded 토글, 상세에 들여쓴 인자 JSON
})
it('shows message and hint for a failed call and the summary for a successful one', () => {})

// TimelineDetail.test.tsx
it('disables 이 시점 로그 보기 with a reason when the call targets another device', () => {
  // serial e2, targetSerial e1 → 버튼 disabled, '활성 기기의 호출만 로그로 이동할 수 있다'
})
it('calls onJumpToLogs for the active device', () => {})
```

기기 이벤트 한국어 라벨: `connected` 연결됨, `disconnected` 연결 끊김, `active_changed` 활성 기기로 선택됨, `stream_started` 화면 스트림 시작, `stream_stopped` 화면 스트림 종료, `stream_reconnecting` 화면 스트림 재연결 중, `log_stopped` 로그 수집 멈춤.

- [ ] **Step 2: 실패를 확인한다**

Run: `npx vitest run src/renderer/src/timeline src/renderer/src/components`
Expected: FAIL

- [ ] **Step 3: 구현한다**

최신 항목이 위에 오는 지금 순서를 유지한다. 인자 JSON은 `detail.args`를 파싱해 들여쓰고, 파싱이 실패하면(잘린 경우) 원문을 그대로 보인다. 툴 이름 선택지는 받은 항목에서 모은다.

- [ ] **Step 4: 통과를 확인한다**

Run: `npm test && npm run typecheck`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/renderer/src/timeline src/renderer/src/components src/renderer/src/app.css
git commit -m "feat(renderer): 활동 탭에 기기 이벤트, 상세 펼침, 필터를 더한다"
```

---

### Task 5: 호출 시점 로그로 점프

**Files:**
- Modify: `src/renderer/src/components/WorkArea.tsx`
- Modify: `src/renderer/src/components/LogTab.tsx`
- Test: `src/renderer/src/components/WorkArea.test.tsx`, `src/renderer/src/components/LogTab.test.tsx`

**Interfaces:**
- Consumes: `findJumpIndex`, `LogTab`의 `highlight` 행 표시, `LogStream.caughtUp` (M3-2b), `ActivityTab.onJumpToLogs` (Task 4)
- Produces:
  - `LogTab` props에 `jump?: { id: string; at: number; highlight: { fromAt: number; toAt: number } } | null`, `onJumpDone?: (id: string, result: 'ok' | 'evicted') => void` 추가
  - `const JUMP_LEAD_MS = 2000`

- [ ] **Step 1: 실패하는 테스트를 쓴다**

```ts
// WorkArea.test.tsx
it('switches to the log tab and passes a jump for the clicked call', () => {
  // at 10_000, durationMs 300 → jump { at: 8000, highlight: { fromAt: 10_000, toAt: 10_300 } }, 로그 탭 선택됨
})

// LogTab.test.tsx
it('applies a jump only when visible and caughtUp', () => {
  // 순서: 숨김(visible false, caughtUp false) → jump 전달 → 보임(visible true, caughtUp false) → 스크롤 안 함
  // → caughtUp true → findJumpIndex 적용, onJumpDone('ok')
})
it('jumps to the first visible row after the time when filters hide the exact row', () => {})
it('shows 로그 버퍼에서 밀려난 구간이다 when the jump is evicted', () => {})
it('applies the same jump id only once', () => {})
```

- [ ] **Step 2: 실패를 확인한다**

Run: `npx vitest run src/renderer/src/components/WorkArea.test.tsx src/renderer/src/components/LogTab.test.tsx`
Expected: FAIL

- [ ] **Step 3: 구현한다**

`WorkArea`가 `jump` 상태를 갖고 `onJumpToLogs`에서 `{ id: entry.id, at: entry.at - JUMP_LEAD_MS, highlight: { fromAt: entry.at, toAt: entry.at + entry.durationMs } }`로 채운 뒤 로그 탭을 선택한다. `LogTab`은 `jump`가 있고 `visible && stream.caughtUp`인 첫 렌더에서 `findJumpIndex`로 위치를 구해 스크롤하고, 따라가기를 멈추고, `highlight`를 채운 뒤 `onJumpDone`을 부른다. `evicted`면 목록 위에 `role="status"` 안내를 띄운다.

- [ ] **Step 4: 통과를 확인한다**

Run: `npm test && npm run typecheck`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/renderer/src/components
git commit -m "feat(renderer): 툴 호출 상세에서 그 시점 로그로 바로 간다"
```

---

### Task 6: 완료 검증과 M3 마무리

**Files:**
- Modify: `docs/superpowers/specs/2026-09-28-m3-node-control-logs-events.md` (`완료 조건` 아래 "M3-3 검증 결과 (날짜)", `status: implemented`, `verified`, `related_plan`)
- Modify: `docs/superpowers/plans/2026-09-28-m3-3-event-timeline.md` (`status: done`)
- Modify: `docs/architecture/main-layers.md` (앱 상태 층 설명에 타임라인 링과 `timeline` 이벤트, `verified` 갱신)

**Interfaces:**
- Consumes: 전 task
- Produces: 없음

- [ ] **Step 1: M3-3 완료 조건을 확인한다**

`npm run dev`로 앱을 띄우고 MCP 클라이언트를 붙인다.
1. 옛 ref로 `ui_tap`을 불러 일부러 실패시킨다(`stale_ref`). 활동 탭에서 그 행을 펼쳐 "이 시점 로그 보기"를 누르면 로그 탭이 그 호출 시각 근처로 스크롤되고 강조가 보인다.
2. 로그 탭을 숨긴 상태에서 1을 반복해도 같은 위치로 간다.
3. 에뮬레이터를 끊었다 붙이면(`adb disconnect`/`adb connect` 또는 에뮬레이터 재시작) 타임라인에 연결 끊김·연결됨 행이 끼인다.
4. `ui_text`로 `hunter2`를 넣은 뒤 활동 탭 상세와 `getSnapshot` 결과 어디에도 `hunter2`가 없다.

결과를 스펙 `완료 조건` 아래 "M3-3 검증 결과 (YYYY-MM-DD)"에 적는다. 실패하면 고치기 전에 멈추고 보고한다.

- [ ] **Step 2: 문서 상태를 바꾼다**

스펙을 `status: implemented`, `verified`를 오늘로, `related_plan`에 M3의 네 계획 id를 넣는다. 이 계획을 `status: done`으로 바꾼다. 아카이브 이동은 별도 커밋에서 한다.

Run: `python3 docs/script/docs.py lint && python3 docs/script/docs.py links`
Expected: 문제 0건

- [ ] **Step 3: Commit**

```bash
git add docs
git commit -m "docs: M3 완료 조건 검증 결과를 남기고 스펙을 닫는다"
```
