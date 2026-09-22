---
id: m1-1-foundation-and-adb
title: M1-1 — 프로젝트 기반과 adb 경계
status: draft
type: work-order
created: 2026-09-22
updated: 2026-09-22
owner: virtual-device-helper 팀
scope: [build, main, shared, android]
hosts: [macos]
archived_reason:
related_adr: [ADR-0002, ADR-0003, ADR-0005, ADR-0006]
related_spec: m1-device-core-mcp-server
related_architecture:
related_plan: [m1-2-android-device, m1-3-mcp-server, m1-4-electron-shell-ui, m1-5-integration-verification]
related_code:
tags: [plan, m1, build, adb]
---

# M1-1 — 프로젝트 기반과 adb 경계 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: `superpowers:subagent-driven-development`(권장) 또는
> `superpowers:executing-plans`로 task 단위 구현. 각 단계는 체크박스(`- [ ]`)로 추적한다.

**Goal:** Electron + TypeScript 프로젝트를 세우고, Android SDK를 찾아 `adb`를 실행하는 최하위 층
(`locateSdk`, `adbClient`)을 완성한다. 마지막에 M2의 기술 위험을 스파이크로 확인한다.

**Architecture:** main 프로세스는 여섯 층으로 쌓는다 — `adbClient` → `AndroidDevice` →
`DeviceRegistry` → `mcpTools` → `mcpHttpServer` → `ipcBridge`. 이 계획은 맨 아래 두 조각과 그 위에
얹을 공유 타입을 만든다. `adbClient`는 adb 문법을 아는 유일한 층이고, 프로세스 실행을 주입받아
실기기 없이 테스트된다.

**Tech Stack:** TypeScript, electron-vite, Electron, electron-builder, React, Vitest

**Spec:** [`../specs/2026-09-22-m1-device-core-mcp-server.md`](../specs/2026-09-22-m1-device-core-mcp-server.md)

**계획 순서:** M1-1(이 문서) → [M1-2](2026-09-22-m1-2-android-device.md) →
[M1-3](2026-09-22-m1-3-mcp-server.md) → [M1-4](2026-09-22-m1-4-electron-shell-ui.md) →
[M1-5](2026-09-22-m1-5-integration-verification.md)

## Global Constraints

이 프로젝트의 규약이다. 루트 `CLAUDE.md`는 서브에이전트에게 자동 전달되지 않으므로 여기 싣는다.
아래는 **모든 task의 요구사항에 암묵적으로 포함된다.**

- **답변 언어는 한국어.** 기술 용어·API 이름·명령어·에러 문자열은 원문 그대로 둔다.
- **코드·주석·커밋 메시지는 일반 산문으로 쓴다.** 축약하거나 caveman 문체로 쓰지 않는다.
- **커밋 메시지는 Conventional Commits.** 본문 마지막 줄에 다음을 붙인다:
  `Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>`
- **TDD.** 실패하는 테스트를 먼저 쓰고, 실패를 확인하고, 최소 구현으로 통과시킨다.
- **축이 셋이고 섞지 않는다:** 호스트 OS(windows/macos) · 타깃 디바이스(android/ios) ·
  Electron 프로세스(main/renderer/preload).
- **층 방향 규칙:** 위층은 바로 아래층만 부른다. 상위 층이 `adbClient`를 직접 부르면 안 된다
  ([ADR-0005](../../adr/0005-device-interface-abstraction.md)).
- **Android SDK를 번들하지 않는다.** 호스트 설치분을 찾아 쓴다
  ([ADR-0003](../../adr/0003-no-bundled-android-sdk.md)).
- **M1의 호스트는 macOS, 타깃은 Android 하나다.** iOS·Windows 코드를 미리 쓰지 않는다.
- 의존성 버전은 설치 시점의 최신 안정판을 쓰고 `package-lock.json`으로 고정한다. 임의의 버전
  번호를 지어내지 않는다.
- 문서를 고쳤으면 `python3 docs/script/docs.py lint`와 `links`를 돌린다.
- 문서에 라인번호·파일 개수·진행률을 적지 않는다. 파일명과 심볼명으로 가리킨다.

## 파일 구성

| 파일 | 책임 |
|---|---|
| `package.json`, `electron.vite.config.ts`, `tsconfig.json` | 빌드·테스트 툴체인 |
| `src/shared/types/device.ts` | `Device` 인터페이스와 도메인 타입 |
| `src/shared/types/errors.ts` | `ToolErrorKind`, `ToolError`, `DeviceError` |
| `src/main/sdk/locateSdk.ts` | Android SDK 탐색 |
| `src/main/adb/adbClient.ts` | adb 프로세스 실행 (`exec`, `stream`) |
| `src/main/index.ts` | Electron main 진입점 |
| `src/preload/index.ts` | preload 진입점 (M1-4에서 채운다) |
| `src/renderer/` | renderer 진입점 (M1-4에서 채운다) |
| `spike/` | 버리는 스파이크 코드. 본 코드가 참조하지 않는다 |

---

### Task 1: 프로젝트 스캐폴딩

**Files:**
- Create: `package.json`
- Create: `electron.vite.config.ts`
- Create: `tsconfig.json`
- Create: `tsconfig.node.json`
- Create: `tsconfig.web.json`
- Create: `src/main/index.ts`
- Create: `src/preload/index.ts`
- Create: `src/renderer/index.html`
- Create: `src/renderer/src/main.tsx`
- Create: `src/renderer/src/App.tsx`
- Create: `.gitignore`
- Test: `src/shared/smoke.test.ts`

**Interfaces:**
- Consumes: 없음 (첫 task)
- Produces: `npm run dev`(개발 실행), `npm run build`(세 타깃 빌드), `npm test`(`vitest run`),
  `npm run typecheck`(`tsc --noEmit`). 이후 모든 task가 이 스크립트를 쓴다.

- [ ] **Step 1: 의존성 설치와 프로젝트 초기화**

```bash
npm init -y
npm install --save-dev electron electron-vite electron-builder vite typescript vitest \
  @types/node @vitejs/plugin-react @types/react @types/react-dom
npm install react react-dom
```

`package.json`의 `scripts`와 `main`을 아래로 교체한다.

```json
{
  "name": "virtual-device-helper",
  "version": "0.0.0",
  "main": "./out/main/index.js",
  "scripts": {
    "dev": "electron-vite dev",
    "build": "electron-vite build",
    "typecheck": "tsc --noEmit -p tsconfig.node.json && tsc --noEmit -p tsconfig.web.json",
    "test": "vitest run",
    "test:watch": "vitest"
  }
}
```

- [ ] **Step 2: 빌드 설정을 쓴다**

`electron.vite.config.ts`:

```ts
import { resolve } from 'node:path'
import { defineConfig } from 'electron-vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  main: {
    build: {
      rollupOptions: { input: { index: resolve(__dirname, 'src/main/index.ts') } }
    }
  },
  preload: {
    build: {
      rollupOptions: { input: { index: resolve(__dirname, 'src/preload/index.ts') } }
    }
  },
  renderer: {
    root: resolve(__dirname, 'src/renderer'),
    build: {
      rollupOptions: { input: { index: resolve(__dirname, 'src/renderer/index.html') } }
    },
    plugins: [react()],
    test: { environment: 'node' }
  }
})
```

