import { describe, expect, it } from 'vitest'
import { locateSdk } from './locateSdk'

function deps(env: Record<string, string>, existing: string[]) {
  return {
    env,
    exists: (p: string) => existing.includes(p),
    homedir: () => '/Users/tester'
  }
}

describe('locateSdk', () => {
  it('prefers ANDROID_HOME when its adb exists', () => {
    const result = locateSdk(
      deps({ ANDROID_HOME: '/opt/sdk' }, ['/opt/sdk/platform-tools/adb', '/opt/sdk/emulator/emulator'])
    )

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.paths.sdkRoot).toBe('/opt/sdk')
    expect(result.paths.adb).toBe('/opt/sdk/platform-tools/adb')
    expect(result.paths.emulator).toBe('/opt/sdk/emulator/emulator')
    expect(result.paths.source).toBe('ANDROID_HOME')
  })

  it('falls through to ANDROID_SDK_ROOT when ANDROID_HOME has no adb', () => {
    const result = locateSdk(
      deps({ ANDROID_HOME: '/opt/empty', ANDROID_SDK_ROOT: '/opt/sdk' }, [
        '/opt/sdk/platform-tools/adb',
        '/opt/sdk/emulator/emulator'
      ])
    )

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.paths.source).toBe('ANDROID_SDK_ROOT')
  })

  it('falls through to the macOS default location', () => {
    const result = locateSdk(
      deps({}, [
        '/Users/tester/Library/Android/sdk/platform-tools/adb',
        '/Users/tester/Library/Android/sdk/emulator/emulator'
      ])
    )

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.paths.sdkRoot).toBe('/Users/tester/Library/Android/sdk')
    expect(result.paths.source).toBe('default')
  })

  it('falls through to PATH as the last resort', () => {
    const result = locateSdk(
      deps({ PATH: '/usr/local/bin:/opt/sdk/platform-tools' }, [
        '/opt/sdk/platform-tools/adb',
        '/opt/sdk/emulator/emulator'
      ])
    )

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.paths.adb).toBe('/opt/sdk/platform-tools/adb')
    expect(result.paths.source).toBe('PATH')
  })

  it('reports every path it searched when nothing is found', () => {
    const result = locateSdk(deps({ ANDROID_HOME: '/opt/empty' }, []))

    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.searched).toContain('/opt/empty/platform-tools/adb')
    expect(result.searched).toContain('/Users/tester/Library/Android/sdk/platform-tools/adb')
    expect(result.searched.length).toBeGreaterThan(1)
  })

  it('requires the emulator binary too, not just adb', () => {
    const result = locateSdk(deps({ ANDROID_HOME: '/opt/sdk' }, ['/opt/sdk/platform-tools/adb']))

    expect(result.ok).toBe(false)
  })

  it('dedupes searched paths when ANDROID_HOME and ANDROID_SDK_ROOT point to the same place', () => {
    const result = locateSdk(
      deps({ ANDROID_HOME: '/opt/sdk', ANDROID_SDK_ROOT: '/opt/sdk' }, [])
    )

    expect(result.ok).toBe(false)
    if (result.ok) return
    const occurrences = result.searched.filter((path) => path === '/opt/sdk/platform-tools/adb')
    expect(occurrences).toHaveLength(1)
  })
})
