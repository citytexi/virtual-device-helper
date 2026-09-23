---
id: m1-4-electron-shell-ui
title: M1-4 — Electron 셸과 renderer UI
status: done
type: work-order
created: 2026-09-22
updated: 2026-09-23
owner: virtual-device-helper 팀
scope: [main, preload, renderer, build]
hosts: [macos]
archived_reason: M1 구현 완료. 최소 CSS와 종료 결함은 M1-5 검증 중에 고쳤다.
related_adr: [ADR-0001, ADR-0003, ADR-0006]
related_spec: m1-device-core-mcp-server
related_architecture:
related_plan: [m1-3-mcp-server, m1-5-integration-verification]
related_code:
tags: [plan, m1, renderer, ipc]
---

# M1-4 — Electron 셸과 renderer UI Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: `superpowers:subagent-driven-development`(권장) 또는
> `superpowers:executing-plans`로 task 단위 구현. 각 단계는 체크박스(`- [ ]`)로 추적한다.

**Goal:** 지금까지 만든 조각을 Electron 앱으로 조립한다. main이 SDK를 찾고 registry와 MCP 서버를
띄우고, preload가 좁은 API만 renderer에 열고, renderer가 기기 패널·화면 영역·활동 탭·엔드포인트
카드를 그린다.

**Architecture:** main이 유일한 진실원이다. renderer는 켜질 때 스냅샷을 한 번 받고 이후 이벤트로
갱신한다. preload는 화이트리스트 채널만 노출하고 범용 `invoke(channel, ...)`를 만들지 않는다.
M1의 화면 영역은 정지 스크린샷이지만, 컴포넌트 경계를 M2의 스트리밍 캔버스가 그대로 들어올
자리에 미리 긋는다.

**Tech Stack:** Electron, React, TypeScript, Vitest, @testing-library/react, jsdom

**Spec:** [`../specs/2026-09-22-m1-device-core-mcp-server.md`](../../specs/archive/2026-09-22-m1-device-core-mcp-server.md)

**계획 순서:** [M1-1](2026-09-22-m1-1-foundation-and-adb.md) →
[M1-2](2026-09-22-m1-2-android-device.md) → [M1-3](2026-09-22-m1-3-mcp-server.md) →
M1-4(이 문서) → [M1-5](2026-09-22-m1-5-integration-verification.md)

## Global Constraints

이 프로젝트의 규약이다. 루트 `CLAUDE.md`는 서브에이전트에게 자동 전달되지 않으므로 여기 싣는다.
아래는 **모든 task의 요구사항에 암묵적으로 포함된다.**

- **답변 언어는 한국어.** 기술 용어·API 이름·명령어·에러 문자열은 원문 그대로 둔다. UI 문구도 한국어.
- **코드·주석·커밋 메시지는 일반 산문으로 쓴다.** 축약하거나 caveman 문체로 쓰지 않는다.
- **커밋 메시지는 Conventional Commits.** 본문 마지막 줄에 다음을 붙인다:
  `Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>`
- **TDD.** 실패하는 테스트를 먼저 쓰고, 실패를 확인하고, 최소 구현으로 통과시킨다.
- **Electron 보안 기본값을 끄지 않는다:** `contextIsolation: true`, `nodeIntegration: false`,
  `sandbox: true`.
- **preload는 화이트리스트 채널만 노출한다.** 범용 `invoke(channel, ...)`를 만들지 않는다.
- **renderer에 임의 셸 실행이나 임의 adb 명령을 열지 않는다.** M1에서 renderer가 하는 조작은
  기기 선택·부팅·종료·스크린샷 갱신뿐이다.
- **main이 유일한 진실원이다.** renderer가 자기만의 기기 상태를 따로 추론하지 않는다.
- **M2·M3의 자리를 미리 비운다.** 화면 영역은 교체 가능한 컴포넌트 경계를 갖고, 오른쪽은 탭
  구조를 갖는다.
- **M1의 호스트는 macOS, 타깃은 Android 하나다.**

## 파일 구성

| 파일 | 책임 |
|---|---|
| `src/shared/types/ipc.ts` | IPC 채널 이름, 스냅샷, 이벤트, renderer API 타입 |
| `src/preload/index.ts` | `contextBridge`로 좁은 API 노출 |
| `src/main/app/appState.ts` | SDK 탐색, registry·서버 조립, 스냅샷 생성 |
| `src/main/app/ipcBridge.ts` | 채널 핸들러 등록과 이벤트 브로드캐스트 |
| `src/main/index.ts` | Electron 부트스트랩 |
| `src/renderer/src/state/useAppState.ts` | 스냅샷 + 이벤트 구독 훅 |
| `src/renderer/src/components/DevicePanel.tsx` | 기기 목록·선택·부팅·종료 |
| `src/renderer/src/components/DeviceScreen.tsx` | 기기 화면 영역 (M2 교체 지점) |
| `src/renderer/src/components/ActivityTab.tsx` | 툴 호출 목록 |
| `src/renderer/src/components/WorkArea.tsx` | 오른쪽 탭 컨테이너 |
| `src/renderer/src/components/EndpointCard.tsx` | URL·토큰·설정 JSON 복사 |
| `src/renderer/src/components/SdkMissing.tsx` | SDK 미발견 안내 |
| `src/renderer/src/App.tsx` | 레이아웃 조립 |

---

### Task 1: IPC 계약과 preload

**Files:**
- Modify: `src/shared/types/ipc.ts`
- Modify: `src/preload/index.ts`
- Create: `src/preload/index.test.ts`
- Modify: `package.json` (테스트 의존성)

**Interfaces:**
- Consumes: `AvdEntry`, `ScreenshotResult` (M1-1 Task 2), `ToolCallRecord` (M1-3 Task 1)
- Produces: `IPC_CHANNELS`, `SdkStatus`, `ServerStatus`, `AppSnapshot`, `MainEvent`,
  `RendererApi`, `window.api`. Task 2~7 전부가 쓴다.

- [ ] **Step 1: renderer 테스트 의존성을 설치한다**

```bash
npm install --save-dev jsdom @testing-library/react @testing-library/dom @testing-library/user-event
```

- [ ] **Step 2: 실패 테스트를 쓴다**

`src/preload/index.test.ts`:

```ts
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { IPC_CHANNELS } from '../shared/types/ipc'

const exposed = vi.fn()
const invoke = vi.fn(async () => ({}))
const on = vi.fn()
const removeListener = vi.fn()

vi.mock('electron', () => ({
  contextBridge: { exposeInMainWorld: exposed },
  ipcRenderer: { invoke, on, removeListener }
}))

async function loadPreload(): Promise<Record<string, unknown>> {
  vi.resetModules()
  exposed.mockClear()
  await import('./index')
  return exposed.mock.calls[0]?.[1] as Record<string, unknown>
}

describe('preload API surface', () => {
  beforeEach(() => {
    invoke.mockClear()
    on.mockClear()
  })

  it('exposes the api under a single namespace', async () => {
    await loadPreload()

    expect(exposed).toHaveBeenCalledTimes(1)
    expect(exposed.mock.calls[0]?.[0]).toBe('api')
  })

  it('exposes exactly the whitelisted methods and nothing else', async () => {
    const api = await loadPreload()

    expect(Object.keys(api).sort()).toEqual(
      ['bootAvd', 'captureScreenshot', 'getSnapshot', 'onEvent', 'selectDevice', 'shutdownDevice'].sort()
    )
  })

  it('does not expose a generic invoke that would open arbitrary channels', async () => {
    const api = await loadPreload()

    expect(api.invoke).toBeUndefined()
    expect(api.send).toBeUndefined()
    expect(api.ipcRenderer).toBeUndefined()
  })

  it('routes each method to its own named channel', async () => {
    const api = await loadPreload()

    await (api.selectDevice as (serial: string) => Promise<unknown>)('emulator-5554')

    expect(invoke).toHaveBeenCalledWith(IPC_CHANNELS.selectDevice, 'emulator-5554')
  })

  it('delivers only the event payload to subscribers, never the IpcRendererEvent', async () => {
    const api = await loadPreload()
    const received: unknown[] = []

    ;(api.onEvent as (callback: (event: unknown) => void) => () => void)((event) => received.push(event))

    const handler = on.mock.calls[0]?.[1] as (event: unknown, payload: unknown) => void
    handler({ sender: 'should not leak' }, { type: 'active_changed', serial: 'emulator-5554' })

    expect(received).toEqual([{ type: 'active_changed', serial: 'emulator-5554' }])
  })

  it('unsubscribes when the returned function is called', async () => {
    const api = await loadPreload()

    const off = (api.onEvent as (callback: (event: unknown) => void) => () => void)(() => {})
    off()

    expect(removeListener).toHaveBeenCalledWith(IPC_CHANNELS.event, expect.any(Function))
  })
})
```

- [ ] **Step 3: 테스트가 실패하는지 확인한다**

Run: `npx vitest run src/preload/index.test.ts`
Expected: FAIL — `IPC_CHANNELS` export가 없다

- [ ] **Step 4: IPC 계약을 쓴다**

`src/shared/types/ipc.ts`에 아래를 덧붙인다. 기존 `ToolCallRecord`는 그대로 둔다.

