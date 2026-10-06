import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.integration.test.ts'],
    // 실제 에뮬레이터를 쓰므로 단위 테스트보다 넉넉히 기다린다.
    // 파일들이 같은 기기 하나를 조작한다. 나란히 돌면 한 파일의 탭이 다른 파일의 화면을 바꾼다.
    fileParallelism: false,
    testTimeout: 120_000,
    hookTimeout: 120_000
  }
})
