---
id: m1-2-android-device
title: M1-2 — Android 기기 구현체
status: draft
type: work-order
created: 2026-09-22
updated: 2026-09-22
owner: virtual-device-helper 팀
scope: [main, android, shared]
hosts: [macos]
archived_reason:
related_adr: [ADR-0003, ADR-0004, ADR-0005, ADR-0007]
related_spec: m1-device-core-mcp-server
related_architecture:
related_plan: [m1-1-foundation-and-adb, m1-3-mcp-server]
related_code:
tags: [plan, m1, android]
---

# M1-2 — Android 기기 구현체 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: `superpowers:subagent-driven-development`(권장) 또는
> `superpowers:executing-plans`로 task 단위 구현. 각 단계는 체크박스(`- [ ]`)로 추적한다.

**Goal:** `adbClient` 위에 Android 도메인을 얹는다. adb 출력 파서, `Device` 구현체인
`AndroidDevice`, AVD 수명주기를 다루는 `AvdController`, 기기 목록과 활성 기기와 명령 큐를 쥐는
`DeviceRegistry`를 만든다.

**Architecture:** adb 출력 파싱은 이 계획 안에 갇힌다. 위층은 파싱된 도메인 타입만 본다.
`AndroidDevice`는 `AdbClient` 하나만 의존하고, 이미지 축소처럼 Electron에 묶이는 일은 함수로
주입받아 실기기·실런타임 없이 테스트된다. `DeviceRegistry`는 기기당 명령을 직렬화해 두 에이전트가
같은 기기를 동시에 만져도 결과가 엉키지 않게 한다.

**Tech Stack:** TypeScript, Vitest, fast-xml-parser, Electron `nativeImage`

**Spec:** [`../specs/2026-09-22-m1-device-core-mcp-server.md`](../specs/2026-09-22-m1-device-core-mcp-server.md)

**계획 순서:** [M1-1](2026-09-22-m1-1-foundation-and-adb.md) → M1-2(이 문서) →
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
- **층 방향 규칙:** 위층은 바로 아래층만 부른다. `AndroidDevice`는 `AdbClient`만 보고,
  `DeviceRegistry`는 `Device` 인터페이스만 본다 ([ADR-0005](../../adr/0005-device-interface-abstraction.md)).
- **adb 출력 파싱은 이 계획 밖으로 새지 않는다.** 위층은 raw stdout·stderr를 해석하지 않는다.
- **파싱 테스트는 실제 출력을 픽스처로 떠서 한다.** 손으로 지어낸 샘플로 검증하면 현실에서 깨진다.
- **M1의 호스트는 macOS, 타깃은 Android 하나다.** iOS·Windows 코드를 미리 쓰지 않는다.
- 의존성 버전은 설치 시점의 최신 안정판을 쓰고 `package-lock.json`으로 고정한다.
- 문서를 고쳤으면 `python3 docs/script/docs.py lint`와 `links`를 돌린다.

## 파일 구성

| 파일 | 책임 |
|---|---|
| `src/main/device/parsers/devices.ts` | `adb devices -l` 출력 파싱 |
| `src/main/device/parsers/uiDump.ts` | uiautomator XML을 `UiNode[]`로 요약 |
| `src/main/device/parsers/logcat.ts` | `logcat -v threadtime` 출력 파싱 |
| `src/main/device/parsers/__fixtures__/` | 실기기에서 뜬 출력 샘플 |
| `src/main/device/androidDevice.ts` | `Device` 구현체 |
| `src/main/device/avdController.ts` | AVD 목록·부팅·종료 |
| `src/main/device/registry.ts` | 기기 목록, 활성 기기, 기기당 명령 큐 |
| `src/main/device/resizeImage.ts` | Electron `nativeImage` 기반 축소 (주입되는 구현) |

---

### Task 1: adb devices 파서

**Files:**
- Create: `src/main/device/parsers/devices.ts`
- Create: `src/main/device/parsers/__fixtures__/devices-l.txt`
- Test: `src/main/device/parsers/devices.test.ts`

**Interfaces:**
- Consumes: 없음 (순수 함수)
- Produces: `parseDevices(stdout: string): AdbDeviceEntry[]`, `AdbDeviceEntry`.
  Task 8의 `DeviceRegistry`가 쓴다.

- [ ] **Step 1: 실제 출력을 픽스처로 뜬다**

에뮬레이터를 하나 이상 띄우고 실제 출력을 저장한다.

```bash
mkdir -p src/main/device/parsers/__fixtures__
adb devices -l > src/main/device/parsers/__fixtures__/devices-l.txt
cat src/main/device/parsers/__fixtures__/devices-l.txt
```

에뮬레이터를 띄울 수 없으면 아래를 그대로 픽스처로 쓰고, M1-5의 실기기 검증에서 실제 출력과
대조한다.

```
List of devices attached
emulator-5554          device product:sdk_gphone64_arm64 model:sdk_gphone64_arm64 device:emu64a transport_id:1
emulator-5556          offline transport_id:2
```

- [ ] **Step 2: 실패 테스트를 쓴다**

`src/main/device/parsers/devices.test.ts`:

```ts
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { parseDevices } from './devices'

const fixture = readFileSync(join(__dirname, '__fixtures__', 'devices-l.txt'), 'utf8')

describe('parseDevices', () => {
  it('skips the "List of devices attached" header', () => {
    const entries = parseDevices(fixture)

    expect(entries.every((entry) => entry.serial !== 'List')).toBe(true)
  })

  it('reads serial and state from each line', () => {
    const entries = parseDevices('List of devices attached\nemulator-5554          device transport_id:1\n')

    expect(entries).toEqual([{ serial: 'emulator-5554', state: 'device', model: null }])
  })

  it('reads the model key when present', () => {
    const entries = parseDevices(
      'List of devices attached\nemulator-5554  device product:sdk_gphone64_arm64 model:sdk_gphone64_arm64 device:emu64a\n'
    )

    expect(entries[0]?.model).toBe('sdk_gphone64_arm64')
  })

  it('keeps non-device states so callers can tell offline from absent', () => {
    const entries = parseDevices('List of devices attached\nemulator-5556  offline transport_id:2\n')

    expect(entries[0]?.state).toBe('offline')
  })

  it('ignores blank lines and daemon startup chatter', () => {
    const entries = parseDevices(
      '* daemon not running; starting now at tcp:5037\n* daemon started successfully\nList of devices attached\n\nemulator-5554  device\n\n'
    )

    expect(entries).toEqual([{ serial: 'emulator-5554', state: 'device', model: null }])
  })

  it('returns an empty array when nothing is attached', () => {
    expect(parseDevices('List of devices attached\n\n')).toEqual([])
  })

  it('parses the recorded fixture without throwing', () => {
    expect(() => parseDevices(fixture)).not.toThrow()
  })
})
```

- [ ] **Step 3: 테스트가 실패하는지 확인한다**

Run: `npx vitest run src/main/device/parsers/devices.test.ts`
Expected: FAIL — `Failed to resolve import "./devices"`

- [ ] **Step 4: 구현한다**

`src/main/device/parsers/devices.ts`:

```ts
export interface AdbDeviceEntry {
  serial: string
  /** device | offline | unauthorized | 그 밖에 adb가 뱉는 값. 그대로 보존한다. */
  state: string
  /** `model:` 키가 있으면 그 값. -l 없이 부르면 null. */
  model: string | null
}

const HEADER = 'List of devices attached'

/**
 * `adb devices -l`의 출력을 파싱한다.
 * 데몬 시작 안내(`* daemon ...`)와 빈 줄은 버린다.
 */
export function parseDevices(stdout: string): AdbDeviceEntry[] {
  const entries: AdbDeviceEntry[] = []

  for (const rawLine of stdout.split('\n')) {
    const line = rawLine.trim()
    if (!line) continue
    if (line === HEADER) continue
    if (line.startsWith('*')) continue

    const [serial, state, ...rest] = line.split(/\s+/)
    if (!serial || !state) continue

    const modelToken = rest.find((token) => token.startsWith('model:'))
    entries.push({
      serial,
      state,
      model: modelToken ? modelToken.slice('model:'.length) : null
    })
  }

  return entries
}
```

- [ ] **Step 5: 테스트가 통과하는지 확인한다**

Run: `npx vitest run src/main/device/parsers/devices.test.ts`
Expected: PASS (7 tests)

- [ ] **Step 6: 커밋**

```bash
git add src/main/device/parsers
git commit -m "$(cat <<'EOF'
feat(main): adb devices 출력 파서 추가

실제 `adb devices -l` 출력을 픽스처로 떠서 테스트한다. 손으로 지어낸
샘플로 검증하면 데몬 안내 줄이나 키 순서 같은 현실의 변형에서 깨진다.

offline과 unauthorized 상태를 버리지 않고 그대로 보존한다. 호출부가
"기기가 없음"과 "기기가 있는데 못 씀"을 구분해야 한다.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 2: uiautomator 덤프 파서

**Files:**
- Create: `src/main/device/parsers/uiDump.ts`
- Create: `src/main/device/parsers/__fixtures__/window-dump.xml`
- Test: `src/main/device/parsers/uiDump.test.ts`
- Modify: `package.json` (fast-xml-parser 추가)

**Interfaces:**
- Consumes: `UiNode` (M1-1 Task 2)
- Produces: `parseUiDump(xml: string, opts: ParseUiDumpOpts): UiNode[]`, `ParseUiDumpOpts`.
  Task 4의 `AndroidDevice.dumpUi`가 쓴다.

> 이 파서가 이 프로젝트에서 가장 값어치 있는 코드다. 원본 XML은 화면 하나가 수만 토큰이라
> 에이전트에게 줄 수 없다. 요약의 품질이 `ui_find`의 쓸모를 정한다
> ([ADR-0004](../../adr/0004-hybrid-mcp-tool-surface.md)).

- [ ] **Step 1: 실제 덤프를 픽스처로 뜬다**

```bash
adb shell uiautomator dump /sdcard/window_dump.xml
adb exec-out cat /sdcard/window_dump.xml > src/main/device/parsers/__fixtures__/window-dump.xml
wc -c src/main/device/parsers/__fixtures__/window-dump.xml
```

에뮬레이터를 띄울 수 없으면 아래 최소 XML을 픽스처로 쓰고, M1-5에서 실제 덤프와 대조한다.

```xml
<?xml version='1.0' encoding='UTF-8' standalone='yes' ?>
<hierarchy rotation="0">
  <node index="0" text="" resource-id="" class="android.widget.FrameLayout" package="com.example" content-desc="" clickable="false" bounds="[0,0][1080,2400]">
    <node index="0" text="이메일" resource-id="com.example:id/email" class="android.widget.EditText" package="com.example" content-desc="" clickable="true" bounds="[80,600][1000,760]" />
    <node index="1" text="로그인" resource-id="com.example:id/login" class="android.widget.Button" package="com.example" content-desc="로그인 버튼" clickable="true" bounds="[80,860][1000,1000]" />
    <node index="2" text="숨은 요소" resource-id="" class="android.widget.TextView" package="com.example" content-desc="" clickable="false" bounds="[0,0][0,0]" />
    <node index="3" text="화면 밖" resource-id="" class="android.widget.TextView" package="com.example" content-desc="" clickable="true" bounds="[80,2600][1000,2700]" />
  </node>