```ts
import type { AvdEntry, ScreenshotResult } from './device'
import type { ToolError } from './errors'

/** 채널 이름은 여기 한곳에만 둔다. preload와 main이 같은 상수를 본다. */
export const IPC_CHANNELS = {
  getSnapshot: 'app:get-snapshot',
  selectDevice: 'app:select-device',
  bootAvd: 'app:boot-avd',
  shutdownDevice: 'app:shutdown-device',
  captureScreenshot: 'app:capture-screenshot',
  event: 'app:event'
} as const

export type SdkStatus = { ok: true; sdkRoot: string } | { ok: false; searched: string[] }

/**
 * IPC를 넘는 결과. 예외로 던지지 않는다 — Electron IPC를 넘는 Error는
 * stack 문자열만 남고 우리가 붙인 kind와 hint가 사라진다.
 */
export type Outcome<T> = { ok: true; value: T } | { ok: false; error: ToolError }

export interface ServerStatus {
  url: string
  port: number
  token: string
}

export interface AppSnapshot {
  sdk: SdkStatus
  server: ServerStatus | null
  avds: AvdEntry[]
  devices: string[]
  activeSerial: string | null
  toolCalls: ToolCallRecord[]
}

export type MainEvent =
  | { type: 'device_connected'; serial: string }
  | { type: 'device_disconnected'; serial: string }
  | { type: 'active_changed'; serial: string | null }
  | { type: 'avds_changed'; avds: AvdEntry[] }
  | { type: 'tool_call'; record: ToolCallRecord }
  | { type: 'server_changed'; server: ServerStatus | null }

/** renderer가 볼 수 있는 전부. 이 목록 밖의 능력은 renderer에 없다. */
export interface RendererApi {
  getSnapshot(): Promise<AppSnapshot>
  selectDevice(serial: string): Promise<Outcome<void>>
  bootAvd(name: string): Promise<Outcome<void>>
  shutdownDevice(serial: string): Promise<Outcome<void>>
  captureScreenshot(serial: string): Promise<Outcome<ScreenshotResult>>
  onEvent(callback: (event: MainEvent) => void): () => void
}
```

- [ ] **Step 5: preload를 구현한다**

`src/preload/index.ts`:

```ts
import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron'
import {
  IPC_CHANNELS,
  type AppSnapshot,
  type MainEvent,
  type Outcome,
  type RendererApi
} from '../shared/types/ipc'
import type { ScreenshotResult } from '../shared/types/device'

/**
 * renderer에 노출하는 전부. 범용 invoke를 만들지 않는다 —
 * 그 하나만 뚫려 있어도 화이트리스트가 의미를 잃는다.
 */
const api: RendererApi = {
  getSnapshot: () => ipcRenderer.invoke(IPC_CHANNELS.getSnapshot) as Promise<AppSnapshot>,
  selectDevice: (serial) =>
    ipcRenderer.invoke(IPC_CHANNELS.selectDevice, serial) as Promise<Outcome<void>>,
  bootAvd: (name) => ipcRenderer.invoke(IPC_CHANNELS.bootAvd, name) as Promise<Outcome<void>>,
  shutdownDevice: (serial) =>
    ipcRenderer.invoke(IPC_CHANNELS.shutdownDevice, serial) as Promise<Outcome<void>>,
  captureScreenshot: (serial) =>
    ipcRenderer.invoke(IPC_CHANNELS.captureScreenshot, serial) as Promise<Outcome<ScreenshotResult>>,
  onEvent: (callback) => {
    // IpcRendererEvent를 renderer로 넘기지 않는다. sender를 통해 더 많은 것이 새어 나간다.
    const listener = (_event: IpcRendererEvent, payload: MainEvent): void => callback(payload)
    ipcRenderer.on(IPC_CHANNELS.event, listener)
    return () => ipcRenderer.removeListener(IPC_CHANNELS.event, listener)
  }
}

contextBridge.exposeInMainWorld('api', api)
```

`src/renderer/src/global.d.ts`를 만들어 renderer가 타입을 본다.

```ts
import type { RendererApi } from '../../shared/types/ipc'

declare global {
  interface Window {
    api: RendererApi
  }
}

export {}
```

- [ ] **Step 6: 테스트가 통과하는지 확인한다**

Run: `npx vitest run src/preload/index.test.ts && npm run typecheck`
Expected: PASS (6 tests), 타입체크 통과

- [ ] **Step 7: 커밋**

```bash
git add src/shared src/preload src/renderer package.json package-lock.json
git commit -m "$(cat <<'EOF'
feat(preload): 화이트리스트 IPC API 노출

renderer가 받는 권한은 여섯 가지뿐이다. 스냅샷 조회, 기기 선택, AVD 부팅,
기기 종료, 스크린샷 갱신, 이벤트 구독.

범용 invoke(channel, ...)를 만들지 않는다. 그 하나만 뚫려 있어도
화이트리스트가 의미를 잃는다. 임의 셸 실행이나 임의 adb 명령은 renderer에
열지 않는다.

이벤트 구독은 payload만 넘긴다. IpcRendererEvent를 그대로 넘기면 sender를
통해 더 많은 것이 새어 나간다.

채널 이름은 shared의 상수 하나에 둔다. 문자열을 양쪽에 적으면 어긋난다.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 2: main 조립과 ipcBridge

**Files:**
- Create: `src/main/app/appState.ts`
- Create: `src/main/app/ipcBridge.ts`
- Modify: `src/main/index.ts`
- Test: `src/main/app/appState.test.ts`
- Test: `src/main/app/ipcBridge.test.ts`

**Interfaces:**
- Consumes: `locateSdk` (M1-1 Task 3), `createAdbClient`·`trackDevices` (M1-1 Task 4·5),
  `createAndroidDevice`·`electronResizeImage`·`createAvdController`·`createDeviceRegistry` (M1-2),
  `startMcpHttpServer` (M1-3 Task 7), `IPC_CHANNELS` (Task 1)
- Produces: `createAppState(deps): AppState`, `AppState`, `registerIpcBridge(ipcMain, state, send)`.
  Task 3 이후의 renderer가 이 스냅샷 모양에 기댄다.

- [ ] **Step 1: appState 실패 테스트를 쓴다**

`src/main/app/appState.test.ts`:

```ts
import { describe, expect, it, vi } from 'vitest'
import type { AvdController } from '../device/avdController'
import type { DeviceRegistry, RegistryEvent } from '../device/registry'
import type { McpServerHandle } from '../mcp/httpServer'
import { createAppState } from './appState'

function parts() {
  let registryListener: ((event: RegistryEvent) => void) | undefined

  const registry = {
    start: vi.fn(),
    stop: vi.fn(),
    serials: vi.fn(() => ['emulator-5554']),
    resolve: vi.fn(),
    setActive: vi.fn(),
    clearActive: vi.fn(),
    getActive: vi.fn(() => 'emulator-5554'),
    run: vi.fn((_serial: string, task: () => Promise<unknown>) => task()),
    on: vi.fn((listener: (event: RegistryEvent) => void) => {
      registryListener = listener
      return () => {}
    })
  } as unknown as DeviceRegistry

  const avd = {
    list: vi.fn(async () => [{ name: 'Pixel_7_API_34', running: true, serial: 'emulator-5554' }]),
    boot: vi.fn(async () => 'emulator-5554'),
    shutdown: vi.fn(async () => {})
  } as unknown as AvdController

  const server: McpServerHandle = {
    url: 'http://127.0.0.1:9321/mcp',
    port: 9321,
    token: 'token-value',
    close: vi.fn(async () => {})
  }

  return { registry, avd, server, fire: (event: RegistryEvent) => registryListener?.(event) }
}

describe('createAppState snapshot', () => {
  it('reports the sdk status it was given', async () => {
    const p = parts()
    const state = createAppState({
      sdk: { ok: false, searched: ['/opt/sdk/platform-tools/adb'] },
      registry: p.registry,
      avd: p.avd,
      server: null
    })

    const snapshot = await state.snapshot()

    expect(snapshot.sdk).toEqual({ ok: false, searched: ['/opt/sdk/platform-tools/adb'] })
    expect(snapshot.server).toBeNull()
  })

  it('includes avds, devices, active serial and the server endpoint', async () => {
    const p = parts()
    const state = createAppState({
      sdk: { ok: true, sdkRoot: '/opt/sdk' },
      registry: p.registry,
      avd: p.avd,
      server: p.server
    })

    const snapshot = await state.snapshot()

    expect(snapshot.avds).toEqual([{ name: 'Pixel_7_API_34', running: true, serial: 'emulator-5554' }])
    expect(snapshot.devices).toEqual(['emulator-5554'])
    expect(snapshot.activeSerial).toBe('emulator-5554')
    expect(snapshot.server).toEqual({ url: 'http://127.0.0.1:9321/mcp', port: 9321, token: 'token-value' })
  })

  it('keeps recorded tool calls newest last and caps how many it holds', async () => {
    const p = parts()
    const state = createAppState({
      sdk: { ok: true, sdkRoot: '/opt/sdk' },
      registry: p.registry,
      avd: p.avd,
      server: p.server,
      toolCallLimit: 3
    })

    for (let i = 0; i < 5; i += 1) {
      state.recordToolCall({
        id: String(i),
        tool: 'ui_tap',
        argsSummary: '{}',
        startedAt: i,
        durationMs: 1,
        ok: true
      })
    }

    const snapshot = await state.snapshot()

    expect(snapshot.toolCalls.map((record) => record.id)).toEqual(['2', '3', '4'])
  })
})

