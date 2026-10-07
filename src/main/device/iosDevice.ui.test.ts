import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { AXE_HINT } from '../ios/axeClient'
import { deviceError } from '../../shared/types/errors'
import { execOk, fakeAxe, fakeSimctl } from '../ios/testing'
import { createIosDevice } from './iosDevice'
import { parseAxeFrame, parseAxeUi } from './parsers/axeUi'

const UDID = 'UDID-1'
const describeUi = readFileSync(join(__dirname, 'parsers', '__fixtures__', 'ios', 'describe-ui-settings.json'), 'utf8')
const noopResize = (png: Buffer) => ({ png, width: 1, height: 1 })

function setup(handlers: Parameters<typeof fakeAxe>[0] = {}, simctlHandlers: Parameters<typeof fakeSimctl>[0] = {}) {
  const axe = fakeAxe(handlers)
  const simctl = fakeSimctl(simctlHandlers)
  const device = createIosDevice({ udid: UDID, simctl, axe, resizeImage: noopResize })
  return { axe, simctl, device }
}

describe('IosDevice 입력', () => {
  it('tap은 좌표를 반올림해 axe tap으로 보낸다', async () => {
    const { axe, device } = setup({ 'tap -x 101 -y 200': execOk() })
    await device.tap(100.6, 200.2)
    expect(axe.calls).toEqual([{ args: ['tap', '-x', '101', '-y', '200'] }])
  })

  it('swipe는 durationMs를 초로 바꿔 axe swipe로 보낸다', async () => {
    const { axe, device } = setup({ 'swipe --start-x 10 --start-y 20 --end-x 30 --end-y 40 --duration 0.3': execOk() })
    await device.swipe(10, 20, 30, 40, 300)
    expect(axe.calls).toEqual([{ args: ['swipe', '--start-x', '10', '--start-y', '20', '--end-x', '30', '--end-y', '40', '--duration', '0.3'] }])
  })

  it('pressKey는 home·enter·tab을 axe로 보낸다', async () => {
    const { axe, device } = setup({ 'button home': execOk(), 'key 40': execOk(), 'key 43': execOk() })
    await device.pressKey('home')
    await device.pressKey('enter')
    await device.pressKey('tab')
    expect(axe.calls.map((call) => call.args)).toEqual([['button', 'home'], ['key', '40'], ['key', '43']])
  })

  it('pressKey(back)은 unsupported이고 axe를 부르지 않는다', async () => {
    const { axe, device } = setup()
    await expect(device.pressKey('back')).rejects.toMatchObject({ toolError: { kind: 'unsupported' } })
    expect(axe.calls).toEqual([])
  })

  it('pressKey(back)은 axe가 없어도 unsupported다', async () => {
    const device = createIosDevice({ udid: UDID, simctl: fakeSimctl({}), axe: null, resizeImage: noopResize })
    await expect(device.pressKey('back')).rejects.toMatchObject({ toolError: { kind: 'unsupported' } })
  })

  it.each([['hello'], ['a"b\nc 한글'], ['안녕 🙂']])('inputText(%j)는 pbcopy의 input으로만 가고 ⌘V를 누른다', async (text) => {
    const { axe, simctl, device } = setup({ 'key-combo --modifiers 227 --key 25': execOk() }, { [`pbcopy ${UDID}`]: execOk() })
    await device.inputText(text)

    expect(simctl.calls).toEqual([['pbcopy', UDID]])
    expect(simctl.inputs).toEqual([text])
    expect(axe.calls).toEqual([{ args: ['key-combo', '--modifiers', '227', '--key', '25'] }])
    const allArgs = [...simctl.calls, ...axe.calls.map((call) => call.args)].flat()
    expect(allArgs.some((arg) => arg.includes(text))).toBe(false)
  })

  it('pbcopy가 실패하면 ⌘V를 누르지 않는다', async () => {
    const { axe, device } = setup({}, { [`pbcopy ${UDID}`]: new Error('boom') })
    await expect(device.inputText('x')).rejects.toThrow('boom')
    expect(axe.calls).toEqual([])
  })
})