</hierarchy>
```

- [ ] **Step 2: XML 파서를 설치한다**

```bash
npm install fast-xml-parser
```

정규식으로 XML을 긁지 않는다. 속성값에 따옴표와 이스케이프가 들어가 금방 깨진다.

- [ ] **Step 3: 실패 테스트를 쓴다**

`src/main/device/parsers/uiDump.test.ts`:

```ts
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { parseUiDump } from './uiDump'

const fixture = readFileSync(join(__dirname, '__fixtures__', 'window-dump.xml'), 'utf8')
const screen = { screenWidth: 1080, screenHeight: 2400 }

describe('parseUiDump', () => {
  it('returns the center point of each node so it can be tapped directly', () => {
    const nodes = parseUiDump(fixture, screen)
    const login = nodes.find((node) => node.resourceId === 'login')

    expect(login).toBeDefined()
    expect(login?.x).toBe(540)
    expect(login?.y).toBe(930)
  })

  it('keeps only the tail of resource-id', () => {
    const nodes = parseUiDump(fixture, screen)

    expect(nodes.map((node) => node.resourceId)).toContain('email')
    expect(nodes.every((node) => !node.resourceId?.includes(':id/'))).toBe(true)
  })

  it('keeps only the short class name', () => {
    const nodes = parseUiDump(fixture, screen)

    expect(nodes.map((node) => node.className)).toContain('Button')
    expect(nodes.every((node) => !node.className.includes('.'))).toBe(true)
  })

  it('drops zero-area nodes', () => {
    const nodes = parseUiDump(fixture, screen)

    expect(nodes.some((node) => node.text === '숨은 요소')).toBe(false)
  })

  it('drops nodes whose center lies outside the screen', () => {
    const nodes = parseUiDump(fixture, screen)

    expect(nodes.some((node) => node.text === '화면 밖')).toBe(false)
  })

  it('drops containers that carry no identity and cannot be clicked', () => {
    const nodes = parseUiDump(fixture, screen)

    expect(nodes.some((node) => node.className === 'FrameLayout')).toBe(false)
  })

  it('turns empty attributes into null instead of empty strings', () => {
    const nodes = parseUiDump(fixture, screen)
    const email = nodes.find((node) => node.resourceId === 'email')

    expect(email?.contentDesc).toBeNull()
  })

  it('filters by query across text, contentDesc and resourceId, case-insensitively', () => {
    const byText = parseUiDump(fixture, { ...screen, query: '로그인' })
    expect(byText.map((node) => node.resourceId)).toEqual(['login'])

    const byId = parseUiDump(fixture, { ...screen, query: 'EMAIL' })
    expect(byId.map((node) => node.resourceId)).toEqual(['email'])
  })

  it('numbers the surviving nodes from zero in document order', () => {
    const nodes = parseUiDump(fixture, screen)

    expect(nodes.map((node) => node.index)).toEqual(nodes.map((_, position) => position))
  })

  it('returns an empty array for a dump with no usable nodes', () => {
    const empty = '<?xml version="1.0"?><hierarchy rotation="0"></hierarchy>'

    expect(parseUiDump(empty, screen)).toEqual([])
  })
})
```

- [ ] **Step 4: 테스트가 실패하는지 확인한다**

Run: `npx vitest run src/main/device/parsers/uiDump.test.ts`
Expected: FAIL — `Failed to resolve import "./uiDump"`

- [ ] **Step 5: 구현한다**

`src/main/device/parsers/uiDump.ts`:

```ts
import { XMLParser } from 'fast-xml-parser'
import type { UiNode } from '../../../shared/types/device'

export interface ParseUiDumpOpts {
  screenWidth: number
  screenHeight: number
  /** text·content-desc·resource-id에 대한 대소문자 무시 부분일치. */
  query?: string
}

interface RawNode {
  text?: string
  'resource-id'?: string
  'content-desc'?: string
  class?: string
  clickable?: string | boolean
  bounds?: string
  node?: RawNode | RawNode[]
}

const BOUNDS = /^\[(-?\d+),(-?\d+)\]\[(-?\d+),(-?\d+)\]$/

function emptyToNull(value: string | undefined): string | null {
  const trimmed = (value ?? '').trim()
  return trimmed === '' ? null : trimmed
}

function shortClassName(value: string | undefined): string {
  const full = (value ?? '').trim()
  const lastDot = full.lastIndexOf('.')
  return lastDot === -1 ? full : full.slice(lastDot + 1)
}

function resourceIdTail(value: string | undefined): string | null {
  const full = emptyToNull(value)
  if (!full) return null
  const marker = full.indexOf('/')
  return marker === -1 ? full : full.slice(marker + 1)
}

function flatten(node: RawNode | RawNode[] | undefined, into: RawNode[]): void {
  if (!node) return
  if (Array.isArray(node)) {
    for (const child of node) flatten(child, into)
    return
  }
  into.push(node)
  flatten(node.node, into)
}

/**
 * uiautomator 덤프를 요소 배열로 요약한다.
 * 원본 XML은 이 함수 밖으로 나가지 않는다 — 화면 하나가 수만 토큰이라
 * 에이전트에게 그대로 줄 수 없다.
 */
export function parseUiDump(xml: string, opts: ParseUiDumpOpts): UiNode[] {
  const parser = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: '' })
  const document = parser.parse(xml) as { hierarchy?: RawNode }

  const raw: RawNode[] = []
  flatten(document.hierarchy?.node, raw)

  const query = opts.query?.toLowerCase()
  const result: UiNode[] = []

  for (const candidate of raw) {
    const match = BOUNDS.exec((candidate.bounds ?? '').trim())
    if (!match) continue

    const left = Number(match[1])
    const top = Number(match[2])
    const right = Number(match[3])
    const bottom = Number(match[4])

    // 크기가 없는 노드는 사람에게도 에이전트에게도 보이지 않는다.
    if (right - left <= 0 || bottom - top <= 0) continue

    const x = Math.round((left + right) / 2)
    const y = Math.round((top + bottom) / 2)

    // 중심이 화면 밖이면 탭할 수 없다.
    if (x < 0 || y < 0 || x > opts.screenWidth || y > opts.screenHeight) continue

    const text = emptyToNull(candidate.text)
    const contentDesc = emptyToNull(candidate['content-desc'])
    const resourceId = resourceIdTail(candidate['resource-id'])
    const clickable = candidate.clickable === true || candidate.clickable === 'true'

    // 이름도 없고 누를 수도 없는 노드는 레이아웃 컨테이너다. 에이전트가 쓸 일이 없다.
    if (!text && !contentDesc && !resourceId && !clickable) continue

    if (query) {
      const haystack = `${text ?? ''}\n${contentDesc ?? ''}\n${resourceId ?? ''}`.toLowerCase()
      if (!haystack.includes(query)) continue
    }

    result.push({
      index: result.length,
      text,
      contentDesc,
      resourceId,
      className: shortClassName(candidate.class),
      x,
      y,
      clickable
    })
  }

  return result
}
```

- [ ] **Step 6: 테스트가 통과하는지 확인한다**

Run: `npx vitest run src/main/device/parsers/uiDump.test.ts`
Expected: PASS (10 tests)

- [ ] **Step 7: 실제 덤프에서 압축률을 재고 기록한다**

```bash
npx --yes tsx -e "
import { readFileSync } from 'node:fs'
import { parseUiDump } from './src/main/device/parsers/uiDump.ts'
const xml = readFileSync('src/main/device/parsers/__fixtures__/window-dump.xml', 'utf8')
const nodes = parseUiDump(xml, { screenWidth: 1080, screenHeight: 2400 })
console.log('xml bytes', xml.length)
console.log('json bytes', JSON.stringify(nodes).length)
console.log('nodes', nodes.length)
"
```

Expected: JSON이 XML보다 확실히 작다. 비슷하거나 크면 필터가 동작하지 않는 것이므로
스펙의 열린 질문("버릴 노드의 기준")으로 돌아가 기준을 좁힌다.

- [ ] **Step 8: 커밋**

```bash
git add src/main/device/parsers package.json package-lock.json
git commit -m "$(cat <<'EOF'
feat(main): uiautomator 덤프를 요소 배열로 요약하는 파서 추가

원본 XML은 화면 하나가 수만 토큰이라 에이전트에게 줄 수 없다.
이 파서의 요약 품질이 ui_find의 쓸모를 정한다.

버리는 것: 크기가 0인 노드, 중심이 화면 밖인 노드, 이름도 없고 누를
수도 없는 레이아웃 컨테이너. 남기는 것은 에이전트가 실제로 지목하거나
누를 수 있는 요소뿐이다.

좌표는 중심점으로 준다. 에이전트가 받은 값을 ui_tap에 그대로 넣는다.
resource-id는 꼬리만, 클래스는 짧은 이름만 남겨 토큰을 줄인다.

정규식 대신 fast-xml-parser를 쓴다. 속성값의 따옴표와 이스케이프에서
정규식은 깨진다.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 3: logcat 파서

**Files:**
- Create: `src/main/device/parsers/logcat.ts`
- Create: `src/main/device/parsers/__fixtures__/logcat-threadtime.txt`
- Test: `src/main/device/parsers/logcat.test.ts`

**Interfaces:**
- Consumes: `LogLine`, `LogLevel` (M1-1 Task 2)
- Produces: `parseLogcat(stdout: string): LogLine[]`. Task 4의 `AndroidDevice.readLogs`가 쓴다.

- [ ] **Step 1: 실제 출력을 픽스처로 뜬다**

```bash
adb logcat -d -v threadtime -t 200 > src/main/device/parsers/__fixtures__/logcat-threadtime.txt
head -5 src/main/device/parsers/__fixtures__/logcat-threadtime.txt
```

에뮬레이터가 없으면 아래를 픽스처로 쓴다.

```
--------- beginning of main
09-22 11:06:21.123  1234  1256 I ActivityManager: Start proc 5678:com.example/u0a123
09-22 11:06:21.456  1234  1256 W ActivityManager: Slow operation took 412ms
09-22 11:06:22.001  5678  5678 E AndroidRuntime: FATAL EXCEPTION: main
09-22 11:06:22.001  5678  5678 E AndroidRuntime: java.lang.IllegalStateException: boom
09-22 11:06:22.900  5678  5690 D OkHttp: --> GET https://example.com/api
```

- [ ] **Step 2: 실패 테스트를 쓴다**