describe('createAppState events', () => {
  it('forwards registry events to subscribers', async () => {
    const p = parts()
    const state = createAppState({
      sdk: { ok: true, sdkRoot: '/opt/sdk' },
      registry: p.registry,
      avd: p.avd,
      server: p.server
    })

    const seen: unknown[] = []
    state.onEvent((event) => seen.push(event))

    p.fire({ type: 'active_changed', serial: 'emulator-5556' })

    expect(seen).toContainEqual({ type: 'active_changed', serial: 'emulator-5556' })
  })

  it('emits a tool_call event when a call is recorded', () => {
    const p = parts()
    const state = createAppState({
      sdk: { ok: true, sdkRoot: '/opt/sdk' },
      registry: p.registry,
      avd: p.avd,
      server: p.server
    })

    const seen: unknown[] = []
    state.onEvent((event) => seen.push(event))

    const record = {
      id: 'a',
      tool: 'screenshot',
      argsSummary: '{}',
      startedAt: 1,
      durationMs: 2,
      ok: true
    }
    state.recordToolCall(record)

    expect(seen).toEqual([{ type: 'tool_call', record }])
  })

  it('emits server_changed and updates the snapshot when the endpoint opens', async () => {
    const p = parts()
    const state = createAppState({
      sdk: { ok: true, sdkRoot: '/opt/sdk' },
      registry: p.registry,
      avd: p.avd,
      server: null
    })

    const seen: unknown[] = []
    state.onEvent((event) => seen.push(event))

    state.setServer(p.server)

    expect(seen).toContainEqual({
      type: 'server_changed',
      server: { url: 'http://127.0.0.1:9321/mcp', port: 9321, token: 'token-value' }
    })
    await expect(state.snapshot().then((snapshot) => snapshot.server)).resolves.toEqual({
      url: 'http://127.0.0.1:9321/mcp',
      port: 9321,
      token: 'token-value'
    })
  })

  it('emits avds_changed after a device connects so the list refreshes', async () => {
    const p = parts()
    const state = createAppState({
      sdk: { ok: true, sdkRoot: '/opt/sdk' },
      registry: p.registry,
      avd: p.avd,
      server: p.server
    })

    const seen: Array<{ type: string }> = []
    state.onEvent((event) => seen.push(event))

    p.fire({ type: 'device_connected', serial: 'emulator-5554' })
    await vi.waitFor(() => expect(seen.some((event) => event.type === 'avds_changed')).toBe(true))
  })
})
```

- [ ] **Step 2: 테스트가 실패하는지 확인한다**

Run: `npx vitest run src/main/app/appState.test.ts`
Expected: FAIL — `Failed to resolve import "./appState"`

- [ ] **Step 3: appState를 구현한다**

`src/main/app/appState.ts`:

```ts
import type { AvdController } from '../device/avdController'
import type { DeviceRegistry, RegistryEvent } from '../device/registry'
import type { McpServerHandle } from '../mcp/httpServer'
import type { AppSnapshot, MainEvent, SdkStatus, ToolCallRecord } from '../../shared/types/ipc'

const DEFAULT_TOOL_CALL_LIMIT = 500

export interface AppStateDeps {
  sdk: SdkStatus
  registry: DeviceRegistry
  avd: AvdController
  server: McpServerHandle | null
  toolCallLimit?: number
}

export interface AppState {
  snapshot(): Promise<AppSnapshot>
  recordToolCall(record: ToolCallRecord): void
  /** 서버는 상태가 만들어진 뒤에 열린다. 툴 컨텍스트가 서버보다 먼저 필요하기 때문이다. */
  setServer(handle: McpServerHandle | null): void
  onEvent(listener: (event: MainEvent) => void): () => void
}

export function createAppState(deps: AppStateDeps): AppState {
  const limit = deps.toolCallLimit ?? DEFAULT_TOOL_CALL_LIMIT
  const toolCalls: ToolCallRecord[] = []
  const listeners = new Set<(event: MainEvent) => void>()
  let server: McpServerHandle | null = deps.server

  function emit(event: MainEvent): void {
    for (const listener of listeners) listener(event)
  }

  async function emitAvds(): Promise<void> {
    emit({ type: 'avds_changed', avds: await deps.avd.list() })
  }

  deps.registry.on((event: RegistryEvent) => {
    emit(event)
    // 기기가 붙거나 떨어지면 AVD의 running 표시가 달라진다.
    if (event.type !== 'active_changed') void emitAvds()
  })

  function endpoint(): AppSnapshot['server'] {
    return server ? { url: server.url, port: server.port, token: server.token } : null
  }

  return {
    async snapshot() {
      return {
        sdk: deps.sdk,
        server: endpoint(),
        avds: deps.sdk.ok ? await deps.avd.list() : [],
        devices: deps.registry.serials(),
        activeSerial: deps.registry.getActive(),
        toolCalls: [...toolCalls]
      }
    },

    recordToolCall(record) {
      toolCalls.push(record)
      // 오래된 것부터 버린다. 전체 이력은 M3의 몫이다.
      if (toolCalls.length > limit) toolCalls.splice(0, toolCalls.length - limit)
      emit({ type: 'tool_call', record })
    },

    setServer(handle) {
      server = handle
      emit({ type: 'server_changed', server: endpoint() })
    },

    onEvent(listener) {
      listeners.add(listener)
      return () => listeners.delete(listener)
    }
  }
}
```

- [ ] **Step 4: ipcBridge 실패 테스트를 쓴다**

`src/main/app/ipcBridge.test.ts`:

```ts
import { describe, expect, it, vi } from 'vitest'
import { IPC_CHANNELS } from '../../shared/types/ipc'
import type { AppState } from './appState'
import { registerIpcBridge, type BridgeActions } from './ipcBridge'

function harness() {
  const handlers = new Map<string, (event: unknown, ...args: unknown[]) => unknown>()
  const ipcMain = {
    handle: (channel: string, handler: (event: unknown, ...args: unknown[]) => unknown) => {
      handlers.set(channel, handler)
    }
  }

  const state = {
    snapshot: vi.fn(async () => ({ sdk: { ok: true, sdkRoot: '/opt/sdk' } })),
    recordToolCall: vi.fn(),
    onEvent: vi.fn((listener: (event: unknown) => void) => {
      listeners.push(listener)
      return () => {}
    })
  } as unknown as AppState

  const listeners: Array<(event: unknown) => void> = []
  const sent: Array<{ channel: string; payload: unknown }> = []

  const actions: BridgeActions = {
    selectDevice: vi.fn(),
    bootAvd: vi.fn(async () => {}),
    shutdownDevice: vi.fn(async () => {}),
    captureScreenshot: vi.fn(async () => ({ base64: 'QUJD', width: 1, height: 1 }))
  }

  registerIpcBridge(ipcMain as never, state, actions, (channel, payload) =>
    sent.push({ channel, payload })
  )

  return { handlers, actions, sent, fire: (event: unknown) => listeners.forEach((l) => l(event)) }
}

describe('registerIpcBridge', () => {
  it('registers exactly the whitelisted channels', () => {
    const h = harness()

    expect([...h.handlers.keys()].sort()).toEqual(
      [
        IPC_CHANNELS.getSnapshot,
        IPC_CHANNELS.selectDevice,
        IPC_CHANNELS.bootAvd,
        IPC_CHANNELS.shutdownDevice,
        IPC_CHANNELS.captureScreenshot
      ].sort()
    )
  })

  it('routes selectDevice to the action with its argument', async () => {
    const h = harness()

    await h.handlers.get(IPC_CHANNELS.selectDevice)?.({}, 'emulator-5554')

    expect(h.actions.selectDevice).toHaveBeenCalledWith('emulator-5554')
  })

  it('returns a serialisable error payload instead of throwing across the boundary', async () => {
    const h = harness()
    ;(h.actions.bootAvd as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
      Object.assign(new Error('그런 AVD가 없다'), {
        toolError: { kind: 'command_failed', message: '그런 AVD가 없다', hint: 'device_list로 확인해라' }
      })
    )

    const result = await h.handlers.get(IPC_CHANNELS.bootAvd)?.({}, 'Nope')

    expect(result).toEqual({
      ok: false,
      error: { kind: 'command_failed', message: '그런 AVD가 없다', hint: 'device_list로 확인해라' }
    })
  })

  it('broadcasts main events on the single event channel', () => {
    const h = harness()

    h.fire({ type: 'active_changed', serial: 'emulator-5554' })

    expect(h.sent).toEqual([
      { channel: IPC_CHANNELS.event, payload: { type: 'active_changed', serial: 'emulator-5554' } }
    ])
  })
})
```

- [ ] **Step 5: 테스트가 실패하는지 확인한다**

Run: `npx vitest run src/main/app/ipcBridge.test.ts`
Expected: FAIL — `Failed to resolve import "./ipcBridge"`

- [ ] **Step 6: ipcBridge를 구현한다**

`src/main/app/ipcBridge.ts`:

```ts
import type { IpcMain } from 'electron'
import { isDeviceError, type ToolError } from '../../shared/types/errors'
import type { ScreenshotResult } from '../../shared/types/device'
import { IPC_CHANNELS, type MainEvent, type Outcome } from '../../shared/types/ipc'
import type { AppState } from './appState'

export interface BridgeActions {
  selectDevice(serial: string): void
  bootAvd(name: string): Promise<void>
  shutdownDevice(serial: string): Promise<void>
  captureScreenshot(serial: string): Promise<ScreenshotResult>
}

export type SendToRenderer = (channel: string, payload: MainEvent) => void

