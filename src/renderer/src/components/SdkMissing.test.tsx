// @vitest-environment jsdom
import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { SdkMissing } from './SdkMissing'

describe('SdkMissing', () => {
  it('says what to install', () => {
    render(<SdkMissing searched={['/opt/sdk/platform-tools/adb']} />)

    expect(screen.getByText(/Android Studio/)).toBeDefined()
  })

  it('lists every path it looked at so the user can see why it failed', () => {
    render(<SdkMissing searched={['/opt/a/adb', '/opt/b/adb']} />)

    expect(screen.getByText('/opt/a/adb')).toBeDefined()
    expect(screen.getByText('/opt/b/adb')).toBeDefined()
  })

  it('names the environment variables that override the search', () => {
    render(<SdkMissing searched={[]} />)

    expect(screen.getByText(/ANDROID_HOME/)).toBeDefined()
  })
})