`src/main/device/parsers/logcat.test.ts`:

```ts
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { parseLogcat } from './logcat'

const fixture = readFileSync(join(__dirname, '__fixtures__', 'logcat-threadtime.txt'), 'utf8')

describe('parseLogcat', () => {
  it('splits a threadtime line into its fields', () => {
    const lines = parseLogcat('09-22 11:06:21.123  1234  1256 I ActivityManager: Start proc 5678\n')

    expect(lines).toEqual([
      {
        timestamp: '09-22 11:06:21.123',
        level: 'I',
        tag: 'ActivityManager',
        pid: 1234,
        message: 'Start proc 5678'
      }
    ])
  })

  it('keeps colons inside the message', () => {
    const lines = parseLogcat('09-22 11:06:22.001  5678  5678 E AndroidRuntime: java.lang.IllegalStateException: boom\n')

    expect(lines[0]?.message).toBe('java.lang.IllegalStateException: boom')
  })

  it('drops the "beginning of" separators logcat emits', () => {
    const lines = parseLogcat('--------- beginning of main\n09-22 11:06:21.123  1 2 I Tag: hi\n')

    expect(lines).toHaveLength(1)
  })

  it('drops lines it cannot parse rather than guessing', () => {
    const lines = parseLogcat('this is not a logcat line\n')

    expect(lines).toEqual([])
  })

  it('handles tags containing dots and dashes', () => {
    const lines = parseLogcat('09-22 11:06:22.900  5678  5690 D okhttp.Http2: frame\n')

    expect(lines[0]?.tag).toBe('okhttp.Http2')
  })

  it('parses the recorded fixture and finds at least one error line', () => {
    const lines = parseLogcat(fixture)

    expect(lines.length).toBeGreaterThan(0)
    expect(lines.every((line) => ['V', 'D', 'I', 'W', 'E', 'F'].includes(line.level))).toBe(true)
  })
})
```

- [ ] **Step 3: 테스트가 실패하는지 확인한다**

Run: `npx vitest run src/main/device/parsers/logcat.test.ts`
Expected: FAIL — `Failed to resolve import "./logcat"`

- [ ] **Step 4: 구현한다**

`src/main/device/parsers/logcat.ts`:

```ts
import type { LogLevel, LogLine } from '../../../shared/types/device'

/**
 * `-v threadtime` 한 줄:
 * `09-22 11:06:21.123  1234  1256 I ActivityManager: Start proc`
 *  날짜시각              pid   tid  레벨 태그          메시지
 */
const THREADTIME =
  /^(\d{2}-\d{2} \d{2}:\d{2}:\d{2}\.\d{3})\s+(\d+)\s+(\d+)\s+([VDIWEF])\s+(.*?):\s?(.*)$/

/**
 * logcat 출력을 구조화한다. 형식은 `-v threadtime`으로 고정한다.
 * 다른 포맷을 추측하지 않는다 — 파싱할 수 없는 줄은 버린다.
 */
export function parseLogcat(stdout: string): LogLine[] {
  const lines: LogLine[] = []

  for (const rawLine of stdout.split('\n')) {
    const line = rawLine.trimEnd()
    if (!line) continue
    if (line.startsWith('---------')) continue

    const match = THREADTIME.exec(line)
    if (!match) continue

    lines.push({
      timestamp: match[1] as string,
      level: match[4] as LogLevel,
      tag: (match[5] as string).trim(),
      pid: Number(match[2]),
      message: match[6] as string
    })
  }

  return lines
}
```

- [ ] **Step 5: 테스트가 통과하는지 확인한다**

Run: `npx vitest run src/main/device/parsers`
Expected: PASS (devices 7 + uiDump 10 + logcat 6 = 23 tests)

- [ ] **Step 6: 커밋**

```bash
git add src/main/device/parsers
git commit -m "$(cat <<'EOF'
feat(main): logcat 출력 파서 추가

포맷을 -v threadtime 하나로 고정한다. 여러 포맷을 추측해 맞추면
조용히 틀린 값을 만든다. 파싱할 수 없는 줄은 버린다.

메시지 안의 콜론을 태그 구분자로 오인하지 않도록 태그는 최소 일치로 끊는다.
스택 트레이스가 전부 태그로 빨려 들어가는 것을 막는다.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 4: AndroidDevice — 정보와 관찰

**Files:**
- Create: `src/main/device/androidDevice.ts`
- Create: `src/main/device/resizeImage.ts`
- Test: `src/main/device/androidDevice.observe.test.ts`

**Interfaces:**
- Consumes: `AdbClient` (M1-1 Task 4), `parseUiDump`, `parseLogcat` (Task 2·3),
  `Device` 관련 타입과 `deviceError` (M1-1 Task 2)
- Produces: `createAndroidDevice(deps: AndroidDeviceDeps): Device`, `AndroidDeviceDeps`,
  `ResizeImage`, `electronResizeImage`, `DEFAULT_MAX_LONG_EDGE`, `DEFAULT_LOG_LIMIT`, `MAX_LOG_LIMIT`.
  Task 7·8과 M1-3이 쓴다.

- [ ] **Step 1: 실패 테스트를 쓴다**

`src/main/device/androidDevice.observe.test.ts`:

```ts
import { describe, expect, it, vi } from 'vitest'
import type { AdbClient, ExecResult } from '../adb/adbClient'
import { createAndroidDevice, DEFAULT_LOG_LIMIT, MAX_LOG_LIMIT } from './androidDevice'

/** args 배열을 공백으로 이어 붙인 문자열을 키로 응답을 고른다. */
function fakeAdb(responses: Record<string, string | Buffer>): { adb: AdbClient; calls: string[][] } {
  const calls: string[][] = []
  const adb = {
    exec: vi.fn(async (_serial: string | null, args: string[]): Promise<ExecResult> => {
      calls.push(args)
      const key = Object.keys(responses).find((candidate) => args.join(' ').includes(candidate))
      const value = key ? responses[key] : ''
      const raw = Buffer.isBuffer(value) ? value : Buffer.from(value ?? '', 'utf8')
      return { stdout: raw.toString('utf8'), stdoutRaw: raw, stderr: '', exitCode: 0 }
    }),
    stream: vi.fn()
  } as unknown as AdbClient
  return { adb, calls }
}

const noopResize = (png: Buffer) => ({ png, width: 1080, height: 2400 })

describe('AndroidDevice.info', () => {
  it('reads model, api level and screen size', async () => {
    const { adb } = fakeAdb({
      'ro.product.model': 'Pixel 7\n',
      'ro.build.version.sdk': '34\n',
      'wm size': 'Physical size: 1080x2400\n'
    })
    const device = createAndroidDevice({ serial: 'emulator-5554', adb, resizeImage: noopResize })

    await expect(device.info()).resolves.toEqual({
      serial: 'emulator-5554',
      model: 'Pixel 7',
      apiLevel: 34,
      width: 1080,
      height: 2400
    })
  })

  it('prefers the override size when one is set', async () => {
    const { adb } = fakeAdb({
      'ro.product.model': 'Pixel 7\n',
      'ro.build.version.sdk': '34\n',
      'wm size': 'Physical size: 1080x2400\nOverride size: 540x1200\n'
    })
    const device = createAndroidDevice({ serial: 'emulator-5554', adb, resizeImage: noopResize })

    const info = await device.info()

    expect(info.width).toBe(540)
    expect(info.height).toBe(1200)
  })
})

describe('AndroidDevice.screenshot', () => {
  it('captures raw PNG bytes with exec-out so they are not mangled', async () => {
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d])
    const { adb, calls } = fakeAdb({ screencap: png, 'wm size': 'Physical size: 1080x2400\n' })
    const device = createAndroidDevice({ serial: 'emulator-5554', adb, resizeImage: noopResize })

    const shot = await device.screenshot()

    expect(calls.some((args) => args[0] === 'exec-out' && args.includes('screencap'))).toBe(true)
    expect(shot.base64).toBe(png.toString('base64'))
  })

  it('shrinks to the default long edge when no scale is given', async () => {
    const resize = vi.fn((png: Buffer, maxLongEdge: number) => ({ png, width: maxLongEdge, height: maxLongEdge }))
    const { adb } = fakeAdb({ screencap: Buffer.from([1]), 'wm size': 'Physical size: 1080x2400\n' })
    const device = createAndroidDevice({ serial: 'emulator-5554', adb, resizeImage: resize })

    await device.screenshot()

    expect(resize).toHaveBeenCalledWith(expect.any(Buffer), 720)
  })

  it('scales relative to the device long edge when scale is given', async () => {
    const resize = vi.fn((png: Buffer, maxLongEdge: number) => ({ png, width: maxLongEdge, height: maxLongEdge }))
    const { adb } = fakeAdb({ screencap: Buffer.from([1]), 'wm size': 'Physical size: 1080x2400\n' })
    const device = createAndroidDevice({ serial: 'emulator-5554', adb, resizeImage: resize })

    await device.screenshot({ scale: 0.5 })

    expect(resize).toHaveBeenCalledWith(expect.any(Buffer), 1200)
  })

  it('rejects a scale outside (0, 1]', async () => {
    const { adb } = fakeAdb({ screencap: Buffer.from([1]), 'wm size': 'Physical size: 1080x2400\n' })
    const device = createAndroidDevice({ serial: 'emulator-5554', adb, resizeImage: noopResize })

    await expect(device.screenshot({ scale: 2 })).rejects.toMatchObject({
      toolError: { kind: 'command_failed' }
    })
  })
})

describe('AndroidDevice.readLogs', () => {
  const logs = Array.from({ length: 5 }, (_, i) => `09-22 11:06:2${i}.000  1 2 I Tag${i}: message ${i}`).join('\n')

  it('applies the default limit when none is given', async () => {
    const { adb } = fakeAdb({ logcat: logs })
    const device = createAndroidDevice({ serial: 'emulator-5554', adb, resizeImage: noopResize })

    const result = await device.readLogs()

    expect(result.lines.length).toBeLessThanOrEqual(DEFAULT_LOG_LIMIT)
    expect(result.truncated).toBe(false)
    expect(result.droppedCount).toBe(0)
  })

  it('keeps the newest lines and reports how many it dropped', async () => {
    const { adb } = fakeAdb({ logcat: logs })
    const device = createAndroidDevice({ serial: 'emulator-5554', adb, resizeImage: noopResize })

    const result = await device.readLogs({ limit: 2 })

    expect(result.lines.map((line) => line.tag)).toEqual(['Tag3', 'Tag4'])
    expect(result.truncated).toBe(true)
    expect(result.droppedCount).toBe(3)
  })

  it('clamps a limit above the hard maximum instead of honouring it', async () => {
    const { adb } = fakeAdb({ logcat: logs })
    const device = createAndroidDevice({ serial: 'emulator-5554', adb, resizeImage: noopResize })

    const result = await device.readLogs({ limit: MAX_LOG_LIMIT + 5000 })

    expect(result.lines.length).toBeLessThanOrEqual(MAX_LOG_LIMIT)
  })

  it('filters on tag and message, case-insensitively', async () => {
    const { adb } = fakeAdb({ logcat: logs })
    const device = createAndroidDevice({ serial: 'emulator-5554', adb, resizeImage: noopResize })

    const result = await device.readLogs({ filter: 'TAG2' })

    expect(result.lines.map((line) => line.tag)).toEqual(['Tag2'])
  })

  it('passes -v threadtime and -d so the parser format is fixed', async () => {
    const { adb, calls } = fakeAdb({ logcat: logs })
    const device = createAndroidDevice({ serial: 'emulator-5554', adb, resizeImage: noopResize })

    await device.readLogs()

    const logcatCall = calls.find((args) => args.includes('logcat'))
    expect(logcatCall).toContain('-d')
    expect(logcatCall).toContain('threadtime')
  })
})