`tsconfig.json`:

```json
{
  "files": [],
  "references": [
    { "path": "./tsconfig.node.json" },
    { "path": "./tsconfig.web.json" }
  ]
}
```

`tsconfig.node.json` (main·preload·shared):

```json
{
  "compilerOptions": {
    "composite": true,
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "bundler",
    "strict": true,
    "noUncheckedIndexedAccess": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "types": ["node"],
    "outDir": "./out-tsc/node"
  },
  "include": ["src/main/**/*", "src/preload/**/*", "src/shared/**/*"]
}
```

`tsconfig.web.json` (renderer·shared):

```json
{
  "compilerOptions": {
    "composite": true,
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "bundler",
    "strict": true,
    "noUncheckedIndexedAccess": true,
    "jsx": "react-jsx",
    "lib": ["ES2022", "DOM", "DOM.Iterable"],
    "skipLibCheck": true,
    "outDir": "./out-tsc/web"
  },
  "include": ["src/renderer/**/*", "src/shared/**/*"]
}
```

`.gitignore`:

```
node_modules/
out/
out-tsc/
dist/
.vite/
```

- [ ] **Step 3: 최소 진입점 세 개를 쓴다**

`src/main/index.ts`:

```ts
import { app, BrowserWindow } from 'electron'
import { join } from 'node:path'

function createWindow(): void {
  const window = new BrowserWindow({
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

app.whenReady().then(() => {
  createWindow()
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})
```

`src/preload/index.ts`:

```ts
// M1-4에서 contextBridge API를 채운다. 지금은 빈 진입점이다.
export {}
```

`src/renderer/index.html`:

```html
<!doctype html>
<html lang="ko">
  <head>
    <meta charset="UTF-8" />
    <title>virtual-device-helper</title>
  </head>
  <body>
    <div id="root"></div>
    <script type="module" src="/src/main.tsx"></script>
  </body>
</html>
```

`src/renderer/src/main.tsx`:

```tsx
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { App } from './App'

const container = document.getElementById('root')
if (!container) throw new Error('#root element not found')

createRoot(container).render(
  <StrictMode>
    <App />
  </StrictMode>
)
```

`src/renderer/src/App.tsx`:

```tsx
export function App(): JSX.Element {
  return <main>virtual-device-helper</main>
}
```

- [ ] **Step 4: 툴체인이 실제로 도는지 확인하는 테스트를 쓴다**

`src/shared/smoke.test.ts`:

```ts
import { describe, expect, it } from 'vitest'

describe('toolchain', () => {
  it('runs TypeScript test files', () => {
    const value: string = 'ok'
    expect(value).toBe('ok')
  })
})
```

- [ ] **Step 5: 테스트가 실패하는지 확인한다**

Run: `npm test`
Expected: FAIL — vitest 설정이 없어 `src/shared/smoke.test.ts`를 찾지 못하거나 실행하지 못한다.

- [ ] **Step 6: vitest 설정을 추가해 통과시킨다**

`vitest.config.ts`:

```ts
import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts', 'src/**/*.test.tsx']
  }
})
```

- [ ] **Step 7: 테스트·타입체크·빌드가 모두 통과하는지 확인한다**

Run: `npm test && npm run typecheck && npm run build`
Expected: 셋 다 PASS. `out/main/index.js`, `out/preload/index.js`, `out/renderer/index.html`이 생긴다.

- [ ] **Step 8: 앱이 실제로 뜨는지 눈으로 확인한다**

Run: `npm run dev`
Expected: Electron 창이 뜨고 "virtual-device-helper" 글자가 보인다. 확인 후 창을 닫는다.

- [ ] **Step 9: 커밋**

```bash
git add -A
git commit -m "$(cat <<'EOF'
build: Electron + TypeScript 프로젝트 스캐폴딩

electron-vite로 main·preload·renderer 세 타깃을 한 설정으로 묶는다.
tsconfig를 node(main·preload·shared)와 web(renderer·shared)으로 나눠
프로세스별 lib과 jsx 설정이 섞이지 않게 한다.

Electron 보안 기본값(contextIsolation, sandbox)을 처음부터 켠다.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 2: 공유 타입과 에러

**Files:**
- Create: `src/shared/types/device.ts`
- Create: `src/shared/types/errors.ts`
- Test: `src/shared/types/errors.test.ts`

**Interfaces:**
- Consumes: Task 1의 `npm test`, `npm run typecheck`
- Produces: `Device`, `DeviceInfo`, `UiNode`, `LogLine`, `LogReadResult`, `ScreenshotResult`,
  `KeyName`, `InstallOpts`, `ScreenshotOpts`, `LogOpts`, `AvdEntry`, `ToolErrorKind`, `ToolError`,
  `DeviceError`, `deviceError()`. **M1-2 이후의 모든 계획이 이 이름들을 그대로 쓴다.**

- [ ] **Step 1: 에러 동작을 규정하는 실패 테스트를 쓴다**

`src/shared/types/errors.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import { DeviceError, deviceError } from './errors'

describe('deviceError', () => {
  it('builds a DeviceError carrying kind, message and hint', () => {
    const error = deviceError('no_device', '연결된 기기가 없다', 'device_list로 확인한 뒤 device_boot로 부팅해라')

    expect(error).toBeInstanceOf(DeviceError)
    expect(error).toBeInstanceOf(Error)
    expect(error.toolError.kind).toBe('no_device')
    expect(error.toolError.message).toBe('연결된 기기가 없다')
    expect(error.toolError.hint).toBe('device_list로 확인한 뒤 device_boot로 부팅해라')
  })

  it('carries optional details for the agent to act on', () => {
    const error = deviceError('ambiguous_device', '기기가 여럿이다', 'serial을 지정해라', {
      candidates: ['emulator-5554', 'emulator-5556']
    })

    expect(error.toolError.details).toEqual({ candidates: ['emulator-5554', 'emulator-5556'] })
  })

  it('uses the message as the Error message so stack traces stay readable', () => {
    const error = deviceError('adb_not_found', 'adb를 찾지 못했다', 'Android SDK를 설치해라')

    expect(error.message).toBe('adb를 찾지 못했다')
  })
})
```

- [ ] **Step 2: 테스트가 실패하는지 확인한다**

Run: `npx vitest run src/shared/types/errors.test.ts`
Expected: FAIL — `Failed to resolve import "./errors"`

- [ ] **Step 3: 에러 타입을 구현한다**

`src/shared/types/errors.ts`:

```ts
/**
 * 툴 실패의 종류. 에이전트가 이 값을 보고 복구 경로를 고른다.
 * 응답 잘림은 여기 들어가지 않는다 — 에러가 아니라 성공 응답의 필드다.
 */
export type ToolErrorKind =
  | 'sdk_not_found'
  | 'adb_not_found'
  | 'no_device'
  | 'ambiguous_device'
  | 'package_not_found'
  | 'apk_path_invalid'
  | 'device_unresponsive'
  | 'command_failed'