describe('IosDevice 노드·화면', () => {
  it('dumpUi는 describe-ui를 parseAxeUi로 바꾼다', async () => {
    const { axe, device } = setup({ 'describe-ui': execOk(describeUi) })
    await expect(device.dumpUi()).resolves.toEqual(parseAxeUi(describeUi))
    expect(axe.calls).toEqual([{ args: ['describe-ui'] }])
  })

  it('displayFrame은 매번 describe-ui를 불러 parseAxeFrame으로 바꾼다', async () => {
    const { axe, device } = setup({ 'describe-ui': execOk(describeUi) })
    await expect(device.displayFrame()).resolves.toEqual(parseAxeFrame(describeUi))
    await device.displayFrame()
    expect(axe.calls).toHaveLength(2)
  })
})

describe('IosDevice describe-ui 재시도', () => {
  const TRANSLATION = deviceError('command_failed', 'axe 명령이 실패했다: describe-ui', '첨부된 stderr를 확인해라', {
    stderr: 'Error: No translation object returned for simulator UDID-1'
  })

  function retrySetup(results: Array<Error | ReturnType<typeof execOk>>) {
    const calls: string[][] = []
    const sleeps: number[] = []
    const axe = {
      calls,
      exec: vi.fn(async (_udid: string, args: string[]) => {
        calls.push(args)
        const next = results.shift()!
        if (next instanceof Error) throw next
        return next
      }),
      stream: vi.fn()
    }
    const device = createIosDevice({
      udid: UDID,
      simctl: fakeSimctl({}),
      axe,
      resizeImage: noopResize,
      sleep: async (ms) => {
        sleeps.push(ms)
      }
    })
    return { calls, sleeps, device }
  }

  it('No translation object 실패는 잠시 뒤 한 번 다시 시도해 성공한다', async () => {
    const { calls, sleeps, device } = retrySetup([TRANSLATION, execOk(describeUi)])
    await expect(device.dumpUi()).resolves.toEqual(parseAxeUi(describeUi))
    expect(calls).toHaveLength(2)
    expect(sleeps).toEqual([500])
  })

  it('다시 시도해도 실패하면 두 번째 에러를 던지고 더 시도하지 않는다', async () => {
    const { calls, device } = retrySetup([TRANSLATION, TRANSLATION, execOk(describeUi)])
    await expect(device.dumpUi()).rejects.toBe(TRANSLATION)
    expect(calls).toHaveLength(2)
  })

  it('다른 stderr는 다시 시도하지 않고 원래 에러를 던진다', async () => {
    const other = deviceError('command_failed', 'axe 명령이 실패했다', '힌트', { stderr: 'boom' })
    const { calls, sleeps, device } = retrySetup([other, execOk(describeUi)])
    await expect(device.dumpUi()).rejects.toBe(other)
    expect(calls).toHaveLength(1)
    expect(sleeps).toEqual([])
  })
})

describe('IosDevice axe 없음', () => {
  it.each([
    ['tap', (d: ReturnType<typeof createIosDevice>) => d.tap(1, 2)],
    ['swipe', (d: ReturnType<typeof createIosDevice>) => d.swipe(1, 2, 3, 4, 100)],
    ['inputText', (d: ReturnType<typeof createIosDevice>) => d.inputText('a')],
    ['pressKey', (d: ReturnType<typeof createIosDevice>) => d.pressKey('home')],
    ['dumpUi', (d: ReturnType<typeof createIosDevice>) => d.dumpUi()],
    ['displayFrame', (d: ReturnType<typeof createIosDevice>) => d.displayFrame()]
  ])('%s는 ios_tool_not_found', async (_name, run) => {
    const simctl = fakeSimctl({})
    const device = createIosDevice({ udid: UDID, simctl, axe: null, resizeImage: noopResize })
    await expect(run(device)).rejects.toMatchObject({ toolError: { kind: 'ios_tool_not_found', hint: AXE_HINT } })
    expect(simctl.calls).toEqual([])
  })
})