describe('AndroidDevice.dumpUi', () => {
  it('returns summarised nodes, never the raw XML', async () => {
    const xml = `<?xml version="1.0"?><hierarchy rotation="0"><node index="0" text="로그인" resource-id="com.example:id/login" class="android.widget.Button" content-desc="" clickable="true" bounds="[80,860][1000,1000]" /></hierarchy>`
    const { adb } = fakeAdb({ 'window_dump.xml': xml, 'wm size': 'Physical size: 1080x2400\n' })
    const device = createAndroidDevice({ serial: 'emulator-5554', adb, resizeImage: noopResize })

    const nodes = await device.dumpUi()

    expect(nodes).toEqual([
      {
        index: 0,
        text: '로그인',
        contentDesc: null,
        resourceId: 'login',
        className: 'Button',
        x: 540,
        y: 930,
        clickable: true
      }
    ])
  })
})
```

- [ ] **Step 2: 테스트가 실패하는지 확인한다**

Run: `npx vitest run src/main/device/androidDevice.observe.test.ts`
Expected: FAIL — `Failed to resolve import "./androidDevice"`

- [ ] **Step 3: 이미지 축소 구현을 쓴다**

`src/main/device/resizeImage.ts`:

```ts
import { nativeImage } from 'electron'

export type ResizeImage = (
  png: Buffer,
  maxLongEdge: number
) => { png: Buffer; width: number; height: number }

/**
 * Electron의 nativeImage로 축소한다. 네이티브 이미지 라이브러리를 따로 들이지 않는다.
 * main 프로세스에서만 부를 수 있으므로 AndroidDevice는 이 함수를 주입받는다 —
 * 그래야 단위 테스트가 Electron 런타임 없이 돈다.
 */
export const electronResizeImage: ResizeImage = (png, maxLongEdge) => {
  const image = nativeImage.createFromBuffer(png)
  const size = image.getSize()
  const longEdge = Math.max(size.width, size.height)

  if (longEdge <= maxLongEdge) {
    return { png, width: size.width, height: size.height }
  }

  const ratio = maxLongEdge / longEdge
  const resized = image.resize({
    width: Math.round(size.width * ratio),
    height: Math.round(size.height * ratio),
    quality: 'good'
  })
  const resizedSize = resized.getSize()

  return { png: resized.toPNG(), width: resizedSize.width, height: resizedSize.height }
}
```

- [ ] **Step 4: AndroidDevice의 정보·관찰 부분을 구현한다**

`src/main/device/androidDevice.ts`:

```ts
import type { AdbClient } from '../adb/adbClient'
import { deviceError } from '../../shared/types/errors'
import type {
  Device,
  DeviceInfo,
  InstallOpts,
  KeyName,
  LogOpts,
  LogReadResult,
  ScreenshotOpts,
  ScreenshotResult,
  UiNode
} from '../../shared/types/device'
import { parseLogcat } from './parsers/logcat'
import { parseUiDump } from './parsers/uiDump'
import type { ResizeImage } from './resizeImage'

/** 스크린샷 기본 축소 기준. 원본이 필요한 쪽은 사람이고, 사람은 앱 화면으로 본다. */
export const DEFAULT_MAX_LONG_EDGE = 720
export const DEFAULT_LOG_LIMIT = 200
/** 인자로도 넘을 수 없는 상한. 툴 하나가 에이전트의 문맥을 통째로 먹는 것을 막는다. */
export const MAX_LOG_LIMIT = 2000

const SCREENSHOT_TIMEOUT_MS = 60_000
const DUMP_PATH = '/sdcard/window_dump.xml'

export interface AndroidDeviceDeps {
  serial: string
  adb: AdbClient
  resizeImage: ResizeImage
}

function parseWmSize(stdout: string): { width: number; height: number } {
  const override = /Override size:\s*(\d+)x(\d+)/.exec(stdout)
  const physical = /Physical size:\s*(\d+)x(\d+)/.exec(stdout)
  const match = override ?? physical

  if (!match) {
    throw deviceError('command_failed', 'wm size 출력에서 화면 크기를 읽지 못했다', '기기가 완전히 부팅됐는지 확인해라', {
      stdout
    })
  }

  return { width: Number(match[1]), height: Number(match[2]) }
}

export function createAndroidDevice(deps: AndroidDeviceDeps): Device {
  const { serial, adb, resizeImage } = deps

  async function shell(args: string[], timeoutMs?: number): Promise<string> {
    const result = await adb.exec(serial, ['shell', ...args], timeoutMs ? { timeoutMs } : undefined)
    return result.stdout
  }

  async function getprop(name: string): Promise<string> {
    return (await shell(['getprop', name])).trim()
  }

  async function screenSize(): Promise<{ width: number; height: number }> {
    return parseWmSize(await shell(['wm', 'size']))
  }

  async function info(): Promise<DeviceInfo> {
    const [model, sdk, size] = await Promise.all([
      getprop('ro.product.model'),
      getprop('ro.build.version.sdk'),
      screenSize()
    ])

    return { serial, model, apiLevel: Number(sdk), width: size.width, height: size.height }
  }

  async function screenshot(opts: ScreenshotOpts = {}): Promise<ScreenshotResult> {
    if (opts.scale !== undefined && (opts.scale <= 0 || opts.scale > 1)) {
      throw deviceError('command_failed', `scale은 0보다 크고 1 이하여야 한다: ${opts.scale}`, '0.1에서 1.0 사이 값을 써라')
    }

    const size = await screenSize()
    const longEdge = Math.max(size.width, size.height)
    const maxLongEdge =
      opts.scale === undefined ? DEFAULT_MAX_LONG_EDGE : Math.round(longEdge * opts.scale)

    const captured = await adb.exec(serial, ['exec-out', 'screencap', '-p'], {
      timeoutMs: SCREENSHOT_TIMEOUT_MS
    })

    const resized = resizeImage(captured.stdoutRaw, maxLongEdge)

    return { base64: resized.png.toString('base64'), width: resized.width, height: resized.height }
  }

  async function dumpUi(): Promise<UiNode[]> {
    const size = await screenSize()
    await shell(['uiautomator', 'dump', DUMP_PATH])
    const xml = (await adb.exec(serial, ['exec-out', 'cat', DUMP_PATH])).stdout

    return parseUiDump(xml, { screenWidth: size.width, screenHeight: size.height })
  }

  async function readLogs(opts: LogOpts = {}): Promise<LogReadResult> {
    const limit = Math.min(opts.limit ?? DEFAULT_LOG_LIMIT, MAX_LOG_LIMIT)

    const args = ['logcat', '-d', '-v', 'threadtime']
    if (opts.since) args.push('-T', opts.since)

    const stdout = (await adb.exec(serial, args)).stdout
    let lines = parseLogcat(stdout)

    if (opts.filter) {
      const needle = opts.filter.toLowerCase()
      lines = lines.filter(
        (line) =>
          line.tag.toLowerCase().includes(needle) || line.message.toLowerCase().includes(needle)
      )
    }

    if (lines.length <= limit) {
      return { lines, truncated: false, droppedCount: 0 }
    }

    // 최신 쪽이 쓸모 있다. 앞에서 자른다.
    return {
      lines: lines.slice(lines.length - limit),
      truncated: true,
      droppedCount: lines.length - limit
    }
  }

  async function clearLogs(): Promise<void> {
    await adb.exec(serial, ['logcat', '-c'])
  }

  return {
    serial,
    info,
    screenshot,
    dumpUi,
    readLogs,
    clearLogs,
    // 앱 조작은 Task 5, UI 조작은 Task 6에서 채운다.
    install: () => Promise.reject(new Error('install is implemented in a later task')),
    uninstall: () => Promise.reject(new Error('uninstall is implemented in a later task')),
    launch: () => Promise.reject(new Error('launch is implemented in a later task')),
    stop: () => Promise.reject(new Error('stop is implemented in a later task')),
    clearData: () => Promise.reject(new Error('clearData is implemented in a later task')),
    grantPermission: () => Promise.reject(new Error('grantPermission is implemented in a later task')),
    tap: () => Promise.reject(new Error('tap is implemented in a later task')),
    swipe: () => Promise.reject(new Error('swipe is implemented in a later task')),
    inputText: () => Promise.reject(new Error('inputText is implemented in a later task')),
    pressKey: () => Promise.reject(new Error('pressKey is implemented in a later task'))
  }
}
```

- [ ] **Step 5: 테스트가 통과하는지 확인한다**

Run: `npx vitest run src/main/device/androidDevice.observe.test.ts`
Expected: PASS (11 tests)

- [ ] **Step 6: 커밋**

```bash
git add src/main/device
git commit -m "$(cat <<'EOF'
feat(main): AndroidDevice의 정보 조회와 관찰 기능 추가

응답 크기 제어가 이 층의 핵심이다. 스크린샷은 기본으로 긴 변 720px까지
줄이고, 로그는 기본 200줄에 상한 2000줄을 둔다. 인자로도 상한을 넘을
수 없다. 잘렸으면 잘렸다는 사실과 버린 줄 수를 함께 돌려준다.

스크린샷은 exec-out으로 받는다. shell로 받으면 개행 변환에 PNG가 깨진다.
이미지 축소는 Electron nativeImage를 쓰되 함수로 주입받는다. 그래야
단위 테스트가 Electron 런타임 없이 돈다.

로그는 최신 쪽을 남기고 앞에서 자른다. 오래된 줄은 대개 쓸모가 적다.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 5: AndroidDevice — 앱 설치와 실행

**Files:**
- Modify: `src/main/device/androidDevice.ts`
- Test: `src/main/device/androidDevice.app.test.ts`

**Interfaces:**
- Consumes: Task 4의 `createAndroidDevice`, `AndroidDeviceDeps`
- Produces: 동작하는 `install`, `uninstall`, `launch`, `stop`, `clearData`, `grantPermission`.
  `AndroidDeviceDeps`에 `fileExists?: (path: string) => boolean`가 추가된다.