export interface ToolError {
  kind: ToolErrorKind
  /** 무엇이 잘못됐는지. 사람이 읽는 한 문장. */
  message: string
  /** 다음에 무엇을 하면 되는지. 한 줄. */
  hint: string
  /** 후보 serial 목록, 원문 stderr 등 에이전트가 쓸 수 있는 부가 정보. */
  details?: Record<string, unknown>
}

export class DeviceError extends Error {
  constructor(readonly toolError: ToolError) {
    super(toolError.message)
    this.name = 'DeviceError'
  }
}

export function deviceError(
  kind: ToolErrorKind,
  message: string,
  hint: string,
  details?: Record<string, unknown>
): DeviceError {
  return new DeviceError({ kind, message, hint, details })
}

export function isDeviceError(value: unknown): value is DeviceError {
  return value instanceof DeviceError
}
```

- [ ] **Step 4: 테스트가 통과하는지 확인한다**

Run: `npx vitest run src/shared/types/errors.test.ts`
Expected: PASS (3 tests)

- [ ] **Step 5: 도메인 타입과 `Device` 인터페이스를 쓴다**

`src/shared/types/device.ts`:

```ts
export type KeyName = 'back' | 'home' | 'enter' | 'tab'

export interface DeviceInfo {
  serial: string
  model: string
  apiLevel: number
  width: number
  height: number
}

/** AVD 하나. 실행 중이면 serial이 붙는다. */
export interface AvdEntry {
  name: string
  running: boolean
  serial: string | null
}

/**
 * uiautomator 덤프에서 요약한 요소 하나.
 * 원본 XML은 이 타입으로 바뀐 뒤 버려진다.
 */
export interface UiNode {
  index: number
  text: string | null
  contentDesc: string | null
  /** resource-id의 꼬리. "com.example:id/login" 이면 "login". */
  resourceId: string | null
  /** 클래스의 짧은 이름. "android.widget.Button" 이면 "Button". */
  className: string
  /** 요소 중심 좌표. ui_tap에 그대로 넣을 수 있다. */
  x: number
  y: number
  clickable: boolean
}

export type LogLevel = 'V' | 'D' | 'I' | 'W' | 'E' | 'F'

export interface LogLine {
  timestamp: string
  level: LogLevel
  tag: string
  pid: number
  message: string
}

export interface LogReadResult {
  lines: LogLine[]
  /** 상한에 걸려 잘렸는가. 에러가 아니라 정상 응답의 필드다. */
  truncated: boolean
  /** 잘려서 버린 줄 수. truncated가 false면 0. */
  droppedCount: number
}

export interface ScreenshotResult {
  /** PNG 바이트의 base64. */
  base64: string
  width: number
  height: number
}

export interface InstallOpts {
  reinstall?: boolean
}

export interface ScreenshotOpts {
  /** 0보다 크고 1 이하. 생략하면 기본 축소 비율을 쓴다. */
  scale?: number
}

export interface LogOpts {
  /** 태그 또는 메시지 부분일치. */
  filter?: string
  /** "MM-DD HH:mm:ss.SSS" 형식. 이 시각 이후만 읽는다. */
  since?: string
  limit?: number
}

/**
 * 타깃 디바이스 하나. M1의 구현체는 AndroidDevice 하나뿐이다.
 * AVD 부팅·종료는 기기가 없는 상태에서 하는 일이라 여기 들어가지 않는다.
 */
export interface Device {
  readonly serial: string
  info(): Promise<DeviceInfo>
  install(apkPath: string, opts?: InstallOpts): Promise<string>
  uninstall(pkg: string): Promise<void>
  launch(pkg: string, activity?: string): Promise<void>
  stop(pkg: string): Promise<void>
  clearData(pkg: string): Promise<void>
  grantPermission(pkg: string, permission: string): Promise<void>
  tap(x: number, y: number): Promise<void>
  swipe(x1: number, y1: number, x2: number, y2: number, durationMs: number): Promise<void>
  inputText(text: string): Promise<void>
  pressKey(key: KeyName): Promise<void>
  dumpUi(): Promise<UiNode[]>
  screenshot(opts?: ScreenshotOpts): Promise<ScreenshotResult>
  readLogs(opts?: LogOpts): Promise<LogReadResult>
  clearLogs(): Promise<void>
}
```

- [ ] **Step 6: 타입체크와 테스트를 돌린다**

Run: `npm run typecheck && npm test`
Expected: 둘 다 PASS

- [ ] **Step 7: 커밋**

```bash
git add src/shared/types
git commit -m "$(cat <<'EOF'
feat(shared): Device 인터페이스와 툴 에러 타입 정의

main·preload·renderer가 공유하는 도메인 타입을 한곳에 둔다.
IPC 채널과 MCP 스키마가 세 프로세스에 걸쳐 있어 타입이 갈리면
런타임에서만 드러난다.

Device 인터페이스는 Android 구현이 실제로 필요로 하는 만큼만 넓힌다.
AVD 부팅·종료는 기기가 없는 상태의 작업이라 포함하지 않는다.
응답 잘림은 ToolErrorKind가 아니라 LogReadResult의 필드로 둔다.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 3: Android SDK 탐색

**Files:**
- Create: `src/main/sdk/locateSdk.ts`
- Test: `src/main/sdk/locateSdk.test.ts`

**Interfaces:**
- Consumes: `deviceError` (Task 2)
- Produces: `locateSdk(deps: LocateSdkDeps): LocateSdkResult`, `SdkPaths`, `LocateSdkDeps`,
  `LocateSdkResult`, `defaultLocateSdkDeps()`. M1-4의 SDK 안내 화면이 `LocateSdkResult`를 그대로 쓴다.

- [ ] **Step 1: 실패 테스트를 쓴다**

`src/main/sdk/locateSdk.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import { locateSdk } from './locateSdk'

function deps(env: Record<string, string>, existing: string[]) {
  return {
    env,
    exists: (p: string) => existing.includes(p),
    homedir: () => '/Users/tester'
  }
}

describe('locateSdk', () => {
  it('prefers ANDROID_HOME when its adb exists', () => {
    const result = locateSdk(
      deps({ ANDROID_HOME: '/opt/sdk' }, ['/opt/sdk/platform-tools/adb', '/opt/sdk/emulator/emulator'])
    )

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.paths.sdkRoot).toBe('/opt/sdk')
    expect(result.paths.adb).toBe('/opt/sdk/platform-tools/adb')
    expect(result.paths.emulator).toBe('/opt/sdk/emulator/emulator')
    expect(result.paths.source).toBe('ANDROID_HOME')
  })

  it('falls through to ANDROID_SDK_ROOT when ANDROID_HOME has no adb', () => {
    const result = locateSdk(
      deps({ ANDROID_HOME: '/opt/empty', ANDROID_SDK_ROOT: '/opt/sdk' }, [
        '/opt/sdk/platform-tools/adb',
        '/opt/sdk/emulator/emulator'
      ])
    )

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.paths.source).toBe('ANDROID_SDK_ROOT')
  })

  it('falls through to the macOS default location', () => {
    const result = locateSdk(
      deps({}, [
        '/Users/tester/Library/Android/sdk/platform-tools/adb',
        '/Users/tester/Library/Android/sdk/emulator/emulator'
      ])
    )

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.paths.sdkRoot).toBe('/Users/tester/Library/Android/sdk')
    expect(result.paths.source).toBe('default')
  })

  it('falls through to PATH as the last resort', () => {
    const result = locateSdk(
      deps({ PATH: '/usr/local/bin:/opt/sdk/platform-tools' }, [
        '/opt/sdk/platform-tools/adb',
        '/opt/sdk/emulator/emulator'
      ])
    )

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.paths.adb).toBe('/opt/sdk/platform-tools/adb')
    expect(result.paths.source).toBe('PATH')
  })

  it('reports every path it searched when nothing is found', () => {
    const result = locateSdk(deps({ ANDROID_HOME: '/opt/empty' }, []))

    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.searched).toContain('/opt/empty/platform-tools/adb')
    expect(result.searched).toContain('/Users/tester/Library/Android/sdk/platform-tools/adb')
    expect(result.searched.length).toBeGreaterThan(1)
  })

  it('requires the emulator binary too, not just adb', () => {
    const result = locateSdk(deps({ ANDROID_HOME: '/opt/sdk' }, ['/opt/sdk/platform-tools/adb']))

    expect(result.ok).toBe(false)
  })
})
```

