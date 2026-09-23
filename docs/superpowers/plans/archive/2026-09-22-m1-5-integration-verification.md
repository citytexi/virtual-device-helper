---
id: m1-5-integration-verification
title: M1-5 — 통합과 완료 검증
status: done
type: work-order
created: 2026-09-22
updated: 2026-09-23
owner: virtual-device-helper 팀
scope: [main, mcp, android, renderer, docs]
hosts: [macos]
archived_reason: M1 구현 완료. 완료 조건 검증 결과는 스펙의 검증 결과에 옮겼다.
related_adr: [ADR-0001, ADR-0002, ADR-0003, ADR-0004]
related_spec: m1-device-core-mcp-server
related_architecture:
related_plan: [m1-4-electron-shell-ui]
related_code:
tags: [plan, m1, verification]
---

# M1-5 — 통합과 완료 검증 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: `superpowers:subagent-driven-development`(권장) 또는
> `superpowers:executing-plans`로 task 단위 구현. 각 단계는 체크박스(`- [ ]`)로 추적한다.

**Goal:** 지금까지 가짜 `adbClient` 위에서만 돈 코드를 실제 에뮬레이터와 실제 외부 에이전트로
검증하고, 스펙의 완료 조건이 실제로 성립하는지 확인한다. 열린 질문에 답을 채우고 문서를 현실과
맞춘다.

**Architecture:** 새 기능을 만들지 않는다. 실기기 통합 테스트를 추가하고, 완료 조건 시나리오를
손으로 돌리고, 관찰한 것을 문서에 반영한다. 여기서 드러난 결함은 해당 계획으로 되돌아가 고친다.

**Tech Stack:** Vitest, Android 에뮬레이터, Claude Code

**Spec:** [`../specs/2026-09-22-m1-device-core-mcp-server.md`](../../specs/archive/2026-09-22-m1-device-core-mcp-server.md)

**계획 순서:** [M1-1](2026-09-22-m1-1-foundation-and-adb.md) →
[M1-2](2026-09-22-m1-2-android-device.md) → [M1-3](2026-09-22-m1-3-mcp-server.md) →
[M1-4](2026-09-22-m1-4-electron-shell-ui.md) → M1-5(이 문서)

## Global Constraints

이 프로젝트의 규약이다. 루트 `CLAUDE.md`는 서브에이전트에게 자동 전달되지 않으므로 여기 싣는다.
아래는 **모든 task의 요구사항에 암묵적으로 포함된다.**

- **답변 언어는 한국어.** 기술 용어·API 이름·명령어·에러 문자열은 원문 그대로 둔다.
- **코드·주석·커밋 메시지는 일반 산문으로 쓴다.** 축약하거나 caveman 문체로 쓰지 않는다.
- **커밋 메시지는 Conventional Commits.** 본문 마지막 줄에 다음을 붙인다:
  `Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>`
- **관찰한 것만 적는다.** 검증 결과에 추측을 쓰지 않는다. 안 해 본 것은 안 해 봤다고 적는다.
- **통합 테스트는 기본 실행에서 빠진다.** `npm test`가 에뮬레이터를 요구하면 안 된다.
- **문서에 라인번호·파일 개수·진행률을 적지 않는다.** 파일명과 심볼명으로 가리킨다.
- **문서를 고쳤으면** `python3 docs/script/docs.py lint`와 `links`를 돌린다.
- **결함을 찾으면 여기서 고치지 않는다.** 해당 계획으로 되돌아가 TDD로 고치고 돌아온다.

## 사전 준비

이 계획은 실제 환경을 요구한다. 시작 전에 아래가 준비돼야 한다.

- Android Studio와 SDK, 그리고 부팅 가능한 AVD 하나.
- 테스트용 APK 하나. **다른 프로젝트의 debug APK가 가장 현실적이다** — 이 앱의 존재 이유가
  그것이다. 없으면 Task 2의 대체 경로를 쓴다.
