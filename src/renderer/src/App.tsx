import type { JSX } from 'react'
import { DevicePanel } from './components/DevicePanel'
import { DeviceScreen } from './components/DeviceScreen'
import { EndpointCard } from './components/EndpointCard'
import { SdkMissing } from './components/SdkMissing'
import { WorkArea } from './components/WorkArea'
import { targetSerial, useAppState } from './state/useAppState'

export function App(): JSX.Element {
  const { snapshot, loading, error } = useAppState()

  if (error) {
    // getSnapshot()이 거부되면 main과 아예 대화할 수 없다는 뜻이다 — "불러오는
    // 중…"을 계속 보여주면 영원히 로딩 중인 것처럼 보인다. 에러를 그대로
    // 보여주고 재시작을 안내한다.
    return (
      <main>
        <p role="alert">앱 상태를 불러오지 못했다 — {error}. 앱을 다시 시작해라.</p>
      </main>
    )
  }

  if (loading || !snapshot) {
    return <main>불러오는 중…</main>
  }

  if (!snapshot.sdk.ok) {
    return <SdkMissing searched={snapshot.sdk.searched} />
  }

  return (
    <main>
      <aside>
        <DevicePanel snapshot={snapshot} />
        <DeviceScreen serial={targetSerial(snapshot)} />
        <EndpointCard server={snapshot.server} />
      </aside>

      <WorkArea snapshot={snapshot} />
    </main>
  )
}
