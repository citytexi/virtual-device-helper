import { readFileSync } from 'node:fs'
import { describe, expect, it, vi } from 'vitest'
import type { AdbClient, AdbStream } from './adbClient'
import { deviceError, type DeviceError } from '../../shared/types/errors'
import { trackDevices, type TrackFailure } from './trackDevices'

/**
 * 픽스처는 손으로 지어내지 않고 실제 기기에서 떴다. 호스트는 macOS, 기기는
 * USB로 붙은 SM_A356N(serial `RFCXC00V8AZ`)이다.
 *
 * - `track-devices-single.bin` — `adb track-devices`를 띄우고 2초 뒤 끊어서 받은
 *   그대로다. 기기 하나가 붙어 있는 상태의 스냅샷 한 판이다.
 * - `track-devices-reconnect-cycle.bin` — 같은 명령을 띄운 채 `adb reconnect`를
 *   실행해 받은 그대로다. 상태 전이(device → offline → authorizing → device)와
 *   기기가 목록에서 통째로 사라지는 빈 목록(`0000`)이 한 캡처 안에 다 들어 있다.
 *   빈 목록을 만들려고 케이블을 뽑지는 않았고, `adb reconnect`가 만든 실제
 *   순간을 그대로 떴다.
 */
const SINGLE = readFileSync(new URL('./__fixtures__/track-devices-single.bin', import.meta.url))
const CYCLE = readFileSync(new URL('./__fixtures__/track-devices-reconnect-cycle.bin', import.meta.url))

/**
 * 캡처를 프레임 단위로 자른다. 4자리 16진수 길이 접두사 + 그 길이만큼의 payload가
 * 한 프레임이다. 테스트가 시나리오를 조립할 때 쓰는, 실제 캡처에서 잘라낸 조각이다.
 */
function frames(capture: Buffer): Buffer[] {
  const result: Buffer[] = []
  let offset = 0
  while (offset < capture.length) {
    const length = Number.parseInt(capture.subarray(offset, offset + 4).toString('ascii'), 16)
    const end = offset + 4 + length
    result.push(Buffer.from(capture.subarray(offset, end)))
    offset = end
  }
  return result
}

const CYCLE_FRAMES = frames(CYCLE)
const [DEVICE_FRAME, OFFLINE_FRAME, EMPTY_FRAME, , AUTHORIZING_FRAME] = CYCLE_FRAMES as [
  Buffer,
  Buffer,
  Buffer,
  Buffer,
  Buffer
]

const SERIAL = 'RFCXC00V8AZ'

function fakeClient(): {
  client: AdbClient
  feed: (chunk: Buffer) => void
  fail: (error: DeviceError) => void
  close: (code: number | null) => void
  closed: () => boolean
} {
  let dataCallback: ((chunk: Buffer) => void) | undefined
  let errorCallback: ((error: DeviceError) => void) | undefined
  let closeCallback: ((code: number | null) => void) | undefined
  let closed = false
  const stream: AdbStream = {
    onLine: () => {},
    onData: (callback) => {
      dataCallback = callback
    },
    onClose: (callback) => {
      closeCallback = callback
    },
    onError: (callback) => {
      errorCallback = callback
    },
    close: () => {
      closed = true
    }
  }
  return {
    client: { exec: vi.fn(), stream: () => stream } as unknown as AdbClient,
    feed: (chunk) => dataCallback?.(chunk),
    fail: (error) => errorCallback?.(error),
    close: (code) => closeCallback?.(code),
    closed: () => closed
  }
}

describe('adb track-devices 실제 출력의 프레이밍', () => {
  it('prefixes every payload with its byte length as four hex digits', () => {
    expect(SINGLE.subarray(0, 4).toString('ascii')).toBe('0013')
    expect(SINGLE.length).toBe(4 + 0x13)
    expect(SINGLE.subarray(4).toString('utf8')).toBe(`${SERIAL}\tdevice\n`)
  })

  it('reports an empty device list as a bare 0000 with no newline at all', () => {
    expect(EMPTY_FRAME.toString('ascii')).toBe('0000')
  })

  it('carries several payloads back to back in one capture', () => {
    expect(CYCLE_FRAMES.map((frame) => frame.subarray(4).toString('utf8'))).toEqual([
      `${SERIAL}\tdevice\n`,
      `${SERIAL}\toffline\n`,
      '',
      `${SERIAL}\toffline\n`,
      `${SERIAL}\tauthorizing\n`,
      `${SERIAL}\toffline\n`,
      `${SERIAL}\tdevice\n`
    ])
  })
})

