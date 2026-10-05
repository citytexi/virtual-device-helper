import { deviceError, isDeviceError, type DeviceError } from '../../shared/types/errors'
import type { DisplayFrame } from '../../shared/types/device'
import type { ControlIntent, VideoPoint } from '../../shared/types/stream'
import type { AxeClient } from '../ios/axeClient'
import { IOS_KEY_ARGS } from './iosKeys'

/** 이 거리(point) 미만으로 움직인 터치는 탭으로 본다. */
const TAP_SLOP_POINTS = 10
const MIN_SWIPE_SECONDS = 0.05
const SCROLL_SECONDS = 0.1
/** scroll 한 번의 이동 거리: displayFrame.height × 이 비율 × clamp(scroll, -1, 1). */
const SCROLL_DISTANCE_RATIO = 0.15

type Video = { width: number; height: number }

export interface AxeControlDeps {
  udid: string
  axe: AxeClient
  /** point 단위. IosDevice.displayFrame()을 넘긴다. 제스처마다 한 번 부른다. */
  displayFrame(): Promise<DisplayFrame>
  /** 문자열 입력. IosDevice.inputText를 넘긴다(simctl pbcopy + Cmd+V). axe 호출과 같은 줄에 선다. */
  inputText(text: string): Promise<void>
  now?: () => number
  /** 기본은 console.error */
  onError?: (error: DeviceError) => void
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

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value))
}

/**
 * renderer 화면 입력 의도를 AXe 호출로 바꾼다. scrcpyProtocol의 control 절반에 해당하는 iOS 쪽이다.
 * 터치는 제스처(down→up) 단위로 모아 tap/swipe 한 번으로 보낸다. 호출은 한 줄로 세운다.
 */
export function createAxeControl(deps: AxeControlDeps): {
  send(intent: ControlIntent, video: Video): void
  close(): void
} {
  const now = deps.now ?? Date.now
  const onError = deps.onError ?? ((e: DeviceError) => console.error(e.message))

  let closed = false
  let gesture: Gesture | null = null
  let chain: Promise<void> = Promise.resolve()

  /** 앞 작업이 끝나면 돈다. close 뒤에는 시작하지 않고, 실패는 onError로 보내 줄을 끊지 않는다. */
  function enqueue(task: () => Promise<void>): void {
    chain = chain.then(async () => {
      if (closed) return
      try {
        await task()
      } catch (thrown) {
        if (!closed) onError(toDeviceError(thrown))
      }
    })
  }

  function exec(args: string[]): Promise<unknown> {
    return deps.axe.exec(deps.udid, args)
  }

  async function frameFor(video: Video): Promise<DisplayFrame | null> {
    const frame = await deps.displayFrame()
    if (!validVideo(frame) || !validVideo(video)) return null
    return frame
  }

  function toPoints(p: VideoPoint, video: Video, frame: DisplayFrame): { x: number; y: number } {
    return { x: (p.x * frame.width) / video.width, y: (p.y * frame.height) / video.height }
  }

  function finishGesture(g: Gesture): void {
    enqueue(async () => {
      const frame = await frameFor(g.startVideo)
      if (!frame || !validVideo(g.endVideo)) return
      const a = toPoints(g.start, g.startVideo, frame)
      const b = toPoints(g.end, g.endVideo, frame)
      if (Math.hypot(b.x - a.x, b.y - a.y) < TAP_SLOP_POINTS) {
        await exec(['tap', '-x', String(Math.round(a.x)), '-y', String(Math.round(a.y))])
        return
      }
      const seconds = Math.max(MIN_SWIPE_SECONDS, (now() - g.startedAt) / 1000)
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
    enqueue(async () => {
      const frame = await frameFor(video)
      if (!frame) return
      const a = toPoints(intent.point, video, frame)
      const dist = frame.height * SCROLL_DISTANCE_RATIO
      // Android 축 의미: vScroll > 0은 위로 스크롤, 곧 손가락이 아래로 간다. hScroll > 0은 손가락이 오른쪽으로 간다.
      const b = {
        x: clamp(a.x + dist * clamp(intent.hScroll, -1, 1), 0, frame.width),
        y: clamp(a.y + dist * clamp(intent.vScroll, -1, 1), 0, frame.height)
      }
      if (b.x === a.x && b.y === a.y) return
      await exec(swipeArgs(a, b, SCROLL_SECONDS))
    })
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

  function send(intent: ControlIntent, video: Video): void {
    if (closed) return
    switch (intent.type) {
      case 'touch':
        touch(intent, video)
        return
      case 'scroll':
        scroll(intent, video)
        return
      case 'text':
        enqueue(() => deps.inputText(intent.text))
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
  }

  return { send, close }
}