- [ ] **Step 2: 테스트가 실패하는지 확인한다**

Run: `npx vitest run src/main/sdk/locateSdk.test.ts`
Expected: FAIL — `Failed to resolve import "./locateSdk"`

- [ ] **Step 3: 구현한다**

`src/main/sdk/locateSdk.ts`:

```ts
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

export type SdkSource = 'ANDROID_HOME' | 'ANDROID_SDK_ROOT' | 'default' | 'PATH'

export interface SdkPaths {
  sdkRoot: string
  adb: string
  emulator: string
  source: SdkSource
}

export interface LocateSdkDeps {
  env: Record<string, string | undefined>
  exists: (path: string) => boolean
  homedir: () => string
}

export type LocateSdkResult =
  | { ok: true; paths: SdkPaths }
  | { ok: false; searched: string[] }

export function defaultLocateSdkDeps(): LocateSdkDeps {
  return { env: process.env, exists: existsSync, homedir }
}

function pathsFor(sdkRoot: string, source: SdkSource): SdkPaths {
  return {
    sdkRoot,
    adb: join(sdkRoot, 'platform-tools', 'adb'),
    emulator: join(sdkRoot, 'emulator', 'emulator'),
    source
  }
}

/**
 * Android SDK를 찾는다. 번들하지 않고 호스트 설치분을 쓴다 (ADR-0003).
 * adb와 emulator 둘 다 있어야 유효한 SDK로 본다 — adb만 있으면 켤 기기가 없다.
 */
export function locateSdk(deps: LocateSdkDeps): LocateSdkResult {
  const searched: string[] = []

  const candidates: SdkPaths[] = []

  const androidHome = deps.env.ANDROID_HOME
  if (androidHome) candidates.push(pathsFor(androidHome, 'ANDROID_HOME'))

  const sdkRoot = deps.env.ANDROID_SDK_ROOT
  if (sdkRoot) candidates.push(pathsFor(sdkRoot, 'ANDROID_SDK_ROOT'))

  candidates.push(pathsFor(join(deps.homedir(), 'Library', 'Android', 'sdk'), 'default'))

  for (const entry of (deps.env.PATH ?? '').split(':')) {
    if (!entry) continue
    const adb = join(entry, 'adb')
    if (!deps.exists(adb)) {
      searched.push(adb)
      continue
    }
    // platform-tools/adb 형태를 가정하고 두 단계 위를 SDK 루트로 본다.
    candidates.push(pathsFor(dirname(dirname(adb)), 'PATH'))
  }

  for (const candidate of candidates) {
    const adbOk = deps.exists(candidate.adb)
    const emulatorOk = deps.exists(candidate.emulator)
    if (!adbOk) searched.push(candidate.adb)
    if (adbOk && !emulatorOk) searched.push(candidate.emulator)
    if (adbOk && emulatorOk) return { ok: true, paths: candidate }
  }

  return { ok: false, searched }
}
```

- [ ] **Step 4: 테스트가 통과하는지 확인한다**

Run: `npx vitest run src/main/sdk/locateSdk.test.ts`
Expected: PASS (6 tests)

- [ ] **Step 5: 실제 머신에서 한 번 돌려 본다**

Run: `npx tsx -e "import('./src/main/sdk/locateSdk.ts').then(m => console.log(m.locateSdk(m.defaultLocateSdkDeps())))"`

`tsx`가 없으면 `npx --yes tsx ...`로 받는다.
Expected: 이 머신에 Android SDK가 있으면 `ok: true`와 실제 경로. 없으면 `ok: false`와 탐색 경로 목록.
둘 중 무엇이 나왔는지 기록해 둔다 — M1-5의 완료 검증에서 다시 쓴다.

- [ ] **Step 6: 커밋**

```bash
git add src/main/sdk
git commit -m "$(cat <<'EOF'
feat(main): Android SDK 탐색 추가

ANDROID_HOME, ANDROID_SDK_ROOT, macOS 기본 위치, PATH 순으로 찾는다.
adb와 emulator가 둘 다 있어야 유효한 SDK로 본다. adb만 있으면 켤 기기가 없다.

찾지 못하면 탐색한 경로를 모두 돌려준다. 조용히 실패하면 사용자가
무엇을 설치해야 하는지 알 수 없다.

환경변수와 파일시스템을 주입받아 실제 설치 없이 테스트한다.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 4: adbClient.exec

**Files:**
- Create: `src/main/adb/adbClient.ts`
- Test: `src/main/adb/adbClient.test.ts`

**Interfaces:**
- Consumes: `deviceError`, `DeviceError` (Task 2)
- Produces: `createAdbClient(adbPath, spawnFn?)`, `AdbClient`, `ExecOpts`, `ExecResult`, `SpawnFn`.
  M1-2의 `AndroidDevice`와 `AvdController`가 `AdbClient`만 본다.

- [ ] **Step 1: 실패 테스트를 쓴다**

`src/main/adb/adbClient.test.ts`:

```ts
import { EventEmitter } from 'node:events'
import { Readable } from 'node:stream'
import { describe, expect, it, vi } from 'vitest'
import { DeviceError } from '../../shared/types/errors'
import { createAdbClient, type SpawnFn } from './adbClient'

interface FakeRun {
  stdout?: string | Buffer
  stderr?: string
  exitCode?: number
  spawnError?: NodeJS.ErrnoException
}

/** spawn 한 번을 흉내 낸다. 인자를 기록해 검증에 쓴다. */
function fakeSpawn(run: FakeRun): { spawn: SpawnFn; calls: string[][] } {
  const calls: string[][] = []
  const spawn: SpawnFn = (_command, args) => {
    calls.push(args)
    const child = new EventEmitter() as ReturnType<SpawnFn>
    child.stdout = Readable.from([run.stdout ?? ''])
    child.stderr = Readable.from([run.stderr ?? ''])
    child.kill = vi.fn() as never
    queueMicrotask(() => {
      if (run.spawnError) child.emit('error', run.spawnError)
      else child.emit('close', run.exitCode ?? 0)
    })
    return child
  }
  return { spawn, calls }
}