describe('trackDevices', () => {
  it('reports a device as connected using the serial without its length prefix', () => {
    const fake = fakeClient()
    const changes: Array<{ serial: string; connected: boolean }> = []

    trackDevices(fake.client, (serial, connected) => changes.push({ serial, connected }))
    fake.feed(SINGLE)

    expect(changes).toEqual([{ serial: SERIAL, connected: true }])
  })

  it('treats offline and authorizing states as not connected', () => {
    const fake = fakeClient()
    const changes: Array<{ serial: string; connected: boolean }> = []

    trackDevices(fake.client, (serial, connected) => changes.push({ serial, connected }))
    fake.feed(DEVICE_FRAME)
    fake.feed(OFFLINE_FRAME)
    fake.feed(DEVICE_FRAME)
    fake.feed(AUTHORIZING_FRAME)

    expect(changes).toEqual([
      { serial: SERIAL, connected: true },
      { serial: SERIAL, connected: false },
      { serial: SERIAL, connected: true },
      { serial: SERIAL, connected: false }
    ])
  })

  it('reports a disconnect when the device simply drops out of the next snapshot', () => {
    const fake = fakeClient()
    const changes: Array<{ serial: string; connected: boolean }> = []

    trackDevices(fake.client, (serial, connected) => changes.push({ serial, connected }))
    fake.feed(DEVICE_FRAME)
    fake.feed(EMPTY_FRAME)

    expect(changes).toEqual([
      { serial: SERIAL, connected: true },
      { serial: SERIAL, connected: false }
    ])
  })

  it('does not repeat a change when the snapshot repeats the same state', () => {
    const fake = fakeClient()
    const changes: string[] = []

    trackDevices(fake.client, (serial) => changes.push(serial))
    fake.feed(DEVICE_FRAME)
    fake.feed(DEVICE_FRAME)

    expect(changes).toEqual([SERIAL])
  })

  it('reports nothing while the device list stays empty', () => {
    const fake = fakeClient()
    const changes: string[] = []

    trackDevices(fake.client, (serial) => changes.push(serial))
    fake.feed(EMPTY_FRAME)
    fake.feed(EMPTY_FRAME)

    expect(changes).toEqual([])
  })

  it('reports each real change once across the whole captured reconnect cycle', () => {
    const fake = fakeClient()
    const changes: boolean[] = []

    trackDevices(fake.client, (_serial, connected) => changes.push(connected))
    fake.feed(CYCLE)

    expect(changes).toEqual([true, false, true])
  })

  it('reassembles a payload split across chunks', () => {
    const fake = fakeClient()
    const changes: Array<{ serial: string; connected: boolean }> = []

    trackDevices(fake.client, (serial, connected) => changes.push({ serial, connected }))
    fake.feed(SINGLE.subarray(0, 10))
    expect(changes).toEqual([])
    fake.feed(SINGLE.subarray(10))

    expect(changes).toEqual([{ serial: SERIAL, connected: true }])
  })

  it('reassembles a length prefix split across chunks', () => {
    const fake = fakeClient()
    const changes: Array<{ serial: string; connected: boolean }> = []

    trackDevices(fake.client, (serial, connected) => changes.push({ serial, connected }))
    fake.feed(SINGLE.subarray(0, 2))
    expect(changes).toEqual([])
    fake.feed(SINGLE.subarray(2, 3))
    expect(changes).toEqual([])
    fake.feed(SINGLE.subarray(3))

    expect(changes).toEqual([{ serial: SERIAL, connected: true }])
  })

  it('handles a chunk boundary that lands between two complete payloads', () => {
    const fake = fakeClient()
    const changes: boolean[] = []
    const twoFrames = Buffer.concat([DEVICE_FRAME, EMPTY_FRAME])

    trackDevices(fake.client, (_serial, connected) => changes.push(connected))
    fake.feed(twoFrames.subarray(0, DEVICE_FRAME.length))
    fake.feed(twoFrames.subarray(DEVICE_FRAME.length))

    expect(changes).toEqual([true, false])
  })

  it('closes the underlying stream when stopped', () => {
    const fake = fakeClient()
    const stop = trackDevices(fake.client, () => {})

    stop()

    expect(fake.closed()).toBe(true)
  })

  it('forwards a stream error so the consumer can decide a restart policy', () => {
    const fake = fakeClient()
    const failures: TrackFailure[] = []
    const error = deviceError('adb_not_found', 'adb를 찾을 수 없다', 'platform-tools를 확인해라')

    trackDevices(
      fake.client,
      () => {},
      (failure) => failures.push(failure)
    )
    fake.fail(error)

    expect(failures).toEqual([{ error, exitCode: null }])
  })

  it('forwards a close so a tracker that simply died is not mistaken for a quiet one', () => {
    const fake = fakeClient()
    const failures: TrackFailure[] = []

    trackDevices(
      fake.client,
      () => {},
      (failure) => failures.push(failure)
    )
    fake.close(1)

    expect(failures).toEqual([{ error: null, exitCode: 1 }])
  })

  it('reports the failure once when an error is followed by its close', () => {
    const fake = fakeClient()
    const failures: TrackFailure[] = []
    const error = deviceError('command_failed', 'adb가 죽었다', '다시 실행해라')

    trackDevices(
      fake.client,
      () => {},
      (failure) => failures.push(failure)
    )
    fake.fail(error)
    fake.close(null)

    expect(failures).toEqual([{ error, exitCode: null }])
  })

  it('stays usable without an onFailure handler', () => {
    const fake = fakeClient()

    trackDevices(fake.client, () => {})

    expect(() => fake.close(1)).not.toThrow()
  })
})