- Claude Code 같은 HTTP MCP 서버를 지원하는 클라이언트.

---

### Task 1: 실기기 통합 테스트와 픽스처 갱신

**Files:**
- Create: `src/main/adb/adbClient.integration.test.ts`
- Modify: `src/main/device/parsers/__fixtures__/devices-l.txt`
- Modify: `src/main/device/parsers/__fixtures__/window-dump.xml`
- Modify: `src/main/device/parsers/__fixtures__/logcat-threadtime.txt`
- Modify: `package.json`

**Interfaces:**
- Consumes: `createAdbClient` (M1-1), `locateSdk` (M1-1), 파서들 (M1-2)
- Produces: `npm run test:integration` 스크립트. 기본 `npm test`는 이 테스트를 건너뛴다.

- [ ] **Step 1: 통합 테스트를 기본 실행에서 분리한다**

`vitest.config.ts`의 `include`에서 통합 테스트를 빼고 `package.json`에 별도 스크립트를 둔다.

```ts
import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts', 'src/**/*.test.tsx'],
    exclude: ['**/node_modules/**', 'src/**/*.integration.test.ts']
  }
})
```

`package.json`의 `scripts`에 추가한다.

```json
{
  "test:integration": "vitest run --config vitest.integration.config.ts"
}
```

`vitest.integration.config.ts`:

```ts
import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.integration.test.ts'],
    // 실제 에뮬레이터를 쓰므로 단위 테스트보다 넉넉히 기다린다.
    testTimeout: 120_000,
    hookTimeout: 120_000
  }
})
```

- [ ] **Step 2: 실기기 통합 테스트를 쓴다**

`src/main/adb/adbClient.integration.test.ts`:

```ts
import { beforeAll, describe, expect, it } from 'vitest'
import { defaultLocateSdkDeps, locateSdk } from '../sdk/locateSdk'
import { parseDevices } from '../device/parsers/devices'
import { parseLogcat } from '../device/parsers/logcat'
import { parseUiDump } from '../device/parsers/uiDump'
import { createAdbClient, type AdbClient } from './adbClient'

let adb: AdbClient
let serial: string

beforeAll(async () => {
  const located = locateSdk(defaultLocateSdkDeps())
  if (!located.ok) {
    throw new Error(
      `Android SDK를 찾지 못했다. 찾아본 경로: ${located.searched.join(', ')}`
    )
  }

  adb = createAdbClient(located.paths.adb)

  const devices = parseDevices((await adb.exec(null, ['devices', '-l'])).stdout).filter(
    (entry) => entry.state === 'device'
  )

  if (devices.length === 0) {
    throw new Error('에뮬레이터를 하나 띄운 뒤 다시 실행해라')
  }

  serial = devices[0]?.serial as string
})

describe('adbClient against a real emulator', () => {
  it('runs a shell command and returns its output', async () => {
    const result = await adb.exec(serial, ['shell', 'echo', 'hello'])

    expect(result.stdout.trim()).toBe('hello')
    expect(result.exitCode).toBe(0)
  })

  it('reports no_device for a serial that does not exist', async () => {
    await expect(adb.exec('emulator-9999', ['shell', 'echo', 'hi'])).rejects.toMatchObject({
      toolError: { kind: 'no_device' }
    })
  })

  it('captures PNG bytes through exec-out without mangling them', async () => {
    const result = await adb.exec(serial, ['exec-out', 'screencap', '-p'], { timeoutMs: 60_000 })

    // PNG 시그니처.
    expect(result.stdoutRaw.subarray(0, 4)).toEqual(Buffer.from([0x89, 0x50, 0x4e, 0x47]))
  })

  it('streams lines from a long-running command', async () => {
    const lines: string[] = []
    const stream = adb.stream(serial, ['logcat', '-v', 'threadtime'])
    stream.onLine((line) => lines.push(line))

    await new Promise((resolve) => setTimeout(resolve, 3_000))
    stream.close()

    expect(lines.length).toBeGreaterThan(0)
  })
})

describe('parsers against real output', () => {
  it('parses the real device list', async () => {
    const entries = parseDevices((await adb.exec(null, ['devices', '-l'])).stdout)

    expect(entries.some((entry) => entry.serial === serial)).toBe(true)
  })

  it('parses a real uiautomator dump into tappable nodes', async () => {
    await adb.exec(serial, ['shell', 'uiautomator', 'dump', '/sdcard/window_dump.xml'])
    const xml = (await adb.exec(serial, ['exec-out', 'cat', '/sdcard/window_dump.xml'])).stdout
    const size = /(\d+)x(\d+)/.exec((await adb.exec(serial, ['shell', 'wm', 'size'])).stdout)

    const nodes = parseUiDump(xml, {
      screenWidth: Number(size?.[1] ?? 1080),
      screenHeight: Number(size?.[2] ?? 2400)
    })

    expect(nodes.length).toBeGreaterThan(0)
    // 요약이 원본보다 확실히 작아야 한다. 이게 ui_find의 존재 이유다.
    expect(JSON.stringify(nodes).length).toBeLessThan(xml.length)
  })

  it('parses real logcat output', async () => {
    const stdout = (await adb.exec(serial, ['logcat', '-d', '-v', 'threadtime', '-t', '200'])).stdout
    const lines = parseLogcat(stdout)

    expect(lines.length).toBeGreaterThan(0)
    expect(lines.every((line) => line.tag.length > 0)).toBe(true)
  })
})
```

