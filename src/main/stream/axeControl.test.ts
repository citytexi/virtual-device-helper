import { describe, expect, it, vi } from 'vitest'
import type { ExecResult } from '../process/processClient'
import type { AxeClient } from '../ios/axeClient'
import { execOk, fakeAxe } from '../ios/testing'
import { deviceError, isDeviceError, type DeviceError } from '../../shared/types/errors'
import type { ControlIntent } from '../../shared/types/stream'
import { createAxeControl } from './axeControl'

const VIDEO = { width: 200, height: 400 }
// point 단위 화면은 비디오의 두 배다.
const FRAME = { width: 400, height: 800 }

function pt(x: number, y: number): { x: number; y: number; width: number; height: number } {
  return { x, y, ...VIDEO }
}
function touch(action: 'down' | 'move' | 'up', x: number, y: number): ControlIntent {
  return { type: 'touch', action, point: pt(x, y) }
}
const flush = async (): Promise<void> => {
  for (let i = 0; i < 20; i++) await Promise.resolve()
}

function setup(over: { handlers?: Record<string, ExecResult | Error>; now?: () => number } = {}) {
  const axe = fakeAxe(over.handlers ?? {})
  const errors: DeviceError[] = []
  const inputText = vi.fn(async (_t: string) => {})
  const displayFrame = vi.fn(async () => FRAME)
  const control = createAxeControl({
    udid: 'U',
    axe,
    displayFrame,
    inputText,
    now: over.now,
    onError: (e) => errors.push(e)
  })
  return { axe, errors, inputText, displayFrame, control }
}

/** 손으로 돌리는 타이머. fire()가 걸려 있는 타이머를 모두 터뜨린다. */
function manualTimer() {
  const pending = new Map<number, { callback: () => void; ms: number }>()
  let next = 1
  return {
    pending,
    setTimer: ((callback: () => void, ms: number) => {
      const id = next++
      pending.set(id, { callback, ms })
      return id
    }) as unknown as typeof setTimeout,
    clearTimer: ((id: number) => {
      pending.delete(id)
    }) as unknown as typeof clearTimeout,
    fire(): void {
      const due = [...pending.values()]
      pending.clear()
      for (const t of due) t.callback()
    }
  }
}

/** 호출마다 deferred를 쥐고 있는 가짜 axe. */
function deferredAxe() {
  const calls: string[][] = []
  const resolvers: Array<() => void> = []
  const axe: AxeClient = {
    exec: vi.fn(async (_u: string, args: string[]) => {
      calls.push(args)
      await new Promise<void>((r) => resolvers.push(r))
      return execOk()
    }),
    stream: vi.fn()
  }
  return { axe, calls, resolvers }
}

