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

/** 정규화된 사각형. 0..1, 소수 4자리로 반올림한다. */
export interface NormalizedRect {
  x: number
  y: number
  w: number
  h: number
}

/** 현재 방향 기준 디스플레이 전체 크기(기기 픽셀). */
export interface DisplayFrame {
  width: number
  height: number
}

/**
 * uiautomator 덤프에서 요약한 요소 하나.
 * 원본 XML은 이 타입으로 바뀐 뒤 버려진다.
 */
export interface UiNode {
  /** 이 덤프 안에서의 순번. 필터 뒤 남은 노드 기준이다. ref의 뒷부분이 된다. */
  index: number
  /** 남은 노드 중 가장 가까운 조상의 index. 없으면 null. */
  parentIndex: number | null
  text: string | null
  contentDesc: string | null
  /** resource-id의 꼬리. "com.example:id/login" 이면 "login". */
  resourceId: string | null
  /** 클래스의 짧은 이름. "android.widget.Button" 이면 "Button". */
  className: string
  /** 디스플레이 전체 크기 기준 정규화 사각형. 덤프 루트 bounds가 아니다. */
  bounds: NormalizedRect
  clickable: boolean
  enabled: boolean
  focused: boolean
  scrollable: boolean
}

export interface UiDump {
  nodes: UiNode[]
  /** 덤프 시점의 디스플레이 크기. 정규화 기준이자 ref 경로의 픽셀 변환 기준이다. */
  frame: DisplayFrame
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
  /** 이 pid들의 줄만 남긴다. limit을 적용하기 전에 거른다. */
  pids?: number[]
}

/**
 * 타깃 디바이스 하나. M1의 구현체는 AndroidDevice 하나뿐이다.
 * AVD 부팅·종료는 기기가 없는 상태에서 하는 일이라 여기 들어가지 않는다.
 */
export interface Device {
  readonly serial: string
  info(): Promise<DeviceInfo>
  /**
   * 설치된 패키지명. 재설치라 패키지 목록이 그대로여서 이름을 특정할 수 없으면 null이다 —
   * 빈 문자열로 말하면 호출부가 그것을 유효한 패키지명으로 착각한다.
   */
  install(apkPath: string, opts?: InstallOpts): Promise<string | null>
  uninstall(pkg: string): Promise<void>
  launch(pkg: string, activity?: string): Promise<void>
  stop(pkg: string): Promise<void>
  clearData(pkg: string): Promise<void>
  grantPermission(pkg: string, permission: string): Promise<void>
  tap(x: number, y: number): Promise<void>
  swipe(x1: number, y1: number, x2: number, y2: number, durationMs: number): Promise<void>
  inputText(text: string): Promise<void>
  pressKey(key: KeyName): Promise<void>
  dumpUi(): Promise<UiDump>
  /** 현재 방향 기준 디스플레이 전체 크기. `dumpsys window displays`의 mDisplayId=0 값을 읽는다. */
  displayFrame(): Promise<DisplayFrame>
  screenshot(opts?: ScreenshotOpts): Promise<ScreenshotResult>
  readLogs(opts?: LogOpts): Promise<LogReadResult>
  clearLogs(): Promise<void>
}