/**
 * 실패를 예외로 던지지 않는다. Electron IPC를 넘는 Error는 stack 문자열만 남고
 * 우리가 붙인 정보가 사라진다. 결과 객체로 바꿔 renderer가 이유를 보게 한다.
 */
async function outcome<T>(run: () => Promise<T> | T): Promise<Outcome<T>> {
  try {
    return { ok: true, value: await run() }
  } catch (thrown) {
    if (isDeviceError(thrown)) return { ok: false, error: thrown.toolError }
    return {
      ok: false,
      error: {
        kind: 'command_failed',
        message: thrown instanceof Error ? thrown.message : String(thrown),
        hint: '다시 시도하고, 반복되면 활동 탭에서 맥락을 확인해라'
      }
    }
  }
}

export function registerIpcBridge(
  ipcMain: IpcMain,
  state: AppState,
  actions: BridgeActions,
  send: SendToRenderer
): void {
  ipcMain.handle(IPC_CHANNELS.getSnapshot, () => state.snapshot())
  ipcMain.handle(IPC_CHANNELS.selectDevice, (_event, serial: string) =>
    outcome(() => actions.selectDevice(serial))
  )
  ipcMain.handle(IPC_CHANNELS.bootAvd, (_event, name: string) => outcome(() => actions.bootAvd(name)))
  ipcMain.handle(IPC_CHANNELS.shutdownDevice, (_event, serial: string) =>
    outcome(() => actions.shutdownDevice(serial))
  )
  ipcMain.handle(IPC_CHANNELS.captureScreenshot, (_event, serial: string) =>
    outcome(() => actions.captureScreenshot(serial))
  )

  state.onEvent((event) => send(IPC_CHANNELS.event, event))
}
```

- [ ] **Step 7: main 부트스트랩에서 전부를 조립한다**

`src/main/index.ts`를 아래로 교체한다.

```ts
import { app, BrowserWindow, ipcMain } from 'electron'
import { join } from 'node:path'
import { spawn } from 'node:child_process'
import { createAdbClient } from './adb/adbClient'
import { trackDevices } from './adb/trackDevices'
import { createAndroidDevice } from './device/androidDevice'
import { createAvdController } from './device/avdController'
import { createDeviceRegistry } from './device/registry'
import { electronResizeImage } from './device/resizeImage'
import { startMcpHttpServer, type McpServerHandle } from './mcp/httpServer'
import { defaultLocateSdkDeps, locateSdk } from './sdk/locateSdk'
import { createAppState, type AppState } from './app/appState'
import { registerIpcBridge } from './app/ipcBridge'
import type { SdkStatus } from '../shared/types/ipc'

let window: BrowserWindow | null = null
let server: McpServerHandle | null = null
let stopRegistry: (() => void) | null = null

function createWindow(): void {
  window = new BrowserWindow({
    width: 1280,
    height: 860,
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  })

  if (process.env.ELECTRON_RENDERER_URL) {
    void window.loadURL(process.env.ELECTRON_RENDERER_URL)
  } else {
    void window.loadFile(join(__dirname, '../renderer/index.html'))
  }
}

async function bootstrap(): Promise<AppState> {
  const located = locateSdk(defaultLocateSdkDeps())

  if (!located.ok) {
    // SDK가 없으면 MCP 서버를 열지 않는다. 툴이 전부 실패할 서버를 여는 것은 거짓말이다.
    const sdk: SdkStatus = { ok: false, searched: located.searched }
    const registry = createDeviceRegistry({ track: () => () => {}, createDevice: () => {
      throw new Error('SDK not found')
    } })
    const avd = createAvdController({
      adb: createAdbClient('adb'),
      emulatorPath: 'emulator',
      spawn,
      listAvdNames: async () => []
    })
    return createAppState({ sdk, registry, avd, server: null })
  }

  const adb = createAdbClient(located.paths.adb)
  const registry = createDeviceRegistry({
    track: (onChange) => trackDevices(adb, onChange),
    createDevice: (serial) =>
      createAndroidDevice({ serial, adb, resizeImage: electronResizeImage })
  })
  const avd = createAvdController({ adb, emulatorPath: located.paths.emulator, spawn })

  registry.start()
  stopRegistry = () => registry.stop()

  const state = createAppState({
    sdk: { ok: true, sdkRoot: located.paths.sdkRoot },
    registry,
    avd,
    server: null
  })

  server = await startMcpHttpServer({
    context: { registry, avd, onToolCall: (record) => state.recordToolCall(record) }
  })
  state.setServer(server)

  registerIpcBridge(
    ipcMain,
    state,
    {
      selectDevice: (serial) => registry.setActive(serial),
      bootAvd: async (name) => {
        await avd.boot(name)
      },
      shutdownDevice: async (serial) => avd.shutdown(serial),
      captureScreenshot: async (serial) => {
        const device = registry.resolve(serial)
        return registry.run(device.serial, () => device.screenshot())
      }
    },
    (channel, payload) => window?.webContents.send(channel, payload)
  )

  return state
}

app.whenReady().then(async () => {
  const state = await bootstrap()
  void state

  createWindow()

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})

app.on('before-quit', () => {
  stopRegistry?.()
  void server?.close()
})
```

> 순서가 이렇게 되는 이유는 하나다. MCP 서버를 열려면 툴 컨텍스트가 필요하고, 툴 컨텍스트의
> `onToolCall`은 `AppState`가 가지고 있다. 그래서 `AppState`를 먼저 만들고 서버를 연 뒤
> `setServer`로 이어 붙인다.

- [ ] **Step 8: 테스트와 타입체크를 돌린다**

Run: `npm test && npm run typecheck`
Expected: 둘 다 PASS (appState 7 + ipcBridge 4 추가)

- [ ] **Step 9: 앱이 뜨고 서버가 열리는지 확인한다**

Run: `npm run dev`
Expected: 창이 뜬다. 터미널에 에러가 없다. 다른 터미널에서 아래가 401이 아니라 200 계열로 답한다면
토큰 검사가 깨진 것이므로 M1-3 Task 7로 돌아간다.

```bash
curl -s -o /dev/null -w '%{http_code}\n' -X POST http://127.0.0.1:9321/mcp
```

Expected: `401`

- [ ] **Step 10: 커밋**

```bash
git add src/main
git commit -m "$(cat <<'EOF'
feat(main): 앱 상태 조립과 IPC 브리지 추가

main이 유일한 진실원이다. renderer는 스냅샷을 한 번 받고 이후 이벤트로
갱신한다. 상태를 양쪽에서 추론하면 반드시 어긋난다.

IPC 핸들러는 예외를 던지지 않고 결과 객체를 돌려준다. Electron IPC를 넘는
Error는 stack 문자열만 남고 우리가 붙인 kind와 hint가 사라진다.

SDK를 찾지 못하면 MCP 서버를 열지 않는다. 툴이 전부 실패할 서버를 여는
것은 거짓말이다. renderer는 안내 화면을 띄운다.

툴 호출 기록은 최근 것만 들고 있는다. 전체 이력은 M3의 몫이다.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 3: renderer 상태 훅

**Files:**
- Create: `src/renderer/src/state/useAppState.ts`
- Test: `src/renderer/src/state/useAppState.test.tsx`

**Interfaces:**
- Consumes: `window.api`, `AppSnapshot`, `MainEvent` (Task 1)
- Produces: `useAppState(): { snapshot, loading }`. Task 4~7의 모든 컴포넌트가 쓴다.

- [ ] **Step 1: 실패 테스트를 쓴다**

`src/renderer/src/state/useAppState.test.tsx`:

```tsx
// @vitest-environment jsdom
import { renderHook, act, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { AppSnapshot, MainEvent, RendererApi } from '../../../shared/types/ipc'
import { useAppState } from './useAppState'

const baseSnapshot: AppSnapshot = {
  sdk: { ok: true, sdkRoot: '/opt/sdk' },
  server: { url: 'http://127.0.0.1:9321/mcp', port: 9321, token: 'token-value' },
  avds: [{ name: 'Pixel_7_API_34', running: false, serial: null }],
  devices: [],
  activeSerial: null,
  toolCalls: []
}

let listener: ((event: MainEvent) => void) | undefined
let unsubscribed = false

beforeEach(() => {
  listener = undefined
  unsubscribed = false
  const api: Partial<RendererApi> = {
    getSnapshot: vi.fn(async () => baseSnapshot),
    onEvent: (callback) => {
      listener = callback
      return () => {
        unsubscribed = true
      }
    }
  }
  ;(window as unknown as { api: RendererApi }).api = api as RendererApi
})

describe('useAppState', () => {
  it('starts in a loading state and then fills in the snapshot', async () => {
    const { result } = renderHook(() => useAppState())

    expect(result.current.loading).toBe(true)

    await waitFor(() => expect(result.current.loading).toBe(false))
    expect(result.current.snapshot?.sdk).toEqual({ ok: true, sdkRoot: '/opt/sdk' })
  })

  it('adds a device when a device_connected event arrives', async () => {
    const { result } = renderHook(() => useAppState())
    await waitFor(() => expect(result.current.loading).toBe(false))

    act(() => listener?.({ type: 'device_connected', serial: 'emulator-5554' }))

    expect(result.current.snapshot?.devices).toEqual(['emulator-5554'])
  })

  it('removes a device when a device_disconnected event arrives', async () => {
    const { result } = renderHook(() => useAppState())
    await waitFor(() => expect(result.current.loading).toBe(false))

    act(() => listener?.({ type: 'device_connected', serial: 'emulator-5554' }))
    act(() => listener?.({ type: 'device_disconnected', serial: 'emulator-5554' }))

    expect(result.current.snapshot?.devices).toEqual([])
  })

  it('updates the active serial', async () => {
    const { result } = renderHook(() => useAppState())
    await waitFor(() => expect(result.current.loading).toBe(false))

    act(() => listener?.({ type: 'active_changed', serial: 'emulator-5554' }))

    expect(result.current.snapshot?.activeSerial).toBe('emulator-5554')
  })

  it('appends tool calls in arrival order', async () => {
    const { result } = renderHook(() => useAppState())
    await waitFor(() => expect(result.current.loading).toBe(false))

    const record = { id: 'a', tool: 'ui_tap', argsSummary: '{}', startedAt: 1, durationMs: 2, ok: true }
    act(() => listener?.({ type: 'tool_call', record }))

    expect(result.current.snapshot?.toolCalls).toEqual([record])
  })

  it('replaces the avd list when it changes', async () => {
    const { result } = renderHook(() => useAppState())
    await waitFor(() => expect(result.current.loading).toBe(false))

    act(() =>
      listener?.({
        type: 'avds_changed',
        avds: [{ name: 'Pixel_7_API_34', running: true, serial: 'emulator-5554' }]
      })
    )

    expect(result.current.snapshot?.avds[0]?.running).toBe(true)
  })

  it('unsubscribes on unmount so events do not hit a dead component', async () => {
    const { result, unmount } = renderHook(() => useAppState())
    await waitFor(() => expect(result.current.loading).toBe(false))

    unmount()

    expect(unsubscribed).toBe(true)
  })
})
```

