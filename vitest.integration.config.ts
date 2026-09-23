import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.integration.test.ts'],
    // 실제 에뮬레이터를 쓰므로 단위 테스트보다 넉넉히 기다린다.
    testTimeout: 120_000,
    hookTimeout: 120_000
  }
})
