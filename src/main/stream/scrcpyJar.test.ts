import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { resolveScrcpyJar, SCRCPY_SERVER_VERSION } from './scrcpyJar'

const REPO_ROOT = join(__dirname, '..', '..', '..')
const VERSION_FILE = readFileSync(join(REPO_ROOT, 'vendor', 'scrcpy', 'VERSION'), 'utf8').split('\n')

describe('SCRCPY_SERVER_VERSION', () => {
  it('matches the pinned tag in vendor/scrcpy/VERSION', () => {
    // 서버는 첫 인자가 자기 버전과 정확히 같지 않으면 뜨지 않는다.
    expect(`v${SCRCPY_SERVER_VERSION}`).toBe(VERSION_FILE[0]?.trim())
  })

  it('points at a jar whose sha-256 matches the pinned hash', () => {
    const pinned = VERSION_FILE[1]?.split(/\s+/)[0]
    const actual = createHash('sha256')
      .update(readFileSync(join(REPO_ROOT, 'vendor', 'scrcpy', 'scrcpy-server.jar')))
      .digest('hex')

    expect(actual).toBe(pinned)
  })
})

describe('resolveScrcpyJar', () => {
  it('uses the vendor copy while developing', () => {
    expect(resolveScrcpyJar({ isPackaged: false, resourcesPath: '/ignored', appPath: '/repo' })).toBe(
      join('/repo', 'vendor', 'scrcpy', 'scrcpy-server.jar')
    )
  })

  it('uses the resources copy in a packaged app', () => {
    expect(
      resolveScrcpyJar({ isPackaged: true, resourcesPath: '/App.app/Contents/Resources', appPath: '/ignored' })
    ).toBe(join('/App.app/Contents/Resources', 'scrcpy-server.jar'))
  })
})
