import { describe, expect, it, vi } from 'vitest'
import { createPlatformLogDeps } from './platformLogDeps'
import type { LogTailHandlers } from './logTail'

const handlers = {} as LogTailHandlers

function setup(platform: 'android' | 'ios' | 'throw') {
  const android = { createTail: vi.fn(() => 'a-tail'), seedPids: vi.fn(async () => 'a-seed'), pidof: vi.fn(async () => [1]) }
  const ios = { createTail: vi.fn(() => 'i-tail'), seedPids: vi.fn(async () => 'i-seed'), pidof: vi.fn(async () => [2]) }
  const deps = createPlatformLogDeps({
    platformOf: () => {
      if (platform === 'throw') throw new Error('disconnected')
      return platform
    },
    android: android as never,
    ios: ios as never
  })
  return { deps, android, ios }
}

describe('createPlatformLogDeps', () => {
  it('android 기기는 android 구현으로 간다', async () => {
    const { deps, android } = setup('android')
    expect(deps.createTail('s', handlers)).toBe('a-tail')
    expect(await deps.seedPids('s')).toBe('a-seed')
    expect(await deps.pidof('s', 'p')).toEqual([1])
    expect(android.createTail).toHaveBeenCalledWith('s', handlers)
  })

  it('ios 기기는 ios 구현으로 간다', async () => {
    const { deps } = setup('ios')
    expect(deps.createTail('s', handlers)).toBe('i-tail')
    expect(await deps.seedPids('s')).toBe('i-seed')
    expect(await deps.pidof('s', 'p')).toEqual([2])
  })

  it('resolve가 던지면 seed·pidof는 빈 결과, createTail은 android 경로다', async () => {
    const { deps, android, ios } = setup('throw')
    expect(await deps.seedPids('s')).toBe('')
    expect(await deps.pidof('s', 'p')).toEqual([])
    expect(deps.createTail('s', handlers)).toBe('a-tail')
    expect(ios.seedPids).not.toHaveBeenCalled()
    expect(android.seedPids).not.toHaveBeenCalled()
  })

  it('Android SDK가 없으면(android: null) android 기기는 아무것도 하지 않는 tail과 빈 결과를 받는다', async () => {
    const ios = { createTail: vi.fn(() => 'i-tail'), seedPids: vi.fn(async () => 'i-seed'), pidof: vi.fn(async () => [2]) }
    const deps = createPlatformLogDeps({ platformOf: () => 'android', android: null, ios: ios as never })

    const tail = deps.createTail('s', handlers)
    await expect(tail.start()).resolves.toBeUndefined()
    expect(() => tail.stop()).not.toThrow()
    expect(await deps.seedPids('s')).toBe('')
    expect(await deps.pidof('s', 'p')).toEqual([])
    expect(ios.createTail).not.toHaveBeenCalled()
  })

  it('Android SDK가 없어도 ios 기기는 ios 구현으로 간다', async () => {
    const ios = { createTail: vi.fn(() => 'i-tail'), seedPids: vi.fn(async () => 'i-seed'), pidof: vi.fn(async () => [2]) }
    const deps = createPlatformLogDeps({ platformOf: () => 'ios', android: null, ios: ios as never })

    expect(deps.createTail('s', handlers)).toBe('i-tail')
    expect(await deps.seedPids('s')).toBe('i-seed')
  })
})
