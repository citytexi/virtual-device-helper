import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { parseLogcat } from './logcat'

const fixture = readFileSync(join(__dirname, '__fixtures__', 'logcat-threadtime.txt'), 'utf8')

describe('parseLogcat', () => {
  it('splits a threadtime line into its fields', () => {
    const lines = parseLogcat('09-22 11:06:21.123  1234  1256 I ActivityManager: Start proc 5678\n')

    expect(lines).toEqual([
      {
        timestamp: '09-22 11:06:21.123',
        level: 'I',
        tag: 'ActivityManager',
        pid: 1234,
        message: 'Start proc 5678'
      }
    ])
  })

  it('keeps colons inside the message', () => {
    const lines = parseLogcat('09-22 11:06:22.001  5678  5678 E AndroidRuntime: java.lang.IllegalStateException: boom\n')

    expect(lines[0]?.message).toBe('java.lang.IllegalStateException: boom')
  })

  it('drops the "beginning of" separators logcat emits', () => {
    const lines = parseLogcat('--------- beginning of main\n09-22 11:06:21.123  1 2 I Tag: hi\n')

    expect(lines).toHaveLength(1)
  })

  it('drops lines it cannot parse rather than guessing', () => {
    const lines = parseLogcat('this is not a logcat line\n')

    expect(lines).toEqual([])
  })

  it('handles tags containing dots and dashes', () => {
    const lines = parseLogcat('09-22 11:06:22.900  5678  5690 D okhttp.Http2: frame\n')

    expect(lines[0]?.tag).toBe('okhttp.Http2')
  })

  it('parses the recorded fixture and finds at least one error line', () => {
    const lines = parseLogcat(fixture)

    expect(lines.length).toBeGreaterThan(0)
    expect(lines.every((line) => ['V', 'D', 'I', 'W', 'E', 'F'].includes(line.level))).toBe(true)
  })
})