- [ ] **Step 3: 에뮬레이터를 띄우고 통합 테스트를 돌린다**

```bash
# 에뮬레이터를 하나 띄운다. 이름은 emulator -list-avds로 확인한다.
adb devices -l
npm run test:integration
```

Expected: 전부 PASS.

**실패하면 여기서 고치지 않는다.** 어느 파서가 깨졌는지 기록하고 M1-1 또는 M1-2로 돌아가
실패 테스트를 먼저 쓴 뒤 고친다. 특히 `parseUiDump`의 압축 검증이 실패하면 스펙의 열린 질문
("버릴 노드의 기준")으로 돌아간다.

- [ ] **Step 4: 실제 출력으로 픽스처를 갱신한다**

M1-1·M1-2에서 에뮬레이터 없이 손으로 쓴 픽스처가 있으면 지금 실제 출력으로 바꾼다.

```bash
adb devices -l > src/main/device/parsers/__fixtures__/devices-l.txt
adb shell uiautomator dump /sdcard/window_dump.xml
adb exec-out cat /sdcard/window_dump.xml > src/main/device/parsers/__fixtures__/window-dump.xml
adb logcat -d -v threadtime -t 200 > src/main/device/parsers/__fixtures__/logcat-threadtime.txt
npm test
```

Expected: 단위 테스트가 실제 픽스처로도 통과한다. 깨지면 파서가 현실과 안 맞는 것이므로
M1-2로 돌아가 고친다.

- [ ] **Step 5: 기본 테스트가 에뮬레이터 없이도 도는지 확인한다**

에뮬레이터를 끄고 돌린다.

```bash
adb emu kill 2>/dev/null || true
npm test
```

Expected: PASS. 기본 실행이 에뮬레이터를 요구하면 CI에서 못 쓴다.

- [ ] **Step 6: 커밋**

