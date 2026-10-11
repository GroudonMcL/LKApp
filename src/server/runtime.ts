import 'server-only'

/**
 * In-memory runtime state for this server process.
 *
 * API keys entered on the Settings page live here only: they are never written to disk,
 * never stored in the database, and are forgotten when the server stops. That keeps them
 * out of backups and Git, at the cost of re-entering them after a restart. For permanent
 * configuration use `.env.local` instead (see README → Configuration).
 *
 * Stored on `globalThis` so Next.js hot reloading in development does not lose it.
 */
interface RuntimeState {
  lkApiKey: string | null
  anthropicApiKey: string | null
  /** `false` when AI was switched off on the Settings page. `null` = follow the environment. */
  aiEnabled: boolean | null
  /** Bumped whenever credentials change, so cached clients are rebuilt. */
  credentialsGeneration: number
}

const KEY = Symbol.for('lk-companion.runtime')

export function runtimeState(): RuntimeState {
  const g = globalThis as unknown as Record<symbol, RuntimeState | undefined>
  if (!g[KEY]) g[KEY] = { lkApiKey: null, anthropicApiKey: null, aiEnabled: null, credentialsGeneration: 0 }
  return g[KEY]!
}

export function setRuntimeKey(kind: 'legendkeeper' | 'anthropic', value: string | null) {
  const state = runtimeState()
  const cleaned = value && value.trim() !== '' ? value.trim() : null
  if (kind === 'legendkeeper') state.lkApiKey = cleaned
  else state.anthropicApiKey = cleaned
  state.credentialsGeneration++
}

export function setRuntimeAiEnabled(enabled: boolean | null) {
  runtimeState().aiEnabled = enabled
}