- [ ] **Step 2: 테스트가 실패하는지 확인한다**

Run: `npx vitest run src/renderer/src/state/useAppState.test.tsx`
Expected: FAIL — `Failed to resolve import "./useAppState"`

- [ ] **Step 3: 구현한다**

`src/renderer/src/state/useAppState.ts`:

```ts
import { useEffect, useState } from 'react'
import type { AppSnapshot, MainEvent } from '../../../shared/types/ipc'

function reduce(snapshot: AppSnapshot, event: MainEvent): AppSnapshot {
  switch (event.type) {
    case 'device_connected':
      return snapshot.devices.includes(event.serial)
        ? snapshot
        : { ...snapshot, devices: [...snapshot.devices, event.serial] }
    case 'device_disconnected':
      return { ...snapshot, devices: snapshot.devices.filter((serial) => serial !== event.serial) }
    case 'active_changed':
      return { ...snapshot, activeSerial: event.serial }
    case 'avds_changed':
      return { ...snapshot, avds: event.avds }
    case 'tool_call':
      return { ...snapshot, toolCalls: [...snapshot.toolCalls, event.record] }
    case 'server_changed':
      return { ...snapshot, server: event.server }
  }
}

/**
 * main이 유일한 진실원이다. 여기서는 스냅샷을 한 번 받고 이벤트로 갱신만 한다.
 * renderer가 자기만의 기기 상태를 따로 추론하지 않는다.
 */
export function useAppState(): { snapshot: AppSnapshot | null; loading: boolean } {
  const [snapshot, setSnapshot] = useState<AppSnapshot | null>(null)

  useEffect(() => {
    let alive = true

    void window.api.getSnapshot().then((initial) => {
      if (alive) setSnapshot(initial)
    })

    const off = window.api.onEvent((event) => {
      setSnapshot((current) => (current ? reduce(current, event) : current))
    })

    return () => {
      alive = false
      off()
    }
  }, [])

  return { snapshot, loading: snapshot === null }
}
```

- [ ] **Step 4: 테스트가 통과하는지 확인한다**

Run: `npx vitest run src/renderer/src/state/useAppState.test.tsx`
Expected: PASS (7 tests)

- [ ] **Step 5: 커밋**

```bash
git add src/renderer
git commit -m "$(cat <<'EOF'
feat(renderer): 스냅샷과 이벤트를 합치는 상태 훅 추가

켜질 때 스냅샷을 한 번 받고 이후는 이벤트로 갱신한다. 폴링하지 않는다.

리듀서를 switch로 모두 다루게 둬서 이벤트 종류가 늘면 타입 검사에서
걸린다. 기본 분기로 조용히 무시하면 새 이벤트가 화면에 반영되지 않는
것을 나중에 발견한다.

언마운트 시 구독을 끊는다.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 4: 기기 패널

**Files:**
- Create: `src/renderer/src/components/DevicePanel.tsx`
- Test: `src/renderer/src/components/DevicePanel.test.tsx`

**Interfaces:**
- Consumes: `AppSnapshot`, `window.api` (Task 1·3)
- Produces: `<DevicePanel snapshot={...} />`. Task 7의 `App`이 배치한다.

- [ ] **Step 1: 실패 테스트를 쓴다**

`src/renderer/src/components/DevicePanel.test.tsx`:

```tsx
// @vitest-environment jsdom
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { AppSnapshot, RendererApi } from '../../../shared/types/ipc'
import { DevicePanel } from './DevicePanel'

const selectDevice = vi.fn(async () => ({ ok: true, value: undefined }))
const bootAvd = vi.fn(async () => ({ ok: true, value: undefined }))
const shutdownDevice = vi.fn(async () => ({ ok: true, value: undefined }))

beforeEach(() => {
  selectDevice.mockClear()
  bootAvd.mockClear()
  shutdownDevice.mockClear()
  ;(window as unknown as { api: Partial<RendererApi> }).api = {
    selectDevice,
    bootAvd,
    shutdownDevice
  } as unknown as RendererApi
})

function snapshot(overrides: Partial<AppSnapshot> = {}): AppSnapshot {
  return {
    sdk: { ok: true, sdkRoot: '/opt/sdk' },
    server: null,
    avds: [
      { name: 'Pixel_7_API_34', running: true, serial: 'emulator-5554' },
      { name: 'Pixel_Tablet', running: false, serial: null }
    ],
    devices: ['emulator-5554'],
    activeSerial: 'emulator-5554',
    toolCalls: [],
    ...overrides
  }
}

describe('DevicePanel', () => {
  it('lists every AVD by name', () => {
    render(<DevicePanel snapshot={snapshot()} />)

    expect(screen.getByText('Pixel_7_API_34')).toBeDefined()
    expect(screen.getByText('Pixel_Tablet')).toBeDefined()
  })

  it('shows the serial of a running AVD', () => {
    render(<DevicePanel snapshot={snapshot()} />)

    expect(screen.getByText('emulator-5554')).toBeDefined()
  })

  it('marks the active device so the user knows where tools will go', () => {
    render(<DevicePanel snapshot={snapshot()} />)

    expect(screen.getByRole('listitem', { current: true })).toBeDefined()
  })

  it('offers 부팅 for a stopped AVD and 종료 for a running one', () => {
    render(<DevicePanel snapshot={snapshot()} />)

    expect(screen.getByRole('button', { name: /Pixel_Tablet 부팅/ })).toBeDefined()
    expect(screen.getByRole('button', { name: /Pixel_7_API_34 종료/ })).toBeDefined()
  })

  it('boots the AVD that was clicked', async () => {
    render(<DevicePanel snapshot={snapshot()} />)

    await userEvent.click(screen.getByRole('button', { name: /Pixel_Tablet 부팅/ }))

    expect(bootAvd).toHaveBeenCalledWith('Pixel_Tablet')
  })

  it('shuts down the serial of the AVD that was clicked', async () => {
    render(<DevicePanel snapshot={snapshot()} />)

    await userEvent.click(screen.getByRole('button', { name: /Pixel_7_API_34 종료/ }))

    expect(shutdownDevice).toHaveBeenCalledWith('emulator-5554')
  })

  it('selects a device when its row is clicked', async () => {
    render(
      <DevicePanel
        snapshot={snapshot({
          avds: [
            { name: 'Pixel_7_API_34', running: true, serial: 'emulator-5554' },
            { name: 'Pixel_Tablet', running: true, serial: 'emulator-5556' }
          ],
          devices: ['emulator-5554', 'emulator-5556']
        })}
      />
    )

    await userEvent.click(screen.getByText('Pixel_Tablet'))

    expect(selectDevice).toHaveBeenCalledWith('emulator-5556')
  })

  it('shows a progress state while an AVD is booting', async () => {
    let resolveBoot: (() => void) | undefined
    bootAvd.mockImplementationOnce(
      () => new Promise((resolve) => {
        resolveBoot = () => resolve({ ok: true, value: undefined })
      })
    )
    render(<DevicePanel snapshot={snapshot()} />)

    await userEvent.click(screen.getByRole('button', { name: /Pixel_Tablet 부팅/ }))

    expect(screen.getByText('부팅 중…')).toBeDefined()

    resolveBoot?.()
    await waitFor(() => expect(screen.queryByText('부팅 중…')).toBeNull())
  })

  it('shows the failure reason when booting fails', async () => {
    bootAvd.mockResolvedValueOnce({
      ok: false,
      error: { kind: 'command_failed', message: '그런 AVD가 없다', hint: '목록을 확인해라' }
    })
    render(<DevicePanel snapshot={snapshot()} />)

    await userEvent.click(screen.getByRole('button', { name: /Pixel_Tablet 부팅/ }))

    await waitFor(() => expect(screen.getByText(/그런 AVD가 없다/)).toBeDefined())
  })

  it('tells the user when there is no AVD at all', () => {
    render(<DevicePanel snapshot={snapshot({ avds: [], devices: [], activeSerial: null })} />)

    expect(screen.getByText(/AVD가 없다/)).toBeDefined()
  })
})
```

- [ ] **Step 2: 테스트가 실패하는지 확인한다**

Run: `npx vitest run src/renderer/src/components/DevicePanel.test.tsx`
Expected: FAIL — `Failed to resolve import "./DevicePanel"`

- [ ] **Step 3: 구현한다**

`src/renderer/src/components/DevicePanel.tsx`:

```tsx
import { useState } from 'react'
import type { AppSnapshot, Outcome } from '../../../shared/types/ipc'
import type { ToolError } from '../../../shared/types/errors'