describe('createAxeControl', () => {
  it('같은 점 down·up은 tap 한 번이고 좌표가 displayFrame/video 비율로 환산된다', async () => {
    const { axe, control, displayFrame } = setup({ handlers: { 'tap -x 50 -y 100': execOk() } })
    control.send(touch('down', 25, 50), VIDEO)
    control.send(touch('up', 25, 50), VIDEO)
    await flush()
    expect(axe.calls).toEqual([{ args: ['tap', '-x', '50', '-y', '100'] }])
    expect(displayFrame).toHaveBeenCalledTimes(1)
  })

  it('긴 이동은 swipe 한 번이고 시작·끝·경과 초가 들어간다', async () => {
    let t = 1000
    const key = 'swipe --start-x 20 --start-y 40 --end-x 100 --end-y 200 --duration 0.3'
    const { axe, control } = setup({ handlers: { [key]: execOk() }, now: () => t })
    control.send(touch('down', 10, 20), VIDEO)
    control.send(touch('move', 30, 60), VIDEO)
    t = 1300
    control.send(touch('move', 50, 100), VIDEO)
    control.send(touch('up', 50, 100), VIDEO)
    await flush()
    expect(axe.calls.map((c) => c.args.join(' '))).toEqual([key])
  })

  it('duration은 손을 뗀 시각까지다. 줄에서 기다리거나 displayFrame을 재는 시간은 넣지 않는다', async () => {
    let t = 1000
    const key = 'swipe --start-x 20 --start-y 40 --end-x 100 --end-y 200 --duration 0.3'
    const axe = fakeAxe({ [key]: execOk() })
    const control = createAxeControl({
      udid: 'U',
      axe,
      // describe-ui는 실제로 수백 ms가 걸린다.
      displayFrame: async () => {
        t += 500
        return FRAME
      },
      inputText: async () => {},
      now: () => t
    })
    control.send(touch('down', 10, 20), VIDEO)
    t = 1300
    control.send(touch('up', 50, 100), VIDEO)
    await flush()
    expect(axe.calls).toEqual([{ args: key.split(' ') }])
  })

  it('duration은 최소 0.05초다', async () => {
    const key = 'swipe --start-x 20 --start-y 40 --end-x 100 --end-y 200 --duration 0.05'
    const { axe, control } = setup({ handlers: { [key]: execOk() }, now: () => 5 })
    control.send(touch('down', 10, 20), VIDEO)
    control.send(touch('up', 50, 100), VIDEO)
    await flush()
    expect(axe.calls).toHaveLength(1)
    expect(axe.calls[0]?.args.join(' ')).toBe(key)
  })

  it('10 point 미만 이동은 tap이다', async () => {
    const { axe, control } = setup({ handlers: { 'tap -x 22 -y 40': execOk() } })
    control.send(touch('down', 10, 20), VIDEO)
    control.send(touch('up', 12, 20), VIDEO)
    await flush()
    expect(axe.calls.map((c) => c.args[0])).toEqual(['tap'])
  })

  it('down 없는 up·move는 무시한다', async () => {
    const { axe, control, displayFrame } = setup()
    control.send(touch('move', 1, 1), VIDEO)
    control.send(touch('up', 1, 1), VIDEO)
    await flush()
    expect(axe.calls).toEqual([])
    expect(displayFrame).not.toHaveBeenCalled()
  })

  it('video 크기가 0이면 버린다', async () => {
    const { axe, control } = setup()
    const zero = { width: 0, height: 0 }
    control.send({ type: 'touch', action: 'down', point: { x: 1, y: 1, ...zero } }, zero)
    control.send({ type: 'touch', action: 'up', point: { x: 1, y: 1, ...zero } }, zero)
    control.send({ type: 'scroll', point: { x: 1, y: 1, ...zero }, hScroll: 0, vScroll: 1 }, zero)
    await flush()
    expect(axe.calls).toEqual([])
  })

  it('scroll vScroll 1은 손가락이 아래로 가고 거리는 height의 0.15다', async () => {
    const key = 'swipe --start-x 100 --start-y 200 --end-x 100 --end-y 320 --duration 0.1'
    const { axe, control } = setup({ handlers: { [key]: execOk() } })
    control.send({ type: 'scroll', point: pt(50, 100), hScroll: 0, vScroll: 1 }, VIDEO)
    await flush()
    expect(axe.calls.map((c) => c.args.join(' '))).toEqual([key])
  })

  it('scroll vScroll은 [-1, 1]로 자른다', async () => {
    const key = 'swipe --start-x 100 --start-y 200 --end-x 100 --end-y 80 --duration 0.1'
    const { axe, control } = setup({ handlers: { [key]: execOk() } })
    control.send({ type: 'scroll', point: pt(50, 100), hScroll: 0, vScroll: -16 }, VIDEO)
    await flush()
    expect(axe.calls.map((c) => c.args.join(' '))).toEqual([key])
  })

  it('key back은 호출이 없고 power는 button lock이다', async () => {
    const { axe, control } = setup({ handlers: { 'button lock': execOk() } })
    control.send({ type: 'key', key: 'back' }, VIDEO)
    control.send({ type: 'key', key: 'power' }, VIDEO)
    await flush()
    expect(axe.calls).toEqual([{ args: ['button', 'lock'] }])
  })

  it('key enter는 HID keycode로 간다', async () => {
    const { axe, control } = setup({ handlers: { 'key 40': execOk() } })
    control.send({ type: 'key', key: 'enter' }, VIDEO)
    await flush()
    expect(axe.calls).toEqual([{ args: ['key', '40'] }])
  })

  it('탭 셋을 연달아 보내면 첫 호출을 늦게 끝내도 보낸 순서로 한 번에 하나씩 돈다', async () => {
    const { axe, calls, resolvers } = deferredAxe()
    const control = createAxeControl({ udid: 'U', axe, displayFrame: async () => FRAME, inputText: async () => {} })
    for (const x of [10, 20, 30]) {
      control.send(touch('down', x, 10), VIDEO)
      control.send(touch('up', x, 10), VIDEO)
    }
    await flush()
    expect(calls).toHaveLength(1)
    resolvers[0]?.()
    await flush()
    expect(calls).toHaveLength(2)
    resolvers[1]?.()
    await flush()
    resolvers[2]?.()
    await flush()
    expect(calls.map((c) => c[2])).toEqual(['20', '40', '60'])
  })

  it('첫 호출이 reject해도 onError로 가고 둘째 호출이 간다', async () => {
    const { axe, control, errors } = setup({
      handlers: { 'key 40': new Error('boom'), 'key 42': execOk() }
    })
    control.send({ type: 'key', key: 'enter' }, VIDEO)
    control.send({ type: 'key', key: 'backspace' }, VIDEO)
    await flush()
    expect(axe.calls.map((c) => c.args.join(' '))).toEqual(['key 40', 'key 42'])
    expect(errors).toHaveLength(1)
    expect(isDeviceError(errors[0])).toBe(true)
    expect(errors[0]?.toolError.message).toContain('boom')
  })

  it('DeviceError는 그대로 onError로 간다', async () => {
    const original = deviceError('command_failed', 'x', 'y')
    const { control, errors } = setup({ handlers: { 'key 40': original as unknown as Error } })
    control.send({ type: 'key', key: 'enter' }, VIDEO)
    await flush()
    expect(errors).toEqual([original])
  })

  it('displayFrame이 실패하면 그 제스처만 버리고 다음은 간다', async () => {
    const axe = fakeAxe({ 'tap -x 20 -y 20': execOk() })
    const errors: DeviceError[] = []
    const displayFrame = vi.fn().mockRejectedValueOnce(new Error('no frame')).mockResolvedValue(FRAME)
    const control = createAxeControl({
      udid: 'U',
      axe,
      displayFrame,
      inputText: async () => {},
      onError: (e) => errors.push(e)
    })
    control.send(touch('down', 5, 5), VIDEO)
    control.send(touch('up', 5, 5), VIDEO)
    control.send(touch('down', 10, 10), VIDEO)
    control.send(touch('up', 10, 10), VIDEO)
    await flush()
    expect(errors).toHaveLength(1)
    expect(axe.calls).toEqual([{ args: ['tap', '-x', '20', '-y', '20'] }])
  })

  it('text는 inputText로 가고 axe는 부르지 않으며 앞선 느린 탭 뒤에 순서대로 돈다', async () => {
    const { axe, calls, resolvers } = deferredAxe()
    const order: string[] = []
    const inputText = vi.fn(async (t: string) => {
      order.push(`text:${t}`)
    })
    const timer = manualTimer()
    const control = createAxeControl({ udid: 'U', axe, displayFrame: async () => FRAME, inputText, ...timer })
    control.send(touch('down', 10, 10), VIDEO)
    control.send(touch('up', 10, 10), VIDEO)
    control.send({ type: 'text', text: '안녕' }, VIDEO)
    timer.fire()
    await flush()
    expect(inputText).not.toHaveBeenCalled()
    resolvers[0]?.()
    await flush()
    expect(inputText).toHaveBeenCalledWith('안녕')
    expect(calls).toHaveLength(1)
    expect(calls.flat()).not.toContain('안녕')
  })

  it('inputText 실패는 onError로 가고 다음 호출이 계속된다', async () => {
    const axe = fakeAxe({ 'key 40': execOk() })
    const errors: DeviceError[] = []
    const control = createAxeControl({
      udid: 'U',
      axe,
      displayFrame: async () => FRAME,
      inputText: async () => {
        throw new Error('pbcopy')
      },
      onError: (e) => errors.push(e)
    })
    control.send({ type: 'text', text: 'a' }, VIDEO)
    control.send({ type: 'key', key: 'enter' }, VIDEO)
    await flush()
    expect(errors).toHaveLength(1)
    expect(axe.calls).toEqual([{ args: ['key', '40'] }])
  })

  it('hScroll 1은 손가락이 왼쪽으로 가고 거리는 width의 0.15다', async () => {
    const key = 'swipe --start-x 200 --start-y 200 --end-x 140 --end-y 200 --duration 0.1'
    const { axe, control } = setup({ handlers: { [key]: execOk() } })
    control.send({ type: 'scroll', point: pt(100, 100), hScroll: 1, vScroll: 0 }, VIDEO)
    await flush()
    expect(axe.calls.map((c) => c.args.join(' '))).toEqual([key])
  })

  it('hScroll -1은 손가락이 오른쪽으로 간다', async () => {
    const key = 'swipe --start-x 200 --start-y 200 --end-x 260 --end-y 200 --duration 0.1'
    const { axe, control } = setup({ handlers: { [key]: execOk() } })
    control.send({ type: 'scroll', point: pt(100, 100), hScroll: -1, vScroll: 0 }, VIDEO)
    await flush()
    expect(axe.calls.map((c) => c.args.join(' '))).toEqual([key])
  })

  it('scroll 끝점은 화면 안으로 자른다', async () => {
    const key = 'swipe --start-x 100 --start-y 790 --end-x 100 --end-y 800 --duration 0.1'
    const { axe, control } = setup({ handlers: { [key]: execOk() } })
    control.send({ type: 'scroll', point: pt(50, 395), hScroll: 0, vScroll: 1 }, VIDEO)
    await flush()
    expect(axe.calls.map((c) => c.args.join(' '))).toEqual([key])
  })

  it('느린 호출 중 몰린 scroll은 합쳐서 swipe 한 번이고 합은 [-1, 1]로 자른다', async () => {
    const { axe, calls, resolvers } = deferredAxe()
    const displayFrame = vi.fn(async () => FRAME)
    const control = createAxeControl({ udid: 'U', axe, displayFrame, inputText: async () => {} })
    control.send({ type: 'key', key: 'enter' }, VIDEO)
    await flush()
    for (let i = 0; i < 10; i++) {
      control.send({ type: 'scroll', point: pt(50, 100 + i), hScroll: 0, vScroll: 0.3 }, VIDEO)
    }
    resolvers[0]?.()
    await flush()
    resolvers[1]?.()
    await flush()
    expect(calls).toHaveLength(2)
    // 마지막 point(50, 109) -> (100, 218), 합 3은 1로 잘려 y + 120
    expect(calls[1]).toEqual(['swipe', '--start-x', '100', '--start-y', '218', '--end-x', '100', '--end-y', '338', '--duration', '0.1'])
    // key 뒤에 선 scroll 하나만 displayFrame을 부른다
    expect(displayFrame).toHaveBeenCalledTimes(1)
  })

  it('이미 시작한 scroll에는 합치지 않고 새 scroll이 대기 항목이 된다', async () => {
    const { axe, calls, resolvers } = deferredAxe()
    const control = createAxeControl({ udid: 'U', axe, displayFrame: async () => FRAME, inputText: async () => {} })
    control.send({ type: 'scroll', point: pt(50, 100), hScroll: 0, vScroll: 0.5 }, VIDEO)
    await flush()
    control.send({ type: 'scroll', point: pt(50, 100), hScroll: 0, vScroll: 0.5 }, VIDEO)
    control.send({ type: 'scroll', point: pt(50, 100), hScroll: 0, vScroll: 0.25 }, VIDEO)
    resolvers[0]?.()
    await flush()
    resolvers[1]?.()
    await flush()
    expect(calls).toHaveLength(2)
    expect(calls[0]?.[8]).toBe('260') // 200 + 60
    expect(calls[1]?.[8]).toBe('290') // 200 + 90 (0.75)
  })

  it('scroll, tap, scroll은 세 호출이고 순서가 보존된다', async () => {
    const { axe, calls, resolvers } = deferredAxe()
    const control = createAxeControl({ udid: 'U', axe, displayFrame: async () => FRAME, inputText: async () => {} })
    control.send({ type: 'key', key: 'enter' }, VIDEO)
    control.send({ type: 'scroll', point: pt(50, 100), hScroll: 0, vScroll: 1 }, VIDEO)
    control.send(touch('down', 10, 10), VIDEO)
    control.send(touch('up', 10, 10), VIDEO)
    control.send({ type: 'scroll', point: pt(50, 100), hScroll: 0, vScroll: 1 }, VIDEO)
    await flush()
    for (let i = 0; i < 4; i++) {
      resolvers[i]?.()
      await flush()
    }
    expect(calls.map((c) => c[0])).toEqual(['key', 'swipe', 'tap', 'swipe'])
  })

  it('화면 밖 up은 화면 안으로 잘라 swipe한다', async () => {
    const key = 'swipe --start-x 200 --start-y 400 --end-x 400 --end-y 800 --duration 0.05'
    const { axe, control } = setup({ handlers: { [key]: execOk() }, now: () => 1 })
    control.send(touch('down', 100, 200), VIDEO)
    control.send(touch('up', 250, 450), VIDEO)
    await flush()
    expect(axe.calls.map((c) => c.args.join(' '))).toEqual([key])
  })

  it('새 down은 끝나지 않은 앞 제스처를 대체한다', async () => {
    const { axe, control } = setup({ handlers: { 'tap -x 60 -y 60': execOk() } })
    control.send(touch('down', 5, 5), VIDEO)
    control.send(touch('down', 30, 30), VIDEO)
    control.send(touch('up', 30, 30), VIDEO)
    await flush()
    expect(axe.calls).toEqual([{ args: ['tap', '-x', '60', '-y', '60'] }])
  })

  it('displayFrame이 크기 0을 주면 제스처를 버린다', async () => {
    const axe = fakeAxe({})
    const control = createAxeControl({
      udid: 'U',
      axe,
      displayFrame: async () => ({ width: 0, height: 0 }),
      inputText: async () => {}
    })
    control.send(touch('down', 5, 5), VIDEO)
    control.send(touch('up', 5, 5), VIDEO)
    await flush()
    expect(axe.calls).toEqual([])
  })

  it('onError가 던져도 줄이 죽지 않는다', async () => {
    const axe = fakeAxe({ 'key 40': new Error('boom'), 'key 42': execOk() })
    const control = createAxeControl({
      udid: 'U',
      axe,
      displayFrame: async () => FRAME,
      inputText: async () => {},
      onError: () => {
        throw new Error('onError 실패')
      }
    })
    control.send({ type: 'key', key: 'enter' }, VIDEO)
    control.send({ type: 'key', key: 'backspace' }, VIDEO)
    await flush()
    expect(axe.calls.map((c) => c.args.join(' '))).toEqual(['key 40', 'key 42'])
  })

  it('호출이 도는 중 close하면 뒤 작업은 안 돌고 onError도 부르지 않는다', async () => {
    const calls: string[][] = []
    let reject: (e: Error) => void = () => {}
    const axe: AxeClient = {
      exec: vi.fn((_u: string, args: string[]) => {
        calls.push(args)
        return new Promise<ExecResult>((_r, rej) => {
          reject = rej
        })
      }),
      stream: vi.fn()
    }
    const errors: DeviceError[] = []
    const control = createAxeControl({
      udid: 'U',
      axe,
      displayFrame: async () => FRAME,
      inputText: async () => {},
      onError: (e) => errors.push(e)
    })
    control.send({ type: 'key', key: 'enter' }, VIDEO)
    control.send({ type: 'key', key: 'backspace' }, VIDEO)
    await flush()
    control.close()
    reject(new Error('late'))
    await flush()
    expect(calls).toHaveLength(1)
    expect(errors).toEqual([])
  })

  it('close 뒤의 send와 대기 중이던 작업, 진행 중 제스처를 버린다', async () => {
    const { axe, calls, resolvers } = deferredAxe()
    const inputText = vi.fn(async () => {})
    const control = createAxeControl({ udid: 'U', axe, displayFrame: async () => FRAME, inputText })
    control.send({ type: 'key', key: 'enter' }, VIDEO)
    control.send({ type: 'text', text: 'queued' }, VIDEO)
    control.send(touch('down', 1, 1), VIDEO)
    await flush()
    control.close()
    resolvers[0]?.()
    await flush()
    control.send(touch('up', 1, 1), VIDEO)
    control.send({ type: 'key', key: 'home' }, VIDEO)
    await flush()
    expect(calls).toHaveLength(1)
    expect(inputText).not.toHaveBeenCalled()
  })

  describe('text 모으기', () => {
    function textSetup(handlers: Record<string, ExecResult | Error> = {}) {
      const timer = manualTimer()
      const axe = fakeAxe(handlers)
      const order: string[] = []
      const inputText = vi.fn(async (t: string) => {
        order.push(`text:${t}`)
      })
      const exec = axe.exec
      axe.exec = vi.fn(async (u: string, args: string[], opts?: never) => {
        order.push(args.join(' '))
        return exec(u, args, opts)
      })
      const control = createAxeControl({ udid: 'U', axe, displayFrame: async () => FRAME, inputText, ...timer })
      return { timer, axe, order, inputText, control }
    }
    const text = (t: string): ControlIntent => ({ type: 'text', text: t })

    it('연달아 온 a·b·c는 타이머가 끝난 뒤 inputText 한 번으로 간다', async () => {
      const { timer, inputText, control } = textSetup()
      control.send(text('a'), VIDEO)
      control.send(text('b'), VIDEO)
      control.send(text('c'), VIDEO)
      await flush()
      expect(inputText).not.toHaveBeenCalled()
      // 새 글자가 올 때마다 다시 잰다. 걸려 있는 타이머는 하나다.
      expect([...timer.pending.values()].map((t) => t.ms)).toEqual([250])
      timer.fire()
      await flush()
      expect(inputText.mock.calls).toEqual([['abc']])
    })

    it('글자 하나도 기다린 뒤에 나간다', async () => {
      const { timer, inputText, control } = textSetup()
      control.send(text('가'), VIDEO)
      await flush()
      expect(inputText).not.toHaveBeenCalled()
      timer.fire()
      await flush()
      expect(inputText.mock.calls).toEqual([['가']])
    })

    it('text 뒤에 key가 오면 타이머를 기다리지 않고 inputText가 key보다 먼저 돈다', async () => {
      const { timer, order, control } = textSetup({ 'key 40': execOk() })
      control.send(text('a'), VIDEO)
      control.send(text('b'), VIDEO)
      control.send({ type: 'key', key: 'enter' }, VIDEO)
      await flush()
      expect(order).toEqual(['text:ab', 'key 40'])
      expect(timer.pending.size).toBe(0)
      timer.fire()
      await flush()
      expect(order).toEqual(['text:ab', 'key 40'])
    })

    it('text 뒤에 터치가 오면 inputText가 탭보다 먼저 돈다', async () => {
      const { order, control } = textSetup({ 'tap -x 50 -y 100': execOk() })
      control.send(text('a'), VIDEO)
      control.send(touch('down', 25, 50), VIDEO)
      control.send(touch('up', 25, 50), VIDEO)
      await flush()
      expect(order).toEqual(['text:a', 'tap -x 50 -y 100'])
    })

    it('타이머로 갈린 두 묶음은 inputText 두 번이다', async () => {
      const { timer, inputText, control } = textSetup()
      control.send(text('a'), VIDEO)
      control.send(text('b'), VIDEO)
      timer.fire()
      control.send(text('c'), VIDEO)
      timer.fire()
      await flush()
      expect(inputText.mock.calls).toEqual([['ab'], ['c']])
    })

    it('close는 모아 둔 글자를 버리고 타이머를 지운다', async () => {
      const { timer, inputText, control } = textSetup()
      control.send(text('a'), VIDEO)
      expect(timer.pending.size).toBe(1)
      control.close()
      expect(timer.pending.size).toBe(0)
      timer.fire()
      await flush()
      expect(inputText).not.toHaveBeenCalled()
    })
  })

  describe('가로 화면', () => {
    const LANDSCAPE = { width: 800, height: 400 }
    const swipeKey = 'swipe --start-x 20 --start-y 40 --end-x 100 --end-y 200 --duration 0.05'

    function orientationSetup(handlers: Record<string, ExecResult | Error>) {
      let frame = LANDSCAPE
      const axe = fakeAxe(handlers)
      const errors: DeviceError[] = []
      const inputText = vi.fn(async (_t: string) => {})
      const control = createAxeControl({
        udid: 'U',
        axe,
        displayFrame: async () => frame,
        inputText,
        now: () => 1,
        onError: (e) => errors.push(e),
        ...manualTimer()
      })
      return { axe, errors, inputText, control, setFrame: (f: { width: number; height: number }) => (frame = f) }
    }
    function tapAt(control: { send(i: ControlIntent, v: typeof VIDEO): void }, x: number, y: number): void {
      control.send(touch('down', x, y), VIDEO)
      control.send(touch('up', x, y), VIDEO)
    }

    it('세로 프레임에 가로 displayFrame이면 탭·스와이프·scroll을 보내지 않고 unsupported를 한 번만 알린다', async () => {
      const { axe, errors, control } = orientationSetup({})
      tapAt(control, 25, 50)
      control.send(touch('down', 10, 20), VIDEO)
      control.send(touch('up', 50, 100), VIDEO)
      await flush()
      control.send({ type: 'scroll', point: pt(50, 100), hScroll: 0, vScroll: 1 }, VIDEO)
      await flush()
      control.send({ type: 'scroll', point: pt(50, 100), hScroll: 0, vScroll: 1 }, VIDEO)
      await flush()
      expect(axe.calls).toEqual([])
      expect(errors).toHaveLength(1)
      expect(errors[0]?.toolError).toMatchObject({ kind: 'unsupported', details: { platform: 'ios', action: '가로 화면 입력' } })
    })

    it('가로 프레임에 세로 displayFrame도 막는다', async () => {
      const { axe, errors, control, setFrame } = orientationSetup({})
      setFrame(FRAME)
      const wide = { width: 400, height: 200 }
      const p = { x: 10, y: 10, ...wide }
      control.send({ type: 'touch', action: 'down', point: p }, wide)
      control.send({ type: 'touch', action: 'up', point: p }, wide)
      await flush()
      expect(axe.calls).toEqual([])
      expect(errors.map((e) => e.toolError.kind)).toEqual(['unsupported'])
    })

    it('가로 화면에서도 key와 text는 간다', async () => {
      const { axe, errors, inputText, control } = orientationSetup({ 'button home': execOk() })
      tapAt(control, 25, 50)
      control.send({ type: 'text', text: 'a' }, VIDEO)
      control.send({ type: 'key', key: 'home' }, VIDEO)
      await flush()
      expect(inputText).toHaveBeenCalledWith('a')
      expect(axe.calls).toEqual([{ args: ['button', 'home'] }])
      expect(errors).toHaveLength(1)
    })

    it('방향이 다시 맞으면 제스처가 가고, 그 뒤 다시 어긋나면 다시 알린다', async () => {
      const { axe, errors, control, setFrame } = orientationSetup({ 'tap -x 50 -y 100': execOk(), [swipeKey]: execOk() })
      tapAt(control, 25, 50)
      await flush()
      expect(errors).toHaveLength(1)

      setFrame(FRAME)
      tapAt(control, 25, 50)
      control.send(touch('down', 10, 20), VIDEO)
      control.send(touch('up', 50, 100), VIDEO)
      await flush()
      expect(axe.calls.map((c) => c.args.join(' '))).toEqual(['tap -x 50 -y 100', swipeKey])
      expect(errors).toHaveLength(1)

      setFrame(LANDSCAPE)
      tapAt(control, 25, 50)
      tapAt(control, 25, 50)
      await flush()
      expect(axe.calls).toHaveLength(2)
      expect(errors).toHaveLength(2)
    })

    it('정사각형 화면이나 프레임은 어긋난 것으로 보지 않는다', async () => {
      const { axe, errors, control, setFrame } = orientationSetup({ 'tap -x 100 -y 50 ': execOk(), 'tap -x 100 -y 50': execOk() })
      // displayFrame이 정사각형
      setFrame({ width: 800, height: 800 })
      tapAt(control, 25, 25)
      await flush()
      // 프레임이 정사각형
      setFrame(LANDSCAPE)
      const square = { width: 200, height: 200 }
      const p = { x: 25, y: 25, ...square }
      control.send({ type: 'touch', action: 'down', point: p }, square)
      control.send({ type: 'touch', action: 'up', point: p }, square)
      await flush()
      expect(errors).toEqual([])
      expect(axe.calls.map((c) => c.args.join(' '))).toEqual(['tap -x 100 -y 50', 'tap -x 100 -y 50'])
    })
  })
})
