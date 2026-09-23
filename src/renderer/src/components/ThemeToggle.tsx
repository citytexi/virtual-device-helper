import { useEffect, useState } from 'react'
import type { JSX } from 'react'

export type ThemePreference = 'system' | 'light' | 'dark'

export const THEME_STORAGE_KEY = 'vdh.theme'

const OPTIONS: { value: ThemePreference; label: string }[] = [
  { value: 'system', label: '시스템' },
  { value: 'light', label: '라이트' },
  { value: 'dark', label: '다크' }
]

function isPreference(value: unknown): value is ThemePreference {
  return value === 'system' || value === 'light' || value === 'dark'
}

// localStorage는 막혀 있을 수 있다(차단된 사이트 데이터 등). 테마는 편의 기능이라
// 저장이 안 되면 이번 세션만 적용하고 넘어간다 — 읽기·쓰기 실패로 UI가 죽으면 안 된다.
function readPreference(): ThemePreference {
  try {
    const stored = localStorage.getItem(THEME_STORAGE_KEY)
    return isPreference(stored) ? stored : 'system'
  } catch {
    return 'system'
  }
}

function writePreference(preference: ThemePreference): void {
  try {
    localStorage.setItem(THEME_STORAGE_KEY, preference)
  } catch {
    // 위 readPreference의 주석과 같은 이유로 무시한다.
  }
}

function applyPreference(preference: ThemePreference): void {
  const root = document.documentElement
  if (preference === 'system') delete root.dataset.theme
  else root.dataset.theme = preference
}

/**
 * 저장된 테마를 첫 렌더 전에 적용한다. ThemeToggle이 없는 화면(SDK 안내,
 * 로딩)에서도 사용자가 고른 테마가 유지되고, 시작할 때 테마가 한 번 뒤집히지 않는다.
 */
export function applyStoredTheme(): void {
  applyPreference(readPreference())
}

/**
 * 라이트·다크 테마 전환. 'system'이면 루트에 data-theme을 두지 않아서
 * app.css의 prefers-color-scheme 규칙이 OS 설정을 따르게 한다.
 */
export function ThemeToggle(): JSX.Element {
  const [preference, setPreference] = useState<ThemePreference>(readPreference)

  useEffect(() => {
    applyPreference(preference)
  }, [preference])

  function choose(next: ThemePreference): void {
    setPreference(next)
    writePreference(next)
  }

  return (
    <div role="radiogroup" aria-label="테마" className="segmented">
      {OPTIONS.map((option) => (
        <label key={option.value} className="segmented-option">
          <input
            type="radio"
            name="theme"
            value={option.value}
            checked={preference === option.value}
            onChange={() => choose(option.value)}
          />
          <span>{option.label}</span>
        </label>
      ))}
    </div>
  )
}