- [ ] **Step 1: 실패 테스트를 쓴다**

`src/main/device/androidDevice.app.test.ts`:

```ts
import { describe, expect, it, vi } from 'vitest'
import type { AdbClient, ExecResult } from '../adb/adbClient'
import { createAndroidDevice } from './androidDevice'

function fakeAdb(responses: Record<string, string> = {}): { adb: AdbClient; calls: string[][] } {
  const calls: string[][] = []
  const adb = {
    exec: vi.fn(async (_serial: string | null, args: string[]): Promise<ExecResult> => {
      calls.push(args)
      const key = Object.keys(responses).find((candidate) => args.join(' ').includes(candidate))
      const text = key ? (responses[key] as string) : ''
      return { stdout: text, stdoutRaw: Buffer.from(text), stderr: '', exitCode: 0 }
    }),
    stream: vi.fn()
  } as unknown as AdbClient
  return { adb, calls }
}

const noopResize = (png: Buffer) => ({ png, width: 1, height: 1 })

function makeDevice(adb: AdbClient, fileExists = () => true) {
  return createAndroidDevice({ serial: 'emulator-5554', adb, resizeImage: noopResize, fileExists })
}

describe('AndroidDevice.install', () => {
  it('rejects a path that does not exist', async () => {
    const { adb } = fakeAdb()
    const device = makeDevice(adb, () => false)

    await expect(device.install('/tmp/missing.apk')).rejects.toMatchObject({
      toolError: { kind: 'apk_path_invalid' }
    })
  })

  it('rejects a path that is not an apk', async () => {
    const { adb } = fakeAdb()
    const device = makeDevice(adb)

    await expect(device.install('/tmp/app.zip')).rejects.toMatchObject({
      toolError: { kind: 'apk_path_invalid' }
    })
  })

  it('passes -r when reinstall is requested', async () => {
    const { adb, calls } = fakeAdb({ 'pm list packages': 'package:com.example\n' })
    const device = makeDevice(adb)

    await device.install('/tmp/app.apk', { reinstall: true })

    const installCall = calls.find((args) => args[0] === 'install')
    expect(installCall).toContain('-r')
  })

  it('returns the package name of the freshly installed apk', async () => {
    const before = 'package:com.android.settings\n'
    const after = 'package:com.android.settings\npackage:com.example.app\n'
    let listCount = 0
    const adb = {
      exec: vi.fn(async (_serial: string | null, args: string[]): Promise<ExecResult> => {
        const text = args.join(' ').includes('pm list packages')
          ? (listCount++ === 0 ? before : after)
          : ''
        return { stdout: text, stdoutRaw: Buffer.from(text), stderr: '', exitCode: 0 }
      }),
      stream: vi.fn()
    } as unknown as AdbClient
    const device = makeDevice(adb)

    await expect(device.install('/tmp/app.apk')).resolves.toBe('com.example.app')
  })
})

describe('AndroidDevice app commands', () => {
  it('uses monkey to launch when no activity is given', async () => {
    const { adb, calls } = fakeAdb()
    const device = makeDevice(adb)

    await device.launch('com.example.app')

    expect(calls.some((args) => args.includes('monkey') && args.includes('com.example.app'))).toBe(true)
  })

  it('uses am start with an explicit component when an activity is given', async () => {
    const { adb, calls } = fakeAdb()
    const device = makeDevice(adb)

    await device.launch('com.example.app', '.MainActivity')

    const start = calls.find((args) => args.includes('am'))
    expect(start).toContain('com.example.app/.MainActivity')
  })

  it('force-stops with am force-stop', async () => {
    const { adb, calls } = fakeAdb()
    const device = makeDevice(adb)

    await device.stop('com.example.app')

    expect(calls.some((args) => args.includes('force-stop'))).toBe(true)
  })

  it('clears data with pm clear', async () => {
    const { adb, calls } = fakeAdb()
    const device = makeDevice(adb)

    await device.clearData('com.example.app')

    expect(calls.some((args) => args.includes('clear'))).toBe(true)
  })

  it('grants a permission with pm grant', async () => {
    const { adb, calls } = fakeAdb()
    const device = makeDevice(adb)

    await device.grantPermission('com.example.app', 'android.permission.CAMERA')

    const grant = calls.find((args) => args.includes('grant'))
    expect(grant).toContain('android.permission.CAMERA')
  })

  it('reports package_not_found when uninstalling something that is not installed', async () => {
    const { adb } = fakeAdb({ 'pm list packages': '' })
    const device = makeDevice(adb)

    await expect(device.uninstall('com.example.missing')).rejects.toMatchObject({
      toolError: { kind: 'package_not_found' }
    })
  })
})
```

- [ ] **Step 2: 테스트가 실패하는지 확인한다**

Run: `npx vitest run src/main/device/androidDevice.app.test.ts`
Expected: FAIL — `install is implemented in a later task`

- [ ] **Step 3: 구현한다**

`src/main/device/androidDevice.ts`의 `AndroidDeviceDeps`에 `fileExists`를 추가한다.

```ts
export interface AndroidDeviceDeps {
  serial: string
  adb: AdbClient
  resizeImage: ResizeImage
  /** APK 경로 검사용. 기본값은 node:fs의 existsSync. */
  fileExists?: (path: string) => boolean
}
```

파일 맨 위에 `import { existsSync } from 'node:fs'`를 추가하고, `createAndroidDevice` 안의
구조 분해를 아래로 바꾼다.

```ts
  const { serial, adb, resizeImage, fileExists = existsSync } = deps
```

그리고 Task 4에서 `Promise.reject`로 둔 앱 관련 메서드를 아래 구현으로 교체한다.

```ts
  async function listPackages(): Promise<string[]> {
    const stdout = await shell(['pm', 'list', 'packages'])
    return stdout
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line.startsWith('package:'))
      .map((line) => line.slice('package:'.length))
  }

  async function requirePackage(pkg: string): Promise<void> {
    const packages = await listPackages()
    if (packages.includes(pkg)) return

    throw deviceError('package_not_found', `기기에 ${pkg}가 설치돼 있지 않다`, 'app_install로 먼저 설치해라', {
      pkg
    })
  }

  async function install(apkPath: string, opts: InstallOpts = {}): Promise<string> {
    if (!apkPath.endsWith('.apk')) {
      throw deviceError('apk_path_invalid', `APK 파일이 아니다: ${apkPath}`, '.apk 파일 경로를 줘라', { apkPath })
    }
    if (!fileExists(apkPath)) {
      throw deviceError('apk_path_invalid', `파일이 없다: ${apkPath}`, '경로를 확인해라. 상대 경로면 절대 경로로 바꿔라', {
        apkPath
      })
    }

    const before = new Set(await listPackages())

    const args = ['install']
    if (opts.reinstall) args.push('-r')
    args.push(apkPath)
    await adb.exec(serial, args, { timeoutMs: 180_000 })

    const after = await listPackages()
    const added = after.filter((pkg) => !before.has(pkg))

    // 재설치면 목록이 그대로다. 그때는 이름을 알 방법이 없으므로 빈 문자열 대신 명시적으로 알린다.
    if (added.length === 1) return added[0] as string
    if (added.length === 0 && opts.reinstall) return ''

    throw deviceError('command_failed', '설치 후 패키지명을 특정하지 못했다', 'app_list 대신 패키지명을 직접 지정해 실행해라', {
      added
    })
  }

  async function uninstall(pkg: string): Promise<void> {
    await requirePackage(pkg)
    await adb.exec(serial, ['uninstall', pkg])
  }

  async function launch(pkg: string, activity?: string): Promise<void> {
    await requirePackage(pkg)

    if (activity) {
      const component = activity.startsWith('.') || activity.includes('/') ? `${pkg}/${activity}` : `${pkg}/${activity}`
      await shell(['am', 'start', '-n', component])
      return
    }

    // 런처 인텐트를 모를 때 monkey가 기본 액티비티를 대신 찾아 준다.
    await shell(['monkey', '-p', pkg, '-c', 'android.intent.category.LAUNCHER', '1'])
  }

  async function stop(pkg: string): Promise<void> {
    await shell(['am', 'force-stop', pkg])
  }

  async function clearData(pkg: string): Promise<void> {
    await requirePackage(pkg)
    await shell(['pm', 'clear', pkg])
  }

  async function grantPermission(pkg: string, permission: string): Promise<void> {
    await requirePackage(pkg)
    await shell(['pm', 'grant', pkg, permission])
  }
```

`return` 객체에서 해당 메서드들의 `Promise.reject` 줄을 지우고 위 함수들을 연결한다.

- [ ] **Step 4: 테스트가 통과하는지 확인한다**

Run: `npx vitest run src/main/device/androidDevice.app.test.ts`
Expected: PASS (11 tests)

- [ ] **Step 5: 커밋**

```bash
git add src/main/device
git commit -m "$(cat <<'EOF'
feat(main): AndroidDevice의 앱 설치·실행 기능 추가

설치 전후 패키지 목록을 비교해 방금 설치된 패키지명을 돌려준다.
에이전트가 APK만 주고도 바로 실행할 수 있어야 한다.

APK 경로는 존재와 확장자를 검사하고 읽기로만 쓴다. 경로 자체를
화이트리스트로 가두지는 않는다. 사용자가 자기 머신에서 자기 에이전트를
돌리는 전제이고, 가두면 실제로 방해가 된다.

액티비티를 모를 때는 monkey로 런처 인텐트를 찾게 한다. 설치 직후
진입점을 모르는 것이 흔한 상황이다.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 6: AndroidDevice — UI 조작

**Files:**
- Modify: `src/main/device/androidDevice.ts`
- Test: `src/main/device/androidDevice.ui.test.ts`

**Interfaces:**
- Consumes: Task 5까지의 `createAndroidDevice`
- Produces: 동작하는 `tap`, `swipe`, `inputText`, `pressKey`. `Device` 인터페이스가 전부 구현된다.

- [ ] **Step 1: 실패 테스트를 쓴다**

`src/main/device/androidDevice.ui.test.ts`:

```ts
import { describe, expect, it, vi } from 'vitest'
import type { AdbClient, ExecResult } from '../adb/adbClient'
import { createAndroidDevice } from './androidDevice'

function fakeAdb(): { adb: AdbClient; calls: string[][] } {
  const calls: string[][] = []
  const adb = {
    exec: vi.fn(async (_serial: string | null, args: string[]): Promise<ExecResult> => {
      calls.push(args)
      return { stdout: '', stdoutRaw: Buffer.alloc(0), stderr: '', exitCode: 0 }
    }),
    stream: vi.fn()
  } as unknown as AdbClient
  return { adb, calls }
}

function makeDevice(adb: AdbClient) {
  return createAndroidDevice({
    serial: 'emulator-5554',
    adb,
    resizeImage: (png) => ({ png, width: 1, height: 1 })
  })
}

