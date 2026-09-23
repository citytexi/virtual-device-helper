import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { parseUiDump } from './uiDump'

// 합성 샘플. 픽스처의 실제 기기 덤프는 수치를 미리 알 수 없어 정밀 좌표 검증에
// 쓸 수 없다. 좌표·필터링 규칙 같은 결정적인 값은 이 샘플로 고정해서 검증한다.
const sample = `<?xml version='1.0' encoding='UTF-8' standalone='yes' ?>
<hierarchy rotation="0">
  <node index="0" text="" resource-id="" class="android.widget.FrameLayout" package="com.example" content-desc="" clickable="false" bounds="[0,0][1080,2400]">
    <node index="0" text="이메일" resource-id="com.example:id/email" class="android.widget.EditText" package="com.example" content-desc="" clickable="true" bounds="[80,600][1000,760]" />
    <node index="1" text="로그인" resource-id="com.example:id/login" class="android.widget.Button" package="com.example" content-desc="로그인 버튼" clickable="true" bounds="[80,860][1000,1000]" />
    <node index="2" text="숨은 요소" resource-id="" class="android.widget.TextView" package="com.example" content-desc="" clickable="false" bounds="[0,0][0,0]" />
    <node index="3" text="화면 밖" resource-id="" class="android.widget.TextView" package="com.example" content-desc="" clickable="true" bounds="[80,2600][1000,2700]" />
  </node>
</hierarchy>`

// 가로 화면 덤프. wm size는 회전과 무관하게 자연 방향 크기를 말하므로 그 값으로
// 화면 밖 판정을 하면 가로에서는 거의 모든 노드가 버려진다. 실제 화면 사각형은
// 덤프의 루트 노드 bounds다.
const landscapeSample = `<?xml version='1.0' encoding='UTF-8' standalone='yes' ?>
<hierarchy rotation="1">
  <node index="0" text="" resource-id="" class="android.widget.FrameLayout" package="com.example" content-desc="" clickable="false" bounds="[0,0][2340,1080]">
    <node index="0" text="왼쪽" resource-id="com.example:id/left" class="android.widget.Button" package="com.example" content-desc="" clickable="true" bounds="[40,400][600,600]" />
    <node index="1" text="오른쪽" resource-id="com.example:id/right" class="android.widget.Button" package="com.example" content-desc="" clickable="true" bounds="[1800,400][2300,600]" />
    <node index="2" text="화면 밖" resource-id="" class="android.widget.TextView" package="com.example" content-desc="" clickable="true" bounds="[2400,400][2600,600]" />
  </node>
</hierarchy>`

// 실제 기기(RFCXC00V8AZ, SM-A356N, 화면 1080x2340)에서 뜬 원본 덤프.
// 좌표는 알 수 없으므로 파싱이 실제 XML 구조에서 안 깨지는지만 확인한다.
const realFixture = readFileSync(join(__dirname, '__fixtures__', 'window-dump.xml'), 'utf8')
const realScreen = { width: 1080, height: 2340 }

// 실제 에뮬레이터(emulator-5554, Pixel_7_API_36, 화면 1080x2400)의 홈 화면 덤프.
const emulatorFixture = readFileSync(
  join(__dirname, '__fixtures__', 'window-dump-emulator.xml'),
  'utf8'
)

describe('parseUiDump', () => {
  it('returns the center point of each node so it can be tapped directly', () => {
    const nodes = parseUiDump(sample)
    const login = nodes.find((node) => node.resourceId === 'login')

    expect(login).toBeDefined()
    expect(login?.x).toBe(540)
    expect(login?.y).toBe(930)
  })

  it('keeps only the tail of resource-id', () => {
    const nodes = parseUiDump(sample)

    expect(nodes.map((node) => node.resourceId)).toContain('email')
    expect(nodes.every((node) => !node.resourceId?.includes(':id/'))).toBe(true)
  })

  it('keeps only the short class name', () => {
    const nodes = parseUiDump(sample)

    expect(nodes.map((node) => node.className)).toContain('Button')
    expect(nodes.every((node) => !node.className.includes('.'))).toBe(true)
  })

  it('drops zero-area nodes', () => {
    const nodes = parseUiDump(sample)

    expect(nodes.some((node) => node.text === '숨은 요소')).toBe(false)
  })

  it('drops nodes whose center lies outside the screen', () => {
    const nodes = parseUiDump(sample)

    expect(nodes.some((node) => node.text === '화면 밖')).toBe(false)
  })

  it('drops containers that carry no identity and cannot be clicked', () => {
    const nodes = parseUiDump(sample)

    expect(nodes.some((node) => node.className === 'FrameLayout')).toBe(false)
  })

  it('turns empty attributes into null instead of empty strings', () => {
    const nodes = parseUiDump(sample)
    const email = nodes.find((node) => node.resourceId === 'email')

    expect(email?.contentDesc).toBeNull()
  })

  it('filters by query across text, contentDesc and resourceId, case-insensitively', () => {
    const byText = parseUiDump(sample, { query: '로그인' })
    expect(byText.map((node) => node.resourceId)).toEqual(['login'])

    const byId = parseUiDump(sample, { query: 'EMAIL' })
    expect(byId.map((node) => node.resourceId)).toEqual(['email'])
  })

  it('numbers the surviving nodes from zero in document order', () => {
    const nodes = parseUiDump(sample)

    expect(nodes.map((node) => node.index)).toEqual(nodes.map((_, position) => position))
  })

  it('returns an empty array for a dump with no usable nodes', () => {
    const empty = '<?xml version="1.0"?><hierarchy rotation="0"></hierarchy>'

    expect(parseUiDump(empty)).toEqual([])
  })

  it('parses the recorded real-device fixture without throwing and returns tappable nodes', () => {
    const nodes = parseUiDump(realFixture)

    expect(nodes.length).toBeGreaterThan(0)
    for (const node of nodes) {
      expect(node.x).toBeGreaterThanOrEqual(0)
      expect(node.x).toBeLessThanOrEqual(realScreen.width)
      expect(node.y).toBeGreaterThanOrEqual(0)
      expect(node.y).toBeLessThanOrEqual(realScreen.height)
    }
  })

  it('keeps landscape nodes whose coordinates run past the natural-orientation width', () => {
    const nodes = parseUiDump(landscapeSample)

    expect(nodes.map((node) => node.resourceId)).toEqual(['left', 'right'])
  })

  it('still drops nodes outside the display rectangle in landscape', () => {
    const nodes = parseUiDump(landscapeSample)

    expect(nodes.some((node) => node.text === '화면 밖')).toBe(false)
  })

  it('parses the real emulator fixture into a non-empty, compressed summary with no leaked XML', () => {
    const nodes = parseUiDump(emulatorFixture)

    expect(nodes.length).toBeGreaterThan(0)
    // 요약 JSON이 원본 XML보다 확실히 작아야 한다. 이게 ui_find의 존재 이유다.
    const summaryJson = JSON.stringify(nodes)
    expect(summaryJson.length).toBeLessThan(emulatorFixture.length)
    // 원본 태그·속성이 요약으로 새어 나오면 안 된다.
    expect(summaryJson).not.toContain('<node')
    expect(summaryJson).not.toContain('resource-id')
  })
})
