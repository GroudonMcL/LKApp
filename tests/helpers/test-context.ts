import type { AppConfig } from '@/server/config'
import type { AppContext } from '@/server/context'
import { openDatabase } from '@/server/db/connection'
import { createRepos } from '@/server/db/repositories'
import { AiError } from '@/server/ai/provider'
import { notConfigured } from '@/server/lk/errors'
import { seedExamples } from '@/server/services/seed'
import { MockConnector } from './mock-connector'
import { MockAiProvider } from './mock-ai'

export interface TestContext extends AppContext {
  lk: MockConnector
  aiMock: MockAiProvider
  settings: AppConfig
  clock: { now: Date }
}

/** A fresh app context with an in-memory database, a mock LegendKeeper and a mock AI. */
export function createTestContext(options: { resources?: ConstructorParameters<typeof MockConnector>[0]; config?: Partial<{ lk: Partial<AppConfig['lk']>; ai: Partial<AppConfig['ai']> }> } = {}): TestContext {
  const db = openDatabase(':memory:')
  const repos = createRepos(db)
  const lk = new MockConnector(options.resources ?? [])
  const aiMock = new MockAiProvider()
  const settings: AppConfig = {
    lk: { apiKey: 'lk_test_key_for_unit_tests', apiKeySource: 'env', baseUrl: null, allowWrites: true, sandboxParentId: 'sandbox0001', ...options.config?.lk },
    ai: {
      provider: 'anthropic',
      providerSource: 'env',
      apiKey: 'sk-ant-test-key-for-unit-tests',
      apiKeySource: 'env',
      enabled: true,
      disabledByEnv: false,
      model: 'mock-model',
      effort: 'high',
      anthropic: { apiKey: 'sk-ant-test-key-for-unit-tests', apiKeySource: 'env', model: 'mock-model' },
      openrouter: { apiKey: null, apiKeySource: null, model: 'openrouter/free' },
      ...options.config?.ai,
    },
    databasePath: ':memory:',
    limits: { maxUploadBytes: 200_000, maxSourceChars: 20_000, maxDocumentBytes: 5_000_000 },
  }
  const clock = { now: new Date('2026-10-11T12:00:00Z') }
  const ctx: TestContext = {
    db,
    repos,
    lk,
    aiMock,
    settings,
    clock,
    config: () => settings,
    connector: () => {
      if (!settings.lk.apiKey) throw notConfigured()
      return lk
    },
    ai: () => {
      if (!settings.ai.enabled) throw new AiError('disabled', 'AI processing is switched off in Settings.')
      if (!settings.ai.apiKey) throw new AiError('not_configured', 'No Anthropic API key is configured.')
      return aiMock
    },
    sdkVersion: '4.0.0',
    now: () => clock.now,
  }
  seedExamples(ctx)
  return ctx
}

export function utf8(text: string): Uint8Array {
  return new TextEncoder().encode(text)
}
