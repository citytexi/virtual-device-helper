import { deviceError, isDeviceError, unsupported, type DeviceError } from '../../shared/types/errors'
import type { DisplayFrame } from '../../shared/types/device'
import type { ControlIntent, VideoPoint } from '../../shared/types/stream'
import type { AxeClient } from '../ios/axeClient'
import { IOS_KEY_ARGS } from './iosKeys'

/** 이 거리(point) 미만으로 움직인 터치는 탭으로 본다. */
const TAP_SLOP_POINTS = 10
const MIN_SWIPE_SECONDS = 0.05
const SCROLL_SECONDS = 0.1
/** scroll 한 번의 이동 거리: 세로는 displayFrame.height, 가로는 width × 이 비율 × clamp(scroll, -1, 1). */
const SCROLL_DISTANCE_RATIO = 0.15
/**
 * 이 시간 동안 새 글자가 없으면 모아 둔 글자를 한 번에 붙여 넣는다. 붙여 넣기를 글자마다 하면
 * iOS가 붙인 낱말 사이에 공백을 넣어 `abc`가 `a b c`가 된다.
 */
const TEXT_FLUSH_MS = 250

type Video = { width: number; height: number }

export interface AxeControlDeps {
  udid: string
  axe: AxeClient
  /** point 단위. IosDevice.displayFrame()을 넘긴다. 제스처마다 한 번 부른다. */
  displayFrame(): Promise<DisplayFrame>
  /** 문자열 입력. IosDevice.inputText를 넘긴다(simctl pbcopy + Cmd+V). axe 호출과 같은 줄에 선다. */
  inputText(text: string): Promise<void>
  now?: () => number
  setTimer?: typeof setTimeout
  clearTimer?: typeof clearTimeout
  /** 기본은 console.error */
  onError?: (error: DeviceError) => void
}

/** 줄에서 아직 시작하지 않은 scroll. 뒤에 온 scroll이 여기에 합쳐진다. */
interface WaitingScroll {
  point: VideoPoint
  video: Video
  hScroll: number
  vScroll: number
  started: boolean
}

interface Gesture {
  start: VideoPoint
  startVideo: Video
  end: VideoPoint
  endVideo: Video
  startedAt: number
}

function toDeviceError(thrown: unknown): DeviceError {
  if (isDeviceError(thrown)) return thrown
  return deviceError('command_failed', thrown instanceof Error ? thrown.message : String(thrown), '다시 시도해라')
}

function validVideo(v: Video): boolean {
  return Number.isFinite(v.width) && Number.isFinite(v.height) && v.width > 0 && v.height > 0
}

/** 한쪽은 가로, 다른 쪽은 세로인가. 정사각형은 어느 쪽과도 어긋나지 않는다. */
function orientationDiffers(a: Video, b: Video): boolean {
  return (a.width > a.height && b.width < b.height) || (a.width < a.height && b.width > b.height)
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value))
}

/**
 * renderer 화면 입력 의도를 AXe 호출로 바꾼다. scrcpyProtocol의 control 절반에 해당하는 iOS 쪽이다.
 * 터치는 제스처(down→up) 단위로 모아 tap/swipe 한 번으로 보낸다. 연달아 온 글자는 모아 한 번에 붙여 넣는다.
 * 호출은 한 줄로 세운다.
 */
