import 'server-only'
import type { AppContext } from '../context'
import { OPENROUTER_BASE_URL } from '../ai/openrouter'

/**
 * What OpenRouter says about the configured key: its spending limit, whether it is on the free
 * tier, and how many free-model requests are left today. Read-only (GET /key; it does not count
 * against the request limits). Cached for a minute. The key itself is never returned.
 */
export interface OpenRouterStatus {
  reachable: boolean
  error: string | null
  limitUsd: number | null
  usageUsd: number | null
  isFreeTier: boolean | null
  freeRequestsToday: { used: number; limit: number; remaining: number } | null
  checkedAt: string
}

let cache: { key: string; at: number; status: OpenRouterStatus } | null = null

export async function openRouterStatus(ctx: AppContext, fetchImpl: typeof fetch = fetch): Promise<OpenRouterStatus | null> {
  const apiKey = ctx.config().ai.openrouter.apiKey
  if (!apiKey) return null
  const cacheKey = `${apiKey.length}:${apiKey.slice(-4)}`
  if (cache && cache.key === cacheKey && Date.now() - cache.at < 60_000) return cache.status
  const checkedAt = ctx.now().toISOString()
  let status: OpenRouterStatus
  try {
    const response = await fetchImpl(`${OPENROUTER_BASE_URL}/key`, { headers: { authorization: `Bearer ${apiKey}` }, signal: AbortSignal.timeout(10_000) })
    if (response.status === 401) status = { reachable: true, error: 'OpenRouter rejected the API key.', limitUsd: null, usageUsd: null, isFreeTier: null, freeRequestsToday: null, checkedAt }
    else if (!response.ok) status = { reachable: true, error: `OpenRouter answered HTTP ${response.status}.`, limitUsd: null, usageUsd: null, isFreeTier: null, freeRequestsToday: null, checkedAt }
    else {
      const body = (await response.json()) as { data?: Record<string, unknown> }
      const d = body.data ?? {}
      const free = d.free_model_daily_requests as { used?: number; limit?: number; remaining?: number } | undefined
      status = {
        reachable: true,
        error: null,
        limitUsd: typeof d.limit === 'number' ? d.limit : null,
        usageUsd: typeof d.usage === 'number' ? d.usage : null,
        isFreeTier: typeof d.is_free_tier === 'boolean' ? d.is_free_tier : null,
        freeRequestsToday: free && typeof free.limit === 'number' ? { used: free.used ?? 0, limit: free.limit, remaining: free.remaining ?? free.limit - (free.used ?? 0) } : null,
        checkedAt,
      }
    }
  } catch {
    status = { reachable: false, error: 'Could not reach OpenRouter.', limitUsd: null, usageUsd: null, isFreeTier: null, freeRequestsToday: null, checkedAt }
  }
  cache = { key: cacheKey, at: Date.now(), status }
  return status
}
