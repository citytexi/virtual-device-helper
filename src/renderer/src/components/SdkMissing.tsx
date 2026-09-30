import type { JSX } from 'react'
import type { PlatformStatuses } from '../../../shared/types/ipc'

export interface SdkMissingProps {
  platforms: PlatformStatuses
}

/**
 * Android SDK도 iOS 도구도 못 찾으면 화면 전체를 이걸로 바꾼다. 조작할 수 없는 UI를 보여주면서
 * 왜 안 되는지 따로 설명하는 것보다 낫다. 두 플랫폼의 안내를 함께 그리고, Android는 찾아본
 * 경로를 모두 나열해 사용자가 원인을 직접 볼 수 있게 한다.
 */
export function SdkMissing({ platforms }: SdkMissingProps): JSX.Element {
  const { android, ios } = platforms

  return (
    <main aria-label="Android SDK를 찾지 못했다" className="app-message sdk-missing">
      <h1>Android SDK를 찾지 못했다</h1>

      <p>
        이 앱은 Android SDK를 번들하지 않는다. 호스트에 설치된 SDK를 쓴다. Android Studio를 설치하고
        Device Manager에서 AVD를 하나 만든 뒤 앱을 다시 켜라.
      </p>

      <p>
        이미 설치돼 있다면 <code>ANDROID_HOME</code> 또는 <code>ANDROID_SDK_ROOT</code>를 SDK 경로로
        지정하고 앱을 다시 켜라.
      </p>

      <h2>찾아본 경로</h2>
      <ul className="path-list mono">
        {(android.ok ? [] : android.searched).map((path) => (
          <li key={path}>{path}</li>
        ))}
      </ul>

      <h2>iOS 시뮬레이터를 쓸 수 없다</h2>
      {ios.ok ? null : <p>{ios.reason}</p>}
      <p>Xcode를 설치하고 xcode-select -s로 개발자 디렉토리를 정해라</p>
    </main>
  )
}