export function createAxeControl(deps: AxeControlDeps): {
  send(intent: ControlIntent, video: Video): void
  close(): void
} {
  const now = deps.now ?? Date.now
  const onError = deps.onError ?? ((e: DeviceError) => console.error(e.message))
  const setTimer = deps.setTimer ?? setTimeout
  const clearTimer = deps.clearTimer ?? clearTimeout

  let closed = false
  let gesture: Gesture | null = null
  let chain: Promise<void> = Promise.resolve()
  // 줄의 마지막 항목. 대기 중인 scroll이 마지막일 때만 새 scroll을 합친다.
  let tail: object | null = null
  let waitingScroll: WaitingScroll | null = null
  // 아직 보내지 않고 모으는 글자와 그 타이머.
  let textBuffer = ''
  let textTimer: ReturnType<typeof setTimeout> | null = null
  // 방향이 어긋난 동안 unsupported를 한 번만 알리려고 적어 둔다.
  let orientationReported = false

  /** 앞 작업이 끝나면 돈다. close 뒤에는 시작하지 않고, 실패는 onError로 보내 줄을 끊지 않는다. */
  function enqueue(task: () => Promise<void>, token: object = {}): void {
    tail = token
    chain = chain.then(async () => {
      if (closed) return
      try {
        await task()
      } catch (thrown) {
        if (closed) return
        try {
          onError(toDeviceError(thrown))
        } catch {
          // onError가 던져도 줄은 계속 간다.
        }
      }
    })
  }

  function exec(args: string[]): Promise<unknown> {
    return deps.axe.exec(deps.udid, args)
  }

  /**
   * 좌표를 옮길 화면 크기. 옮길 수 없으면 null이다.
   * 시뮬레이터를 가로로 돌려도 스트림 프레임은 세로 그대로이고 displayFrame만 가로가 된다. 어느 쪽으로
   * 돌았는지는 알 수 없어 좌표를 옮기면 짐작이 된다. 엉뚱한 곳을 누르느니 제스처를 버리고 한 번 알린다.
   */
  async function frameFor(video: Video): Promise<DisplayFrame | null> {
    const frame = await deps.displayFrame()
    if (!validVideo(frame) || !validVideo(video)) return null
    if (orientationDiffers(frame, video)) {
      if (orientationReported) return null
      orientationReported = true
      throw unsupported('ios', '가로 화면 입력', '스트림 프레임이 돌지 않아 좌표를 옮길 수 없다')
    }
    orientationReported = false
    return frame
  }

  /** 비디오 좌표를 point로 바꾸고 화면 안으로 자른다. */
  function toPoints(p: VideoPoint, video: Video, frame: DisplayFrame): { x: number; y: number } {
    return {
      x: clamp((p.x * frame.width) / video.width, 0, frame.width),
      y: clamp((p.y * frame.height) / video.height, 0, frame.height)
    }
  }

  function finishGesture(g: Gesture): void {
    // 손을 뗀 지금 잰다. 줄 안에서 재면 앞 호출과 displayFrame을 기다린 시간이 스와이프 길이에 더해진다.
    const seconds = Math.max(MIN_SWIPE_SECONDS, (now() - g.startedAt) / 1000)
    enqueue(async () => {
      const frame = await frameFor(g.startVideo)
      if (!frame || !validVideo(g.endVideo)) return
      const a = toPoints(g.start, g.startVideo, frame)
      const b = toPoints(g.end, g.endVideo, frame)
      if (Math.hypot(b.x - a.x, b.y - a.y) < TAP_SLOP_POINTS) {
        await exec(['tap', '-x', String(Math.round(a.x)), '-y', String(Math.round(a.y))])
        return
      }
      await exec(swipeArgs(a, b, seconds))
    })
  }

  function swipeArgs(a: { x: number; y: number }, b: { x: number; y: number }, seconds: number): string[] {
    return [
      'swipe',
      '--start-x',
      String(Math.round(a.x)),
      '--start-y',
      String(Math.round(a.y)),
      '--end-x',
      String(Math.round(b.x)),
      '--end-y',
      String(Math.round(b.y)),
      '--duration',
      String(seconds)
    ]
  }

  function scroll(intent: Extract<ControlIntent, { type: 'scroll' }>, video: Video): void {
    if (!validVideo(video)) return
    // 휠은 초당 수십 번 오는데 AXe 호출은 느리다. 대기 중인 scroll이 줄의 끝이면 거기에 합친다.
    if (waitingScroll && !waitingScroll.started && tail === waitingScroll) {
      waitingScroll.point = intent.point
      waitingScroll.video = video
      waitingScroll.hScroll += intent.hScroll
      waitingScroll.vScroll += intent.vScroll
      return
    }
    const entry: WaitingScroll = {
      point: intent.point,
      video,
      hScroll: intent.hScroll,
      vScroll: intent.vScroll,
      started: false
    }
    waitingScroll = entry
    enqueue(async () => {
      entry.started = true
      const frame = await frameFor(entry.video)
      if (!frame) return
      const a = toPoints(entry.point, entry.video, frame)
      // 양수는 Android 축 의미(뷰포트가 오른쪽·위로)라 내용을 쥔 손가락은 왼쪽·아래로 간다.
      const b = {
        x: clamp(a.x - frame.width * SCROLL_DISTANCE_RATIO * clamp(entry.hScroll, -1, 1), 0, frame.width),
        y: clamp(a.y + frame.height * SCROLL_DISTANCE_RATIO * clamp(entry.vScroll, -1, 1), 0, frame.height)
      }
      if (b.x === a.x && b.y === a.y) return
      await exec(swipeArgs(a, b, SCROLL_SECONDS))
    }, entry)
  }

  function touch(intent: Extract<ControlIntent, { type: 'touch' }>, video: Video): void {
    const { action, point } = intent
    if (action === 'down') {
      // 새 down은 끝나지 않은 앞 제스처를 대체한다.
      gesture = validVideo(video)
        ? { start: point, startVideo: video, end: point, endVideo: video, startedAt: now() }
        : null
      return
    }
    if (!gesture) return
    gesture.end = point
    gesture.endVideo = video
    if (action === 'up') {
      const g = gesture
      gesture = null
      finishGesture(g)
    }
  }

  function clearTextTimer(): void {
    if (textTimer === null) return
    clearTimer(textTimer)
    textTimer = null
  }

  /** 모아 둔 글자를 inputText 한 번으로 줄에 세운다. */
  function flushText(): void {
    clearTextTimer()
    if (textBuffer === '') return
    const text = textBuffer
    textBuffer = ''
    enqueue(() => deps.inputText(text))
  }

  function send(intent: ControlIntent, video: Video): void {
    if (closed) return
    // 글자가 아닌 입력이 오면 모아 둔 글자를 먼저 세운다. 그래야 순서가 보낸 대로다.
    if (intent.type !== 'text') flushText()
    switch (intent.type) {
      case 'touch':
        touch(intent, video)
        return
      case 'scroll':
        scroll(intent, video)
        return
      case 'text':
        textBuffer += intent.text
        clearTextTimer()
        textTimer = setTimer(flushText, TEXT_FLUSH_MS)
        return
      case 'key': {
        const args = IOS_KEY_ARGS[intent.key]
        if (!args) return
        enqueue(async () => {
          await exec(args)
        })
        return
      }
    }
  }

  function close(): void {
    closed = true
    gesture = null
    textBuffer = ''
    clearTextTimer()
  }

  return { send, close }
}