```bash
git add src vitest.config.ts vitest.integration.config.ts package.json
git commit -m "$(cat <<'EOF'
test: 실기기 통합 테스트와 실제 출력 픽스처 추가

지금까지 가짜 adbClient 위에서만 돌던 코드를 실제 에뮬레이터로 확인한다.
파서는 특히 현실과 어긋나기 쉬워 실제 출력으로 픽스처를 갱신한다.

통합 테스트는 기본 실행에서 뺀다. npm test가 에뮬레이터를 요구하면
CI에서 못 쓴다. npm run test:integration으로 따로 돌린다.

uiautomator 요약이 원본 XML보다 작은지를 통합 테스트로 확인한다. 이게
성립하지 않으면 ui_find의 존재 이유가 사라진다.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 2: 완료 조건 — 에이전트 경로

**Files:**
- Create: `docs/superpowers/plans/m1-acceptance-log.md` (검증 기록, 임시 파일)
- Modify: 결함이 나오면 해당 계획의 파일

**Interfaces:**
- Consumes: 완성된 앱 전체
- Produces: 스펙의 주된 완료 조건에 대한 관찰 기록. Task 4가 이걸 스펙으로 옮긴다.

> 이 task는 코드를 쓰지 않는다. **관찰한 것만 적는다.** 되는 것처럼 보이는 것과 실제로 되는 것을
> 구분한다.

- [ ] **Step 1: 앱을 띄우고 클라이언트를 붙인다**

```bash
npm run dev
```

앱의 엔드포인트 카드에서 "설정 JSON 복사"를 누르고, Claude Code의 MCP 설정에 붙인 뒤 연결한다.
연결된 클라이언트에서 툴 목록을 확인한다.

Expected: 툴 20개가 보인다. 스펙의 표와 이름이 일치한다.
보이지 않으면 토큰·URL·`Origin` 중 무엇이 막았는지 앱의 터미널 출력으로 확인한다.

- [ ] **Step 2: 테스트용 APK를 준비한다**

**기본 경로:** 다른 프로젝트의 debug APK 경로를 쓴다. 보통
`app/build/outputs/apk/debug/app-debug.apk`다.

**대체 경로:** 쓸 APK가 없으면 에뮬레이터에 이미 깔린 사용자 앱을 꺼내 쓴다.

```bash
# 사용자 앱(-3)만 나열한다.
adb shell pm list packages -3
# 하나를 골라 경로를 얻는다.
adb shell pm path <패키지명>
adb pull <위 경로> /tmp/sample.apk
```

사용자 앱이 하나도 없으면 APK 설치 단계는 건너뛰고, 이미 설치된 앱으로
`app_reset_and_launch`부터 검증한다. **건너뛴 사실을 기록한다.**

- [ ] **Step 3: 완료 조건 시나리오를 한 번에 지시한다**

클라이언트에 아래를 그대로 준다. 중간에 사람이 끼어들지 않는다.

> 이 APK를 설치하고 켜서, 첫 화면에서 텍스트 입력 칸 하나에 `test@example.com`을 넣고,
> 화면을 찍어서 보여주고, 에러 로그가 있으면 알려줘.
> APK 경로: `<위에서 준비한 절대 경로>`

관찰하고 기록한다.

- [ ] **Step 4: 관찰을 기록한다**

`docs/superpowers/plans/m1-acceptance-log.md`에 적는다. 이 파일은 Task 4에서 스펙으로 옮긴 뒤
지운다.

```markdown
# M1 완료 조건 검증 기록

검증 날짜: 2026-MM-DD
에뮬레이터: <AVD 이름>, API <레벨>
클라이언트: <이름과 버전>

## 에이전트 경로

지시문: <그대로>

| 툴 | 불렸나 | 성공했나 | 관찰 |
|---|---|---|---|
| app_install | | | |
| app_launch | | | |
| ui_find | | | |
| ui_tap | | | |
| ui_text | | | |
| screenshot | | | |
| log_read | | | |

