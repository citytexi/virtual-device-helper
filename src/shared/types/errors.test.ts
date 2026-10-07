import { describe, expect, it } from 'vitest'
import { DeviceError, deviceError, unsupported } from './errors'

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

describe('unsupported', () => {
  it('uses 를 after a syllable without a final consonant', () => {
    expect(unsupported('ios', '스와이프', 'M4-2에서 지원한다').toolError.message).toBe('iOS에서는 스와이프를 할 수 없다: M4-2에서 지원한다')
  })

  it('uses 을 after a syllable with a final consonant', () => {
    expect(unsupported('ios', '실시간 화면', 'M4-3에서 지원한다').toolError.message).toBe('iOS에서는 실시간 화면을 할 수 없다: M4-3에서 지원한다')
  })

  it('falls back to 을(를) when the action does not end in Hangul', () => {
    expect(unsupported('ios', 'UI 덤프 v2', '이유').toolError.message).toBe('iOS에서는 UI 덤프 v2을(를) 할 수 없다: 이유')
  })

  it('shows the platform with its display label but keeps the raw value in details', () => {
    const error = unsupported('android', '시스템 앱 데이터 지우기', '이유')
    expect(error.toolError.kind).toBe('unsupported')
    expect(error.toolError.message).toBe('Android에서는 시스템 앱 데이터 지우기를 할 수 없다: 이유')
    expect(error.toolError.details).toEqual({ platform: 'android', action: '시스템 앱 데이터 지우기' })
  })
})