export interface DevicePanelProps {
  snapshot: AppSnapshot
}

export function DevicePanel({ snapshot }: DevicePanelProps): JSX.Element {
  const [busy, setBusy] = useState<string | null>(null)
  const [failure, setFailure] = useState<ToolError | null>(null)

  async function run(label: string, action: () => Promise<Outcome<unknown>>): Promise<void> {
    setBusy(label)
    setFailure(null)
    const result = await action()
    setBusy(null)
    if (!result.ok) setFailure(result.error)
  }

  if (snapshot.avds.length === 0) {
    return (
      <section aria-label="기기">
        <h2>기기</h2>
        <p>AVD가 없다. Android Studio의 Device Manager에서 하나 만들고 앱을 다시 켜라.</p>
      </section>
    )
  }

  return (
    <section aria-label="기기">
      <h2>기기</h2>

      {busy === 'boot' ? <p>부팅 중…</p> : null}
      {failure ? (
        <p role="alert">
          {failure.message} — {failure.hint}
        </p>
      ) : null}

      <ul>
        {snapshot.avds.map((avd) => {
          const isActive = avd.serial !== null && avd.serial === snapshot.activeSerial

          return (
            <li key={avd.name} aria-current={isActive ? true : undefined}>
              <button
                type="button"
                onClick={() => {
                  if (avd.serial) void run('select', () => window.api.selectDevice(avd.serial as string))
                }}
                disabled={!avd.running}
              >
                {avd.name}
              </button>

              {avd.serial ? <span>{avd.serial}</span> : null}

              {avd.running && avd.serial ? (
                <button
                  type="button"
                  onClick={() => void run('shutdown', () => window.api.shutdownDevice(avd.serial as string))}
                  disabled={busy !== null}
                >
                  {avd.name} 종료
                </button>
              ) : (
                <button
                  type="button"
                  onClick={() => void run('boot', () => window.api.bootAvd(avd.name))}
                  disabled={busy !== null}
                >
                  {avd.name} 부팅
                </button>
              )}
            </li>
          )
        })}
      </ul>
    </section>
  )
}
```

- [ ] **Step 4: 테스트가 통과하는지 확인한다**

Run: `npx vitest run src/renderer/src/components/DevicePanel.test.tsx`
Expected: PASS (11 tests)

- [ ] **Step 5: 커밋**

```bash
git add src/renderer
git commit -m "$(cat <<'EOF'
feat(renderer): AVD 목록과 부팅·종료·선택을 다루는 기기 패널 추가

활성 기기를 aria-current로 표시한다. 어느 기기로 툴이 가는지 보이지
않으면 사용자가 엉뚱한 기기를 보며 디버깅한다.

부팅은 오래 걸린다. 진행 표시를 두고 그동안 다른 버튼을 막는다.

실패하면 kind가 아니라 message와 hint를 보여준다. 사용자에게는 무엇을
하면 되는지가 필요하다.

AVD가 하나도 없는 경우를 빈 목록으로 두지 않고 다음 행동을 안내한다.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 5: 기기 화면 영역

**Files:**
- Create: `src/renderer/src/components/DeviceScreen.tsx`
- Test: `src/renderer/src/components/DeviceScreen.test.tsx`

**Interfaces:**
- Consumes: `window.api.captureScreenshot`
- Produces: `<DeviceScreen serial={...} />`. **M2에서 이 컴포넌트의 내부만 스트리밍 캔버스로
  바뀐다. 바깥 경계와 props는 그대로 둔다.**

- [ ] **Step 1: 실패 테스트를 쓴다**

`src/renderer/src/components/DeviceScreen.test.tsx`:

```tsx
// @vitest-environment jsdom
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { RendererApi } from '../../../shared/types/ipc'
import { DeviceScreen } from './DeviceScreen'

const captureScreenshot = vi.fn(async () => ({
  ok: true,
  value: { base64: 'QUJD', width: 360, height: 800 }
}))

beforeEach(() => {
  captureScreenshot.mockClear()
  ;(window as unknown as { api: Partial<RendererApi> }).api = {
    captureScreenshot
  } as unknown as RendererApi
})

describe('DeviceScreen', () => {
  it('asks for no screenshot when there is no device', () => {
    render(<DeviceScreen serial={null} />)

    expect(captureScreenshot).not.toHaveBeenCalled()
    expect(screen.getByText(/기기를 선택해라/)).toBeDefined()
  })

  it('captures once for the given serial on mount', async () => {
    render(<DeviceScreen serial="emulator-5554" />)

    await waitFor(() => expect(captureScreenshot).toHaveBeenCalledWith('emulator-5554'))
    expect(captureScreenshot).toHaveBeenCalledTimes(1)
  })

  it('renders the captured png as an image', async () => {
    render(<DeviceScreen serial="emulator-5554" />)

    const image = (await screen.findByRole('img')) as HTMLImageElement
    expect(image.src).toBe('data:image/png;base64,QUJD')
  })

  it('recaptures when the refresh button is pressed', async () => {
    render(<DeviceScreen serial="emulator-5554" />)
    await screen.findByRole('img')

    await userEvent.click(screen.getByRole('button', { name: '새로고침' }))

    await waitFor(() => expect(captureScreenshot).toHaveBeenCalledTimes(2))
  })

  it('recaptures when the serial changes', async () => {
    const { rerender } = render(<DeviceScreen serial="emulator-5554" />)
    await screen.findByRole('img')

    rerender(<DeviceScreen serial="emulator-5556" />)

    await waitFor(() => expect(captureScreenshot).toHaveBeenLastCalledWith('emulator-5556'))
  })

  it('shows the failure reason instead of a blank frame', async () => {
    captureScreenshot.mockResolvedValueOnce({
      ok: false,
      error: { kind: 'device_unresponsive', message: '응답이 없다', hint: '다시 부팅해라' }
    } as never)

    render(<DeviceScreen serial="emulator-5554" />)

    await waitFor(() => expect(screen.getByText(/응답이 없다/)).toBeDefined())
  })
})
```

- [ ] **Step 2: 테스트가 실패하는지 확인한다**

Run: `npx vitest run src/renderer/src/components/DeviceScreen.test.tsx`
Expected: FAIL — `Failed to resolve import "./DeviceScreen"`

- [ ] **Step 3: 구현한다**

`src/renderer/src/components/DeviceScreen.tsx`:

```tsx
import { useCallback, useEffect, useState } from 'react'
import type { ToolError } from '../../../shared/types/errors'
import type { ScreenshotResult } from '../../../shared/types/device'

export interface DeviceScreenProps {
  serial: string | null
}

/**
 * 기기 화면을 보여주는 영역.
 *
 * M1에서는 정지 스크린샷이다. M2에서 이 컴포넌트의 내부만 scrcpy 스트리밍
 * 캔버스로 바뀐다. props와 바깥 경계는 그대로 두므로 App은 손대지 않는다.
 */
export function DeviceScreen({ serial }: DeviceScreenProps): JSX.Element {
  const [shot, setShot] = useState<ScreenshotResult | null>(null)
  const [failure, setFailure] = useState<ToolError | null>(null)
  const [capturing, setCapturing] = useState(false)

  const capture = useCallback(async (target: string) => {
    setCapturing(true)
    setFailure(null)
    const result = await window.api.captureScreenshot(target)
    setCapturing(false)

    if (result.ok) setShot(result.value)
    else setFailure(result.error)
  }, [])

  useEffect(() => {
    if (!serial) {
      setShot(null)
      return
    }
    void capture(serial)
  }, [serial, capture])

  if (!serial) {
    return (
      <section aria-label="기기 화면">
        <p>기기를 선택해라. 왼쪽 목록에서 실행 중인 기기를 누르면 화면이 뜬다.</p>
      </section>
    )
  }

  return (
    <section aria-label="기기 화면">
      <button type="button" onClick={() => void capture(serial)} disabled={capturing}>
        새로고침
      </button>

      {failure ? (
        <p role="alert">
          {failure.message} — {failure.hint}
        </p>
      ) : null}

      {shot ? (
        <img
          src={`data:image/png;base64,${shot.base64}`}
          alt={`${serial}의 화면`}
          width={shot.width}
          height={shot.height}
        />
      ) : null}
    </section>
  )
}
```

- [ ] **Step 4: 테스트가 통과하는지 확인한다**

Run: `npx vitest run src/renderer/src/components/DeviceScreen.test.tsx`
Expected: PASS (6 tests)

- [ ] **Step 5: 커밋**

