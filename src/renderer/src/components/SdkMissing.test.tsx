// @vitest-environment jsdom
import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import type { AppSnapshot } from '../../../shared/types/ipc'
import { SdkMissing } from './SdkMissing'

function missing(
  searched: string[],
  iosReason = 'macOS에서만 iOS 시뮬레이터를 쓸 수 있다',
  iosHint: string | null = null
): AppSnapshot['platforms'] {
  return {
    android: { ok: false, reason: 'Android SDK를 찾지 못했다', searched, hint: null },
    ios: { ok: false, reason: iosReason, searched: [], hint: iosHint }
  }
}

describe('SdkMissing', () => {
  it('says what to install', () => {
    render(<SdkMissing platforms={missing(['/opt/sdk/platform-tools/adb'])} />)

    expect(screen.getByText(/Android Studio/)).toBeDefined()
  })

  it('lists every path it looked at so the user can see why it failed', () => {
    render(<SdkMissing platforms={missing(['/opt/a/adb', '/opt/b/adb'])} />)

    expect(screen.getByText('/opt/a/adb')).toBeDefined()
    expect(screen.getByText('/opt/b/adb')).toBeDefined()
  })

  it('names the environment variables that override the search', () => {
    render(<SdkMissing platforms={missing([])} />)

    expect(screen.getByText(/ANDROID_HOME/)).toBeDefined()
  })

  it('shows the iOS reason and the hint main sent next to the Android guidance', () => {
    const hint = 'Xcode를 설치하고 xcode-select -s로 개발자 디렉토리를 정해라'
    render(<SdkMissing platforms={missing(['/opt/a/adb'], 'xcrun simctl을 실행할 수 없다', hint)} />)

    expect(screen.getByText(/Android Studio/)).toBeDefined()
    expect(screen.getByText('xcrun simctl을 실행할 수 없다')).toBeDefined()
    expect(screen.getByText(hint)).toBeDefined()
  })

  it('does not mention Xcode when main sent no iOS hint', () => {
    render(<SdkMissing platforms={missing(['/opt/a/adb'])} />)

    expect(screen.getByText('macOS에서만 iOS 시뮬레이터를 쓸 수 있다')).toBeDefined()
    expect(screen.queryByText(/Xcode/)).toBeNull()
  })

  it('names the screen without favoring one platform', () => {
    render(<SdkMissing platforms={missing([])} />)

    expect(screen.getByRole('main', { name: '기기 도구를 찾지 못했다' })).toBeDefined()
    expect(screen.getByRole('heading', { level: 1, name: '기기 도구를 찾지 못했다' })).toBeDefined()
  })
})