describe('adbClient.exec', () => {
  it('passes -s <serial> before the command when a serial is given', async () => {
    const { spawn, calls } = fakeSpawn({ stdout: 'ok' })
    const client = createAdbClient('/opt/sdk/platform-tools/adb', spawn)

    await client.exec('emulator-5554', ['shell', 'echo', 'hi'])

    expect(calls[0]).toEqual(['-s', 'emulator-5554', 'shell', 'echo', 'hi'])
  })

  it('omits -s when serial is null', async () => {
    const { spawn, calls } = fakeSpawn({ stdout: 'ok' })
    const client = createAdbClient('/opt/sdk/platform-tools/adb', spawn)

    await client.exec(null, ['devices', '-l'])

    expect(calls[0]).toEqual(['devices', '-l'])
  })

  it('returns stdout as both text and raw bytes', async () => {
    const { spawn } = fakeSpawn({ stdout: Buffer.from([0x89, 0x50, 0x4e, 0x47]) })
    const client = createAdbClient('/opt/sdk/platform-tools/adb', spawn)

    const result = await client.exec(null, ['exec-out', 'screencap', '-p'])

    expect(result.stdoutRaw).toEqual(Buffer.from([0x89, 0x50, 0x4e, 0x47]))
    expect(result.exitCode).toBe(0)
  })

  it('throws adb_not_found when the binary is missing', async () => {
    const enoent: NodeJS.ErrnoException = Object.assign(new Error('spawn ENOENT'), { code: 'ENOENT' })
    const { spawn } = fakeSpawn({ spawnError: enoent })
    const client = createAdbClient('/opt/sdk/platform-tools/adb', spawn)

    await expect(client.exec(null, ['devices'])).rejects.toMatchObject({
      toolError: { kind: 'adb_not_found' }
    })
  })

  it('throws no_device when adb reports no devices', async () => {
    const { spawn } = fakeSpawn({ stderr: 'error: no devices/emulators found', exitCode: 1 })
    const client = createAdbClient('/opt/sdk/platform-tools/adb', spawn)

    await expect(client.exec(null, ['shell', 'ls'])).rejects.toMatchObject({
      toolError: { kind: 'no_device' }
    })
  })

  it('throws ambiguous_device when adb reports more than one device', async () => {
    const { spawn } = fakeSpawn({ stderr: 'adb: error: more than one device/emulator', exitCode: 1 })
    const client = createAdbClient('/opt/sdk/platform-tools/adb', spawn)

    await expect(client.exec(null, ['shell', 'ls'])).rejects.toMatchObject({
      toolError: { kind: 'ambiguous_device' }
    })
  })

  it('throws command_failed with the original stderr attached', async () => {
    const { spawn } = fakeSpawn({ stderr: 'something specific went wrong', exitCode: 1 })
    const client = createAdbClient('/opt/sdk/platform-tools/adb', spawn)

    const error = await client.exec(null, ['shell', 'ls']).catch((e: unknown) => e)

    expect(error).toBeInstanceOf(DeviceError)
    expect((error as DeviceError).toolError.kind).toBe('command_failed')
    expect((error as DeviceError).toolError.details?.stderr).toBe('something specific went wrong')
  })

  it('throws device_unresponsive when the command exceeds its timeout', async () => {
    const spawn: SpawnFn = () => {
      const child = new EventEmitter() as ReturnType<SpawnFn>
      child.stdout = new Readable({ read() {} })
      child.stderr = new Readable({ read() {} })
      child.kill = vi.fn() as never
      return child
    }
    const client = createAdbClient('/opt/sdk/platform-tools/adb', spawn)

    await expect(client.exec(null, ['shell', 'sleep', '99'], { timeoutMs: 10 })).rejects.toMatchObject({
      toolError: { kind: 'device_unresponsive' }
    })
  })
})
```

- [ ] **Step 2: 테스트가 실패하는지 확인한다**

Run: `npx vitest run src/main/adb/adbClient.test.ts`
Expected: FAIL — `Failed to resolve import "./adbClient"`

- [ ] **Step 3: 구현한다**

`src/main/adb/adbClient.ts`:

```ts
import { spawn as nodeSpawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { deviceError } from '../../shared/types/errors'

export type SpawnFn = (command: string, args: string[]) => ChildProcessWithoutNullStreams

export interface ExecOpts {
  /** 기본 30초. 화면 캡처처럼 오래 걸리는 명령은 호출부가 늘린다. */
  timeoutMs?: number
}

export interface ExecResult {
  stdout: string
  stdoutRaw: Buffer
  stderr: string
  exitCode: number
}

export interface AdbStream {
  onLine(callback: (line: string) => void): void
  onClose(callback: (code: number | null) => void): void
  close(): void
}

export interface AdbClient {
  exec(serial: string | null, args: string[], opts?: ExecOpts): Promise<ExecResult>
  stream(serial: string | null, args: string[]): AdbStream
}

const DEFAULT_TIMEOUT_MS = 30_000

function withSerial(serial: string | null, args: string[]): string[] {
  return serial ? ['-s', serial, ...args] : args
}

/**
 * stderr 문자열을 타입 있는 에러로 바꾼다.
 * adb 문법을 아는 유일한 층이므로, 위층은 raw stderr를 해석하지 않는다.
 */
function classify(stderr: string, args: string[]): never {
  const text = stderr.trim()

  if (/no devices\/emulators found/i.test(text)) {
    throw deviceError('no_device', '연결된 기기가 없다', 'device_list로 확인한 뒤 device_boot로 부팅해라', {
      stderr: text
    })
  }
  if (/more than one device/i.test(text)) {
    throw deviceError('ambiguous_device', '기기가 여럿이라 대상을 정할 수 없다', 'serial을 지정하거나 device_select로 활성 기기를 정해라', {
      stderr: text
    })
  }
  if (/device .*not found|device offline/i.test(text)) {
    throw deviceError('no_device', '지정한 기기를 찾을 수 없다', 'device_list로 현재 연결된 기기를 확인해라', {
      stderr: text
    })
  }

  throw deviceError('command_failed', `adb 명령이 실패했다: ${args.join(' ')}`, '첨부된 stderr를 확인해라', {
    stderr: text,
    args
  })
}

export function createAdbClient(adbPath: string, spawnFn: SpawnFn = nodeSpawn as SpawnFn): AdbClient {
  function exec(serial: string | null, args: string[], opts: ExecOpts = {}): Promise<ExecResult> {
    const fullArgs = withSerial(serial, args)
    const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS

    return new Promise<ExecResult>((resolve, reject) => {
      let child: ChildProcessWithoutNullStreams
      try {
        child = spawnFn(adbPath, fullArgs)
      } catch {
        reject(deviceError('adb_not_found', `adb를 실행할 수 없다: ${adbPath}`, 'Android SDK 설치와 platform-tools를 확인해라'))
        return
      }

      const stdoutChunks: Buffer[] = []
      const stderrChunks: Buffer[] = []
      let settled = false

      const timer = setTimeout(() => {
        if (settled) return
        settled = true
        child.kill('SIGKILL')
        reject(
          deviceError('device_unresponsive', `adb 명령이 ${timeoutMs}ms 안에 끝나지 않았다: ${fullArgs.join(' ')}`, '기기 상태를 확인하고 필요하면 device_shutdown 후 다시 부팅해라', {
            args: fullArgs,
            timeoutMs
          })
        )
      }, timeoutMs)

      child.stdout.on('data', (chunk: Buffer) => stdoutChunks.push(Buffer.from(chunk)))
      child.stderr.on('data', (chunk: Buffer) => stderrChunks.push(Buffer.from(chunk)))

      child.on('error', (error: NodeJS.ErrnoException) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        if (error.code === 'ENOENT') {
          reject(deviceError('adb_not_found', `adb를 찾을 수 없다: ${adbPath}`, 'Android SDK 설치와 platform-tools를 확인해라'))
          return
        }
        reject(deviceError('command_failed', `adb 실행에 실패했다: ${error.message}`, '첨부된 정보를 확인해라', { args: fullArgs }))
      })

      child.on('close', (code) => {
        if (settled) return
        settled = true
        clearTimeout(timer)

        const stdoutRaw = Buffer.concat(stdoutChunks)
        const stderr = Buffer.concat(stderrChunks).toString('utf8')

        if (code !== 0) {
          try {
            classify(stderr, fullArgs)
          } catch (error) {
            reject(error)
            return
          }
        }

        resolve({ stdout: stdoutRaw.toString('utf8'), stdoutRaw, stderr, exitCode: code ?? 0 })
      })
    })
  }

  function stream(): AdbStream {
    throw new Error('stream is implemented in the next task')
  }

  return { exec, stream }
}
```

- [ ] **Step 4: 테스트가 통과하는지 확인한다**

Run: `npx vitest run src/main/adb/adbClient.test.ts`
Expected: PASS (8 tests)

- [ ] **Step 5: 커밋**

```bash
git add src/main/adb
git commit -m "$(cat <<'EOF'
feat(main): adbClient.exec 추가

