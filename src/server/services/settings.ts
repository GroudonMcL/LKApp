import 'server-only'
import type { AppContext } from '../context'
import { setRuntimeAiEnabled, setRuntimeKey } from '../runtime'
import { recordAudit } from './audit'
import { ServiceError } from './errors'

/**
 * Settings changed from the UI.
 *
 * API keys entered here are kept in server memory only (see runtime.ts): not in the
 * database, not on disk, not in logs, and never sent back to the browser. They are lost
 * when the app restarts. The AI on/off preference is not secret and is saved.
 */
export function setApiKey(ctx: AppContext, kind: 'legendkeeper' | 'anthropic', value: string | null) {
  if (value !== null) {
    const trimmed = value.trim()
    if (trimmed.length < 8 || trimmed.length > 500 || /\s/.test(trimmed)) throw new ServiceError(400, 'That does not look like an API key.')
  }
  setRuntimeKey(kind, value)
  recordAudit(ctx, { operation: `settings.${kind}_key`, outcome: 'success', message: value === null ? 'Session key cleared' : 'Session key set (kept in memory only)' })
}

export function setAiEnabled(ctx: AppContext, enabled: boolean) {
  ctx.repos.settings.set('ai.enabled', enabled)
  setRuntimeAiEnabled(enabled ? null : false)
  recordAudit(ctx, { operation: 'settings.ai_enabled', outcome: 'success', message: enabled ? 'AI processing switched on' : 'AI processing switched off' })
}
