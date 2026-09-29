---
id: m3-1-node-control         # 파일명에서 날짜 접두사를 뺀 slug
title: M3-1 — 노드 기반 제어
status: done                    # draft | in-progress | done | abandoned | superseded
type: work-order                # work-order | handoff
created: 2026-09-28
updated: 2026-09-29
owner: virtual-device-helper 팀
scope: [main, mcp, android, shared, renderer, docs]
hosts: []                       # windows | macos — 호스트 OS마다 작업이 갈릴 때만 채운다
archived_reason: done — M3-1 구현 완료. 노드 트리·정규화 bounds, ref 재검증, UI 툴의 ref·0..1 좌표 입력, 제스처 정규화. PR #18로 develop에 머지. 앱 확인 일부 미검증(스펙 "M3-1 검증 결과")
related_adr: [ADR-0011, ADR-0012]
related_spec: m3-node-control-logs-events
related_architecture: main-layers
related_plan:
related_code: [uiDump.ts#parseUiDump, androidDevice.ts#createAndroidDevice, ui.ts#registerUiTools, runTool.ts#runTool, app.ts#waitForSettle, GestureOverlay.tsx#gestureToVideo, agentGuide.ts]
tags: [plan, node, mcp, coordinates]
---

# M3-1 — 노드 기반 제어 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: `superpowers:subagent-driven-development`(권장) 또는
> `superpowers:executing-plans`로 task 단위 구현. 각 단계는 체크박스(`- [ ]`)로 추적한다.

**Goal:** 에이전트가 픽셀 대신 노드 ref와 0..1 정규화 좌표로 기기를 조작하고, 서버는 ref를 동작 직전에 다시
검증해 화면이 바뀐 뒤의 틀린 탭을 `stale_ref`로 막는다.

**Architecture:** 기기 구현 층(`androidDevice.ts`, `uiDump.ts`)이 노드마다 부모와 디스플레이 기준 정규화 bounds를
만들고, 현재 방향 디스플레이 크기를 `DisplayFrame`으로 준다. MCP 툴 층에 순수 모듈 두 개를 더한다.
`coordinates.ts`는 좌표 변환과 스와이프 궤적을, `nodeRefs.ts`는 스냅샷·지문·재검증을 맡는다. `ui.ts`가 둘을 엮고,
`Gesture`는 정규화 좌표를 실어 오버레이의 회전 추정을 없앤다.

**Tech Stack:** TypeScript, zod 4, `@modelcontextprotocol/sdk` 1.30, fast-xml-parser, React 19, Vitest, @testing-library/react

**Spec:** [`../specs/2026-09-28-m3-node-control-logs-events.md`](../../specs/archive/2026-09-28-m3-node-control-logs-events.md)
— 특히 "UiDump와 Device", "ui_find", "nodeRefs", "ui_tap · ui_swipe · ui_text", "Gesture" 절. 결정 근거는
[ADR-0011](../../../adr/0011-node-ref-revalidation.md), [ADR-0012](../../../adr/0012-normalized-tool-coordinates.md).

**선행 조건:** 없다. M3-2와 독립이다.

## Global Constraints

- 답변·주석·문서는 한국어로 쓴다. 기술 용어·API 이름·명령어·에러 문자열은 원문 그대로 둔다.
- MCP 툴이 주고받는 좌표는 전부 현재 방향 기준 0 이상 1 이하다. 정규화 값은 소수 4자리로 반올림한다.
- 정규화 기준은 디스플레이 전체 크기(`wm size` 자연 방향 크기에 회전 적용)다. 덤프 루트 bounds는 화면 밖 판정에만 쓴다.
- 정규화 bounds는 0..1로 clamp한다. 중심만 화면 안인 노드도 bounds가 1을 넘지 않는다.
- 회전을 읽지 못하면(덤프의 `rotation` 속성이 없거나 0~3이 아님, `mDisplayRotation` 없음) `command_failed`다. 0으로 추측하지 않는다.
- `src/main/mcp/` 아래에는 adb나 `androidDevice`를 import하는 파일을 두지 않는다. 통합 테스트도 마찬가지다(`layering.test.ts`가 테스트 파일까지 검사한다).
- `Device.tap`·`Device.swipe`는 계속 기기 픽셀을 받는다. 변환은 MCP 툴 층의 몫이다.
- MCP 툴 층(`src/main/mcp/`)은 `adbClient`나 `androidDevice`를 import하지 않는다. `layering.test.ts`가 지킨다.
- ref 형식은 `g<세대>:<index>`다. 세대는 프로세스 전역 단조 카운터다. 기기마다 최근 8세대만 유효하다.
- `stale_ref`의 hint는 정확히 "`ui_find`를 다시 불러 새 ref를 받아라"다.
- ref 스와이프 궤적은 노드 bounds 안쪽 80% 구간이고 `durationMs` 기본값은 300이다. `direction`은 보고 싶은 쪽이다.
- 새 npm 의존성을 들이지 않는다.
- 각 task 끝에서 `npm test`와 `npm run typecheck`가 통과해야 한다. 바뀐 모양 때문에 깨지는 기존 테스트는 같은 task에서 고친다.
- 문서에는 라인번호, 파일·툴 개수, 진행률을 적지 않는다. 파일명과 심볼명으로 가리킨다.
- 문서를 고치면 `python3 docs/script/docs.py lint`와 `python3 docs/script/docs.py links`를 돌린다.
- 커밋 메시지는 한국어 Conventional Commits(`feat(mcp): ...한다`)이고, 끝에 다음 줄을 붙인다:
  `Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>`

## Review Focus

- **다이얼로그가 떠 있는 화면**: 덤프 루트가 다이얼로그 사각형이어도 노드 bounds는 디스플레이 기준이어야 한다. 루트 기준으로 정규화하면 버튼을 엉뚱한 곳에서 누른다. → Task 1 테스트.
- **스트리밍 중의 회전 조회**: scrcpy 가상 디스플레이 블록이 기본 디스플레이보다 먼저 나와도 기본 디스플레이의 회전을 읽어야 한다. → Task 1 테스트.
- **리스트에서 같은 아이콘 여럿**: 스크롤 뒤 같은 순번이 다른 행을 가리키면 누르지 말고 `stale_ref`여야 한다. → Task 3 테스트.
- **픽셀을 넣던 옛 클라이언트**: `ui_tap({ x: 540, y: 930 })`은 조용히 화면 끝을 누르지 말고 인자 오류여야 한다. → Task 4 테스트.
- **입력한 뒤 같은 입력칸 ref 재사용**: `ui_text({ ref })` 뒤 같은 ref로 다시 누를 수 있어야 한다. → Task 3 테스트.

---

### Task 1: 기기 구현 층이 노드 트리와 디스플레이 크기를 준다

**Files:**
- Modify: `src/shared/types/device.ts`
- Modify: `src/main/device/parsers/uiDump.ts`
- Modify: `src/main/device/androidDevice.ts`
- Modify: `src/main/mcp/tools/app.ts` (`app_reset_and_launch`가 `dumpUi().then(d => d.nodes)`를 넘긴다)
- Modify: `src/main/mcp/tools/ui.ts` (`ui_find`만 과도기 모양으로. 아래 Step 7)
- Modify: `src/main/mcp/tools/highLevel.test.ts` (`node()` 헬퍼, 가짜 `dumpUi`, `ui_find` 기대값)
- Modify: `src/main/device/androidDevice.observe.test.ts` (`AndroidDevice.dumpUi` 블록)
- Modify: `src/main/adb/adbClient.integration.test.ts` (새 `parseUiDump` 시그니처)
- Create: `src/main/device/parsers/__fixtures__/window-displays-streaming.txt`
- Test: `src/main/device/parsers/uiDump.test.ts`, `src/main/device/androidDevice.ui.test.ts`, `src/main/device/androidDevice.observe.test.ts`, `src/main/mcp/tools/highLevel.test.ts`

**Interfaces:**
- Consumes: 없음
- Produces (`src/shared/types/device.ts`):
  - `interface NormalizedRect { x: number; y: number; w: number; h: number }`
  - `interface DisplayFrame { width: number; height: number }`
  - `interface UiNode { index: number; parentIndex: number | null; text: string | null; contentDesc: string | null; resourceId: string | null; className: string; bounds: NormalizedRect; clickable: boolean; enabled: boolean; focused: boolean; scrollable: boolean }` — `x`, `y` 삭제
  - `interface UiDump { nodes: UiNode[]; frame: DisplayFrame }`
  - `Device.dumpUi(): Promise<UiDump>`, `Device.displayFrame(): Promise<DisplayFrame>`
- Produces (`uiDump.ts`): `parseUiDump(xml: string, natural: DisplayFrame): UiDump` — `ParseUiDumpOpts`(query)는 없앤다. 파서 안에서 거르면 dense index와 ref 의미가 어긋난다. 거르기는 `ui.ts`가 한다.
- Produces (`androidDevice.ts`): `parseDisplayRotation(stdout: string): 0 | 1 | 2 | 3` (export, 테스트용)

- [ ] **Step 1: 스트리밍 중 `dumpsys window displays` 픽스처를 뜬다**

앱에서 에뮬레이터 스트림을 켠 채로 실행한다. scrcpy 가상 디스플레이 블록이 기본 디스플레이보다 먼저 나와야 한다.

```bash
adb -s emulator-5554 shell dumpsys window displays > src/main/device/parsers/__fixtures__/window-displays-streaming.txt
grep -n "Display: mDisplayId" src/main/device/parsers/__fixtures__/window-displays-streaming.txt
```

Expected: `Display: mDisplayId=2`(또는 0이 아닌 id) 줄이 `Display: mDisplayId=0` 줄보다 위에 있다.

- [ ] **Step 2: 실패하는 파서 테스트를 쓴다**

`uiDump.test.ts`의 기존 `sample`·`landscapeSample`을 새 시그니처로 옮기고 아래를 더한다. 합성 XML에 `enabled`,
`focused`, `scrollable` 속성을 넣는다. 다이얼로그 샘플은 루트 bounds가 `[140,900][940,1500]`인 덤프다.

```ts
const natural = { width: 1080, height: 2400 }

it('normalizes bounds against the display, not the dump root', () => {
  const dump = parseUiDump(dialogSample, natural)
  const ok = dump.nodes.find((n) => n.text === '확인')!
  // 확인 버튼 픽셀 [540,1380][900,1480]
  expect(ok.bounds).toEqual({ x: 0.5, y: 0.575, w: 0.3333, h: 0.0417 })
  expect(dump.frame).toEqual({ width: 1080, height: 2400 })
})

it('swaps the frame axes when the hierarchy is rotated', () => {
  const dump = parseUiDump(landscapeSample, { width: 1080, height: 2340 }) // rotation="1", 루트 [0,0][2340,1080]
  expect(dump.frame).toEqual({ width: 2340, height: 1080 })
})

it('points parentIndex at the nearest kept ancestor', () => {
  // 래퍼 LinearLayout(이름·클릭 없음)은 빠지고, 그 안 버튼의 부모는 바깥 clickable 카드가 된다
  const dump = parseUiDump(nestedSample, natural)
  const card = dump.nodes.find((n) => n.resourceId === 'card')!
  const button = dump.nodes.find((n) => n.resourceId === 'more')!
  expect(button.parentIndex).toBe(card.index)
  expect(card.parentIndex).toBeNull()
})

it('keeps a scrollable container that has no name', () => {
  const dump = parseUiDump(nestedSample, natural)
  expect(dump.nodes.some((n) => n.className === 'RecyclerView' && n.scrollable)).toBe(true)
})

it('reads enabled and focused flags', () => {
  const email = parseUiDump(sample, natural).nodes.find((n) => n.resourceId === 'email')!
  expect(email).toMatchObject({ enabled: true, focused: true })
})

it('throws command_failed when the hierarchy has no rotation', () => {
  expect(() => parseUiDump(sample.replace(' rotation="0"', ''), natural)).toThrow(
    expect.objectContaining({ toolError: expect.objectContaining({ kind: 'command_failed' }) })
  )
})

it('clamps bounds of a node whose center is on screen but edge is not', () => {
  // 버튼 픽셀 [900,2300][1200,2500], 중심 (1050,2400)은 화면 안
  const n = parseUiDump(edgeSample, natural).nodes.find((x) => x.resourceId === 'edge')!
  expect(n.bounds).toEqual({ x: 0.8333, y: 0.9583, w: 0.1667, h: 0.0417 })
})

it('numbers index densely over kept nodes in document order', () => {
  const dump = parseUiDump(nestedSample, natural)
  expect(dump.nodes.map((n) => n.index)).toEqual(dump.nodes.map((_, i) => i))
})
```

기존 실제 기기·에뮬레이터 픽스처 테스트는 `parseUiDump(fixture, realScreen)`로 부르고, 모든 bounds가 0..1 안인지만 확인한다. `query` 옵션 테스트는 지운다.

- [ ] **Step 3: 테스트가 실패하는지 본다**

Run: `npx vitest run src/main/device/parsers/uiDump.test.ts`
Expected: FAIL — `bounds`, `parentIndex`, `frame`이 없다.

- [ ] **Step 4: `parseUiDump`를 구현한다**

- `flatten`을 조상 스택을 넘기는 재귀로 바꿔 남은 조상 중 가장 가까운 것의 index를 `parentIndex`로 준다.
- 회전은 `<hierarchy rotation="N">`에서 읽는다. 속성이 없거나 0~3이 아니면 `command_failed`(hint "화면 전환이나 애니메이션이 끝난 뒤 다시 불러라"). N이 1·3이면 `natural`의 가로·세로를 바꿔 `frame`으로 쓴다.
- 남기는 기준에 `scrollable === 'true'`를 더한다. 화면 밖 판정은 지금처럼 `screenRect`(루트 bounds)로 한다.
- 정규화는 `frame` 기준으로 픽셀 사각형을 먼저 `[0, frame]`에 clamp한 뒤 `Math.round(v * 10000) / 10000`.

- [ ] **Step 5: 실패하는 기기 테스트를 쓴다** (`androidDevice.ui.test.ts`)

```ts
const streaming = readFileSync(join(__dirname, 'parsers', '__fixtures__', 'window-displays-streaming.txt'), 'utf8')

it('reads the default display rotation even when a virtual display comes first', () => {
  expect(parseDisplayRotation(streaming)).toBe(0)
  expect(parseDisplayRotation(streaming.replace(/(Display: mDisplayId=0[\s\S]*?)ROTATION_0/, '$1ROTATION_90'))).toBe(1)
})

it('accepts the (organized) suffix on the default display line', () => {
  expect(parseDisplayRotation('Display: mDisplayId=0 (organized)\n winConfig={ mDisplayRotation=ROTATION_270 }')).toBe(3)
})

it('throws command_failed when the default display has no rotation', () => {
  expect(() => parseDisplayRotation('Display: mDisplayId=2\n mDisplayRotation=ROTATION_0')).toThrow(
    expect.objectContaining({ toolError: expect.objectContaining({ kind: 'command_failed' }) })
  )
})

it('displayFrame swaps axes for a 90 degree rotation', async () => {
  // fakeAdb가 ['shell','wm','size']에 "Physical size: 1080x2400", ['shell','dumpsys','window','displays']에 ROTATION_90 픽스처를 준다
  expect(await device.displayFrame()).toEqual({ width: 2400, height: 1080 })
})

it('asks wm size once per device instance across dumpUi and displayFrame', async () => {
  await device.dumpUi(); await device.displayFrame(); await device.displayFrame()
  expect(calls.filter((c) => c.join(' ') === 'shell wm size')).toHaveLength(1)
})

it('does not cache a failed wm size', async () => { /* 첫 호출 실패 → 두 번째 호출이 wm size를 다시 부른다 */ })
```

`fakeAdb`는 지금 모든 명령에 빈 stdout을 준다. 인자별 응답을 줄 수 있게 `respond?: (args) => string`을 받도록 넓힌다.

`androidDevice.observe.test.ts`의 `AndroidDevice.dumpUi` 블록도 고친다. "`wm size`를 부르지 않는다"는 단언은 "한 인스턴스에서 한 번만 부른다"로 바꾸고, 가짜 adb가 `wm size`에 `Physical size: 1080x2400`을 주게 한다. 실패를 기대하는 테스트는 기대한 이유(덤프 ERROR 줄, `<hierarchy` 없음)로 실패하는지 `message`까지 확인한다.

- [ ] **Step 6: `androidDevice.ts`를 구현한다**

- `parseDisplayRotation`: `Display: mDisplayId=0` 줄(뒤에 ` (organized)` 같은 꼬리가 붙을 수 있다)부터 다음 `Display: mDisplayId=` 줄 전까지에서 첫 `mDisplayRotation=ROTATION_(0|90|180|270)`을 읽어 0..3으로 준다. 못 읽으면 `command_failed`, hint는 "기기가 완전히 부팅됐는지 확인해라".
- 자연 방향 크기는 `createAndroidDevice` 클로저의 `Promise` 캐시로 한 번만 묻는다. 실패한 promise는 캐시에서 지운다(`screenSize.ts#screenSizeOf`와 같은 규칙). `info()`와 `screenshot`의 `wm size`도 이 캐시를 쓴다.
- `dumpUi()`는 `parseUiDump(xml, natural)`을 돌려준다. `displayFrame()`은 자연 방향 크기와 `parseDisplayRotation` 결과로 만든다.

- [ ] **Step 7: 호출부를 맞춘다**

- `app.ts`: `waitForSettle(() => device.dumpUi().then((d) => d.nodes), ...)`. `highLevel.test.ts`의 `node()` 헬퍼와 가짜 `dumpUi`를 `UiDump` 모양으로 고친다.
- `ui.ts`의 `ui_find`: 과도기 모양으로 `dump.nodes`를 걸러 돌려준다. 걸러진 목록에 index를 다시 매기지 않는다(`kept.map((node, index) => ...)` 삭제). ref는 Task 4에서 붙인다. `highLevel.test.ts`의 `'renumbers the returned nodes from zero after filtering'`은 반대 규칙이 됐으므로 "걸러도 덤프 index를 유지한다"로 바꾼다.
- `adbClient.integration.test.ts`: `parseUiDump(xml, { width, height })`. 크기는 같은 테스트에서 `wm size`로 구한다.

- [ ] **Step 8: 전부 통과하는지 본다**

Run: `npm test && npm run typecheck`
Expected: PASS

- [ ] **Step 9: Commit**

```bash
git add src/shared/types/device.ts src/main/device src/main/mcp/tools/app.ts src/main/mcp/tools/ui.ts src/main/mcp/tools/highLevel.test.ts src/main/adb/adbClient.integration.test.ts
git commit -m "feat(android): 노드 트리와 디스플레이 기준 정규화 bounds를 준다"
```

---

### Task 2: 좌표 변환과 스와이프 궤적

**Files:**
- Create: `src/main/mcp/coordinates.ts`
- Test: `src/main/mcp/coordinates.test.ts`

**Interfaces:**
- Consumes: `NormalizedRect`, `DisplayFrame` (Task 1)
- Produces:
  - `type Direction = 'up' | 'down' | 'left' | 'right'`
  - `interface NormalizedPoint { x: number; y: number }`
  - `toPixel(point: NormalizedPoint, frame: DisplayFrame): { x: number; y: number }`
  - `centerOf(rect: NormalizedRect): NormalizedPoint` (소수 4자리)
  - `swipeWithin(rect: NormalizedRect, direction: Direction): { from: NormalizedPoint; to: NormalizedPoint }`
  - `const REF_SWIPE_INSET = 0.1`, `const DEFAULT_SWIPE_MS = 300`

- [ ] **Step 1: 실패하는 테스트를 쓴다**

```ts
const frame = { width: 1080, height: 2400 }
const rect = { x: 0.1, y: 0.2, w: 0.8, h: 0.5 }

it('maps a normalized point to device pixels', () => {
  expect(toPixel({ x: 0.5, y: 0.25 }, frame)).toEqual({ x: 540, y: 600 })
})

it('keeps the far edge inside the display', () => {
  expect(toPixel({ x: 1, y: 1 }, frame)).toEqual({ x: 1079, y: 2399 })
})

it('uses the rotated frame as given', () => {
  expect(toPixel({ x: 0.5, y: 0.5 }, { width: 2400, height: 1080 })).toEqual({ x: 1200, y: 540 })
})

it('centers a rect', () => {
  expect(centerOf(rect)).toEqual({ x: 0.5, y: 0.45 })
})

it('down means the finger moves up inside the inner 80%', () => {
  expect(swipeWithin(rect, 'down')).toEqual({ from: { x: 0.5, y: 0.65 }, to: { x: 0.5, y: 0.25 } })
})

it('up means the finger moves down', () => {
  expect(swipeWithin(rect, 'up')).toEqual({ from: { x: 0.5, y: 0.25 }, to: { x: 0.5, y: 0.65 } })
})

it('right means the finger moves left', () => {
  expect(swipeWithin(rect, 'right')).toEqual({ from: { x: 0.82, y: 0.45 }, to: { x: 0.18, y: 0.45 } })
})

it('left means the finger moves right', () => {
  expect(swipeWithin(rect, 'left')).toEqual({ from: { x: 0.18, y: 0.45 }, to: { x: 0.82, y: 0.45 } })
})
```

- [ ] **Step 2: 실패를 확인한다**

Run: `npx vitest run src/main/mcp/coordinates.test.ts`
Expected: FAIL — 모듈이 없다.

- [ ] **Step 3: `coordinates.ts`를 구현한다**

`toPixel`은 `Math.min(Math.round(v * size), size - 1)`. 궤적은 방향 축에서 `rect` 양 끝을 `REF_SWIPE_INSET * 길이`만큼 안으로 당긴 두 점, 다른 축은 중심. 모든 결과는 소수 4자리.

- [ ] **Step 4: 통과를 확인한다**

Run: `npx vitest run src/main/mcp/coordinates.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/main/mcp/coordinates.ts src/main/mcp/coordinates.test.ts
git commit -m "feat(mcp): 정규화 좌표 변환과 노드 안 스와이프 궤적을 더한다"
```

---

### Task 3: ref 스냅샷과 재검증

**Files:**
- Create: `src/main/mcp/nodeRefs.ts`
- Modify: `src/shared/types/errors.ts` (`ToolErrorKind`에 `'stale_ref'`)
- Test: `src/main/mcp/nodeRefs.test.ts`

**Interfaces:**
- Consumes: `Device`, `UiDump`, `UiNode`, `DisplayFrame` (Task 1), `centerOf` (Task 2)
- Produces:
  - `interface NodeRefs { remember(device: Device, dump: UiDump): number; resolve(device: Device, ref: string): Promise<{ node: UiNode; frame: DisplayFrame }> }`
  - `createNodeRefs(opts?: { keep?: number }): NodeRefs` — `keep` 기본값 8
  - `const nodeRefs: NodeRefs` — 모듈 기본 인스턴스. MCP 세션마다 `McpServer`가 새로 생기므로 스냅샷은 이 인스턴스에 둔다.
  - `formatRef(generation: number, index: number): string` → `"g<generation>:<index>"`
  - `const STALE_REF_HINT = '`ui_find`를 다시 불러 새 ref를 받아라'`

- [ ] **Step 1: 실패하는 테스트를 쓴다**

가짜 기기는 `{ serial, dumpUi: vi.fn() }`이고 `dumpUi`는 준비한 `UiDump`를 차례로 돌려준다. 헬퍼
`node(partial): UiNode`로 노드를 만든다.

```ts
it('numbers generations globally across devices', () => {
  const refs = createNodeRefs()
  const a = refs.remember(deviceA, dump([login]))
  const b = refs.remember(deviceB, dump([login]))
  expect(b).toBe(a + 1)
})

it('resolves to the fresh bounds of the same node', async () => {
  const refs = createNodeRefs()
  const gen = refs.remember(deviceA, dump([login]))
  deviceA.dumpUi.mockResolvedValueOnce(dump([{ ...login, bounds: moved }]))
  const { node } = await refs.resolve(deviceA, formatRef(gen, login.index))
  expect(node.bounds).toEqual(moved)
})

it('rejects a ref taken from another device', async () => {
  const refs = createNodeRefs()
  const gen = refs.remember(deviceA, dump([login]))
  await expect(refs.resolve(deviceB, formatRef(gen, 0))).rejects.toMatchObject({
    toolError: { kind: 'stale_ref', hint: STALE_REF_HINT }
  })
  expect(deviceB.dumpUi).not.toHaveBeenCalled()
})

it('rejects a ref taken before the device reconnected', async () => {
  // serial이 같은 새 Device 객체(deviceA2) → remember는 deviceA에 했으므로 stale_ref, dumpUi 부르지 않음
})

it('forgets generations older than keep', async () => { /* keep: 2, 세 번 remember → 첫 세대 ref는 stale_ref */ })

it('rejects a malformed ref without dumping', async () => { /* 'login', 'g1', 'gX:1' → stale_ref */ })

it('rejects when the fingerprint is gone', async () => { /* 새 덤프에 login이 없다 → stale_ref */ })

it('ignores text on EditText so a typed field still resolves', async () => {
  const refs = createNodeRefs()
  const field = node({ className: 'EditText', resourceId: 'email', text: '이메일' })
  const gen = refs.remember(deviceA, dump([field]))
  deviceA.dumpUi.mockResolvedValueOnce(dump([{ ...field, text: 'a@b.c' }]))
  await expect(refs.resolve(deviceA, formatRef(gen, field.index))).resolves.toBeTruthy()
})

it('treats changed text on a non-EditText node as a different node', async () => { /* TextView 텍스트 변경 → stale_ref */ })

it('includes the ancestor chain in the fingerprint', async () => { /* 같은 버튼이 다른 resourceId 부모 아래로 가면 stale_ref */ })

it('picks the same ordinal among duplicates when count and nearest agree', async () => {
  // 같은 지문 아이콘 셋. 두 번째를 ref로 받고, 새 덤프에서 셋 모두 약간 이동(순서 유지) → 두 번째가 풀린다
})

it('rejects duplicates when their count changed', async () => { /* 셋 → 넷 → stale_ref */ })

it('rejects duplicates when the ordinal pick is not the nearest to the old bounds', async () => {
  // 셋이 한 행 높이만큼 스크롤돼 옛 두 번째 자리에 옛 세 번째가 옴 → 순번 선택과 최근접이 다름 → stale_ref
})

it('does not create a generation when revalidating', async () => {
  const refs = createNodeRefs()
  const gen = refs.remember(deviceA, dump([login]))
  deviceA.dumpUi.mockResolvedValueOnce(dump([login]))
  await refs.resolve(deviceA, formatRef(gen, 0))
  expect(refs.remember(deviceA, dump([login]))).toBe(gen + 1)
})
```

- [ ] **Step 2: 실패를 확인한다**

Run: `npx vitest run src/main/mcp/nodeRefs.test.ts`
Expected: FAIL — 모듈이 없다.

- [ ] **Step 3: `nodeRefs.ts`와 `stale_ref`를 구현한다**

규칙은 스펙 "nodeRefs" 절의 `resolve` 순서 그대로다. 지문은 문자열 하나로 만든다. 네 필드(`EditText`로 끝나는
클래스는 text 제외) 뒤에 `parentIndex`를 따라 올라가며 모은 조상들의 `className|resourceId`를 붙인다. 스냅샷은
`WeakMap<Device, Array<{ generation: number; dump: UiDump }>>`, 세대 카운터는 모듈 전역 변수 하나를 모든 인스턴스가 공유한다.
최근접은 `centerOf` 사이 유클리드 거리다. 에러는 `deviceError('stale_ref', <무엇이 어긋났는지 한 문장>, STALE_REF_HINT, { ref })`.

- [ ] **Step 4: 통과를 확인한다**

Run: `npx vitest run src/main/mcp/nodeRefs.test.ts && npm run typecheck`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/main/mcp/nodeRefs.ts src/main/mcp/nodeRefs.test.ts src/shared/types/errors.ts
git commit -m "feat(mcp): ref 스냅샷과 동작 직전 재검증을 더한다"
```

---

### Task 4: UI 툴이 ref와 정규화 좌표를 받고 Gesture를 정규화한다

**Files:**
- Modify: `src/main/mcp/tools/ui.ts`
- Modify: `src/shared/types/ipc.ts` (`Gesture` 정규화, `ScreenSize` 삭제)
- Modify: `src/main/mcp/runTool.ts` (`GESTURE_TIMEOUT_MS`, `withGestureTimeout` 삭제)
- Delete: `src/main/mcp/screenSize.ts`, `src/main/mcp/screenSize.test.ts`
- Modify: `src/renderer/src/components/GestureOverlay.tsx`
- Modify: `src/renderer/src/components/DeviceScreen.test.tsx` (`gesture` 픽스처의 `screen` 삭제, 좌표를 0..1로)
- Modify: `src/main/mcp/tools/highLevel.test.ts` (`ui_find` 응답 기대값을 새 모양으로)
- Test: `src/main/mcp/tools/ui.test.ts`, `src/main/mcp/runTool.test.ts`, `src/renderer/src/components/GestureOverlay.test.tsx`

**Interfaces:**
- Consumes: `nodeRefs`, `formatRef` (Task 3), `toPixel`, `centerOf`, `swipeWithin`, `DEFAULT_SWIPE_MS` (Task 2), `Device.displayFrame` (Task 1)
- Produces:
  - `type Gesture = { kind: 'tap'; serial: string; x: number; y: number } | { kind: 'swipe'; serial: string; x1: number; y1: number; x2: number; y2: number }` (0..1)
  - `gestureToVideo(gesture: Gesture, video: VideoSize): VideoGesture` — 곱하기만 한다
  - `ui_find` 응답 `{ generation, nodes: [{ ref, parentRef, text, contentDesc, resourceId, className, bounds, clickable, enabled, focused, scrollable }], truncated, droppedCount }`
  - `ui_tap` 응답 `{ tapped: { ref?: string; x: number; y: number } }`, `ui_swipe` 응답 `{ swiped: { ref?: string; x1, y1, x2, y2 } }`, `ui_text` 응답 `{ typed: true, ref?: string }`

- [ ] **Step 1: 실패하는 툴 테스트를 쓴다** (`ui.test.ts`)

기존 픽셀 테스트는 정규화 값으로 바꾼다. `harnessFor`의 가짜 기기에 `displayFrame: async () => ({ width: 1080, height: 2400 })`을 기본으로 둔다. `'still succeeds without a gesture when the screen size cannot be read'`는 지우고 "`displayFrame`이 실패하면 탭하지 않고 그 에러를 돌려준다"로 바꾼다.

```ts
it('ui_find returns refs of one generation with parentRef', async () => {
  const result = await harness.call('ui_find') as { generation: number; nodes: Array<{ ref: string; parentRef: string | null }> }
  expect(result.nodes[0].ref).toBe(`g${result.generation}:0`)
  expect(result.nodes[1].parentRef).toBe(`g${result.generation}:0`)
  expect(result.nodes[0]).not.toHaveProperty('x')
})

it('ui_find keeps dump index in refs after a query filter', async () => { /* query로 index 3만 남음 → ref 끝이 :3 */ })

it('ui_tap by coordinates converts through displayFrame', async () => {
  await harness.call('ui_tap', { x: 0.5, y: 0.25 })
  expect(tap).toHaveBeenCalledWith(540, 600)
})

it('rejects pixel coordinates from an old client', async () => {
  expect((await harness.raw('ui_tap', { x: 540, y: 930 })).isError).toBe(true)
  expect(tap).not.toHaveBeenCalled()
})

it('rejects both ref and coordinates, and neither', async () => {
  expect((await harness.raw('ui_tap', { ref: 'g1:0', x: 0.5, y: 0.5 })).isError).toBe(true)
  expect((await harness.raw('ui_tap', {})).isError).toBe(true)
})

it('ui_tap by ref taps the fresh center and records a normalized gesture', async () => {
  const { generation } = await harness.call('ui_find') as { generation: number }
  // 재검증 덤프에서 login이 이동: bounds { x: 0.2, y: 0.5, w: 0.2, h: 0.1 }
  await harness.call('ui_tap', { ref: `g${generation}:1` })
  expect(tap).toHaveBeenCalledWith(324, 1320)
  expect(harness.records.at(-1)?.gesture).toEqual({ kind: 'tap', serial: 'emulator-5554', x: 0.3, y: 0.55 })
})

it('ui_tap with a stale ref taps nothing and returns stale_ref', async () => {
  const error = await harness.callExpectingError('ui_tap', { ref: 'g999999:0' })
  expect(error.kind).toBe('stale_ref')
  expect(tap).not.toHaveBeenCalled()
})

it('ui_swipe by ref scrolls inside the node', async () => {
  // scrollable 노드 bounds { x: 0, y: 0.2, w: 1, h: 0.6 }, direction 'down'
  // → from (0.5, 0.74), to (0.5, 0.26), durationMs 기본 300
  expect(swipe).toHaveBeenCalledWith(540, 1776, 540, 624, 300)
})

it('ui_swipe rejects direction without ref and ref with coordinates', async () => { /* 둘 다 isError */ })

it('ui_text by ref taps the node center before typing', async () => {
  // tap 호출이 inputText 호출보다 먼저, tap gesture가 기록된다
  expect(order).toEqual(['tap', 'inputText'])
  expect(harness.records.at(-1)?.gesture?.kind).toBe('tap')
})

it('resolves and acts inside one registry.run call', async () => {
  // registry.run을 감싸 호출 수를 센다 → ui_tap(ref) 한 번에 run 한 번
})
```

- [ ] **Step 2: 실패하는 runTool·오버레이 테스트로 바꾼다**

- `runTool.test.ts`: gesture 픽스처에서 `screen`을 뺀다. 타임아웃·지연 관련 테스트(`does not let a slow gesture delay...`, `excludes the gesture wait...`, `leaves no pending timer...`)를 지운다. "gesture 콜백이 던져도 성공은 유지"와 "실패한 호출은 gesture를 묻지 않음"은 남긴다.
- `GestureOverlay.test.tsx`:

```ts
it('scales normalized coordinates by the video size', () => {
  expect(gestureToVideo({ kind: 'tap', serial: 's', x: 0.5, y: 0.25 }, { width: 1024, height: 2048 })).toEqual({ kind: 'tap', x: 512, y: 512 })
})

it('draws a landscape video without any rotation guess', () => {
  expect(gestureToVideo({ kind: 'swipe', serial: 's', x1: 0, y1: 0.5, x2: 1, y2: 0.5 }, { width: 2048, height: 1024 }))
    .toEqual({ kind: 'swipe', x1: 0, y1: 512, x2: 2048, y2: 512 })
})
```

- [ ] **Step 3: 실패를 확인한다**

Run: `npx vitest run src/main/mcp/tools/ui.test.ts src/main/mcp/runTool.test.ts src/renderer/src/components/GestureOverlay.test.tsx`
Expected: FAIL

- [ ] **Step 4: 구현한다**

- `ui.ts`의 세 툴은 `inputSchema`를 `z.object({...}).superRefine(...)`로 준다. 좌표 필드는 `z.number().min(0).max(1)`. ref와 좌표의 배타 조건은 `superRefine`에서 걸어 SDK의 검증 에러(`isError: true`)로 나가게 한다. 최상위가 `type: object`로 남아야 하므로 `z.union`은 쓰지 않는다.
- `ui_swipe`의 `durationMs`는 스키마에서 `.optional()`이고, 좌표 경로에서 빠지면 `superRefine`이 거절한다. ref 경로에서 빠지면 `DEFAULT_SWIPE_MS`.
- `ui_text`에 `runTool`의 `gesture` 옵션을 새로 붙인다(ref 경로에서만 tap gesture).
- ref 경로는 `context.registry.run(device.serial, async () => { const { node, frame } = await nodeRefs.resolve(device, ref); ... })` 안에서 동작까지 끝낸다. 좌표 경로는 같은 `run` 안에서 `device.displayFrame()`을 부른다.
- gesture는 핸들러가 쓴 정규화 좌표를 클로저에 잡아 두고 `gesture` 콜백이 그대로 돌려준다.
- `ui_find`는 `nodeRefs.remember(device, dump)`로 세대를 받아 ref와 parentRef를 만든다.
- `runTool.ts`는 성공 뒤 `opts.gesture`를 try/catch로 직접 기다린다.
- 툴 설명: `ui_tap`은 "ui_find의 ref를 먼저 쓴다. 노드가 없는 화면에서만 0..1 좌표를 쓴다", `ui_swipe`의 `direction` 설명에 "보고 싶은 쪽. down은 아래 콘텐츠를 본다(손가락은 위로)", `ui_text`는 "ref를 주면 그 입력칸을 눌러 포커스를 준 뒤 입력한다".

- [ ] **Step 5: 통과를 확인한다**

Run: `npm test && npm run typecheck`
Expected: PASS. `grep -rn "screenSizeOf\|ScreenSize\|GESTURE_TIMEOUT_MS" src` 결과가 없다.

- [ ] **Step 6: Commit**

```bash
git add -A src/main/mcp src/shared/types/ipc.ts src/renderer/src/components/GestureOverlay.tsx src/renderer/src/components/GestureOverlay.test.tsx src/renderer/src/components/DeviceScreen.test.tsx
git commit -m "feat(mcp): UI 툴이 ref와 0..1 좌표를 받고 제스처를 정규화한다"
```

---

### Task 5: 에이전트 안내와 README를 새 툴 표면에 맞춘다

**Files:**
- Modify: `src/shared/agentGuide.ts`
- Modify: `README.md` (툴 표의 `ui_find`·`ui_tap`·`ui_text` 행, 전형적인 흐름 문장, "자주 나는 실패" 표에 stale_ref 행)
- Test: `src/shared/agentGuide.test.ts`, `src/main/mcp/guideConsistency.test.ts`

**Interfaces:**
- Consumes: Task 4의 툴 이름과 인자
- Produces: 없음

- [ ] **Step 1: 실패하는 테스트를 쓴다** (`agentGuide.test.ts`)

```ts
it('tells agents to act by ref and to refetch on stale_ref', () => {
  const text = serverInstructions()
  expect(text).toContain('ref')
  expect(text).toContain('stale_ref')
  expect(text).not.toMatch(/돌려받은 x, y/)
})

it('says coordinates are 0..1 and only for screens without nodes', () => {
  expect(serverInstructions()).toContain('0..1')
})
```

- [ ] **Step 2: 실패를 확인한다**

Run: `npx vitest run src/shared/agentGuide.test.ts`
Expected: FAIL

- [ ] **Step 3: 안내를 고친다**

`RULES`의 좌표 규칙을 세 줄로 바꾼다.
- "`ui_find`로 요소를 찾고, 돌려받은 `ref`로 `ui_tap`·`ui_text`·`ui_swipe`를 부른다."
- "stale_ref 에러가 오면 화면이 바뀐 것이다. `ui_find`를 다시 불러 새 ref를 받는다." — stale_ref에는 백틱을 치지 않는다. `guideConsistency.test.ts`의 `mentionedToolNames`가 백틱 안 snake_case를 툴 이름으로 보기 때문이다.
- "노드가 없는 화면(지도·게임 캔버스)에서만 0..1 좌표를 쓴다. `screenshot` 크기와 무관하다."

`scenario` 템플릿 4단계 문장도 ref를 쓰도록 고친다. README 표의 `ui_find` 설명은 "화면 요소와 ref. 조작 전에 먼저 부른다",
`ui_tap`은 "ref 또는 0..1 좌표를 누른다", `ui_text`는 "ref의 입력칸에, 또는 포커스된 칸에 텍스트를 넣는다". "자주 나는 실패" 표에 `stale_ref | 화면이 바뀌었다 | ui_find를 다시 부른다` 행을 더한다.

- [ ] **Step 4: 통과를 확인한다**

Run: `npx vitest run src/shared/agentGuide.test.ts src/main/mcp/guideConsistency.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/shared/agentGuide.ts src/shared/agentGuide.test.ts README.md
git commit -m "docs(mcp): 에이전트 안내를 ref와 정규화 좌표로 바꾼다"
```

---

### Task 6: 실기기 통합 테스트와 완료 검증

**Files:**
- Create: `src/main/device/androidDevice.nodeRefs.integration.test.ts` (mcp 밖에 둔다. `layering.test.ts`)
- Modify: `docs/superpowers/specs/2026-09-28-m3-node-control-logs-events.md` (`완료 조건` 아래 "M3-1 검증 결과 (날짜)")
- Modify: `docs/adr/0011-node-ref-revalidation.md`, `docs/adr/0012-normalized-tool-coordinates.md` (`status: accepted`)
- Modify: `docs/adr/0007-xml-parsing-library.md` (경계를 넘는 모양 `UiNode[]`를 `UiDump`로)
- Modify: `docs/superpowers/plans/2026-09-28-m3-1-node-control.md` (`status: done`)

**Interfaces:**
- Consumes: 전 task
- Produces: 없음

- [ ] **Step 1: 통합 테스트를 쓴다**

`adbClient.integration.test.ts`의 기기 선택 규칙(`VDH_TEST_SERIAL` 또는 에뮬레이터 정확히 하나)을 그대로 쓴다.
`createAndroidDevice`로 기기를 만들고, 설정 앱을 띄운 뒤 두 가지를 확인한다.

```ts
it('taps a node by ref on a real device', async () => {
  // am start -n com.android.settings/.Settings → dumpUi → remember → 첫 clickable 노드 ref → resolve → tap
  // 이후 dumpUi가 화면이 바뀌었음을 보여 준다(첫 덤프와 노드 지문 목록이 다르다)
})

it('returns stale_ref for a ref taken before the screen changed', async () => {
  // 메인 화면 ref 저장 → input keyevent BACK 또는 다른 화면 진입 → resolve가 stale_ref로 거절
})
```

- [ ] **Step 2: 통합 테스트를 돌린다**

Run: `npm run test:integration -- src/main/device/androidDevice.nodeRefs.integration.test.ts`
Expected: PASS

- [ ] **Step 3: 스펙의 M3-1 완료 조건을 앱과 에이전트로 확인한다**

`npm run dev`로 앱을 띄우고 MCP 클라이언트(Claude Code)를 붙인다. 설정 앱에서 확인한다.
1. ref만으로 검색창 탭 → 검색어 입력 → 결과 항목 탭.
2. `ui_swipe({ ref, direction: 'down' })`로 메인 목록이 아래로 스크롤된다.
3. 화면을 바꾼 뒤 옛 ref로 `ui_tap` → 아무것도 누르지 않고 `stale_ref`.
4. 기기를 가로로 돌리고 좌표 탭 → 의도한 위치에 맞고 오버레이도 그 위치에 뜬다.
5. 다이얼로그가 뜬 상태(예: 설정의 초기화 확인 창)에서 `ui_find`의 ref로 다이얼로그 버튼을 누른다.

각 항목의 결과를 스펙 `완료 조건` 아래 "M3-1 검증 결과 (YYYY-MM-DD)"에 한 줄씩 적는다. 실패한 항목이 있으면
고치기 전에 멈추고 보고한다.

- [ ] **Step 4: 문서 상태를 바꾼다**

ADR-0011·0012를 `status: accepted`로, 이 계획을 `status: done`으로 바꾼다. ADR-0007 본문의 `UiNode[]`를 `UiDump`로 고친다. 스펙의 `verified`를 오늘 날짜로 바꾼다.

Run: `python3 docs/script/docs.py lint && python3 docs/script/docs.py links`
Expected: 문제 0건

- [ ] **Step 5: Commit**

```bash
git add src/main/device/androidDevice.nodeRefs.integration.test.ts docs
git commit -m "docs: M3-1 완료 조건 검증 결과를 남긴다"
```
