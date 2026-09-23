import { cleanup } from '@testing-library/react'
import { afterEach } from 'vitest'

// React Testing Library는 자동 cleanup을 위해 vitest의 전역(globals: true)을
// 전제하는데 이 저장소는 그것을 켜지 않는다. 그래서 여기서 직접 등록한다.
// node 환경의 main 쪽 테스트에도 이 파일이 함께 로드되지만 cleanup()은 렌더된
// 것이 없으면 아무 일도 하지 않으므로 안전하다.
afterEach(() => {
  cleanup()
})
