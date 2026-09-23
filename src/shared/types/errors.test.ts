import { describe, expect, it } from 'vitest'
import { DeviceError, deviceError } from './errors'

describe('deviceError', () => {
  it('builds a DeviceError carrying kind, message and hint', () => {
    const error = deviceError('no_device', '연결된 기기가 없다', 'device_list로 확인한 뒤 device_boot로 부팅해라')

    expect(error).toBeInstanceOf(DeviceError)
    expect(error).toBeInstanceOf(Error)
    expect(error.toolError.kind).toBe('no_device')
    expect(error.toolError.message).toBe('연결된 기기가 없다')
    expect(error.toolError.hint).toBe('device_list로 확인한 뒤 device_boot로 부팅해라')
  })

  it('carries optional details for the agent to act on', () => {
    const error = deviceError('ambiguous_device', '기기가 여럿이다', 'serial을 지정해라', {
      candidates: ['emulator-5554', 'emulator-5556']
    })

    expect(error.toolError.details).toEqual({ candidates: ['emulator-5554', 'emulator-5556'] })
  })

  it('uses the message as the Error message so stack traces stay readable', () => {
    const error = deviceError('adb_not_found', 'adb를 찾지 못했다', 'Android SDK를 설치해라')

    expect(error.message).toBe('adb를 찾지 못했다')
  })
})