- 사람이 끼어들지 않고 끝까지 갔나: 예 / 아니오
- 끝까지 못 갔다면 어디서 멈췄나:
- 에이전트가 잘못 고른 툴이 있었나:
- 응답이 너무 커서 문제가 된 툴이 있었나:
- 앱의 활동 탭에 호출이 순서대로 쌓였나: 예 / 아니오
```

- [ ] **Step 5: 막힌 지점이 있으면 원인을 분류한다**

막혔다면 셋 중 무엇인지 가른다. 분류에 따라 돌아갈 곳이 다르다.

1. **툴 설명이 부족해 에이전트가 잘못 골랐다** → M1-3의 해당 툴 설명을 고친다.
2. **응답이 너무 커서 에이전트가 무너졌다** → M1-2·M1-3의 상한을 좁힌다.
3. **툴 자체가 실패했다** → 해당 계획으로 돌아가 실패 테스트를 먼저 쓰고 고친다.

고친 뒤 Step 3부터 다시 돌린다. **고치지 않고 "대체로 된다"로 넘어가지 않는다.**

- [ ] **Step 6: 사람 경로를 확인한다**

앱 화면에서 직접 확인하고 기록에 덧붙인다.

- AVD 목록이 보이나.
- 하나를 골라 부팅하면 완료 시점에 상태가 running으로 바뀌나.
- 스크린샷이 뜨고 새로고침하면 갱신되나.
- 기기를 바꾸면 화면도 바뀌나.
- 엔드포인트 카드의 설정 JSON이 실제로 붙여 쓸 수 있는 형태인가.

- [ ] **Step 7: 커밋**

```bash
git add docs/superpowers/plans/m1-acceptance-log.md
git commit -m "$(cat <<'EOF'
docs: M1 완료 조건 에이전트 경로 검증 기록

외부 에이전트를 실제로 붙여 스펙의 주된 완료 조건을 확인한다.
관찰한 것만 적는다. 안 해 본 것은 안 해 봤다고 적는다.

이 기록은 Task 4에서 스펙으로 옮긴 뒤 지운다.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 3: 완료 조건 — 실패 경로와 보안

**Files:**
- Modify: `docs/superpowers/plans/m1-acceptance-log.md`
- Modify: 결함이 나오면 해당 계획의 파일

**Interfaces:**
- Consumes: 완성된 앱과 붙어 있는 클라이언트
- Produces: 실패 경로와 보안 기본값에 대한 관찰 기록.

> 실패 경로는 정상 경로보다 자주 쓰인다. 에이전트는 계속 틀리고, 그때마다 에러를 읽고 복구한다.
> 에러가 쓸모없으면 툴 전체가 쓸모없다.

- [ ] **Step 1: 기기 없는 상태의 에러를 확인한다**

에뮬레이터를 모두 끈 상태에서 클라이언트에 `screenshot`을 부르게 한다.

Expected: `kind: "no_device"`, 그리고 `hint`가 다음에 무엇을 하라고 말한다.
에이전트가 그 힌트를 읽고 실제로 `device_list` → `device_boot`로 복구하는지 본다.

- [ ] **Step 2: 기기가 여럿일 때의 모호 에러를 확인한다**

에뮬레이터 두 대를 띄우고, 앱에서 활성 기기를 해제할 방법이 없으므로 대신
클라이언트에서 존재하지 않는 serial을 지정해 본다.

```
device_info 를 serial "emulator-9999" 로 불러줘
```

Expected: `kind: "no_device"`, `details.candidates`에 실제 serial 목록이 들어 있다.
에이전트가 그 목록에서 하나를 골라 다시 부르는지 본다.

- [ ] **Step 3: 없는 패키지와 잘못된 APK 경로를 확인한다**

```
app_launch 를 pkg "com.example.does.not.exist" 로 불러줘
app_install 을 apkPath "/tmp/nope.apk" 로 불러줘
```

Expected: 각각 `package_not_found`, `apk_path_invalid`. 힌트가 다음 행동을 말한다.

- [ ] **Step 4: 응답 상한이 실제로 걸리는지 확인한다**

```
log_read 를 limit 999999 로 불러줘
```

Expected: 상한(2000줄)을 넘지 않는다. 잘렸으면 `truncated: true`와 `droppedCount`가 함께 온다.
응답 크기가 에이전트의 문맥을 삼키지 않는다.

