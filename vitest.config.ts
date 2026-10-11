import { defineConfig } from 'vitest/config'
import { fileURLToPath } from 'node:url'

export default defineConfig({
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
      // `server-only` throws outside a React Server environment; tests run in plain Node.
      'server-only': fileURLToPath(new URL('./tests/helpers/server-only-stub.ts', import.meta.url)),
    },
  },
  test: {
    include: ['tests/unit/**/*.test.ts', 'tests/contract/**/*.test.ts'],
    environment: 'node',
    // Routine tests never talk to the real LegendKeeper or Anthropic APIs.
    env: {
      LEGENDKEEPER_API_KEY: '',
      ANTHROPIC_API_KEY: '',
      LKC_DATABASE_PATH: ':memory:',
    },
  },
})