```bash
git add src/renderer
git commit -m "$(cat <<'EOF'
feat(renderer): 기기 화면 영역 추가

M1에서는 정지 스크린샷을 보여준다. M2에서 이 컴포넌트의 내부만 scrcpy
스트리밍 캔버스로 바뀐다. props와 바깥 경계를 지금 확정해 두면 그때 App을
손대지 않는다.

serial이 바뀌면 다시 캡처한다. 기기를 바꿨는데 이전 기기의 화면이 남아
있으면 사용자가 잘못된 화면을 보며 판단한다.

실패하면 빈 프레임을 두지 않고 이유를 보여준다.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 6: 활동 탭과 작업 영역

**Files:**
- Create: `src/renderer/src/components/ActivityTab.tsx`
- Create: `src/renderer/src/components/WorkArea.tsx`
- Test: `src/renderer/src/components/ActivityTab.test.tsx`
- Test: `src/renderer/src/components/WorkArea.test.tsx`

**Interfaces:**
- Consumes: `ToolCallRecord` (M1-3 Task 1)
- Produces: `<ActivityTab records={...} />`, `<WorkArea snapshot={...} />`.
  **M3에서 `WorkArea`에 "로그" 탭이 추가된다.**

- [ ] **Step 1: 실패 테스트를 쓴다**

`src/renderer/src/components/ActivityTab.test.tsx`:

```tsx
// @vitest-environment jsdom
import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import type { ToolCallRecord } from '../../../shared/types/ipc'
import { ActivityTab } from './ActivityTab'

function record(overrides: Partial<ToolCallRecord> = {}): ToolCallRecord {
  return {
    id: 'a',
    tool: 'ui_tap',
    argsSummary: '{"x":540,"y":930}',
    startedAt: Date.UTC(2026, 8, 22, 2, 6, 21),
    durationMs: 42,
    ok: true,
    ...overrides
  }
}

describe('ActivityTab', () => {
  it('tells the user what to do when nothing has happened yet', () => {
    render(<ActivityTab records={[]} />)

    expect(screen.getByText(/아직 호출이 없다/)).toBeDefined()
  })

  it('shows the tool name, argument summary and duration', () => {
    render(<ActivityTab records={[record()]} />)

    expect(screen.getByText('ui_tap')).toBeDefined()
    expect(screen.getByText('{"x":540,"y":930}')).toBeDefined()
    expect(screen.getByText('42ms')).toBeDefined()
  })

  it('shows newest first so the latest call is not buried', () => {
    render(
      <ActivityTab
        records={[record({ id: 'a', tool: 'app_launch' }), record({ id: 'b', tool: 'screenshot' })]}
      />
    )

    const rows = screen.getAllByRole('listitem')
    expect(rows[0]?.textContent).toContain('screenshot')
  })

  it('marks a failed call and names its error kind', () => {
    render(<ActivityTab records={[record({ ok: false, errorKind: 'no_device' })]} />)

    expect(screen.getByText(/no_device/)).toBeDefined()
    expect(screen.getByRole('listitem').getAttribute('data-ok')).toBe('false')
  })
})
```

`src/renderer/src/components/WorkArea.test.tsx`:

```tsx
// @vitest-environment jsdom
import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import type { AppSnapshot } from '../../../shared/types/ipc'
import { WorkArea } from './WorkArea'

const snapshot: AppSnapshot = {
  sdk: { ok: true, sdkRoot: '/opt/sdk' },
  server: null,
  avds: [],
  devices: [],
  activeSerial: null,
  toolCalls: []
}

describe('WorkArea', () => {
  it('renders a tab list even though M1 has only one tab', () => {
    render(<WorkArea snapshot={snapshot} />)

    expect(screen.getByRole('tablist')).toBeDefined()
    expect(screen.getByRole('tab', { name: '활동' })).toBeDefined()
  })

  it('shows the activity panel as the selected tab', () => {
    render(<WorkArea snapshot={snapshot} />)

    expect(screen.getByRole('tab', { name: '활동' }).getAttribute('aria-selected')).toBe('true')
    expect(screen.getByRole('tabpanel')).toBeDefined()
  })
})
```

- [ ] **Step 2: 테스트가 실패하는지 확인한다**

Run: `npx vitest run src/renderer/src/components/ActivityTab.test.tsx src/renderer/src/components/WorkArea.test.tsx`
Expected: FAIL — 두 모듈 모두 import 실패

- [ ] **Step 3: 구현한다**

`src/renderer/src/components/ActivityTab.tsx`:

```tsx
import type { ToolCallRecord } from '../../../shared/types/ipc'

export interface ActivityTabProps {
  records: ToolCallRecord[]
}

function formatTime(epochMs: number): string {
  return new Date(epochMs).toLocaleTimeString('ko-KR', { hour12: false })
}

/**
 * 툴 호출을 한 줄씩 쌓는다. 필터·검색·상세는 M3다.
 * M1에서 이것이 필요한 이유는 예쁨이 아니라 디버깅이다 —
 * 에이전트가 무엇을 하는지 안 보이면 개발이 안 된다.
 */
export function ActivityTab({ records }: ActivityTabProps): JSX.Element {
  if (records.length === 0) {
    return <p>아직 호출이 없다. 외부 에이전트를 붙이면 여기에 쌓인다.</p>
  }

  return (
    <ul>
      {[...records].reverse().map((record) => (
        <li key={record.id} data-ok={String(record.ok)}>
          <time>{formatTime(record.startedAt)}</time>
          <strong>{record.tool}</strong>
          <code>{record.argsSummary}</code>
          <span>{record.durationMs}ms</span>
          {record.ok ? null : <span>{record.errorKind}</span>}
        </li>
      ))}
    </ul>
  )
}
```

`src/renderer/src/components/WorkArea.tsx`:

```tsx
import type { AppSnapshot } from '../../../shared/types/ipc'
import { ActivityTab } from './ActivityTab'

export interface WorkAreaProps {
  snapshot: AppSnapshot
}

/**
 * 오른쪽 작업 영역. M1에는 탭이 하나뿐이지만 탭 구조로 만들어 둔다.
 * M3에서 "로그" 탭이 옆에 붙는다.
 */
export function WorkArea({ snapshot }: WorkAreaProps): JSX.Element {
  return (
    <section aria-label="작업 영역">
      <div role="tablist">
        <button type="button" role="tab" aria-selected="true" id="tab-activity" aria-controls="panel-activity">
          활동
        </button>
      </div>

      <div role="tabpanel" id="panel-activity" aria-labelledby="tab-activity">
        <ActivityTab records={snapshot.toolCalls} />
      </div>
    </section>
  )
}
```

- [ ] **Step 4: 테스트가 통과하는지 확인한다**

Run: `npx vitest run src/renderer/src/components`
Expected: PASS (DevicePanel 11 + DeviceScreen 6 + ActivityTab 4 + WorkArea 2 = 23 tests)

- [ ] **Step 5: 커밋**

```bash
git add src/renderer
git commit -m "$(cat <<'EOF'
feat(renderer): 툴 호출 활동 탭과 탭 구조 추가

활동 탭은 최신 호출을 위에 둔다. 오래된 것이 위에 있으면 방금 무슨 일이
있었는지 보려고 매번 스크롤해야 한다.

실패한 호출은 error kind를 함께 보여준다. 여기서 원인이 보이면 에이전트
쪽 로그를 뒤지지 않아도 된다.

탭이 하나뿐이지만 탭 구조로 만든다. M3에서 로그 탭이 붙을 때 레이아웃을
갈아엎지 않는다.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 7: 엔드포인트 카드, SDK 안내, 레이아웃 조립

**Files:**
- Create: `src/renderer/src/components/EndpointCard.tsx`
- Create: `src/renderer/src/components/SdkMissing.tsx`
- Modify: `src/renderer/src/App.tsx`
- Test: `src/renderer/src/components/EndpointCard.test.tsx`
- Test: `src/renderer/src/components/SdkMissing.test.tsx`
- Test: `src/renderer/src/App.test.tsx`

**Interfaces:**
- Consumes: Task 3~6의 모든 컴포넌트와 `useAppState`
- Produces: 완성된 `<App />`. M1-5의 완료 검증이 이 화면을 본다.

- [ ] **Step 1: 실패 테스트를 쓴다**

`src/renderer/src/components/EndpointCard.test.tsx`:

```tsx
// @vitest-environment jsdom
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { EndpointCard } from './EndpointCard'

const writeText = vi.fn(async () => {})

beforeEach(() => {
  writeText.mockClear()
  Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true })
})

const server = { url: 'http://127.0.0.1:9321/mcp', port: 9321, token: 'token-value' }

describe('EndpointCard', () => {
  it('explains that the server is not running when there is none', () => {
    render(<EndpointCard server={null} />)

    expect(screen.getByText(/서버가 떠 있지 않다/)).toBeDefined()
  })

  it('shows the endpoint url', () => {
    render(<EndpointCard server={server} />)

    expect(screen.getByText('http://127.0.0.1:9321/mcp')).toBeDefined()
  })

  it('hides the token until the user asks to see it', async () => {
    render(<EndpointCard server={server} />)

    expect(screen.queryByText('token-value')).toBeNull()

    await userEvent.click(screen.getByRole('button', { name: '토큰 보기' }))

    expect(screen.getByText('token-value')).toBeDefined()
  })

  it('copies the token', async () => {
    render(<EndpointCard server={server} />)

    await userEvent.click(screen.getByRole('button', { name: '토큰 복사' }))

    await waitFor(() => expect(writeText).toHaveBeenCalledWith('token-value'))
  })

  it('copies a config snippet that carries both url and token', async () => {
    render(<EndpointCard server={server} />)

    await userEvent.click(screen.getByRole('button', { name: '설정 JSON 복사' }))

    await waitFor(() => expect(writeText).toHaveBeenCalled())
    const copied = writeText.mock.calls[0]?.[0] as string
    const parsed = JSON.parse(copied) as Record<string, unknown>

    expect(copied).toContain('http://127.0.0.1:9321/mcp')
    expect(copied).toContain('token-value')
    expect(parsed).toHaveProperty('mcpServers')
  })
})
```

