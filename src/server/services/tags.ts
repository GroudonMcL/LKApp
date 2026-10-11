import 'server-only'
import type { ExistingTag } from '@/core/tagging'
import type { AppContext } from '../context'
import { ConnectorError, toConnectorError } from '../lk/errors'
import { knownProjectId } from './connection'

/**
 * Read-only tag information.
 *
 * `tags.list` returns every tag with its usage count, but requires an ADMIN key. With a
 * MEMBER key (or offline), tags are counted from the local resource index instead, which is
 * only as fresh as the last scan. The response always says which source was used.
 */

export type TagSource = 'api' | 'index' | 'none'

export interface TagOverview {
  source: TagSource
  sourceNote: string
  tags: ExistingTag[]
  apiError: ReturnType<ConnectorError['toJSON']> | null
  indexScannedAt: string | null
  untaggedCount: number | null
  indexedCount: number | null
}

const CACHE = Symbol.for('lk-companion.tag-cache')
const CACHE_MS = 5 * 60 * 1000
type Cache = { at: number; projectId: string; tags: ExistingTag[] } | { at: number; projectId: string; error: ReturnType<ConnectorError['toJSON']> }

export async function tagOverview(ctx: AppContext, options: { refresh?: boolean } = {}): Promise<TagOverview> {
  const projectId = knownProjectId(ctx)
  const indexStats = projectId ? ctx.repos.index.stats(projectId) : null
  const lastScan = projectId ? ctx.repos.index.lastCompletedScan(projectId) : null
  const indexScannedAt = lastScan?.finishedAt ?? null

  let apiTags: ExistingTag[] | null = null
  let apiError: ReturnType<ConnectorError['toJSON']> | null = null
  if (ctx.config().lk.apiKey) {
    const g = globalThis as unknown as Record<symbol, Cache | undefined>
    const cached = g[CACHE]
    if (!options.refresh && cached && cached.projectId === projectId && Date.now() - cached.at < CACHE_MS) {
      if ('tags' in cached) apiTags = cached.tags
      else apiError = cached.error
    } else {
      try {
        apiTags = await ctx.connector().listTags()
        if (projectId) g[CACHE] = { at: Date.now(), projectId, tags: apiTags }
      } catch (error) {
        apiError = toConnectorError(error).toJSON()
        if (projectId) g[CACHE] = { at: Date.now(), projectId, error: apiError }
      }
    }
  }

  const base = { apiError, indexScannedAt, untaggedCount: indexStats && indexStats.total > 0 ? indexStats.untagged : null, indexedCount: indexStats?.total ?? null }
  if (apiTags) {
    return { ...base, source: 'api', sourceNote: 'Live from LegendKeeper (tags.list). Counts exclude resources in the trash.', tags: apiTags }
  }
  if (projectId && indexStats && indexStats.total > 0) {
    const reason = apiError?.kind === 'permission' ? 'The API key is not an ADMIN key, so the live tag list is not available. ' : apiError ? 'The live tag list could not be read. ' : ''
    return {
      ...base,
      source: 'index',
      sourceNote: `${reason}Counted from the local resource index${indexScannedAt ? ` (last complete scan ${indexScannedAt})` : ' (scan not yet complete)'}.`,
      tags: ctx.repos.index.tagCounts(projectId),
    }
  }
  return {
    ...base,
    source: 'none',
    sourceNote: apiError ? `${apiError.message} Run a project scan to count tags from the resource index instead.` : 'No tag information yet. Test the connection and run a project scan.',
    tags: [],
  }
}

/** Existing tags for tag suggestions (best available source; empty when none). */
export async function existingTags(ctx: AppContext): Promise<{ tags: ExistingTag[]; source: TagSource }> {
  const overview = await tagOverview(ctx)
  return { tags: overview.tags, source: overview.source }
}
