import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

export type SdkSource = 'ANDROID_HOME' | 'ANDROID_SDK_ROOT' | 'default' | 'PATH'

export interface SdkPaths {
  sdkRoot: string
  adb: string
  emulator: string
  source: SdkSource
}

export interface LocateSdkDeps {
  env: Record<string, string | undefined>
  exists: (path: string) => boolean
  homedir: () => string
}

export type LocateSdkResult =
  | { ok: true; paths: SdkPaths }
  | { ok: false; searched: string[] }

export function defaultLocateSdkDeps(): LocateSdkDeps {
  return { env: process.env, exists: existsSync, homedir }
}

function pathsFor(sdkRoot: string, source: SdkSource): SdkPaths {
  return {
    sdkRoot,
    adb: join(sdkRoot, 'platform-tools', 'adb'),
    emulator: join(sdkRoot, 'emulator', 'emulator'),
    source
  }
}

/**
 * Android SDK를 찾는다. 번들하지 않고 호스트 설치분을 쓴다 (ADR-0003).
 * adb와 emulator 둘 다 있어야 유효한 SDK로 본다 — adb만 있으면 켤 기기가 없다.
 */
export function locateSdk(deps: LocateSdkDeps): LocateSdkResult {
  const searched: string[] = []

  const candidates: SdkPaths[] = []

  const androidHome = deps.env.ANDROID_HOME
  if (androidHome) candidates.push(pathsFor(androidHome, 'ANDROID_HOME'))

  const sdkRoot = deps.env.ANDROID_SDK_ROOT
  if (sdkRoot) candidates.push(pathsFor(sdkRoot, 'ANDROID_SDK_ROOT'))

  candidates.push(pathsFor(join(deps.homedir(), 'Library', 'Android', 'sdk'), 'default'))

  for (const entry of (deps.env.PATH ?? '').split(':')) {
    if (!entry) continue
    const adb = join(entry, 'adb')
    if (!deps.exists(adb)) {
      searched.push(adb)
      continue
    }
    // platform-tools/adb 형태를 가정하고 두 단계 위를 SDK 루트로 본다.
    candidates.push(pathsFor(dirname(dirname(adb)), 'PATH'))
  }

  for (const candidate of candidates) {
    const adbOk = deps.exists(candidate.adb)
    const emulatorOk = deps.exists(candidate.emulator)
    if (!adbOk) searched.push(candidate.adb)
    if (adbOk && !emulatorOk) searched.push(candidate.emulator)
    if (adbOk && emulatorOk) return { ok: true, paths: candidate }
  }

  return { ok: false, searched }
}
