import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { parseUiDump } from './uiDump'

// 합성 샘플. 픽스처의 실제 기기 덤프는 수치를 미리 알 수 없어 정밀 좌표 검증에
// 쓸 수 없다. 좌표·필터링 규칙 같은 결정적인 값은 이 샘플로 고정해서 검증한다.
const sample = `<?xml version='1.0' encoding='UTF-8' standalone='yes' ?>
<hierarchy rotation="0">
  <node index="0" text="" resource-id="" class="android.widget.FrameLayout" package="com.example" content-desc="" clickable="false" enabled="true" focused="false" scrollable="false" bounds="[0,0][1080,2400]">
    <node index="0" text="이메일" resource-id="com.example:id/email" class="android.widget.EditText" package="com.example" content-desc="" clickable="true" enabled="true" focused="true" scrollable="false" bounds="[80,600][1000,760]" />
    <node index="1" text="로그인" resource-id="com.example:id/login" class="android.widget.Button" package="com.example" content-desc="로그인 버튼" clickable="true" enabled="true" focused="false" scrollable="false" bounds="[80,860][1000,1000]" />
    <node index="2" text="숨은 요소" resource-id="" class="android.widget.TextView" package="com.example" content-desc="" clickable="false" enabled="true" focused="false" scrollable="false" bounds="[0,0][0,0]" />
    <node index="3" text="화면 밖" resource-id="" class="android.widget.TextView" package="com.example" content-desc="" clickable="true" enabled="true" focused="false" scrollable="false" bounds="[80,2600][1000,2700]" />
  </node>
</hierarchy>`

// 가로 화면 덤프. wm size는 회전과 무관하게 자연 방향 크기를 말하므로 그 값으로
// 화면 밖 판정을 하면 가로에서는 거의 모든 노드가 버려진다. 실제 화면 사각형은
// 덤프의 루트 노드 bounds다.
const landscapeSample = `<?xml version='1.0' encoding='UTF-8' standalone='yes' ?>
<hierarchy rotation="1">
  <node index="0" text="" resource-id="" class="android.widget.FrameLayout" package="com.example" content-desc="" clickable="false" enabled="true" focused="false" scrollable="false" bounds="[0,0][2340,1080]">
    <node index="0" text="왼쪽" resource-id="com.example:id/left" class="android.widget.Button" package="com.example" content-desc="" clickable="true" enabled="true" focused="false" scrollable="false" bounds="[40,400][600,600]" />
    <node index="1" text="오른쪽" resource-id="com.example:id/right" class="android.widget.Button" package="com.example" content-desc="" clickable="true" enabled="true" focused="false" scrollable="false" bounds="[1800,400][2300,600]" />
    <node index="2" text="화면 밖" resource-id="" class="android.widget.TextView" package="com.example" content-desc="" clickable="true" enabled="true" focused="false" scrollable="false" bounds="[2400,400][2600,600]" />
  </node>
</hierarchy>`

// 다이얼로그 샘플. uiautomator dump는 활성 창 하나만 덤프하므로 다이얼로그가 떠
// 있으면 루트 bounds가 다이얼로그 사각형([140,900][940,1500])이 된다. 정규화는
// 이 루트가 아니라 디스플레이 전체 크기(natural) 기준이어야 한다.
const dialogSample = `<?xml version='1.0' encoding='UTF-8' standalone='yes' ?>
<hierarchy rotation="0">
  <node index="0" text="" resource-id="" class="android.widget.FrameLayout" package="com.example" content-desc="" clickable="false" enabled="true" focused="false" scrollable="false" bounds="[140,900][940,1500]">
    <node index="0" text="확인" resource-id="com.example:id/ok" class="android.widget.Button" package="com.example" content-desc="" clickable="true" enabled="true" focused="false" scrollable="false" bounds="[540,1380][900,1480]" />
  </node>
</hierarchy>`

// 중첩 샘플. 이름·클릭 둘 다 없는 래퍼 LinearLayout은 빠지고, 그 안 버튼의 부모는
// 남은 노드 중 가장 가까운 조상인 바깥 clickable 카드가 된다. 이름 없는 스크롤
// 컨테이너(RecyclerView)는 scrollable만으로 남는다.
const nestedSample = `<?xml version='1.0' encoding='UTF-8' standalone='yes' ?>
<hierarchy rotation="0">
  <node index="0" text="" resource-id="" class="android.widget.FrameLayout" package="com.example" content-desc="" clickable="false" enabled="true" focused="false" scrollable="false" bounds="[0,0][1080,2400]">
    <node index="0" text="" resource-id="com.example:id/card" class="android.widget.LinearLayout" package="com.example" content-desc="" clickable="true" enabled="true" focused="false" scrollable="false" bounds="[40,200][1040,600]">
      <node index="0" text="" resource-id="" class="android.widget.LinearLayout" package="com.example" content-desc="" clickable="false" enabled="true" focused="false" scrollable="false" bounds="[60,220][1020,580]">
        <node index="0" text="더보기" resource-id="com.example:id/more" class="android.widget.Button" package="com.example" content-desc="" clickable="true" enabled="true" focused="false" scrollable="false" bounds="[800,240][1000,320]" />
      </node>
    </node>
    <node index="1" text="" resource-id="" class="androidx.recyclerview.widget.RecyclerView" package="com.example" content-desc="" clickable="false" enabled="true" focused="false" scrollable="true" bounds="[0,700][1080,2400]" />
  </node>
</hierarchy>`

