import { defineConfig } from 'vitest/config'
import { fileURLToPath } from 'node:url'

// Optional live tests against an explicitly configured LegendKeeper project.
// They never run as part of `npm test`. See README → "Optional integration tests".
export default defineConfig({
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
      'server-only': fileURLToPath(new URL('./tests/helpers/server-only-stub.ts', import.meta.url)),
    },
  },
  test: {
    include: ['tests/integration/**/*.test.ts'],
    environment: 'node',
    testTimeout: 60_000,
    fileParallelism: false,
  },
})
