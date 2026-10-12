import 'server-only'
import type { AppContext } from '../context'
import { settingsFilePath, writeSetting } from '../local-settings'
import { setRuntimeAiEnabled, setRuntimeAiProvider, setRuntimeKey } from '../runtime'
import { recordAudit } from './audit'
import { forgetConnectionCheck } from './connection'
import { ServiceError } from './errors'

/**
 * Settings changed from the UI.
 *
 * API keys entered here are either kept in server memory only (see runtime.ts; lost when
 * the app restarts) or, when you choose "Save on this computer", written to the settings
 * file (local-settings.ts). Never in the database or logs, and never sent back to the
 * browser. The AI on/off preference is not secret and is saved in the database.
 */
const KEY_SETTING = { legendkeeper: 'LEGENDKEEPER_API_KEY', anthropic: 'ANTHROPIC_API_KEY', openrouter: 'OPENROUTER_API_KEY' } as const

export function setApiKey(ctx: AppContext, kind: 'legendkeeper' | 'anthropic' | 'openrouter', value: string | null, options: { persist?: boolean } = {}) {
  let trimmed: string | null = null
  if (value !== null) {
    trimmed = value.trim()
    if (trimmed.length < 8 || trimmed.length > 500 || /\s/.test(trimmed)) throw new ServiceError(400, 'That does not look like an API key.')
  }
  if (kind === 'legendkeeper') forgetConnectionCheck()
  if (options.persist) {
    try {
      writeSetting(KEY_SETTING[kind], trimmed)
    } catch {
      throw new ServiceError(500, `The key could not be saved to ${settingsFilePath()}. Check that the folder can be written to.`)
    }
    // The saved key is now the one in use; a session key would hide it.
    setRuntimeKey(kind, null)
    recordAudit(ctx, { operation: `settings.${kind}_key`, outcome: 'success', message: trimmed === null ? 'Saved key removed from this computer' : 'Key saved on this computer (settings file)' })
    return
  }
  setRuntimeKey(kind, trimmed)
  recordAudit(ctx, { operation: `settings.${kind}_key`, outcome: 'success', message: trimmed === null ? 'Session key cleared' : 'Session key set (kept in memory only)' })
}

/** Remembers the AI provider choice in the settings file (`null` = back to the default rule). */
export function saveAiProvider(ctx: AppContext, provider: 'openrouter' | 'anthropic' | null) {
  writeSetting('LKC_AI_PROVIDER', provider)
  setRuntimeAiProvider(null)
  recordAudit(ctx, { operation: 'settings.ai_provider', outcome: 'success', message: provider ? `AI provider saved: ${provider}` : 'Saved AI provider choice removed' })
}

export function setAiEnabled(ctx: AppContext, enabled: boolean) {
  ctx.repos.settings.set('ai.enabled', enabled)
  setRuntimeAiEnabled(enabled ? null : false)
  recordAudit(ctx, { operation: 'settings.ai_enabled', outcome: 'success', message: enabled ? 'AI processing switched on' : 'AI processing switched off' })
}

/** Chooses the AI service for this session (`null` = back to the .env.local choice). Not secret. */
export function setAiProvider(ctx: AppContext, provider: 'openrouter' | 'anthropic' | null) {
  setRuntimeAiProvider(provider)
  recordAudit(ctx, { operation: 'settings.ai_provider', outcome: 'success', message: provider ? `AI provider set to ${provider} for this session` : 'AI provider back to the configured default' })
}
