import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { createIosPidof, createIosSeedPids } from './iosLogDeps'
import { createPidTracker } from './pidTracker'
import { execOk, fakeSimctl } from '../ios/testing'

const LAUNCHCTL = readFileSync(join(__dirname, '../device/parsers/__fixtures__/ios/launchctl-list.txt'), 'utf8')
const KEY = 'spawn UDID-1 launchctl list'

describe('iosLogDeps', () => {
  it('seedPids 결과를 pidTracker가 그대로 읽는다', async () => {
    const simctl = fakeSimctl({ [KEY]: execOk(LAUNCHCTL) })
    const tracker = createPidTracker()
    tracker.seed(await createIosSeedPids(simctl)('UDID-1'))
    expect(tracker.packageOf(11829)).toBe('com.apple.Preferences')
  })

  it('pidof는 bundle id의 pid를 돌려준다', async () => {
    const simctl = fakeSimctl({ [KEY]: execOk(LAUNCHCTL) })
    expect(await createIosPidof(simctl)('UDID-1', 'com.apple.Preferences')).toEqual([11829])
    expect(await createIosPidof(simctl)('UDID-1', 'com.nope')).toEqual([])
  })

  it('simctl이 reject하면 pidof는 빈 배열이다', async () => {
    const simctl = fakeSimctl({ [KEY]: new Error('boom') })
    expect(await createIosPidof(simctl)('UDID-1', 'com.apple.Preferences')).toEqual([])
  })
})
