import { describe, expect, it, vi } from 'vitest'
import { locateAxe } from './locateAxe'

describe('locateAxe', () => {
  it('prefers /opt/homebrew/bin/axe', async () => {
    const which = vi.fn(async () => '/somewhere/axe')
    const found = await locateAxe({ fileExists: () => true, which })
    expect(found).toBe('/opt/homebrew/bin/axe')
    expect(which).not.toHaveBeenCalled()
  })

  it('falls back to /usr/local/bin/axe', async () => {
    const found = await locateAxe({ fileExists: (path) => path === '/usr/local/bin/axe', which: async () => null })
    expect(found).toBe('/usr/local/bin/axe')
  })

  it('falls back to PATH lookup', async () => {
    const found = await locateAxe({ fileExists: () => false, which: async () => '/custom/bin/axe' })
    expect(found).toBe('/custom/bin/axe')
  })

  it('returns null when nothing is found', async () => {
    const found = await locateAxe({ fileExists: () => false, which: async () => null })
    expect(found).toBeNull()
  })
})