describe('AndroidDevice.tap', () => {
  it('sends input tap with integer coordinates', async () => {
    const { adb, calls } = fakeAdb()

    await makeDevice(adb).tap(540, 930)

    expect(calls[0]).toEqual(['shell', 'input', 'tap', '540', '930'])
  })

  it('rounds fractional coordinates rather than passing them through', async () => {
    const { adb, calls } = fakeAdb()

    await makeDevice(adb).tap(540.6, 930.2)

    expect(calls[0]).toEqual(['shell', 'input', 'tap', '541', '930'])
  })
})

describe('AndroidDevice.swipe', () => {
  it('sends input swipe with duration last', async () => {
    const { adb, calls } = fakeAdb()

    await makeDevice(adb).swipe(100, 200, 100, 800, 300)

    expect(calls[0]).toEqual(['shell', 'input', 'swipe', '100', '200', '100', '800', '300'])
  })

  it('rejects a non-positive duration', async () => {
    const { adb } = fakeAdb()

    await expect(makeDevice(adb).swipe(1, 2, 3, 4, 0)).rejects.toMatchObject({
      toolError: { kind: 'command_failed' }
    })
  })
})

describe('AndroidDevice.inputText', () => {
  it('escapes spaces so the shell does not split the text', async () => {
    const { adb, calls } = fakeAdb()

    await makeDevice(adb).inputText('hello world')

    expect(calls[0]).toEqual(['shell', 'input', 'text', 'hello%sworld'])
  })

  it('escapes shell metacharacters that would otherwise be interpreted', async () => {
    const { adb, calls } = fakeAdb()

    await makeDevice(adb).inputText('a&b$c')

    expect(calls[0]?.[3]).toBe('a\\&b\\$c')
  })

  it('rejects text it cannot send safely instead of sending something wrong', async () => {
    const { adb } = fakeAdb()

    await expect(makeDevice(adb).inputText('안녕')).rejects.toMatchObject({
      toolError: { kind: 'command_failed' }
    })
  })
})

describe('AndroidDevice.pressKey', () => {
  it('maps names to Android keycodes', async () => {
    const { adb, calls } = fakeAdb()
    const device = makeDevice(adb)

    await device.pressKey('back')
    await device.pressKey('home')
    await device.pressKey('enter')
    await device.pressKey('tab')

    expect(calls.map((args) => args[3])).toEqual([
      'KEYCODE_BACK',
      'KEYCODE_HOME',
      'KEYCODE_ENTER',
      'KEYCODE_TAB'
    ])
  })
})
```

- [ ] **Step 2: 테스트가 실패하는지 확인한다**

Run: `npx vitest run src/main/device/androidDevice.ui.test.ts`
Expected: FAIL — `tap is implemented in a later task`

- [ ] **Step 3: 구현한다**

`src/main/device/androidDevice.ts`의 UI 관련 `Promise.reject` 메서드를 아래로 교체한다.

```ts
const KEYCODES: Record<KeyName, string> = {
  back: 'KEYCODE_BACK',
  home: 'KEYCODE_HOME',
  enter: 'KEYCODE_ENTER',
  tab: 'KEYCODE_TAB'
}

/**
 * `input text`는 ASCII만 안전하게 보낼 수 있다. 공백은 %s로, 셸 메타문자는
 * 백슬래시로 이스케이프한다. ASCII 밖의 문자는 조용히 깨뜨리는 대신 거부한다.
 */
