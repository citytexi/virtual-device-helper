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
    const control = createAxeControl({ udid: 'U', axe, displayFrame: async () => FRAME, inputText })
    control.send(touch('down', 10, 10), VIDEO)
    control.send(touch('up', 10, 10), VIDEO)
    control.send({ type: 'text', text: '안녕' }, VIDEO)
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
})