긴 목록 화면(설정 앱 등)을 띄우고 `ui_find`를 부른다.

Expected: `nodes`가 상한(60개)을 넘지 않고, `truncated: true`가 온다. 응답에 XML이 섞이지 않는다.

- [ ] **Step 5: 보안 기본값 세 가지를 직접 찔러 본다**

```bash
PORT=$(curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:9321/mcp >/dev/null 2>&1; echo 9321)

# 토큰 없음 → 401
curl -s -o /dev/null -w 'no-token: %{http_code}\n' -X POST "http://127.0.0.1:${PORT}/mcp"

# 틀린 토큰 → 401
curl -s -o /dev/null -w 'bad-token: %{http_code}\n' -X POST \
  -H 'Authorization: Bearer wrong' "http://127.0.0.1:${PORT}/mcp"

# Origin 헤더 → 403 (올바른 토큰이어도 거부돼야 한다)
curl -s -o /dev/null -w 'origin: %{http_code}\n' -X POST \
  -H "Authorization: Bearer <앱에서 복사한 토큰>" \
  -H 'Origin: https://evil.example' "http://127.0.0.1:${PORT}/mcp"

# 루프백이 아닌 주소로는 아예 안 열려야 한다.
LAN_IP=$(ipconfig getifaddr en0 2>/dev/null || echo '')
if [ -n "$LAN_IP" ]; then
  curl -s -m 3 -o /dev/null -w "lan: %{http_code}\n" -X POST "http://${LAN_IP}:${PORT}/mcp" || echo 'lan: 연결 실패 (정상)'
fi
```

Expected: `401`, `401`, `403`, 그리고 LAN 주소는 연결 실패.
**하나라도 다르면 M1-3 Task 7로 돌아간다. 이건 타협하지 않는다.**

- [ ] **Step 6: 관찰을 기록에 덧붙인다**

`docs/superpowers/plans/m1-acceptance-log.md`에 이어 적는다.

```markdown
## 실패 경로

| 상황 | 기대 kind | 실제 kind | 힌트가 다음 행동을 말했나 | 에이전트가 복구했나 |
|---|---|---|---|---|
| 기기 없음 | no_device | | | |
| 없는 serial | no_device | | | |
| 없는 패키지 | package_not_found | | | |
| 잘못된 APK 경로 | apk_path_invalid | | | |

## 응답 상한

| 툴 | 요청 | 실제 반환량 | truncated |
|---|---|---|---|
| log_read | limit 999999 | | |
| ui_find | 긴 목록 화면 | | |

## 보안

| 검사 | 기대 | 실제 |
|---|---|---|
| 토큰 없음 | 401 | |
| 틀린 토큰 | 401 | |
| Origin 헤더 | 403 | |
| LAN 주소 접속 | 연결 실패 | |
```

- [ ] **Step 7: 커밋**