// 화면 끝에 걸친 샘플. 버튼 픽셀 [900,2300][1200,2500], 중심 (1050,2400)은 화면
// 안(루트 bounds 기준)이지만 오른쪽·아래 변은 화면을 넘어간다.
const edgeSample = `<?xml version='1.0' encoding='UTF-8' standalone='yes' ?>
<hierarchy rotation="0">
  <node index="0" text="" resource-id="" class="android.widget.FrameLayout" package="com.example" content-desc="" clickable="false" enabled="true" focused="false" scrollable="false" bounds="[0,0][1080,2400]">
    <node index="0" text="" resource-id="com.example:id/edge" class="android.widget.Button" package="com.example" content-desc="" clickable="true" enabled="true" focused="false" scrollable="false" bounds="[900,2300][1200,2500]" />
  </node>
</hierarchy>`

const natural = { width: 1080, height: 2400 }

// 실제 기기(RFCXC00V8AZ, SM-A356N, 화면 1080x2340)에서 뜬 원본 덤프.
// 좌표는 알 수 없으므로 파싱이 실제 XML 구조에서 안 깨지는지, bounds가 0..1
// 안인지만 확인한다.
const realFixture = readFileSync(join(__dirname, '__fixtures__', 'window-dump.xml'), 'utf8')
const realScreen = { width: 1080, height: 2340 }

// 실제 에뮬레이터(emulator-5554, Pixel_7_API_36, 화면 1080x2400)의 홈 화면 덤프.
const emulatorFixture = readFileSync(
  join(__dirname, '__fixtures__', 'window-dump-emulator.xml'),
  'utf8'
)
const emulatorScreen = { width: 1080, height: 2400 }

describe('parseUiDump', () => {
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

  it('throws command_failed when rotation is empty rather than treating it as 0', () => {
    // Number("") === 0이라 곧이곧대로 두면 회전을 못 읽은 걸 0으로 오인한다.
    expect(() => parseUiDump(sample.replace('rotation="0"', 'rotation=""'), natural)).toThrow(
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

  it('keeps only the tail of resource-id', () => {
    const nodes = parseUiDump(sample, natural).nodes

    expect(nodes.map((node) => node.resourceId)).toContain('email')
    expect(nodes.every((node) => !node.resourceId?.includes(':id/'))).toBe(true)
  })

  it('keeps only the short class name', () => {
    const nodes = parseUiDump(sample, natural).nodes

    expect(nodes.map((node) => node.className)).toContain('Button')
    expect(nodes.every((node) => !node.className.includes('.'))).toBe(true)
  })

  it('drops zero-area nodes', () => {
    const nodes = parseUiDump(sample, natural).nodes

    expect(nodes.some((node) => node.text === '숨은 요소')).toBe(false)
  })

  it('drops nodes whose center lies outside the screen', () => {
    const nodes = parseUiDump(sample, natural).nodes

    expect(nodes.some((node) => node.text === '화면 밖')).toBe(false)
  })

  it('drops containers that carry no identity and cannot be clicked', () => {
    const nodes = parseUiDump(sample, natural).nodes

    expect(nodes.some((node) => node.className === 'FrameLayout')).toBe(false)
  })

  it('turns empty attributes into null instead of empty strings', () => {
    const nodes = parseUiDump(sample, natural).nodes
    const email = nodes.find((node) => node.resourceId === 'email')

    expect(email?.contentDesc).toBeNull()
  })

  it('returns an empty array for a dump with no usable nodes', () => {
    const empty = '<?xml version="1.0"?><hierarchy rotation="0"></hierarchy>'

    expect(parseUiDump(empty, natural).nodes).toEqual([])
  })

  it('parses the recorded real-device fixture without throwing and returns tappable nodes', () => {
    const nodes = parseUiDump(realFixture, realScreen).nodes

    expect(nodes.length).toBeGreaterThan(0)
    for (const node of nodes) {
      expect(node.bounds.x).toBeGreaterThanOrEqual(0)
      expect(node.bounds.x).toBeLessThanOrEqual(1)
      expect(node.bounds.y).toBeGreaterThanOrEqual(0)
      expect(node.bounds.y).toBeLessThanOrEqual(1)
      expect(node.bounds.w).toBeGreaterThanOrEqual(0)
      expect(node.bounds.w).toBeLessThanOrEqual(1)
      expect(node.bounds.h).toBeGreaterThanOrEqual(0)
      expect(node.bounds.h).toBeLessThanOrEqual(1)
    }
  })

  it('keeps landscape nodes whose coordinates run past the natural-orientation width', () => {
    const nodes = parseUiDump(landscapeSample, { width: 1080, height: 2340 }).nodes

    expect(nodes.map((node) => node.resourceId)).toEqual(['left', 'right'])
  })

  it('still drops nodes outside the display rectangle in landscape', () => {
    const nodes = parseUiDump(landscapeSample, { width: 1080, height: 2340 }).nodes

    expect(nodes.some((node) => node.text === '화면 밖')).toBe(false)
  })

  it('parses the real emulator fixture into a non-empty, compressed summary with no leaked XML', () => {
    const nodes = parseUiDump(emulatorFixture, emulatorScreen).nodes

    expect(nodes.length).toBeGreaterThan(0)
    // 요약 JSON이 원본 XML보다 확실히 작아야 한다. 이게 ui_find의 존재 이유다.
    const summaryJson = JSON.stringify(nodes)
    expect(summaryJson.length).toBeLessThan(emulatorFixture.length)
    // 원본 태그·속성이 요약으로 새어 나오면 안 된다.
    expect(summaryJson).not.toContain('<node')
    expect(summaryJson).not.toContain('resource-id')
  })
})
