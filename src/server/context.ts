import 'server-only'
import { getConfig, type AppConfig } from './config'
import { openDatabase, type Db } from './db/connection'
import { createRepos, type Repos } from './db/repositories'
import type { LegendKeeperConnector } from './lk/connector'
import { notConfigured } from './lk/errors'
import { LEGENDKEEPER_SDK_VERSION, SdkConnector } from './lk/sdk-connector'
import { AiError, type AiProvider } from './ai/provider'
import { ClaudeProvider } from './ai/claude'
import { runtimeState } from './runtime'
import { seedExamples } from './services/seed'
import { log } from './log'

/**
 * The application context: database repositories, configuration, and factories for the
 * LegendKeeper connector and the AI provider. Services receive it as their first argument,
 * which keeps them testable — tests build a context with an in-memory database, a mock
 * connector and a mock AI provider.
 */
export interface AppContext {
  db: Db
  repos: Repos
  config: () => AppConfig
  /** Throws ConnectorError('not_configured') when no API key is set. */
  connector: () => LegendKeeperConnector
  /** Throws AiError('disabled' | 'not_configured') when AI cannot be used. */
  ai: () => AiProvider
  sdkVersion: string
  now: () => Date
}

const KEY = Symbol.for('lk-companion.context')

export function getAppContext(): AppContext {
  const g = globalThis as unknown as Record<symbol, AppContext | undefined>
  if (!g[KEY]) g[KEY] = createProductionContext()
  return g[KEY]!
}

function createProductionContext(): AppContext {
  const config = getConfig()
  const db = openDatabase(config.databasePath)
  const repos = createRepos(db)

  let cachedConnector: { key: string; connector: LegendKeeperConnector } | null = null
  let cachedAi: { key: string; provider: AiProvider } | null = null

  const ctx: AppContext = {
    db,
    repos,
    config: () => getConfig(),
    connector: () => {
      const current = getConfig()
      if (!current.lk.apiKey) throw notConfigured()
      const cacheKey = `${runtimeState().credentialsGeneration}|${current.lk.baseUrl ?? ''}|${current.lk.apiKey.length}`
      if (!cachedConnector || cachedConnector.key !== cacheKey) {
        cachedConnector = { key: cacheKey, connector: new SdkConnector({ apiKey: current.lk.apiKey, baseUrl: current.lk.baseUrl }) }
      }
      return cachedConnector.connector
    },
    ai: () => {
      const current = getConfig()
      if (!current.ai.enabled) {
        throw new AiError('disabled', current.ai.disabledByEnv ? 'AI processing is switched off (LKC_AI_ENABLED=false).' : 'AI processing is switched off in Settings.')
      }
      if (!current.ai.apiKey) throw new AiError('not_configured', 'No Anthropic API key is configured. Add ANTHROPIC_API_KEY to .env.local, or use the structural (no-AI) transformation.')
      const cacheKey = `${runtimeState().credentialsGeneration}|${current.ai.model}|${current.ai.effort}`
      if (!cachedAi || cachedAi.key !== cacheKey) {
        cachedAi = { key: cacheKey, provider: new ClaudeProvider({ apiKey: current.ai.apiKey, model: current.ai.model, effort: current.ai.effort }) }
      }
      return cachedAi.provider
    },
    sdkVersion: LEGENDKEEPER_SDK_VERSION,
    now: () => new Date(),
  }

  // Startup housekeeping: anything that was mid-flight when the server stopped.
  const interruptedJobs = repos.jobs.markInterrupted()
  const interruptedWrites = repos.drafts.markInterruptedWrites()
  const interruptedScans = repos.index.markRunningInterrupted()
  const interruptedBatches = repos.batches.markInterrupted()
  const interruptedItems = repos.batchItems.markInterrupted()
  const interruptedAudits = repos.auditRuns.markInterrupted()
  if (interruptedJobs || interruptedWrites || interruptedScans || interruptedBatches || interruptedItems.processing || interruptedItems.running || interruptedAudits) {
    log.warn('Recovered from an interrupted run', { interruptedJobs, interruptedWrites, interruptedScans, interruptedBatches, interruptedItems, interruptedAudits })
  }
  const aiPreference = repos.settings.get<boolean>('ai.enabled')
  if (aiPreference === false) runtimeState().aiEnabled = false
  seedExamples(ctx)
  return ctx
}
