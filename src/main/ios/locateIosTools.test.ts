import { describe, expect, it, vi } from 'vitest'
import { locateIosTools } from './locateIosTools'

function enoent(): NodeJS.ErrnoException {
  const error = new Error('spawn xcrun ENOENT') as NodeJS.ErrnoException
  error.code = 'ENOENT'
  return error
}

describe('locateIosTools', () => {
  it('macOS가 아니면 도구를 찾지 않고 ok false다', async () => {
    const execFile = vi.fn()

    const result = await locateIosTools({ platform: 'linux', execFile })

    expect(result).toEqual({ ok: false, reason: 'macOS에서만 iOS 시뮬레이터를 쓸 수 있다' })
    expect(execFile).not.toHaveBeenCalled()
  })

  it('xcrun이 없으면 ok false다', async () => {
    const execFile = vi.fn(async (command: string) => {
      if (command === 'xcode-select') return { stdout: '/Applications/Xcode.app/Contents/Developer\n' }
      throw enoent()
    })

    const result = await locateIosTools({ platform: 'darwin', execFile })

    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.reason).toEqual(expect.any(String))
  })

  it('xcode-select -p가 실패하면 ok false다', async () => {
    const execFile = vi.fn(async (command: string) => {
      if (command === 'xcode-select') throw new Error('unable to get active developer directory')
      return { stdout: '' }
    })

    const result = await locateIosTools({ platform: 'darwin', execFile })

    expect(result.ok).toBe(false)
  })

  it('xcode-select -p와 xcrun simctl help가 모두 성공하면 developerDir을 돌려준다', async () => {
    const execFile = vi.fn(async (command: string) =>
      command === 'xcode-select' ? { stdout: '/Applications/Xcode.app/Contents/Developer\n' } : { stdout: 'usage: simctl' }
    )

    const result = await locateIosTools({ platform: 'darwin', execFile })

    expect(result).toEqual({ ok: true, developerDir: '/Applications/Xcode.app/Contents/Developer' })
    expect(execFile).toHaveBeenCalledWith('xcode-select', ['-p'])
    expect(execFile).toHaveBeenCalledWith('xcrun', ['simctl', 'help'])
  })
})