adb 바이너리를 한 번 실행하고 결과를 돌려준다. stderr 문자열을
타입 있는 에러로 바꾸는 것이 이 층의 핵심 책임이다. adb 문법을 아는
유일한 층이므로 위층은 raw stderr를 해석하지 않는다.

stdout을 문자열과 Buffer 양쪽으로 돌려준다. screencap 출력은 PNG
바이트라 문자열로 받으면 깨진다.

프로세스 실행 함수를 주입받아 실기기 없이 테스트한다.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 5: adbClient.stream과 기기 추적

**Files:**
- Modify: `src/main/adb/adbClient.ts`
- Create: `src/main/adb/trackDevices.ts`
- Test: `src/main/adb/adbClient.stream.test.ts`
- Test: `src/main/adb/trackDevices.test.ts`

**Interfaces:**
- Consumes: `createAdbClient`, `AdbClient`, `AdbStream` (Task 4)
- Produces: 동작하는 `AdbClient.stream`, `trackDevices(client, onChange): () => void`.
  M1-2의 `DeviceRegistry`가 `trackDevices`로 연결·해제를 안다.

- [ ] **Step 1: stream 실패 테스트를 쓴다**

`src/main/adb/adbClient.stream.test.ts`:

```ts
import { EventEmitter } from 'node:events'
import { Readable } from 'node:stream'
import { describe, expect, it, vi } from 'vitest'
import { createAdbClient, type SpawnFn } from './adbClient'

function pushableSpawn(): { spawn: SpawnFn; push: (chunk: string) => void; close: (code: number) => void; killed: () => boolean } {
  let killed = false
  const stdout = new Readable({ read() {} })
  const child = new EventEmitter() as ReturnType<SpawnFn>
  child.stdout = stdout
  child.stderr = new Readable({ read() {} })
  child.kill = vi.fn(() => {
    killed = true
    return true
  }) as never

  return {
    spawn: () => child,
    push: (chunk) => stdout.push(chunk),
    close: (code) => child.emit('close', code),
    killed: () => killed
  }
}

describe('adbClient.stream', () => {
  it('emits one callback per complete line', async () => {
    const fake = pushableSpawn()
    const client = createAdbClient('/opt/sdk/platform-tools/adb', fake.spawn)
    const lines: string[] = []

    const stream = client.stream(null, ['track-devices'])
    stream.onLine((line) => lines.push(line))

    fake.push('first\nsecond\n')
    await vi.waitFor(() => expect(lines).toEqual(['first', 'second']))

    stream.close()
  })

  it('holds a partial line until its newline arrives', async () => {
    const fake = pushableSpawn()
    const client = createAdbClient('/opt/sdk/platform-tools/adb', fake.spawn)
    const lines: string[] = []

    const stream = client.stream(null, ['logcat'])
    stream.onLine((line) => lines.push(line))

    fake.push('half')
    await new Promise((r) => setTimeout(r, 5))
    expect(lines).toEqual([])

    fake.push('-line\n')
    await vi.waitFor(() => expect(lines).toEqual(['half-line']))

    stream.close()
  })

  it('reports the exit code on close', async () => {
    const fake = pushableSpawn()
    const client = createAdbClient('/opt/sdk/platform-tools/adb', fake.spawn)
    let closedWith: number | null | undefined

    const stream = client.stream(null, ['track-devices'])
    stream.onClose((code) => {
      closedWith = code
    })

    fake.close(0)
    await vi.waitFor(() => expect(closedWith).toBe(0))
  })

  it('kills the child process when closed', () => {
    const fake = pushableSpawn()
    const client = createAdbClient('/opt/sdk/platform-tools/adb', fake.spawn)

    client.stream(null, ['logcat']).close()

    expect(fake.killed()).toBe(true)
  })
})
```

- [ ] **Step 2: 테스트가 실패하는지 확인한다**

Run: `npx vitest run src/main/adb/adbClient.stream.test.ts`
Expected: FAIL — `stream is implemented in the next task`

- [ ] **Step 3: stream을 구현한다**

`src/main/adb/adbClient.ts`의 `function stream(): AdbStream { ... }` 자리를 아래로 교체한다.
`createAdbClient`가 돌려주는 `{ exec, stream }`은 그대로 둔다.

```ts
  function stream(serial: string | null, args: string[]): AdbStream {
    const child = spawnFn(adbPath, withSerial(serial, args))
    const lineCallbacks: Array<(line: string) => void> = []
    const closeCallbacks: Array<(code: number | null) => void> = []
    let buffer = ''

    child.stdout.on('data', (chunk: Buffer) => {
      buffer += chunk.toString('utf8')
      const parts = buffer.split('\n')
      buffer = parts.pop() ?? ''
      for (const line of parts) {
        for (const callback of lineCallbacks) callback(line)
      }
    })

    child.on('close', (code) => {
      for (const callback of closeCallbacks) callback(code)
    })

    return {
      onLine(callback) {
        lineCallbacks.push(callback)
      },
      onClose(callback) {
        closeCallbacks.push(callback)
      },
      close() {
        child.kill('SIGTERM')
      }
    }
  }
```

