import type { JSX } from 'react'
import { DevicePanel } from './components/DevicePanel'
import { DeviceScreen, type OccupiedScreen } from './components/DeviceScreen'
import { EndpointCard } from './components/EndpointCard'
import { SdkMissing } from './components/SdkMissing'
import { ThemeToggle } from './components/ThemeToggle'
import { WorkArea } from './components/WorkArea'
import { useAppState } from './state/useAppState'

export function App(): JSX.Element {
  const { snapshot, loading, error } = useAppState()

  if (error) {
    // getSnapshot()이 거부되면 main과 아예 대화할 수 없다는 뜻이다 — "불러오는
    // 중…"을 계속 보여주면 영원히 로딩 중인 것처럼 보인다. 에러를 그대로
    // 보여주고 재시작을 안내한다.
    return (
      <main className="app-message">
        <p role="alert">앱 상태를 불러오지 못했다 — {error}. 앱을 다시 시작해라.</p>
      </main>
    )
  }

  if (loading || !snapshot) {
    return <main className="app-message">불러오는 중…</main>
  }

  // 두 플랫폼이 모두 준비되지 않았을 때만 화면 전체를 안내로 바꾼다. 하나만 빠졌으면
  // 기기 패널이 그 위에 한 줄 안내를 띄운다.
  if (!snapshot.platforms.android.ok && !snapshot.platforms.ios.ok) {
    return <SdkMissing platforms={snapshot.platforms} />
  }

  // 여러 화면은 아직 그리지 않는다. 기기가 놓인 첫 칸 하나만 그린다.
  const screen = snapshot.screens.find((s): s is OccupiedScreen => s.serial !== null)

  return (
    <main className="app-shell">
      <header className="app-header">
        <h1 className="app-title">virtual-device-helper</h1>
        <EndpointCard server={snapshot.server} />
        <ThemeToggle />
      </header>

      <aside className="pane pane-devices">
        <DevicePanel snapshot={snapshot} />
      </aside>

      <div className="pane pane-screen">
        {screen ? (
          // 세대가 key를 대신한다. 칸의 기기가 바뀌면 새 캔버스·새 스트림으로 다시 마운트된다.
          <DeviceScreen key={`${screen.id}:${screen.epoch}`} screen={screen} />
        ) : (
          <section aria-label="기기 화면" className="device-screen">
            <p className="empty">연결된 기기가 없다. 왼쪽 목록에서 기기를 부팅해라</p>
          </section>
        )}
      </div>

      <WorkArea snapshot={snapshot} />
    </main>
  )
}
