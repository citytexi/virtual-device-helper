import type { JSX } from 'react'
import { ScreenshotView } from './ScreenshotView'

export interface DeviceScreenProps {
  serial: string | null
}

export function DeviceScreen({ serial }: DeviceScreenProps): JSX.Element {
  return (
    <section aria-label="기기 화면" className="device-screen">
      {serial ? (
        <>
          <div className="screen-toolbar">
            <h2 className="pane-title">화면</h2>
            <span className="device-serial mono">{serial}</span>
          </div>
          <ScreenshotView serial={serial} />
        </>
      ) : (
        <p className="empty">기기를 선택해라. 왼쪽 목록에서 실행 중인 기기를 누르면 화면이 뜬다.</p>
      )}
    </section>
  )
}
