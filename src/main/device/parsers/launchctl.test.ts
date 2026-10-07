import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { parseLaunchctlList } from './launchctl'

const fixture = readFileSync(join(__dirname, '__fixtures__', 'ios', 'launchctl-list.txt'), 'utf8')

describe('parseLaunchctlList', () => {
  const apps = parseLaunchctlList(fixture)

  it('returns the pid of a running UIKitApplication', () => {
    expect(apps).toContainEqual({ pid: 11829, bundleId: 'com.apple.Preferences' })
  })

  it('drops lines whose pid is "-" and non-UIKitApplication labels', () => {
    expect(apps.every((app) => Number.isInteger(app.pid) && app.pid > 0)).toBe(true)
    expect(apps.some((app) => app.bundleId.startsWith('UIKitApplication'))).toBe(false)
    expect(apps.some((app) => app.bundleId === 'com.apple.homed')).toBe(false)
  })

  it('strips the bracket suffix from the label', () => {
    expect(apps.some((app) => app.bundleId.includes('['))).toBe(false)
  })
})