function escapeInputText(text: string): string {
  if (!/^[\x20-\x7e]*$/.test(text)) {
    throw deviceError('command_failed', 'adb input text로는 ASCII 문자만 보낼 수 있다', '해당 문자는 클립보드 붙여넣기 등 다른 방법이 필요하다. M1 범위 밖이다', {
      text
    })
  }

  return text.replace(/(["$&'()*;<>?\[\\\]`|])/g, '\\$1').replace(/ /g, '%s')
}
```

`createAndroidDevice` 안에 아래 함수들을 넣고 `return` 객체에 연결한다.

```ts
  async function tap(x: number, y: number): Promise<void> {
    await shell(['input', 'tap', String(Math.round(x)), String(Math.round(y))])
  }

  async function swipe(
    x1: number,
    y1: number,
    x2: number,
    y2: number,
    durationMs: number
  ): Promise<void> {
    if (durationMs <= 0) {
      throw deviceError('command_failed', `durationMs는 0보다 커야 한다: ${durationMs}`, '100에서 1000 사이 값을 써라')
    }

    await shell([
      'input',
      'swipe',
      String(Math.round(x1)),
      String(Math.round(y1)),
      String(Math.round(x2)),
      String(Math.round(y2)),
      String(Math.round(durationMs))
    ])
  }

  async function inputText(text: string): Promise<void> {
    await shell(['input', 'text', escapeInputText(text)])
  }

  async function pressKey(key: KeyName): Promise<void> {
    await shell(['input', 'keyevent', KEYCODES[key]])
  }
```

- [ ] **Step 4: 테스트가 통과하는지 확인한다**

Run: `npx vitest run src/main/device && npm run typecheck`
Expected: PASS (parsers 23 + observe 11 + app 11 + ui 8 = 53 tests), 타입체크 통과

- [ ] **Step 5: 커밋**

```bash
git add src/main/device
git commit -m "$(cat <<'EOF'
feat(main): AndroidDevice의 UI 조작 기능 추가

좌표는 정수로 반올림해 보낸다. ui_find가 돌려준 중심 좌표가 소수일 수
있고 input tap은 정수만 받는다.

input text는 ASCII만 안전하게 보낼 수 있다. 공백은 %s로, 셸 메타문자는
백슬래시로 이스케이프한다. ASCII 밖의 문자는 조용히 깨뜨리는 대신
거부하고 무엇이 문제인지 알린다.

이것으로 Device 인터페이스가 전부 구현된다.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 7: AvdController

**Files:**
- Create: `src/main/device/avdController.ts`
- Test: `src/main/device/avdController.test.ts`

**Interfaces:**
- Consumes: `AdbClient`, `SpawnFn` (M1-1 Task 4), `parseDevices` (Task 1), `AvdEntry` (M1-1 Task 2)
- Produces: `createAvdController(deps: AvdControllerDeps): AvdController`, `AvdControllerDeps`,
  `AvdController`. M1-3의 `device_boot`·`device_shutdown`·`device_list` 툴이 쓴다.

> AVD 부팅·종료는 기기가 없는 상태에서 하는 일이라 `Device` 인터페이스에 들어가지 않는다.

- [ ] **Step 1: 실패 테스트를 쓴다**

`src/main/device/avdController.test.ts`:

```ts
import { EventEmitter } from 'node:events'
import { Readable } from 'node:stream'
import { describe, expect, it, vi } from 'vitest'
import type { AdbClient, ExecResult, SpawnFn } from '../adb/adbClient'
import { createAvdController } from './avdController'

function result(stdout: string): ExecResult {
  return { stdout, stdoutRaw: Buffer.from(stdout), stderr: '', exitCode: 0 }
}

function fakeSpawn(): { spawn: SpawnFn; started: string[][] } {
  const started: string[][] = []
  const spawn: SpawnFn = (_command, args) => {
    started.push(args)
    const child = new EventEmitter() as ReturnType<SpawnFn>
    child.stdout = new Readable({ read() {} })
    child.stderr = new Readable({ read() {} })
    child.unref = vi.fn() as never
    child.kill = vi.fn() as never
    return child
  }
  return { spawn, started }
}

describe('AvdController.list', () => {
  it('marks an AVD as running when its name matches a live emulator', async () => {
    const adb = {
      exec: vi.fn(async (serial: string | null, args: string[]) => {
        if (args.includes('devices')) return result('List of devices attached\nemulator-5554  device\n')
        if (serial === 'emulator-5554' && args.includes('avd')) return result('Pixel_7_API_34\nOK\n')
        return result('')
      }),
      stream: vi.fn()
    } as unknown as AdbClient
    const { spawn } = fakeSpawn()

    const controller = createAvdController({
      adb,
      emulatorPath: '/opt/sdk/emulator/emulator',
      spawn,
      listAvdNames: async () => ['Pixel_7_API_34', 'Pixel_Tablet']
    })

    await expect(controller.list()).resolves.toEqual([
      { name: 'Pixel_7_API_34', running: true, serial: 'emulator-5554' },
      { name: 'Pixel_Tablet', running: false, serial: null }
    ])
  })

  it('reports every AVD as stopped when nothing is attached', async () => {
    const adb = {
      exec: vi.fn(async () => result('List of devices attached\n')),
      stream: vi.fn()
    } as unknown as AdbClient
    const { spawn } = fakeSpawn()

    const controller = createAvdController({
      adb,
      emulatorPath: '/opt/sdk/emulator/emulator',
      spawn,
      listAvdNames: async () => ['Pixel_7_API_34']
    })

    await expect(controller.list()).resolves.toEqual([
      { name: 'Pixel_7_API_34', running: false, serial: null }
    ])
  })
})

describe('AvdController.boot', () => {
  it('rejects an AVD name that does not exist', async () => {
    const adb = { exec: vi.fn(async () => result('')), stream: vi.fn() } as unknown as AdbClient
    const { spawn } = fakeSpawn()

    const controller = createAvdController({
      adb,
      emulatorPath: '/opt/sdk/emulator/emulator',
      spawn,
      listAvdNames: async () => ['Pixel_7_API_34']
    })

    await expect(controller.boot('Nope')).rejects.toMatchObject({
      toolError: { kind: 'command_failed' }
    })
  })

  it('spawns the emulator with -avd and waits until boot completes', async () => {
    let bootChecks = 0
    const adb = {
      exec: vi.fn(async (serial: string | null, args: string[]) => {
        const joined = args.join(' ')
        if (joined.includes('devices')) return result('List of devices attached\nemulator-5554  device\n')
        if (joined.includes('sys.boot_completed')) {
          bootChecks += 1
          return result(bootChecks >= 2 ? '1\n' : '\n')
        }
        if (serial === 'emulator-5554' && joined.includes('avd')) return result('Pixel_7_API_34\nOK\n')
        return result('')
      }),
      stream: vi.fn()
    } as unknown as AdbClient
    const { spawn, started } = fakeSpawn()

    const controller = createAvdController({
      adb,
      emulatorPath: '/opt/sdk/emulator/emulator',
      spawn,
      listAvdNames: async () => ['Pixel_7_API_34'],
      sleep: async () => {}
    })

    await expect(controller.boot('Pixel_7_API_34')).resolves.toBe('emulator-5554')
    expect(started[0]).toEqual(['-avd', 'Pixel_7_API_34'])
    expect(bootChecks).toBeGreaterThanOrEqual(2)
  })

  it('gives up with device_unresponsive when boot never completes', async () => {
    const adb = {
      exec: vi.fn(async (_serial: string | null, args: string[]) => {
        const joined = args.join(' ')
        if (joined.includes('devices')) return result('List of devices attached\nemulator-5554  device\n')
        if (joined.includes('avd')) return result('Pixel_7_API_34\nOK\n')
        return result('\n')
      }),
      stream: vi.fn()
    } as unknown as AdbClient
    const { spawn } = fakeSpawn()

    let now = 0
    const controller = createAvdController({
      adb,
      emulatorPath: '/opt/sdk/emulator/emulator',
      spawn,
      listAvdNames: async () => ['Pixel_7_API_34'],
      sleep: async () => {
        now += 5_000
      },
      now: () => now
    })

    await expect(controller.boot('Pixel_7_API_34', 20_000)).rejects.toMatchObject({
      toolError: { kind: 'device_unresponsive' }
    })
  })
})

describe('AvdController.shutdown', () => {
  it('sends emu kill to the given serial', async () => {
    const calls: Array<{ serial: string | null; args: string[] }> = []
    const adb = {
      exec: vi.fn(async (serial: string | null, args: string[]) => {
        calls.push({ serial, args })
        return result('')
      }),
      stream: vi.fn()
    } as unknown as AdbClient
    const { spawn } = fakeSpawn()

    const controller = createAvdController({
      adb,
      emulatorPath: '/opt/sdk/emulator/emulator',
      spawn,
      listAvdNames: async () => []
    })

    await controller.shutdown('emulator-5554')

    expect(calls[0]).toEqual({ serial: 'emulator-5554', args: ['emu', 'kill'] })
  })
})
```

- [ ] **Step 2: 테스트가 실패하는지 확인한다**

Run: `npx vitest run src/main/device/avdController.test.ts`
Expected: FAIL — `Failed to resolve import "./avdController"`

- [ ] **Step 3: 구현한다**

`src/main/device/avdController.ts`:

```ts
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import type { AdbClient, SpawnFn } from '../adb/adbClient'
import { deviceError } from '../../shared/types/errors'
import type { AvdEntry } from '../../shared/types/device'
import { parseDevices } from './parsers/devices'

const execFileAsync = promisify(execFile)

const DEFAULT_BOOT_TIMEOUT_MS = 180_000
const POLL_INTERVAL_MS = 2_000

export interface AvdControllerDeps {
  adb: AdbClient
  emulatorPath: string
  spawn: SpawnFn
  /** 기본값은 `emulator -list-avds` 실행. 테스트에서 주입한다. */
  listAvdNames?: () => Promise<string[]>
  sleep?: (ms: number) => Promise<void>
  now?: () => number
}

export interface AvdController {
  list(): Promise<AvdEntry[]>
  /** 부팅 완료까지 기다리고 새로 뜬 기기의 serial을 돌려준다. */
  boot(name: string, timeoutMs?: number): Promise<string>
  shutdown(serial: string): Promise<void>
}

export function createAvdController(deps: AvdControllerDeps): AvdController {
  const {
    adb,
    emulatorPath,
    spawn,
    sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms)),
    now = () => Date.now()
  } = deps

  const listAvdNames =
    deps.listAvdNames ??
    (async () => {
      const { stdout } = await execFileAsync(emulatorPath, ['-list-avds'])
      return stdout
        .split('\n')
        .map((line) => line.trim())
        .filter((line) => line.length > 0)
    })

  /** 실행 중인 기기의 serial과 그 기기가 띄운 AVD 이름을 잇는다. */
  async function runningAvdBySerial(): Promise<Map<string, string>> {
    const devices = parseDevices((await adb.exec(null, ['devices'])).stdout)
    const mapping = new Map<string, string>()

    for (const entry of devices) {
      if (entry.state !== 'device') continue
      try {
        const stdout = (await adb.exec(entry.serial, ['emu', 'avd', 'name'])).stdout
        const name = stdout.split('\n')[0]?.trim()
        if (name) mapping.set(entry.serial, name)
      } catch {
        // 에뮬레이터가 아닌 기기이거나 콘솔이 아직 안 뜬 경우다. 목록에서 빠질 뿐이다.
      }
    }

    return mapping
  }

  async function list(): Promise<AvdEntry[]> {
    const [names, running] = await Promise.all([listAvdNames(), runningAvdBySerial()])

    return names.map((name) => {
      const found = [...running.entries()].find(([, avdName]) => avdName === name)
      return { name, running: found !== undefined, serial: found?.[0] ?? null }
    })
  }

  async function boot(name: string, timeoutMs = DEFAULT_BOOT_TIMEOUT_MS): Promise<string> {
    const names = await listAvdNames()
    if (!names.includes(name)) {
      throw deviceError('command_failed', `그런 AVD가 없다: ${name}`, 'device_list로 사용할 수 있는 AVD 이름을 확인해라', {
        available: names
      })
    }

    const child = spawn(emulatorPath, ['-avd', name])
    child.unref?.()

    const deadline = now() + timeoutMs

    while (now() < deadline) {
      await sleep(POLL_INTERVAL_MS)

      const running = await runningAvdBySerial()
      const found = [...running.entries()].find(([, avdName]) => avdName === name)
      if (!found) continue

      const serial = found[0]
      const booted = (await adb.exec(serial, ['shell', 'getprop', 'sys.boot_completed'])).stdout.trim()
      if (booted === '1') return serial
    }

    throw deviceError('device_unresponsive', `${name}이 ${timeoutMs}ms 안에 부팅되지 않았다`, '에뮬레이터 창을 직접 확인하고, 필요하면 device_shutdown 후 다시 시도해라', {
      avd: name,
      timeoutMs
    })
  }

  async function shutdown(serial: string): Promise<void> {
    await adb.exec(serial, ['emu', 'kill'])
  }

  return { list, boot, shutdown }
}
```

- [ ] **Step 4: 테스트가 통과하는지 확인한다**

Run: `npx vitest run src/main/device/avdController.test.ts`
Expected: PASS (6 tests)

- [ ] **Step 5: 커밋**

```bash
git add src/main/device
git commit -m "$(cat <<'EOF'
feat(main): AVD 목록·부팅·종료를 다루는 AvdController 추가

AVD 부팅과 종료는 기기가 없는 상태에서 하는 일이라 Device 인터페이스에
넣지 않는다. Device는 이미 붙어 있는 기기 하나를 다룬다.

부팅 완료 판정은 serial이 나타나는 것만으로 부족하다. sys.boot_completed가
1이 될 때까지 기다린다. 그 전에 명령을 보내면 조용히 실패한다.

AVD 이름과 serial은 `adb -s <serial> emu avd name`으로 잇는다. 이름만으로는
어느 기기가 그 AVD인지 알 수 없다.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 8: DeviceRegistry

**Files:**
- Create: `src/main/device/registry.ts`
- Test: `src/main/device/registry.test.ts`

**Interfaces:**
- Consumes: `trackDevices` (M1-1 Task 5), `createAndroidDevice` (Task 4·5·6), `Device`, `deviceError`
- Produces: `createDeviceRegistry(deps: DeviceRegistryDeps): DeviceRegistry`, `DeviceRegistry`,
  `DeviceRegistryDeps`, `RegistryEvent`. M1-3의 모든 툴과 M1-4의 `ipcBridge`가 쓴다.

> **M1-1에서 넘어온 항목 셋.** M1-1의 최종 리뷰가 `trackDevices`의 파서를 통째로 다시 쓰게 만들었고,
> 그 수정이 Minor 둘을 남겼다. 이 task가 `trackDevices`를 소비하는 자리이므로 여기서 함께 정리한다.
> 셋 다 한 줄짜리이고 기존 테스트를 깨지 않는다.
>
> 1. `adbClient.ts`의 `deliverError`에 `closeNotified` 가드를 더한다. 지금은 stdout이 `error`를 내면
>    소비자가 `error → close → error` 순으로 받아, 같은 파일에 적힌 "에러 뒤에는 반드시 `onClose`가
>    뒤따른다"는 계약을 어긴다.
> 2. `adbClient.ts`의 `failFromStream`이 `child.kill('SIGKILL')`을 부르게 한다. 지금은 reject만 하고
>    타이머까지 지워서 adb 자식 프로세스를 아무도 회수하지 않는다. main 프로세스가 오래 도는 앱이라
>    좀비가 쌓인다.
> 3. `trackDevices`는 이제 `(client, onChange, onFailure?)`다. `DeviceRegistryDeps.track`도 실패를
>    받을 수 있게 넓히고, registry가 그 실패로 무엇을 할지 정한다 — 최소한 이벤트로 올려서
>    M1-4의 UI가 "기기 추적이 끊겼다"를 표시할 수 있어야 한다. 조용히 삼키면 기기가 안 보이는
>    증상만 남고 원인이 사라진다.

- [ ] **Step 1: 실패 테스트를 쓴다**

`src/main/device/registry.test.ts`:

```ts
import { describe, expect, it, vi } from 'vitest'
import type { Device } from '../../shared/types/device'
import { createDeviceRegistry, type RegistryEvent } from './registry'

function makeRegistry() {
  let notify: ((serial: string, connected: boolean) => void) | undefined
  let stopped = false

  const registry = createDeviceRegistry({
    track: (onChange) => {
      notify = onChange
      return () => {
        stopped = true
      }
    },
    createDevice: (serial) => ({ serial } as Device)
  })

  return {
    registry,
    connect: (serial: string) => notify?.(serial, true),
    disconnect: (serial: string) => notify?.(serial, false),
    stopped: () => stopped
  }
}

describe('DeviceRegistry membership', () => {
  it('lists a device once it connects', () => {
    const harness = makeRegistry()
    harness.registry.start()

    harness.connect('emulator-5554')

    expect(harness.registry.serials()).toEqual(['emulator-5554'])
  })

  it('drops a device when it disconnects', () => {
    const harness = makeRegistry()
    harness.registry.start()

    harness.connect('emulator-5554')
    harness.disconnect('emulator-5554')

    expect(harness.registry.serials()).toEqual([])
  })

  it('closes the underlying tracker when stopped', () => {
    const harness = makeRegistry()
    harness.registry.start()

    harness.registry.stop()

    expect(harness.stopped()).toBe(true)
  })
})

describe('DeviceRegistry active device', () => {
  it('makes the first device active automatically', () => {
    const harness = makeRegistry()
    harness.registry.start()

    harness.connect('emulator-5554')

    expect(harness.registry.getActive()).toBe('emulator-5554')
  })

  it('does not steal the active slot when a second device appears', () => {
    const harness = makeRegistry()
    harness.registry.start()

    harness.connect('emulator-5554')
    harness.connect('emulator-5556')

    expect(harness.registry.getActive()).toBe('emulator-5554')
  })

  it('falls back to the only remaining device when the active one disappears', () => {
    const harness = makeRegistry()
    harness.registry.start()

    harness.connect('emulator-5554')
    harness.connect('emulator-5556')
    harness.disconnect('emulator-5554')

    expect(harness.registry.getActive()).toBe('emulator-5556')
  })

  it('clears the active slot when the last device disappears', () => {
    const harness = makeRegistry()
    harness.registry.start()

    harness.connect('emulator-5554')
    harness.disconnect('emulator-5554')

    expect(harness.registry.getActive()).toBeNull()
  })

  it('rejects setActive for a serial it does not know', () => {
    const harness = makeRegistry()
    harness.registry.start()

    expect(() => harness.registry.setActive('emulator-9999')).toThrowError(
      expect.objectContaining({ toolError: expect.objectContaining({ kind: 'no_device' }) })
    )
  })
})

describe('DeviceRegistry.resolve', () => {
  it('returns the named device when a serial is given', () => {
    const harness = makeRegistry()
    harness.registry.start()
    harness.connect('emulator-5554')

    expect(harness.registry.resolve('emulator-5554').serial).toBe('emulator-5554')
  })

  it('returns the active device when no serial is given', () => {
    const harness = makeRegistry()
    harness.registry.start()
    harness.connect('emulator-5554')

    expect(harness.registry.resolve().serial).toBe('emulator-5554')
  })

  it('throws no_device when nothing is attached', () => {
    const harness = makeRegistry()
    harness.registry.start()

    expect(() => harness.registry.resolve()).toThrowError(
      expect.objectContaining({ toolError: expect.objectContaining({ kind: 'no_device' }) })
    )
  })

  it('throws ambiguous_device with the candidate list when the active slot is empty', () => {
    const harness = makeRegistry()
    harness.registry.start()
    harness.connect('emulator-5554')
    harness.connect('emulator-5556')
    harness.disconnect('emulator-5554')
    harness.connect('emulator-5558')
    harness.registry.clearActive()

    const error = (() => {
      try {
        harness.registry.resolve()
        return null
      } catch (thrown) {
        return thrown as { toolError: { kind: string; details?: Record<string, unknown> } }
      }
    })()

    expect(error?.toolError.kind).toBe('ambiguous_device')
    expect(error?.toolError.details?.candidates).toEqual(['emulator-5556', 'emulator-5558'])
  })
})

describe('DeviceRegistry.run', () => {
  it('runs commands for one device strictly in order', async () => {
    const harness = makeRegistry()
    harness.registry.start()
    harness.connect('emulator-5554')

    const order: string[] = []
    const slow = harness.registry.run('emulator-5554', async () => {
      await new Promise((resolve) => setTimeout(resolve, 20))
      order.push('slow')
    })
    const fast = harness.registry.run('emulator-5554', async () => {
      order.push('fast')
    })

    await Promise.all([slow, fast])

    expect(order).toEqual(['slow', 'fast'])
  })

  it('keeps the queue alive after a command throws', async () => {
    const harness = makeRegistry()
    harness.registry.start()
    harness.connect('emulator-5554')

    await expect(
      harness.registry.run('emulator-5554', async () => {
        throw new Error('boom')
      })
    ).rejects.toThrow('boom')

    await expect(harness.registry.run('emulator-5554', async () => 'ok')).resolves.toBe('ok')
  })

  it('lets different devices run at the same time', async () => {
    const harness = makeRegistry()
    harness.registry.start()
    harness.connect('emulator-5554')
    harness.connect('emulator-5556')

    const order: string[] = []
    const slow = harness.registry.run('emulator-5554', async () => {
      await new Promise((resolve) => setTimeout(resolve, 20))
      order.push('slow')
    })
    const fast = harness.registry.run('emulator-5556', async () => {
      order.push('fast')
    })

    await Promise.all([slow, fast])

    expect(order).toEqual(['fast', 'slow'])
  })
})

describe('DeviceRegistry events', () => {
  it('emits connect, disconnect and active changes to listeners', () => {
    const harness = makeRegistry()
    const events: RegistryEvent[] = []
    harness.registry.on((event) => events.push(event))
    harness.registry.start()

    harness.connect('emulator-5554')
    harness.disconnect('emulator-5554')

    expect(events).toEqual([
      { type: 'device_connected', serial: 'emulator-5554' },
      { type: 'active_changed', serial: 'emulator-5554' },
      { type: 'device_disconnected', serial: 'emulator-5554' },
      { type: 'active_changed', serial: null }
    ])
  })

  it('stops delivering events after the listener unsubscribes', () => {
    const harness = makeRegistry()
    const events: RegistryEvent[] = []
    const off = harness.registry.on((event) => events.push(event))
    harness.registry.start()

    off()
    harness.connect('emulator-5554')

    expect(events).toEqual([])
  })
})
```

- [ ] **Step 2: 테스트가 실패하는지 확인한다**

Run: `npx vitest run src/main/device/registry.test.ts`
Expected: FAIL — `Failed to resolve import "./registry"`

- [ ] **Step 3: 구현한다**

`src/main/device/registry.ts`:

```ts
import type { Device } from '../../shared/types/device'
import { deviceError } from '../../shared/types/errors'

export type RegistryEvent =
  | { type: 'device_connected'; serial: string }
  | { type: 'device_disconnected'; serial: string }
  | { type: 'active_changed'; serial: string | null }

export interface DeviceRegistryDeps {
  /** 연결·해제를 알려 주는 구독. 반환값은 구독 해제 함수다. */
  track: (onChange: (serial: string, connected: boolean) => void) => () => void
  createDevice: (serial: string) => Device
}

export interface DeviceRegistry {
  start(): void
  stop(): void
  serials(): string[]
  resolve(serial?: string): Device
  setActive(serial: string): void
  clearActive(): void
  getActive(): string | null
  /** 같은 기기의 명령을 직렬화한다. 다른 기기끼리는 병렬로 돈다. */
  run<T>(serial: string, task: () => Promise<T>): Promise<T>
  on(listener: (event: RegistryEvent) => void): () => void
}

export function createDeviceRegistry(deps: DeviceRegistryDeps): DeviceRegistry {
  const devices = new Map<string, Device>()
  const queues = new Map<string, Promise<unknown>>()
  const listeners = new Set<(event: RegistryEvent) => void>()

  let active: string | null = null
  let stopTracking: (() => void) | null = null

  function emit(event: RegistryEvent): void {
    for (const listener of listeners) listener(event)
  }

  function setActiveInternal(serial: string | null): void {
    if (active === serial) return
    active = serial
    emit({ type: 'active_changed', serial })
  }

  function onChange(serial: string, connected: boolean): void {
    if (connected) {
      if (devices.has(serial)) return
      devices.set(serial, deps.createDevice(serial))
      emit({ type: 'device_connected', serial })
      if (active === null) setActiveInternal(serial)
      return
    }

    if (!devices.delete(serial)) return
    queues.delete(serial)
    emit({ type: 'device_disconnected', serial })

    if (active !== serial) return
    // 활성 기기가 사라졌다. 남은 것이 하나뿐이면 그것을 활성으로 올린다.
    const remaining = [...devices.keys()]
    setActiveInternal(remaining.length === 1 ? (remaining[0] as string) : null)
  }

  return {
    start() {
      if (stopTracking) return
      stopTracking = deps.track(onChange)
    },

    stop() {
      stopTracking?.()
      stopTracking = null
    },

    serials() {
      return [...devices.keys()]
    },

    resolve(serial) {
      if (serial) {
        const device = devices.get(serial)
        if (device) return device

        throw deviceError('no_device', `그런 기기가 없다: ${serial}`, 'device_list로 현재 연결된 기기를 확인해라', {
          candidates: [...devices.keys()]
        })
      }

      if (active) {
        const device = devices.get(active)
        if (device) return device
      }

      if (devices.size === 0) {
        throw deviceError('no_device', '연결된 기기가 없다', 'device_list로 AVD를 확인하고 device_boot로 부팅해라')
      }

      throw deviceError('ambiguous_device', '기기가 여럿이라 대상을 정할 수 없다', 'serial을 지정하거나 device_select로 활성 기기를 정해라', {
        candidates: [...devices.keys()]
      })
    },

    setActive(serial) {
      if (!devices.has(serial)) {
        throw deviceError('no_device', `그런 기기가 없다: ${serial}`, 'device_list로 현재 연결된 기기를 확인해라', {
          candidates: [...devices.keys()]
        })
      }
      setActiveInternal(serial)
    },

    clearActive() {
      setActiveInternal(null)
    },

    getActive() {
      return active
    },

    run<T>(serial: string, task: () => Promise<T>): Promise<T> {
      const previous = queues.get(serial) ?? Promise.resolve()
      // 앞선 작업이 실패해도 큐는 계속 돌아야 한다.
      const next = previous.then(task, task)
      queues.set(
        serial,
        next.catch(() => undefined)
      )
      return next
    },

    on(listener) {
      listeners.add(listener)
      return () => listeners.delete(listener)
    }
  }
}
```

- [ ] **Step 4: 테스트가 통과하는지 확인한다**

Run: `npx vitest run src/main/device/registry.test.ts`
Expected: PASS (15 tests)

- [ ] **Step 5: 전체 테스트와 타입체크를 돌린다**

Run: `npm test && npm run typecheck`
Expected: 둘 다 PASS

- [ ] **Step 6: 커밋**

```bash
git add src/main/device
git commit -m "$(cat <<'EOF'
feat(main): 기기 목록·활성 기기·명령 큐를 쥐는 DeviceRegistry 추가

기기당 명령을 큐 하나로 직렬화한다. 세션은 여럿 허용하되 같은 기기를
동시에 만지면 결과가 엉킨다. 다른 기기끼리는 병렬로 돈다. 앞선 명령이
실패해도 큐는 계속 돌아간다.

활성 기기 규칙: 처음 붙은 기기가 자동으로 활성이 되고, 뒤에 붙는 기기가
그 자리를 뺏지 않는다. 활성 기기가 사라지면 남은 것이 하나일 때만
승계하고, 여럿이면 비운다. 비어 있을 때 serial 없이 부르면 후보 목록을
담은 ambiguous_device를 던진다.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## 이 계획이 끝났을 때

- `adb devices -l`, uiautomator XML, logcat 출력이 실제 샘플 기반 테스트로 덮여 있다.
- `Device` 인터페이스가 `AndroidDevice`로 전부 구현돼 있다.
- 스크린샷 축소와 로그 상한이 `AndroidDevice` 안에서 강제된다.
- AVD를 부팅하고 `sys.boot_completed`까지 기다렸다가 serial을 돌려받을 수 있다.
- `DeviceRegistry`가 활성 기기와 기기당 명령 직렬화를 책임진다.
- 아직 MCP도 UI도 없다. 다음 계획에서 붙인다.

다음은 [M1-3 — MCP 툴과 HTTP 서버](2026-09-22-m1-3-mcp-server.md)다.
