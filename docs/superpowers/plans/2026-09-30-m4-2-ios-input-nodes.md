---
id: m4-2-ios-input-nodes
title: M4-2 — iOS 입력과 노드
status: draft
type: work-order
created: 2026-09-30
updated: 2026-09-30
owner: virtual-device-helper 팀
scope: [main, mcp, shared, ios, renderer]
hosts: [macos]
archived_reason:
related_adr: [ADR-0014, ADR-0015, ADR-0011, ADR-0012, ADR-0005]
related_spec: m4-ios-simulator
related_architecture: main-layers
related_plan: [m4-1-ios-foundation, m4-3-ios-streaming]
related_code: [processClient.ts#createProcessClient, iosDevice.ts#createIosDevice, uiDump.ts#parseUiDump, nodeRefs.ts, ui.ts, coordinates.ts#toPixel, app.ts#waitForSettle, ipc.ts#PlatformStatus, DevicePanel.tsx#DevicePanel, agentGuide.ts]
tags: [plan, ios, axe, node]
---

# M4-2 — iOS 입력과 노드 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: `superpowers:subagent-driven-development`(권장) 또는
> `superpowers:executing-plans`로 task 단위 구현. 각 단계는 체크박스(`- [ ]`)로 추적한다.

**Goal:** 에이전트가 iOS 시뮬레이터에서 `ui_find` → `ui_tap` → `ui_text`로 입력 흐름을 끝낸다.

**Architecture:** `axeClient`가 `axe` 문법을 아는 유일한 층이 된다. `IosDevice`의 입력·`dumpUi`·
`displayFrame`이 AXe로 채워지고, `describe-ui` JSON은 `parseAxeUi`가 `UiDump`로 바꾼다. mcp 층은
바뀌지 않는다 — point 단위 `displayFrame`이 `toPixel`을 그대로 point로 만든다.

**Tech Stack:** TypeScript, AXe CLI, `xcrun simctl`, Vitest

**Spec:** [`../specs/2026-09-29-m4-ios-simulator.md`](../specs/2026-09-29-m4-ios-simulator.md) —
"입력과 노드 (M4-2)" 절, "실패 처리", "스파이크 결과". 결정 근거는
[ADR-0014](../../adr/0014-ios-control-via-axe.md), [ADR-0015](../../adr/0015-platform-difference-surface.md).

**선행 조건:** [M4-1](2026-09-29-m4-1-ios-foundation.md) 완료. 특히 M4-1 Task 1의 fixture
`describe-ui-settings.json`과 스펙 "스파이크 결과"의 1~3·5번 답.

## Global Constraints

- 답변·주석·문서는 한국어로 쓴다. 기술 용어·API 이름·명령어·에러 문자열은 원문 그대로 둔다.
- `axe`를 아는 층은 `src/main/ios/axeClient.ts` 하나다. 모든 호출에 `--udid <udid>`를 붙인다.
  셸 없이 `processClient`로 부른다. 텍스트는 인자가 아니라 stdin으로 넘긴다.
- `axe`를 찾는 순서는 `/opt/homebrew/bin/axe`, `/usr/local/bin/axe`, 그다음 `PATH`다. 패키징된 앱은
  셸 `PATH`를 받지 못하기 때문이다. 못 찾으면 입력·`dumpUi`·`displayFrame`이
  `ios_tool_not_found`, hint `brew install cameroncooke/axe/axe로 설치하고 앱을 다시 켜라`.
- AXe 좌표는 point다. `IosDevice.displayFrame()`은 point 크기를 준다. mcp 층(`ui.ts`,
  `coordinates.ts`, `nodeRefs.ts`)은 고치지 않는다. 고쳐야 할 것 같으면 멈추고 보고한다.
- ADR-0015: mcp·renderer는 `platform`으로 분기하지 않는다. `pressKey('back')`은 iOS에서
  `unsupported('ios', 'back 키', 'iOS에는 back 버튼이 없다')`다.
- 파서 테스트는 M4-1 Task 1에서 채집한 fixture만 쓴다. 필드 이름은 스펙 "스파이크 결과"에 적힌
  실제 이름을 따른다. 이 계획의 AX 속성 이름(`AXLabel`, `AXUniqueId`, `AXValue`, `AXFrame`, `type`)이
  fixture와 다르면 fixture가 옳다.
- 새 npm 의존성을 들이지 않는다.
- 각 task 끝에서 `npm test`와 `npm run typecheck`가 통과해야 한다.
- 문서에는 라인번호, 파일·툴 개수, 진행률을 적지 않는다. 문서를 고치면 `docs.py lint`와 `docs.py links`를 돌린다.
- 커밋 메시지는 한국어 Conventional Commits이고, 끝에 다음 줄을 붙인다:
  `Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>`

## Review Focus

- **패키징된 앱의 PATH**: Finder로 띄운 앱은 `/opt/homebrew/bin`이 `PATH`에 없다. 그래도 axe를
  찾는다. → Task 1 테스트.
- **특수 텍스트**: 따옴표, 개행, 한글, 이모지가 든 `ui_text`가 셸 해석 없이 그대로 가거나, 못 넣는
  문자면 `unsupported`로 분명히 실패한다. 조용히 빠지지 않는다. → Task 3 테스트.
- **빈 트리**: 앱이 뜨는 중이라 `describe-ui`가 루트만 주거나 빈 자식을 줘도 `ui_find`가 빈 결과를
  준다. 던지지 않는다. → Task 2 테스트.
- **화면 밖 노드**: 스크롤 목록에서 화면 밖에 있는 셀은 Android처럼 빠진다(중심이 `displayFrame`
  밖이면 제외). → Task 2 테스트.
- **AXe 없는 호스트**: `simctl` 기능은 계속 되고, 기기 패널에 AXe 설치 안내가 한 줄 보인다.
  → Task 1 테스트.

---

### Task 1: `axeClient`, axe 찾기, stdin 입력

**Files:**
- Create: `src/main/ios/axeClient.ts`, `src/main/ios/axeClient.test.ts`, `src/main/ios/locateAxe.ts`, `src/main/ios/locateAxe.test.ts`
- Modify: `src/main/process/processClient.ts`, `src/main/process/processClient.test.ts`, `src/main/ios/testing.ts`,
  `src/main/index.ts`, `src/shared/types/ipc.ts`, `src/main/app/bootstrap.ts`, `src/renderer/src/components/DevicePanel.tsx`
- Test: `src/renderer/src/components/DevicePanel.test.tsx`, `src/main/app/bootstrap.test.ts`

**Interfaces:**
- Produces (`processClient.ts`): `ExecOpts.input?: string | Buffer` — 주면 stdin에 쓰고 닫는다. 안 주면 지금처럼 stdin을 건드리지 않는다.
- Produces (`axeClient.ts`):
  - `interface AxeClient { exec(udid: string, args: string[], opts?: ExecOpts): Promise<ExecResult>; stream(udid: string, args: string[]): ProcessStream }` — `args` 뒤에 `['--udid', udid]`를 붙인다.
  - `createAxeClient(axePath: string, spawnFn?: SpawnFn): AxeClient`. `notFound`는 `ios_tool_not_found`(위 hint), `classify`는 `command_failed`(details `{ stderr, args }`).
- Produces (`locateAxe.ts`): `locateAxe(deps: { fileExists(path: string): boolean; which(): Promise<string | null> }): Promise<string | null>`.
- Produces (`testing.ts`): `fakeAxe(handlers): AxeClient & { calls: Array<{ args: string[]; input?: string }> }`.
- `PlatformStatus`의 ok 갈래에 `notes: string[]`를 더한다. iOS가 ok인데 axe가 없으면 `notes: ['AXe가 없어 iOS 입력·노드·실시간 화면을 쓸 수 없다. brew install cameroncooke/axe/axe로 설치하고 앱을 다시 켜라']`. `DevicePanel`은 각 플랫폼의 `notes`를 `notice-info` 줄로 그린다.
- `index.ts`의 iOS `createDevice`는 `axe: AxeClient | null`을 `createIosDevice`에 넘긴다(`IosDeviceDeps.axe`, Task 3에서 쓴다).

- [ ] **Step 1: 실패하는 테스트를 쓴다** — `processClient`: `input`을 주면 가짜 child의 stdin에 그 바이트가 쓰이고 `end()`된다 / `axeClient`: `exec('U', ['tap', '-x', '1'])`의 spawn 인자가 `['tap', '-x', '1', '--udid', 'U']` / `locateAxe`: `/opt/homebrew/bin/axe`만 있으면 그 경로, 둘 다 없고 `which`가 `null`이면 `null` / `DevicePanel`: `notes`가 보인다 / `bootstrap`: axe 없음이 스냅샷 `platforms.ios.notes`로 간다.
- [ ] **Step 2: 실패를 확인한다** — Run: `npx vitest run src/main/process src/main/ios src/main/app src/renderer/src/components/DevicePanel.test.tsx` / Expected: FAIL.
- [ ] **Step 3: 구현한다.**
- [ ] **Step 4: 통과를 확인한다** — Run: `npm test && npm run typecheck` / Expected: PASS.
- [ ] **Step 5: 커밋** — `git commit -m "feat(ios): axe 클라이언트와 찾기, 프로세스 stdin 입력을 더한다"`

---

### Task 2: `describe-ui` → `UiDump` 파서

**Files:**
- Create: `src/main/device/parsers/axeUi.ts`, `src/main/device/parsers/axeUi.test.ts`

**Interfaces:**
- Produces: `parseAxeUi(json: string): UiDump`
  - 매핑은 스펙 "노드: `describe-ui` → `UiNode`" 표 그대로. `editable`은 역할이 TextField·SecureTextField·TextView 계열.
  - `frame`(= `displayFrame`)은 최상위 Application 요소의 `AXFrame` 크기(point).
  - 거르기·`index`/`parentIndex`는 `uiDump.ts`의 `collect`와 같은 규칙: 이름(text·contentDesc·resourceId)도 없고 clickable·scrollable도 아닌 노드는 버리되 자식은 조상에 붙인다 / 중심이 `frame` 밖이면 버린다 / `bounds`는 `frame` 기준 0..1, 소수 4자리.
  - JSON이 아니거나 루트가 없으면 `command_failed`, message `describe-ui 출력을 읽지 못했다`.
- Produces: `parseAxeFrame(json: string): DisplayFrame` — 같은 루트 규칙. Task 3의 `displayFrame`이 쓴다.

- [ ] **Step 1: 실패하는 테스트를 쓴다** (`describe-ui-settings.json`) — Settings 첫 화면의 셀 하나(스파이크에서 본 label)가 `clickable: true`와 0..1 `bounds`로 나온다 / 모든 노드의 `parentIndex`가 자기보다 작은 index거나 null / 루트 자식이 빈 배열인 JSON은 `nodes: []` / `frame`의 크기가 fixture 루트 `AXFrame`과 같다 / 중심이 `frame` 아래로 벗어난 노드를 fixture에 더한 복사본에서 그 노드가 빠진다 / TextField 노드가 있으면 `editable: true`.
- [ ] **Step 2: 실패를 확인한다** — Run: `npx vitest run src/main/device/parsers/axeUi.test.ts` / Expected: FAIL.
- [ ] **Step 3: 구현한다.**
- [ ] **Step 4: 통과를 확인한다** — Run: `npm test && npm run typecheck` / Expected: PASS.
- [ ] **Step 5: 커밋** — `git commit -m "feat(ios): describe-ui 트리를 UiDump로 바꾼다"`

---

### Task 3: `IosDevice`의 입력·`dumpUi`·`displayFrame`

**Files:**
- Modify: `src/main/device/iosDevice.ts`, `src/shared/agentGuide.ts`
- Create: `src/main/device/iosDevice.ui.test.ts`
- Test: `src/shared/agentGuide.test.ts`

**Interfaces:**
- Consumes: `AxeClient`, `fakeAxe` (Task 1), `parseAxeUi`, `parseAxeFrame` (Task 2)
- `IosDeviceDeps.axe: AxeClient | null`. null이면 아래 메서드가 모두 `ios_tool_not_found`.
- 매핑은 스펙 "입력 매핑" 표 그대로:
  - `tap(x, y)`: `['tap', '-x', <round>, '-y', <round>]`
  - `swipe(x1, y1, x2, y2, durationMs)`: `['swipe', '--start-x', …, '--end-y', …, '--duration', <durationMs/1000>]`
  - `inputText(text)`: `['type', '--stdin']`, `input: text`. 스파이크 3번이 "비 ASCII 입력 불가"면: 비 ASCII가 섞인 텍스트는 `simctl pbcopy <udid>`(`input: text`) 뒤 `axe key-combo`로 ⌘V(스파이크에서 확인한 인자). 스파이크가 "가능"이면 이 갈래를 만들지 않는다.
  - `pressKey`: `home` → `['button', 'home']`, `enter` → `['key', '40']`, `tab` → `['key', '43']`, `back` → `unsupported`.
  - `dumpUi()`: `['describe-ui']` → `parseAxeUi`.
  - `displayFrame()`: `['describe-ui']` → `parseAxeFrame`. 캐시하지 않는다(회전).
- `agentGuide.ts`의 "플랫폼 차이" 절에서 M4-1의 "iOS 입력은 아직 안 된다" 문장을 지우고, iOS 좌표·노드 차이(`resourceId`는 `accessibilityIdentifier`, `focused`는 늘 false)를 적는다.

- [ ] **Step 1: 실패하는 테스트를 쓴다** — 위 매핑마다 `fakeAxe.calls`의 인자 / `inputText('a"b\nc 한글')`이 인자가 아니라 `input`으로 간다 / `pressKey('back')`은 `unsupported`이고 axe를 부르지 않는다 / `axe: null`이면 `tap`이 `ios_tool_not_found` / `dumpUi()`가 fixture로 Task 2와 같은 결과.
- [ ] **Step 2: 실패를 확인한다** — Run: `npx vitest run src/main/device/iosDevice.ui.test.ts src/shared/agentGuide.test.ts` / Expected: FAIL.
- [ ] **Step 3: 구현한다.**
- [ ] **Step 4: 통과를 확인한다** — Run: `npm test && npm run typecheck` / Expected: PASS.
- [ ] **Step 5: 커밋** — `git commit -m "feat(ios): IosDevice의 탭·스와이프·텍스트·키·노드를 AXe로 구현한다"`

---

### Task 4: 계약 테스트, 통합 테스트, 완료 검증

**Files:**
- Create: `src/main/device/deviceContract.test.ts`, `src/main/device/iosDevice.ui.ios.integration.test.ts`
- Modify: `docs/superpowers/specs/2026-09-29-m4-ios-simulator.md`, `docs/architecture/main-layers.md`, 이 계획 문서

- [ ] **Step 1: 계약 테스트를 쓴다**

`describe.each([['android', makeAndroid], ['ios', makeIos]])`로 같은 시나리오를 돈다. 두 팩토리는 각각
`fakeAdb()`와 `fakeSimctl()`·`fakeAxe()`에 fixture를 물린 기기를 돌려준다.
시나리오: `dumpUi()`의 모든 `bounds`가 0..1 / `displayFrame()`이 양수 크기 / `tap`이 resolve /
`pressKey('home')`이 resolve / `stop`을 두 번 불러도 resolve / `install`에 없는 경로는 `app_path_invalid`.

Run: `npx vitest run src/main/device/deviceContract.test.ts` / Expected: PASS.

- [ ] **Step 2: 통합 테스트를 쓴다**

부팅된 시뮬레이터와 axe가 없으면 skip. Settings를 띄우고 `dumpUi()`에서 clickable 셀 하나를 골라
그 중심을 `displayFrame()` 기준 point로 `tap` → 1초 뒤 `dumpUi()`의 지문이 달라진다 → `pressKey('home')`.

Run: `npm run test:integration -- src/main/device/iosDevice.ui.ios.integration.test.ts` / Expected: PASS.

- [ ] **Step 3: 앱으로 완료 기준을 확인한다**

앱을 띄우고 MCP 클라이언트로: Settings에서 `ui_find({ text: <검색 필드 label> })` → `ui_tap({ ref })` →
`ui_text({ ref, text: 'Wi' })` → `ui_find`로 검색 결과 확인 → 1분 지난 ref로 `ui_tap`하면 화면이 바뀐 경우
`stale_ref`. `app_reset_and_launch`가 이제 `settled`를 준다(`settleSkipped` 없음). `describe-ui` 소요
시간을 다섯 번 재 평균을 적는다. 결과를 스펙 끝 "M4-2 검증 결과" 절에 적는다.

- [ ] **Step 4: 문서를 고치고 커밋한다**

`main-layers.md`에 `axeClient`를 더하고 `verified`를 갱신한다. Run: `python3 docs/script/docs.py lint && python3 docs/script/docs.py links` / Expected: 문제 0건.

`git commit -m "docs(ios): M4-2 계약·통합 테스트와 앱 확인 결과를 남긴다"`