- [ ] **Step 4: stream 테스트가 통과하는지 확인한다**

Run: `npx vitest run src/main/adb/adbClient.stream.test.ts`
Expected: PASS (4 tests)

- [ ] **Step 5: trackDevices 실패 테스트를 쓴다**

`src/main/adb/trackDevices.test.ts`:

```ts
import { describe, expect, it, vi } from 'vitest'
import type { AdbClient, AdbStream } from './adbClient'
import { trackDevices } from './trackDevices'

function fakeClient(): { client: AdbClient; emit: (line: string) => void; closed: () => boolean } {
  let lineCallback: ((line: string) => void) | undefined
  let closed = false
  const stream: AdbStream = {
    onLine: (callback) => {
      lineCallback = callback
    },
    onClose: () => {},
    close: () => {
      closed = true
    }
  }
  return {
    client: { exec: vi.fn(), stream: () => stream } as unknown as AdbClient,
    emit: (line) => lineCallback?.(line),
    closed: () => closed
  }
}

describe('trackDevices', () => {
  it('reports a device as connected when it appears in device state', () => {
    const fake = fakeClient()
    const changes: Array<{ serial: string; connected: boolean }> = []

    trackDevices(fake.client, (serial, connected) => changes.push({ serial, connected }))
    fake.emit('emulator-5554\tdevice')

    expect(changes).toEqual([{ serial: 'emulator-5554', connected: true }])
  })

  it('treats offline and unauthorized states as not connected', () => {
    const fake = fakeClient()
    const changes: Array<{ serial: string; connected: boolean }> = []

    trackDevices(fake.client, (serial, connected) => changes.push({ serial, connected }))
    fake.emit('emulator-5554\tdevice')
    fake.emit('emulator-5554\toffline')

    expect(changes).toEqual([
      { serial: 'emulator-5554', connected: true },
      { serial: 'emulator-5554', connected: false }
    ])
  })

  it('does not repeat a change when the state is unchanged', () => {
    const fake = fakeClient()
    const changes: string[] = []

    trackDevices(fake.client, (serial) => changes.push(serial))
    fake.emit('emulator-5554\tdevice')
    fake.emit('emulator-5554\tdevice')

    expect(changes).toEqual(['emulator-5554'])
  })

  it('ignores blank lines', () => {
    const fake = fakeClient()
    const changes: string[] = []

    trackDevices(fake.client, (serial) => changes.push(serial))
    fake.emit('')
    fake.emit('   ')

    expect(changes).toEqual([])
  })

  it('closes the underlying stream when stopped', () => {
    const fake = fakeClient()
    const stop = trackDevices(fake.client, () => {})

    stop()

    expect(fake.closed()).toBe(true)
  })
})
```

- [ ] **Step 6: 테스트가 실패하는지 확인한다**

Run: `npx vitest run src/main/adb/trackDevices.test.ts`
Expected: FAIL — `Failed to resolve import "./trackDevices"`

- [ ] **Step 7: trackDevices를 구현한다**

`src/main/adb/trackDevices.ts`:

```ts
import type { AdbClient } from './adbClient'

export type DeviceChange = (serial: string, connected: boolean) => void

/**
 * `adb track-devices`를 붙잡고 기기 연결·해제를 알린다.
 * 폴링 대신 쓰는 이유는 부팅 완료 시점을 늦지 않게 잡기 위해서다.
 * 같은 상태가 반복되면 알리지 않는다.
 */
export function trackDevices(client: AdbClient, onChange: DeviceChange): () => void {
  const stream = client.stream(null, ['track-devices'])
  const lastState = new Map<string, boolean>()

  stream.onLine((line) => {
    const trimmed = line.trim()
    if (!trimmed) return

    const [serial, state] = trimmed.split(/\s+/)
    if (!serial || !state) return

    const connected = state === 'device'
    if (lastState.get(serial) === connected) return

    lastState.set(serial, connected)
    onChange(serial, connected)
  })

  return () => stream.close()
}
```

- [ ] **Step 8: 테스트가 통과하는지 확인한다**

Run: `npx vitest run src/main/adb && npm run typecheck`
Expected: PASS (adbClient 8 + stream 4 + trackDevices 5 = 17 tests), 타입체크 통과

- [ ] **Step 9: 커밋**

```bash
git add src/main/adb
git commit -m "$(cat <<'EOF'
feat(main): adbClient.stream과 기기 추적 추가

stream은 장시간 도는 adb 프로세스의 출력을 줄 단위로 흘린다.
청크 경계가 줄 중간에 떨어져도 잘리지 않도록 버퍼에 남긴다.

trackDevices는 adb track-devices를 붙잡고 연결·해제를 알린다.
폴링 대신 쓰면 부팅 완료 시점을 늦지 않게 잡는다. offline과
unauthorized는 연결로 보지 않는다.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 6: scrcpy · WebCodecs 스파이크 (버리는 코드)

**Files:**
- Create: `spike/scrcpy/README.md`
- Create: `spike/scrcpy/probe.ts`
- Create: `spike/scrcpy/index.html`
- Create: `vendor/scrcpy/VERSION`
- Modify: `docs/superpowers/specs/2026-09-22-m1-device-core-mcp-server.md` (결과 기록)

**Interfaces:**
- Consumes: `createAdbClient` (Task 4), `locateSdk` (Task 3)
- Produces: **코드가 아니라 답 하나.** `Device` 인터페이스도 `AdbClient`도 바꾸지 않는다.
  본 코드는 `spike/`를 절대 import 하지 않는다.

> 이 task는 TDD를 따르지 않는다. 답을 얻는 것이 목적이고 결과물은 버린다.
> 성공해도 코드를 본 코드로 옮기지 않는다. M2에서 처음부터 다시 쓴다.

- [ ] **Step 1: 스파이크의 질문과 폐기 조건을 적는다**

`spike/scrcpy/README.md`:

```markdown
# 스파이크: scrcpy 서버 → WebCodecs 디코딩

## 질문

고정한 버전의 `scrcpy-server.jar`을 기기에 푸시하고 비디오 소켓을 열어서,
첫 H.264 키프레임을 받아 renderer의 WebCodecs `VideoDecoder`로 디코딩해
한 프레임을 그릴 수 있나?

## 성공 기준

화면에 기기 화면 한 장이 뜬다. 거기서 멈춘다.

## 이 코드의 수명

버린다. 성공해도 M2에서 처음부터 다시 쓴다. 본 코드(`src/`)는 이 디렉토리를
절대 import 하지 않는다.

## 실패 시 후퇴안

- main에서 ffmpeg으로 디코딩해 프레임을 renderer로 넘긴다.
- `adb exec-out screencap` 폴링으로 내려앉는다.