```bash
git add docs/superpowers/plans/m1-acceptance-log.md
git commit -m "$(cat <<'EOF'
docs: M1 실패 경로와 보안 기본값 검증 기록

실패 경로는 정상 경로보다 자주 쓰인다. 에이전트는 계속 틀리고 그때마다
에러를 읽고 복구한다. 에러가 쓸모없으면 툴 전체가 쓸모없다.

에러의 kind만 보지 않고, 에이전트가 hint를 읽고 실제로 복구했는지까지
관찰한다.

보안 기본값 네 가지를 직접 찔러 확인한다. 루프백 바인드, 토큰 없음,
틀린 토큰, Origin 헤더. 하나라도 어긋나면 넘어가지 않는다.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 4: 문서를 현실과 맞추고 M1을 닫는다

**Files:**
- Modify: `docs/superpowers/specs/2026-09-22-m1-device-core-mcp-server.md`
- Modify: `docs/adr/0002-screen-streaming-via-scrcpy-server.md` (스파이크 결과에 따라)
- Modify: `docs/superpowers/plans/*.md` (status, updated)
- Delete: `docs/superpowers/plans/m1-acceptance-log.md`
- Create: `README.md` 갱신
- 가능성: `docs/architecture/` 새 문서

**Interfaces:**
- Consumes: Task 1~3의 관찰 기록
- Produces: 현실과 맞는 문서. M2 착수에 필요한 전제가 기록된 상태.

- [ ] **Step 1: 스펙의 열린 질문 세 개에 답을 채운다**

스펙의 "열린 질문" 절을 지우고, 각 답을 본문의 해당 자리로 올린다. 답은 **Task 1~3에서 실제로
관찰한 것**이어야 한다. 아직 모르면 모른다고 적고 질문을 남긴다.

- `app_reset_and_launch`의 "첫 화면 안정" 판정 기준 — 실제로 쓴 기준과 그것으로 충분했는지.
- `ui_find` 요약에서 버릴 노드의 기준 — 실제 덤프에서 압축률과 놓친 요소가 있었는지.
- `device_boot`의 부팅 완료 판정 — `sys.boot_completed` 하나로 충분했는지.

- [ ] **Step 2: 완료 조건 검증 결과를 스펙에 옮긴다**

스펙의 "완료 조건" 절 끝에 아래를 덧붙이고, `m1-acceptance-log.md`를 지운다.

```markdown
### 검증 결과 (2026-MM-DD)

- 에이전트 경로: 성공 / 부분 성공 / 실패 — <한 문단>
- 사람 경로: 성공 / 부분 성공 / 실패 — <한 문단>
- 실패 경로: <어떤 에러가 실제로 복구로 이어졌는지>
- 보안 기본값 네 가지: 전부 확인 / 일부 미확인 — <어느 것>
- 남은 결함: <있으면 나열, 없으면 "없다">
```

```bash
git rm docs/superpowers/plans/m1-acceptance-log.md
```

- [ ] **Step 3: 스파이크 결과에 따라 ADR-0002를 정리한다**

M1-1 Task 6의 스파이크가 성공이면 ADR-0002는 `accepted` 그대로 두고, 스펙에 적힌 결과를
`related_spec`으로 이미 잇고 있으므로 손댈 것이 없다.

실패했으면 아래를 한다.

- `ADR-0002`의 `status`를 `superseded`로, `superseded_by`를 새 ADR 번호로 바꾼다.
- 후퇴안 ADR을 새로 만든다.

```bash
python3 docs/script/docs.py new adr <후퇴안-slug> --title "<제목>"
```

- 새 ADR의 `supersedes`에 `ADR-0002`를 적고, 기각 사유에 스파이크에서 관찰한 것을 적는다.
- `docs/adr/README.md`의 인덱스에서 두 줄의 상태와 비고를 맞춘다.

- [ ] **Step 4: architecture 문서 승격이 필요한지 판단한다**

CLAUDE.md의 규칙은 **같은 구조 설명이 스펙 두 곳 이상에서 반복되기 시작하면** 승격이다.
지금은 M1 스펙 하나뿐이므로 원칙적으로 아직 이르다.

다만 **main의 여섯 층 구조**는 M2·M3·M4 스펙이 전부 기대게 된다. M2 스펙을 쓸 때 같은 설명을
다시 쓰게 되면 그때 승격한다. 지금은 승격하지 않고, 스펙의 "구조" 절을 그대로 둔다.

**이 판단을 커밋 메시지에 남긴다.** 나중에 "왜 아직 architecture 문서가 없나"라는 질문이 나온다.

- [ ] **Step 5: 계획 문서들의 상태를 갱신한다**

M1-1부터 M1-5까지 각 계획의 frontmatter를 손본다.

- `status: done`
- `updated: 2026-MM-DD`
- `archived_reason`에 한 줄 — 예: "M1 구현 완료. 완료 조건 검증까지 통과."

그리고 `archive/`로 옮긴 뒤 `docs/superpowers/plans/README.md`의 아카이브 표에 한 줄씩 남긴다.

```bash
git mv docs/superpowers/plans/2026-09-22-m1-1-foundation-and-adb.md docs/superpowers/plans/archive/
# 나머지 넷도 같은 방식으로 옮긴다.
```

스펙도 마찬가지로 `status: implemented`로 바꾸고 `archive/`로 옮긴다. **단, M2 계획을 쓸 때
참조해야 하므로 링크가 깨지지 않는지 확인한다.**

- [ ] **Step 6: README를 사람이 쓸 수 있게 채운다**

`README.md`를 아래 골자로 쓴다. 지금 README는 제목 한 줄뿐이다.

```markdown
# virtual-device-helper

Android·iOS 가상 기기를 MCP로 제어하고, 화면·로그·이벤트를 한 화면에서 보는 Electron 데스크탑 앱.

현재 상태: M1 완료 — macOS 호스트, Android 에뮬레이터, MCP 서버와 최소 UI.

## 필요한 것

- macOS
- Android Studio와 Android SDK, 부팅 가능한 AVD 하나
- Node.js

이 앱은 Android SDK를 번들하지 않는다. 이유는
[ADR-0003](docs/adr/0003-no-bundled-android-sdk.md)에 있다.

## 실행

```bash
npm install
npm run dev
```

## 에이전트 붙이기

앱의 엔드포인트 카드에서 "설정 JSON 복사"를 누르고 MCP 클라이언트 설정에 붙인다.
서버는 `127.0.0.1`에만 열리고 토큰을 요구한다. 앱을 닫으면 서버도 닫힌다.

## 개발

```bash
npm test              # 단위 테스트 (에뮬레이터 불필요)
npm run test:integration   # 실기기 테스트 (에뮬레이터 필요)
npm run typecheck
npm run build
```

## 문서

`docs/`에 있다. 찾을 때는 grep보다 `python3 docs/script/docs.py find "<주제>"`를 먼저 쓴다.
```

- [ ] **Step 7: 문서 검사를 돌린다**

Run: `python3 docs/script/docs.py lint && python3 docs/script/docs.py links`
Expected: 문제 0건, 깨진 링크 0건

Run: `npm test && npm run typecheck && npm run build`
Expected: 전부 PASS

- [ ] **Step 8: 커밋**

```bash
git add -A
git commit -m "$(cat <<'EOF'
docs: M1 완료 — 스펙·계획 아카이브와 검증 결과 반영

열린 질문 세 개에 실제 관찰로 답을 채우고 본문으로 올린다. 추측으로
채우지 않는다. 아직 모르는 것은 질문으로 남긴다.

architecture 문서는 아직 만들지 않는다. main의 여섯 층 구조는 M2·M3·M4가
전부 기대게 되지만, 승격 기준은 "같은 설명이 스펙 두 곳 이상에서 반복되기
시작하면" 이다. M2 스펙에서 같은 설명을 다시 쓰게 되면 그때 승격한다.

README를 사람이 쓸 수 있게 채운다. 지금까지 제목 한 줄뿐이었다.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## 이 계획이 끝났을 때

- 실기기 통합 테스트가 있고, 기본 `npm test`는 에뮬레이터 없이 돈다.
- 스펙의 완료 조건이 실제 에이전트와 실제 기기로 검증됐고, 결과가 스펙에 기록돼 있다.
- 보안 기본값 네 가지가 직접 찔러 확인됐다.
- 열린 질문 세 개에 관찰 기반의 답이 있다.
- 스파이크 결과에 따라 ADR-0002의 운명이 정해져 있다.
- M1 스펙과 계획 다섯 개가 아카이브됐고, README가 사람이 쓸 수 있는 상태다.

다음은 M2다. 스펙부터 다시 쓴다 — `superpowers:brainstorming`으로 시작한다.
