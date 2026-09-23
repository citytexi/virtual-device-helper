import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts', 'src/**/*.test.tsx'],
    exclude: ['**/node_modules/**', 'src/**/*.integration.test.ts'],
    setupFiles: ['src/renderer/src/test/setup.ts']
  }
})