둘 다 M2의 모양이 달라지며 ADR-0002를 대체한다.
```

- [ ] **Step 2: scrcpy 릴리스에서 server jar을 받아 버전을 고정한다**

```bash
mkdir -p vendor/scrcpy
# scrcpy 릴리스 페이지에서 scrcpy-server 파일을 내려받아 vendor/scrcpy/scrcpy-server.jar 로 둔다.
# 받은 릴리스 태그를 그대로 기록한다. 버전을 지어내지 않는다.
printf '%s\n' '<받은 릴리스 태그>' > vendor/scrcpy/VERSION
shasum -a 256 vendor/scrcpy/scrcpy-server.jar >> vendor/scrcpy/VERSION
```

`vendor/scrcpy/scrcpy-server.jar`은 커밋한다. 버전을 우리가 고정해야 파서가 깨지지 않는다
([ADR-0002](../../adr/0002-screen-streaming-via-scrcpy-server.md)).

- [ ] **Step 3: 에뮬레이터를 띄우고 jar을 푸시해 소켓이 열리는지 확인한다**

```bash
# 에뮬레이터가 하나 떠 있어야 한다.
adb devices -l

adb push vendor/scrcpy/scrcpy-server.jar /data/local/tmp/scrcpy-server.jar
adb forward tcp:27183 localabstract:scrcpy

# 아래 인자 목록은 받은 릴리스의 server 진입점이 요구하는 형식에 맞춘다.
# scrcpy 릴리스마다 인자가 달라지므로 해당 태그의 소스에서 확인한다.
adb shell CLASSPATH=/data/local/tmp/scrcpy-server.jar \
  app_process / com.genymobile.scrcpy.Server <해당 버전의 인자>
```

Expected: 명령이 붙어 있고, 다른 터미널에서 `nc localhost 27183`에 연결이 된다.
연결이 안 되면 그 사실을 기록하고 Step 6으로 간다.

- [ ] **Step 4: Node에서 소켓을 읽어 첫 H.264 청크를 파일로 떠 본다**

`spike/scrcpy/probe.ts`:

```ts
// 스파이크 코드. 버린다.
import { createConnection } from 'node:net'
import { writeFileSync } from 'node:fs'

const socket = createConnection({ host: '127.0.0.1', port: 27183 })
const chunks: Buffer[] = []

socket.on('data', (chunk: Buffer) => {
  chunks.push(chunk)
  const total = chunks.reduce((sum, c) => sum + c.length, 0)
  console.log(`received ${chunk.length} bytes (total ${total})`)
  if (total > 200_000) {
    writeFileSync('spike/scrcpy/first-chunks.bin', Buffer.concat(chunks))
    console.log('wrote spike/scrcpy/first-chunks.bin')
    socket.end()
  }
})

socket.on('error', (error) => {
  console.error('socket error', error)
})
```

Run: `npx --yes tsx spike/scrcpy/probe.ts`
Expected: 바이트가 들어오고 `first-chunks.bin`이 생긴다. 헤더 형식과 청크 경계를
받은 릴리스의 소스와 대조해 기록한다.

- [ ] **Step 5: renderer에서 WebCodecs로 한 프레임을 그려 본다**

`spike/scrcpy/index.html`:

```html
<!doctype html>
<html lang="ko">
  <head>
    <meta charset="UTF-8" />
    <title>scrcpy WebCodecs spike</title>
  </head>
  <body>
    <canvas id="screen" width="1080" height="2400"></canvas>
    <pre id="log"></pre>
    <script type="module">
      const log = (text) => {
        document.getElementById('log').textContent += text + '\n'
      }

      const canvas = document.getElementById('screen')
      const context = canvas.getContext('2d')

      const decoder = new VideoDecoder({
        output: (frame) => {
          context.drawImage(frame, 0, 0, canvas.width, canvas.height)
          frame.close()
          log('frame drawn')
        },
        error: (error) => log('decoder error: ' + error.message)
      })

      // codec 문자열과 description은 Step 4에서 확인한 SPS/PPS로 채운다.
      decoder.configure({ codec: 'avc1.640028', optimizeForLatency: true })

      const response = await fetch('./first-chunks.bin')
      const bytes = new Uint8Array(await response.arrayBuffer())

      // Step 4에서 확인한 청크 경계로 잘라 첫 키프레임을 넣는다.
      decoder.decode(new EncodedVideoChunk({ type: 'key', timestamp: 0, data: bytes }))
      log('decode submitted')
    </script>
  </body>
</html>
```

Electron 창에서 이 파일을 연다. 브라우저가 아니라 Electron이어야 한다 — 우리가 쓸 Chromium
버전에서 되는지가 질문이다.

Run: `npm run dev` 후 main의 `createWindow`에서 이 파일을 임시로 로드하거나,
`npx electron spike/scrcpy` 로 직접 띄운다.
Expected: 캔버스에 기기 화면 한 장이 뜨고 로그에 `frame drawn`이 찍힌다.

- [ ] **Step 6: 답을 스펙에 기록한다**

성공이든 실패든 스펙의 "스파이크" 절 끝에 아래 형식으로 결과를 덧붙인다.
**추측을 적지 않는다. 확인한 것만 적는다.**

```markdown
### 스파이크 결과 (2026-MM-DD)

- scrcpy 릴리스: `<태그>`
- 소켓 연결: 성공 / 실패 — <관찰한 것>
- H.264 수신: 성공 / 실패 — <관찰한 것>
- WebCodecs 디코딩: 성공 / 실패 — <관찰한 것>
- 판정: ADR-0002 유지 / 후퇴안으로 전환
- M2 설계의 전제: <한 문단>
```

실패했으면 [ADR-0002](../../adr/0002-screen-streaming-via-scrcpy-server.md)의
`status`를 `superseded`로 바꾸고 후퇴안 ADR을 새로 만든다.

Run: `python3 docs/script/docs.py lint && python3 docs/script/docs.py links`
Expected: 문제 0건

- [ ] **Step 7: 커밋**

```bash
git add spike vendor docs
git commit -m "$(cat <<'EOF'
chore(spike): scrcpy 서버 스트림의 WebCodecs 디코딩 가능 여부 확인

M2의 기술 위험을 M1 초반에 확인한다. 실패하면 M2 설계가 통째로
달라지므로 늦게 알수록 비싸다.

spike/ 아래 코드는 버린다. 본 코드는 이 디렉토리를 import 하지 않는다.
성공해도 M2에서 처음부터 다시 쓴다.

scrcpy-server.jar은 버전을 고정해 vendor/에 커밋한다. 프로토콜이
릴리스마다 바뀌어 사용자 머신의 설치분에 기댈 수 없다.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## 이 계획이 끝났을 때

- `npm run dev`로 Electron 창이 뜬다.
- `npm test`, `npm run typecheck`, `npm run build`가 모두 통과한다.
- `locateSdk`가 이 머신의 Android SDK를 찾거나, 못 찾은 경로 목록을 돌려준다.
- `adbClient.exec`와 `stream`이 실기기 없이 테스트로 덮여 있다.
- scrcpy 스파이크의 답이 스펙에 기록되어 있고, ADR-0002의 운명이 정해져 있다.

다음은 [M1-2 — Android 기기 구현체](2026-09-22-m1-2-android-device.md)다.
