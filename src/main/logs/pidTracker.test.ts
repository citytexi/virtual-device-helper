import { describe, expect, it } from 'vitest'
import { createPidTracker, packageFromProcessName } from './pidTracker'
import type { LogLine } from '../../shared/types/device'

const ps =
  '  PID NAME\n    1 init\n 8383 com.android.settings\n 7601 com.android.chrome:sandboxed_process0:org.chromium.content.app.SandboxedProcessService0:29\n'

const start = (pid: number, proc: string): LogLine => ({
  timestamp: '09-28 10:00:00.000',
  level: 'I',
  tag: 'ActivityManager',
  pid: 500,
  message: `Start proc ${pid}:${proc}/u0a123 for top-activity {${proc.split(':')[0]}/.Main}`,
})

describe('packageFromProcessName', () => {
  it('strips the process suffix', () => {
    expect(packageFromProcessName('com.android.chrome:sandboxed_process0:x:29')).toBe(
      'com.android.chrome'
    )
  })
})

describe('createPidTracker', () => {
  it('seeds from ps', () => {
    const t = createPidTracker()
    t.seed(ps)
    expect(t.packageOf(8383)).toBe('com.android.settings')
    expect(t.packageOf(7601)).toBe('com.android.chrome')
  })

  it('learns a started process and reports a new package', () => {
    const t = createPidTracker()
    expect(t.observe(start(9000, 'com.example.app'))).toBe(true)
    expect(t.observe(start(9001, 'com.example.app:remote'))).toBe(false)
    expect(t.pidsOf('com.example.app')).toEqual([9000, 9001])
  })

  it('keeps a dead pid in history after the pid is reused', () => {
    const t = createPidTracker()
    t.observe(start(9000, 'com.example.app'))
    t.observe(start(9000, 'com.other'))
    expect(t.packageOf(9000)).toBe('com.other')
    expect(t.pidsOf('com.example.app')).toEqual([9000])
  })

  it('ignores Start proc from other tags', () => {
    const t = createPidTracker()
    expect(t.observe({ ...start(9000, 'com.x'), tag: 'Fake' })).toBe(false)
    expect(t.packageOf(9000)).toBeUndefined()
  })

  it('does not report a package already known from seed as new', () => {
    const t = createPidTracker()
    t.seed(ps)
    expect(t.observe(start(8383, 'com.android.settings'))).toBe(false)
  })

  it('pidsOf returns a copy the caller cannot use to change the history', () => {
    const t = createPidTracker()
    t.observe(start(9000, 'com.android.settings'))
    t.pidsOf('com.android.settings').push(1)
    expect(t.pidsOf('com.android.settings')).toEqual([9000])
  })

  it('pidsOf includes seeded pids and stays first-seen order without duplicates', () => {
    const t = createPidTracker()
    t.seed(ps)
    t.observe(start(9000, 'com.android.settings'))
    t.observe(start(9000, 'com.android.settings')) // 중복 관찰
    expect(t.pidsOf('com.android.settings')).toEqual([8383, 9000])
  })

  it('skips the ps header line and kernel threads named like [foo]', () => {
    const t = createPidTracker()
    t.seed('  PID NAME\n    2 [kthreadd]\n    1 init\n')
    expect(t.packageOf(2)).toBeUndefined()
    expect(t.packageOf(1)).toBe('init')
  })

  it('packages() returns known package names sorted', () => {
    const t = createPidTracker()
    t.observe(start(9001, 'com.b'))
    t.observe(start(9000, 'com.a'))
    expect(t.packages()).toEqual(['com.a', 'com.b'])
  })
})
