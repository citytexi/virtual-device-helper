import { readdirSync, readFileSync } from 'node:fs'
import { dirname, join, relative, resolve, sep } from 'node:path'
import { describe, expect, it } from 'vitest'

/**
 * ADR-0005의 "위층은 바로 아래층만 부른다"를 지키는지 본다. mcpTools 층은 `Device`
 * 인터페이스(`DeviceRegistry`를 거쳐)만 봐야 하고, Android 구현(`androidDevice`)이나
 * adb 문법을 아는 `adbClient` 층을 직접 import하면 안 된다. 그런 import가 생기면 M4에서
 * iOS 어댑터를 붙일 때 이 층이 Android에 묶인다.
 */
const MCP_DIR = resolve(__dirname)
const MAIN_DIR = resolve(__dirname, '..')
const FORBIDDEN = [join(MAIN_DIR, 'device', 'androidDevice'), join(MAIN_DIR, 'adb')]

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) return sourceFiles(path)
    return /\.tsx?$/.test(entry.name) ? [path] : []
  })
}

function importSpecifiers(source: string): string[] {
  const pattern = /(?:import|export)\s[^'"]*?from\s+['"]([^'"]+)['"]|import\(\s*['"]([^'"]+)['"]\s*\)/g
  return Array.from(source.matchAll(pattern), (match) => (match[1] ?? match[2]) as string)
}

function isForbidden(file: string, specifier: string): boolean {
  if (!specifier.startsWith('.')) return false
  const target = resolve(dirname(file), specifier)
  return FORBIDDEN.some((forbidden) => target === forbidden || target.startsWith(`${forbidden}${sep}`) || target.startsWith(`${forbidden}.`))
}

describe('mcp layer dependency direction (ADR-0005)', () => {
  it('does not import the Android implementation or the adb layer from src/main/mcp', () => {
    const violations = sourceFiles(MCP_DIR).flatMap((file) =>
      importSpecifiers(readFileSync(file, 'utf8'))
        .filter((specifier) => isForbidden(file, specifier))
        .map((specifier) => `${relative(MAIN_DIR, file)} -> ${specifier}`)
    )

    expect(violations).toEqual([])
  })

  it('recognizes a forbidden import (guards the guard)', () => {
    const file = join(MCP_DIR, 'tools', 'observe.ts')
    expect(isForbidden(file, '../../device/androidDevice')).toBe(true)
    expect(isForbidden(file, '../../adb/adbClient')).toBe(true)
    expect(isForbidden(file, '../../device/registry')).toBe(false)
    expect(isForbidden(file, '../../../shared/limits')).toBe(false)
  })
})