`src/renderer/src/components/SdkMissing.test.tsx`:

```tsx
// @vitest-environment jsdom
import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { SdkMissing } from './SdkMissing'

describe('SdkMissing', () => {
  it('says what to install', () => {
    render(<SdkMissing searched={['/opt/sdk/platform-tools/adb']} />)

    expect(screen.getByText(/Android Studio/)).toBeDefined()
  })

  it('lists every path it looked at so the user can see why it failed', () => {
    render(<SdkMissing searched={['/opt/a/adb', '/opt/b/adb']} />)

    expect(screen.getByText('/opt/a/adb')).toBeDefined()
    expect(screen.getByText('/opt/b/adb')).toBeDefined()
  })

  it('names the environment variables that override the search', () => {
    render(<SdkMissing searched={[]} />)

    expect(screen.getByText(/ANDROID_HOME/)).toBeDefined()
  })
})
```

`src/renderer/src/App.test.tsx`:

```tsx
// @vitest-environment jsdom
import { render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { AppSnapshot, RendererApi } from '../../shared/types/ipc'
import { App } from './App'

function mockApi(snapshot: AppSnapshot): void {
  ;(window as unknown as { api: Partial<RendererApi> }).api = {
    getSnapshot: vi.fn(async () => snapshot),
    onEvent: () => () => {},
    captureScreenshot: vi.fn(async () => ({ ok: true, value: { base64: 'QUJD', width: 1, height: 1 } })),
    selectDevice: vi.fn(),
    bootAvd: vi.fn(),
    shutdownDevice: vi.fn()
  } as unknown as RendererApi
}

const ready: AppSnapshot = {
  sdk: { ok: true, sdkRoot: '/opt/sdk' },
  server: { url: 'http://127.0.0.1:9321/mcp', port: 9321, token: 'token-value' },
  avds: [{ name: 'Pixel_7_API_34', running: true, serial: 'emulator-5554' }],
  devices: ['emulator-5554'],
  activeSerial: 'emulator-5554',
  toolCalls: []
}

beforeEach(() => {
  mockApi(ready)
})

describe('App', () => {
  it('shows a loading state before the snapshot arrives', () => {
    render(<App />)

    expect(screen.getByText(/불러오는 중/)).toBeDefined()
  })

  it('renders the device panel, screen area, work area and endpoint card once ready', async () => {
    render(<App />)

    await waitFor(() => expect(screen.getByRole('region', { name: '기기' })).toBeDefined())
    expect(screen.getByRole('region', { name: '기기 화면' })).toBeDefined()
    expect(screen.getByRole('region', { name: '작업 영역' })).toBeDefined()
    expect(screen.getByText('http://127.0.0.1:9321/mcp')).toBeDefined()
  })

  it('replaces the whole screen with the SDK guidance when no SDK was found', async () => {
    mockApi({ ...ready, sdk: { ok: false, searched: ['/opt/a/adb'] }, server: null, avds: [] })

    render(<App />)

    await waitFor(() => expect(screen.getByText(/Android Studio/)).toBeDefined())
    expect(screen.queryByRole('region', { name: '작업 영역' })).toBeNull()
  })
})
```

- [ ] **Step 2: 테스트가 실패하는지 확인한다**

Run: `npx vitest run src/renderer/src`
Expected: FAIL — `EndpointCard`, `SdkMissing` import 실패

- [ ] **Step 3: EndpointCard를 구현한다**

`src/renderer/src/components/EndpointCard.tsx`:

```tsx
import { useState } from 'react'
import type { ServerStatus } from '../../../shared/types/ipc'

export interface EndpointCardProps {
  server: ServerStatus | null
}

function configSnippet(server: ServerStatus): string {
  return JSON.stringify(
    {
      mcpServers: {
        'virtual-device-helper': {
          type: 'http',
          url: server.url,
          headers: { Authorization: `Bearer ${server.token}` }
        }
      }
    },
    null,
    2
  )
}

export function EndpointCard({ server }: EndpointCardProps): JSX.Element {
  const [revealed, setRevealed] = useState(false)

  if (!server) {
    return (
      <section aria-label="MCP 엔드포인트">
        <h2>MCP 엔드포인트</h2>
        <p>서버가 떠 있지 않다. Android SDK를 찾지 못하면 서버를 열지 않는다.</p>
      </section>
    )
  }

  return (
    <section aria-label="MCP 엔드포인트">
      <h2>MCP 엔드포인트</h2>
      <p>{server.url}</p>

      {/* 토큰은 기본으로 가린다. 화면 공유나 스크린샷에 그대로 찍히면 안 된다. */}
      {revealed ? <p>{server.token}</p> : null}

      <button type="button" onClick={() => setRevealed((current) => !current)}>
        {revealed ? '토큰 숨기기' : '토큰 보기'}
      </button>
      <button type="button" onClick={() => void navigator.clipboard.writeText(server.token)}>
        토큰 복사
      </button>
      <button type="button" onClick={() => void navigator.clipboard.writeText(configSnippet(server))}>
        설정 JSON 복사
      </button>
    </section>
  )
}
```

- [ ] **Step 4: SdkMissing을 구현한다**

`src/renderer/src/components/SdkMissing.tsx`:

```tsx
export interface SdkMissingProps {
  searched: string[]
}

export function SdkMissing({ searched }: SdkMissingProps): JSX.Element {
  return (
    <main aria-label="Android SDK를 찾지 못했다">
      <h1>Android SDK를 찾지 못했다</h1>

      <p>
        이 앱은 Android SDK를 번들하지 않는다. 호스트에 설치된 SDK를 쓴다. Android Studio를 설치하고
        Device Manager에서 AVD를 하나 만든 뒤 앱을 다시 켜라.
      </p>

      <p>
        이미 설치돼 있다면 <code>ANDROID_HOME</code> 또는 <code>ANDROID_SDK_ROOT</code>를 SDK 경로로
        지정하고 앱을 다시 켜라.
      </p>

      <h2>찾아본 경로</h2>
      <ul>
        {searched.map((path) => (
          <li key={path}>{path}</li>
        ))}
      </ul>
    </main>
  )
}
```

- [ ] **Step 5: App을 조립한다**

`src/renderer/src/App.tsx`:

```tsx
import { DevicePanel } from './components/DevicePanel'
import { DeviceScreen } from './components/DeviceScreen'
import { EndpointCard } from './components/EndpointCard'
import { SdkMissing } from './components/SdkMissing'
import { WorkArea } from './components/WorkArea'
import { useAppState } from './state/useAppState'

export function App(): JSX.Element {
  const { snapshot, loading } = useAppState()

  if (loading || !snapshot) {
    return <main>불러오는 중…</main>
  }

  if (!snapshot.sdk.ok) {
    return <SdkMissing searched={snapshot.sdk.searched} />
  }

  return (
    <main>
      <aside>
        <DevicePanel snapshot={snapshot} />
        <DeviceScreen serial={snapshot.activeSerial} />
        <EndpointCard server={snapshot.server} />
      </aside>

      <WorkArea snapshot={snapshot} />
    </main>
  )
}
```

- [ ] **Step 6: 테스트와 타입체크를 돌린다**

Run: `npm test && npm run typecheck && npm run build`
Expected: 전부 PASS

- [ ] **Step 7: 앱을 눈으로 확인한다**

Run: `npm run dev`
Expected: SDK가 있으면 기기 패널·화면 영역·활동 탭·엔드포인트 카드가 보인다.
SDK가 없으면 안내 화면만 보인다. 엔드포인트 카드의 "설정 JSON 복사"를 눌러 클립보드 내용을
확인한다.

- [ ] **Step 8: 커밋**

```bash
git add src/renderer
git commit -m "$(cat <<'EOF'
feat(renderer): 엔드포인트 카드와 SDK 안내 화면, 레이아웃 조립

엔드포인트 카드는 토큰을 기본으로 가린다. 화면 공유나 스크린샷에 그대로
찍히면 그 포트에 붙을 수 있는 모든 권한이 새어 나간다.

설정 JSON을 통째로 복사하는 버튼을 둔다. 없으면 사람이 매번 손으로
조립하고 그 과정에서 토큰을 틀린다.

SDK를 찾지 못하면 화면 전체를 안내로 바꾼다. 조작할 수 없는 UI를 보여
주면서 왜 안 되는지 따로 설명하는 것보다 낫다. 찾아본 경로를 모두 나열해
사용자가 원인을 직접 볼 수 있게 한다.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## 이 계획이 끝났을 때

- Electron 앱이 뜨고, SDK를 찾으면 MCP 서버가 열리고, 못 찾으면 안내 화면이 뜬다.
- renderer가 기기를 고르고 부팅·종료하고 스크린샷을 갱신한다.
- 툴 호출이 활동 탭에 실시간으로 쌓인다.
- 엔드포인트 카드에서 설정 JSON을 통째로 복사할 수 있다.
- preload가 노출하는 API가 여섯 개뿐이고 테스트로 고정돼 있다.

다음은 [M1-5 — 통합과 완료 검증](2026-09-22-m1-5-integration-verification.md)이다.
