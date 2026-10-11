import 'server-only'
import { z } from 'zod'
import { newAppId } from '@/core/ids'
import { estimateCostUsd, PRICES_AS_OF } from '@/core/pricing'
import { allPageTypes } from '@/core/resolve'
import { applyTagChanges, existingTagMap, inferPageType, suggestTagsForPage, TaxonomyConfig, type TagPageInput, type TagSuggestion } from '@/core/tag-assistant'
import { MAX_TAGS_PER_RESOURCE } from '@/core/tagging'
import { normalizeTag } from '@/core/text'
import { TAGS_PROMPT_VERSION } from '../ai/prompts/tags'
import { configuredSecrets } from '../config'
import type { AppContext } from '../context'
import type { Batch, BatchItem } from '../db/batch-repositories'
import { ITEM_STATUS_EXPLANATIONS } from '../db/batch-repositories'
import { sha256Hex, stableStringify } from '../hash'
import { toConnectorError } from '../lk/errors'
import { pageStructure } from '../lk/structure'
import { redactSecrets } from '../redact'
import { recordAudit } from './audit'
import { BATCH_TIMING, cancelRequested, noteModel, runningPhase, sleep, startBatchWork } from './batch-engine'
import { knownProjectId, requireProjectId } from './connection'
import { ServiceError } from './errors'
import { toCsv } from './import-batches'
import { existingTags } from './tags'
import { PageScope, selectPages, type IndexedPage } from './page-scope'

/**
 * Tagging assistant batches: suggest, review, approve and apply tags on existing pages.
 *
 * Applying uses `resources.update` with the full tag list (the documented behaviour: tags
 * replace the whole list; verified live). LegendKeeper offers no version check for this, so
 * right before writing the app reads the page's current tags and compares them with the tags
 * the suggestion was based on. If they differ, the proposal is refreshed and must be approved
 * again. The written list is the page's current tags plus the approved additions (minus
 * removals you explicitly selected), so existing tags are never dropped by accident.
 */

const SETTINGS_KEY = 'tagging.taxonomy'

export function getTaxonomy(ctx: AppContext): { config: TaxonomyConfig; revision: number } {
  const stored = ctx.repos.settings.get<{ config: unknown; revision: number }>(SETTINGS_KEY)
  return { config: TaxonomyConfig.parse(stored?.config ?? {}), revision: stored?.revision ?? 0 }
}

export function saveTaxonomy(ctx: AppContext, input: unknown) {
  const parsed = TaxonomyConfig.safeParse(input)
  if (!parsed.success) throw new ServiceError(400, 'The tagging settings are not valid.', parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`))
  const revision = getTaxonomy(ctx).revision + 1
  ctx.repos.settings.set(SETTINGS_KEY, { config: parsed.data, revision })
  recordAudit(ctx, { operation: 'tagging.taxonomy', outcome: 'success', message: `Tagging settings saved (revision ${revision}, policy ${parsed.data.policy})` })
  return { config: parsed.data, revision }
}

/** Which pages a tagging job covers (shared with template migration). */
export const TaggingScope = PageScope
export type TaggingScope = PageScope

interface TagPlan {
  before: string[]
  suggestions: TagSuggestion[]
  pageType: string | null
  path: string | null
  after?: string[]
  aiUsed: boolean
  version: string | null
  notes: string[]
}

const planOf = (item: BatchItem) => item.plan as TagPlan

function getTaggingBatch(ctx: AppContext, batchId: string): Batch {
  const batch = ctx.repos.batches.get(batchId)
  if (!batch || batch.kind !== 'tagging') throw new ServiceError(404, 'Tagging job not found.')
  return batch
}
function requireUsable(batch: Batch) {
  if (batch.status === 'completed' || batch.status === 'cancelled') throw new ServiceError(409, `This job is ${batch.status}.`)
  const phase = runningPhase(batch.id)
  if (phase) throw new ServiceError(409, `This job is busy (${phase}).`)
}

export async function createTaggingBatch(ctx: AppContext, input: unknown) {
  const parsed = z.object({ name: z.string().trim().min(1).max(200), scope: TaggingScope }).safeParse(input)
  if (!parsed.success) throw new ServiceError(400, 'The tagging job is not valid.', parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`))
  const projectId = await requireProjectId(ctx)
  const pages = ctx.repos.index.forAudit(projectId)
  if (pages.length === 0) throw new ServiceError(409, 'Scan the project first (Page browser → Scan project).')
  const selected = selectPages(pages, parsed.data.scope)
  if (selected.length === 0) throw new ServiceError(400, 'No pages match this selection.')
  const taxonomy = getTaxonomy(ctx)
  const id = newAppId('bat')
  // The tagging settings are copied into the job, so later changes do not alter it.
  ctx.repos.batches.insert({ id, kind: 'tagging', name: parsed.data.name, recipeId: null, recipeVersion: null, templateId: null, options: { scope: parsed.data.scope, taxonomy: taxonomy.config, taxonomyRevision: taxonomy.revision } })
  selected.forEach((page, seq) => {
    ctx.repos.batchItems.insert({ id: newAppId('itm'), batchId: id, seq, kind: 'update_tags', status: 'pending', title: page.name, sourceId: null, jobId: null, resourceId: page.id, flags: page.tags.length ? [] : ['untagged'] })
  })
  ctx.repos.batches.update(id, { status: 'ready' })
  recordAudit(ctx, { operation: 'tagging.create', outcome: 'success', projectId, message: `${parsed.data.name}: ${selected.length} page(s)`, details: { batchId: id, scope: parsed.data.scope, taxonomyRevision: taxonomy.revision } })
  return taggingView(ctx, id)
}

function taxonomyOf(batch: Batch): TaxonomyConfig {
  return TaxonomyConfig.parse((batch.options as { taxonomy?: unknown }).taxonomy ?? {})
}

/** Reads each page (once) and works out suggestions. Reads only. */
export async function suggestTagging(ctx: AppContext, batchId: string, input: { itemIds?: string[]; wait?: boolean } = {}) {
  const batch = getTaggingBatch(ctx, batchId)
  requireUsable(batch)
  const config = taxonomyOf(batch)
  if (config.useAi) {
    try {
      noteModel(ctx, batchId, ctx.ai().model)
    } catch (error) {
      throw new ServiceError(400, `${(error as Error).message} (AI tag suggestions are switched on in the tagging settings.)`)
    }
  }
  const items = ctx.repos.batchItems.list(batchId, { status: ['pending', 'failed'] }).filter((i) => !input.itemIds || input.itemIds.includes(i.id))
  if (items.length === 0) throw new ServiceError(409, 'There are no pages waiting for suggestions.')
  const projectId = await requireProjectId(ctx)

  await startBatchWork(ctx, batchId, 'suggesting', { status: 'processing', wait: input.wait }, async () => {
    const tagInfo = await existingTags(ctx)
    const existing = existingTagMap(tagInfo.tags.map((t) => ({ tag: t.tag, count: t.count ?? 0 })))
    const pages = ctx.repos.index.forAudit(projectId)
    const byId = new Map(pages.map((p) => [p.id, p]))
    const children = new Map<string | null, IndexedPage[]>()
    for (const p of pages) children.set(p.parentId, [...(children.get(p.parentId) ?? []), p])
    const types = allPageTypes()
    const allowed = config.policy === 'approved_taxonomy' ? config.approved.map((e) => ({ tag: e.tag, description: e.description })) : tagInfo.tags.slice(0, 400).map((t) => ({ tag: t.tag }))

    for (const item of items) {
      if (cancelRequested(ctx, batchId)) break
      if (!ctx.repos.batchItems.transition(item.id, ['pending', 'failed'], 'processing')) continue
      try {
        const live = await ctx.connector().getResource(item.resourceId!)
        const doc = live.documents.find((d) => d.type === 'page')
        let text = ''
        let mentionIds: string[] = []
        let version: string | null = null
        if (doc) {
          const content = await ctx.connector().getDocumentContent(live.id, doc.id)
          const structure = pageStructure(content.blocks)
          ctx.repos.contentCache.put(projectId, { resourceId: live.id, documentId: doc.id, version: content.version, structure, fetchedAt: ctx.now().toISOString(), error: null })
          text = structure.text
          mentionIds = structure.mentionIds
          version = content.version
        }
        const ancestors: { id: string; name: string }[] = []
        let cursor = live.parentId ? byId.get(live.parentId) : undefined
        for (let guard = 0; cursor && guard < 50; guard++) {
          ancestors.unshift({ id: cursor.id, name: cursor.name })
          cursor = cursor.parentId ? byId.get(cursor.parentId) : undefined
        }
        const page: TagPageInput = {
          id: live.id,
          name: live.name,
          parentId: live.parentId,
          tags: live.tags,
          ancestors,
          siblingTags: (children.get(live.parentId) ?? []).filter((p) => p.id !== live.id).map((p) => p.tags),
          linkedNames: mentionIds.map((id) => byId.get(id)?.name).filter((n): n is string => Boolean(n)),
          text,
        }
        const inferred = inferPageType(page, types)
        let ai: { tag: string; reason: string; certainty: 'likely' | 'possible' }[] = []
        let aiTokens = { input: 0, output: 0 }
        const notes: string[] = []
        if (config.useAi && text.trim()) {
          const provider = ctx.ai()
          const key = sha256Hex(stableStringify({ kind: 'tags', prompt: TAGS_PROMPT_VERSION, model: provider.model, version, tags: [...live.tags].sort(), policy: config.policy, allowed: allowed.map((a) => a.tag).sort(), max: config.maxSuggestionsPerPage }))
          const cached = ctx.repos.aiCache.get(key)
          if (cached) {
            ai = (cached.output as { suggestions: typeof ai }).suggestions
            notes.push('AI suggestions reused from an earlier run on the same page version.')
          } else {
            const response = await provider.suggestTags({
              name: live.name,
              path: ancestors.map((a) => a.name).join(' / ') || null,
              currentTags: live.tags,
              pageType: inferred?.type.label ?? null,
              policy: config.policy,
              allowedTags: allowed,
              maxSuggestions: config.maxSuggestionsPerPage,
              text: text.slice(0, 6000),
            })
            ctx.repos.aiCache.set(key, 'tags', response.output, response.servedByModel, response.inputTokens, response.outputTokens)
            ai = response.output.suggestions
            aiTokens = { input: response.inputTokens ?? 0, output: response.outputTokens ?? 0 }
            for (const q of response.output.questionable) notes.push(`AI thinks “${q.tag}” may not fit: ${q.reason}`)
            notes.push(...response.output.notes)
          }
        }
        const suggestions = suggestTagsForPage(page, { existing, pageTypes: types, config }, ai)
        const plan: TagPlan = { before: live.tags, suggestions, pageType: inferred?.type.label ?? null, path: ancestors.map((a) => a.name).join(' / ') || null, aiUsed: config.useAi, version, notes }
        const hasAny = suggestions.some((s) => s.refused === null)
        ctx.repos.batchItems.update(item.id, {
          status: hasAny ? 'awaiting_review' : 'skipped',
          plan,
          baseFingerprint: stableStringify({ tags: live.tags, updatedAt: live.updatedAt }),
          error: hasAny ? null : 'Nothing to suggest under the current settings.',
          flags: [...(live.tags.length ? [] : ['untagged']), ...(suggestions.some((s) => s.existence === 'new' && s.refused === null) ? ['new_tags'] : []), ...(suggestions.some((s) => s.selected) ? ['confident'] : [])],
          inputTokens: (item.inputTokens ?? 0) + aiTokens.input,
          outputTokens: (item.outputTokens ?? 0) + aiTokens.output,
        })
      } catch (error) {
        ctx.repos.batchItems.update(item.id, { status: 'failed', error: error instanceof ServiceError ? error.message : toConnectorError(error).message, result: { stage: 'suggest' } })
      }
      if (BATCH_TIMING.checkSpacingMs) await sleep(BATCH_TIMING.checkSpacingMs)
    }
  })
  return taggingView(ctx, batchId)
}

/** Saves your ticks for one page. Changing an approved page withdraws its approval. */
export function selectSuggestions(ctx: AppContext, batchId: string, input: unknown) {
  const batch = getTaggingBatch(ctx, batchId)
  requireUsable(batch)
  const parsed = z
    .object({ itemId: z.string(), selections: z.array(z.object({ tag: z.string(), action: z.enum(['add', 'remove']), selected: z.boolean() })).max(100) })
    .safeParse(input)
  if (!parsed.success) throw new ServiceError(400, 'The selection is not valid.')
  const item = ctx.repos.batchItems.get(parsed.data.itemId)
  if (!item || item.batchId !== batchId || !item.plan) throw new ServiceError(404, 'Page not found in this job.')
  if (!['awaiting_review', 'approved'].includes(item.status)) throw new ServiceError(409, `This page is ${item.status.replace('_', ' ')}.`)
  const plan = planOf(item)
  for (const choice of parsed.data.selections) {
    const s = plan.suggestions.find((x) => x.tag === choice.tag && x.action === choice.action)
    if (s && s.refused === null) s.selected = choice.selected
  }
  ctx.repos.batchItems.update(item.id, { plan: { ...plan, after: undefined }, status: 'awaiting_review', approvedAt: null, planHash: null })
  return taggingView(ctx, batchId)
}

/** Approves pages: fixes the exact tag list each will get. New tags need explicit approval. */
export function approveTagging(ctx: AppContext, batchId: string, input: unknown) {
  const batch = getTaggingBatch(ctx, batchId)
  requireUsable(batch)
  const parsed = z.object({ itemIds: z.array(z.string()).min(1).max(5000), approveNewTags: z.boolean() }).safeParse(input)
  if (!parsed.success) throw new ServiceError(400, 'Choose pages to approve.')
  let approved = 0
  for (const item of ctx.repos.batchItems.list(batchId, { status: ['awaiting_review'] })) {
    if (!parsed.data.itemIds.includes(item.id)) continue
    const plan = planOf(item)
    const after = applyTagChanges(plan.before, plan.suggestions)
    const newTags = plan.suggestions.filter((s) => s.selected && s.action === 'add' && s.existence === 'new' && !s.refused).map((s) => s.tag)
    let problem: string | null = null
    if (stableStringify(after) === stableStringify(plan.before)) problem = 'Nothing selected for this page.'
    else if (newTags.length && !parsed.data.approveNewTags) problem = `Adds new tag(s) ${newTags.map((t) => `“${t}”`).join(', ')}; tick “Approve new tags” to allow them.`
    else if (after.length > MAX_TAGS_PER_RESOURCE) problem = `A page can have at most ${MAX_TAGS_PER_RESOURCE} tags.`
    if (problem) {
      ctx.repos.batchItems.update(item.id, { error: problem })
      continue
    }
    ctx.repos.batchItems.update(item.id, { status: 'approved', approvedAt: ctx.now().toISOString(), plan: { ...plan, after }, planHash: sha256Hex(stableStringify({ before: plan.before, after, base: item.baseFingerprint })), error: null })
    approved++
  }
  recordAudit(ctx, { operation: 'tagging.approve', outcome: 'success', approval: 'approved', projectId: knownProjectId(ctx), message: `${approved} page(s) approved`, details: { batchId, approveNewTags: parsed.data.approveNewTags } })
  return taggingView(ctx, batchId)
}

export function unapproveTagging(ctx: AppContext, batchId: string, itemIds: string[]) {
  const batch = getTaggingBatch(ctx, batchId)
  requireUsable(batch)
  for (const item of ctx.repos.batchItems.list(batchId, { status: ['approved'] })) if (itemIds.includes(item.id)) ctx.repos.batchItems.update(item.id, { status: 'awaiting_review', approvedAt: null, planHash: null })
  return taggingView(ctx, batchId)
}

const sameTags = (a: string[], b: string[]) => stableStringify([...a].sort()) === stableStringify([...b].sort())

/** A dry run: reads every approved page's current tags and shows the exact result. Writes nothing. */
export async function dryRunTagging(ctx: AppContext, batchId: string, input: { wait?: boolean } = {}) {
  const batch = getTaggingBatch(ctx, batchId)
  requireUsable(batch)
  const items = ctx.repos.batchItems.list(batchId, { status: ['approved', 'awaiting_review'] })
  if (items.length === 0) throw new ServiceError(409, 'There is nothing to check yet.')
  await startBatchWork(ctx, batchId, 'dry run', { status: 'processing', wait: input.wait }, async () => {
    const entries = []
    for (const item of items) {
      if (cancelRequested(ctx, batchId)) break
      const plan = planOf(item)
      const proposed = plan.after ?? applyTagChanges(plan.before, plan.suggestions)
      const problems: string[] = []
      if (!ctx.config().lk.allowWrites) problems.push('Writes are switched off (LKC_ALLOW_WRITES=false), so nothing could be written.')
      let current: string[] | null = null
      try {
        current = (await ctx.connector().getResource(item.resourceId!)).tags
        if (!sameTags(current, plan.before)) problems.push(`Tags changed in LegendKeeper since the suggestion (now: ${current.join(', ') || 'none'}). Running would refresh the proposal and ask again.`)
      } catch (error) {
        problems.push(toConnectorError(error).message)
      }
      if (item.status !== 'approved') problems.push('Not approved yet.')
      entries.push({
        itemId: item.id,
        page: item.title,
        resourceId: item.resourceId,
        status: item.status,
        before: plan.before,
        current,
        add: proposed.filter((t) => !plan.before.includes(t)),
        remove: plan.before.filter((t) => !proposed.includes(t)),
        after: proposed,
        newTags: plan.suggestions.filter((s) => s.selected && s.existence === 'new' && s.action === 'add').map((s) => s.tag),
        problems,
        canProceed: problems.length === 0,
      })
      if (BATCH_TIMING.checkSpacingMs) await sleep(BATCH_TIMING.checkSpacingMs)
    }
    const report = { kind: 'tag_dry_run', batchId, at: ctx.now().toISOString(), totals: { pages: entries.length, ready: entries.filter((e) => e.canProceed).length }, entries }
    ctx.repos.batches.update(batchId, { options: { ...getTaggingBatch(ctx, batchId).options, lastDryRun: report } })
    recordAudit(ctx, { operation: 'tagging.dry_run', outcome: 'success', projectId: knownProjectId(ctx), message: `${report.totals.ready} of ${entries.length} ready`, details: { batchId } })
  })
  return taggingView(ctx, batchId)
}

/** Applies approved tag changes, one page at a time. */
export async function runTagging(ctx: AppContext, batchId: string, input: { wait?: boolean } = {}) {
  const batch = getTaggingBatch(ctx, batchId)
  requireUsable(batch)
  if (ctx.repos.batchItems.list(batchId, { status: ['approved', 'needs_reconciliation'] }).length === 0) throw new ServiceError(409, 'There are no approved pages to update.')
  if (!ctx.config().lk.allowWrites) throw new ServiceError(409, 'Writes are switched off (LKC_ALLOW_WRITES=false).')
  await startBatchWork(ctx, batchId, 'running', { status: 'running', wait: input.wait }, async () => {
    for (const item of ctx.repos.batchItems.list(batchId, { status: ['needs_reconciliation'] })) await reconcileTagItem(ctx, item)
    const counts = { succeeded: 0, failed: 0, uncertain: 0, refreshed: 0 }
    const approved = ctx.repos.batchItems.list(batchId, { status: ['approved'] })
    for (const [index, item] of approved.entries()) {
      if (cancelRequested(ctx, batchId)) break
      counts[await applyTagItem(ctx, item)]++
      if (index < approved.length - 1) await sleep(BATCH_TIMING.writeSpacingMs)
    }
    recordAudit(ctx, { operation: 'tagging.run', outcome: counts.failed || counts.uncertain ? 'failure' : 'success', approval: 'approved', projectId: knownProjectId(ctx), message: `${counts.succeeded} updated, ${counts.refreshed} refreshed for review, ${counts.failed} failed, ${counts.uncertain} uncertain`, details: { batchId, ...counts } })
  })
  return taggingView(ctx, batchId)
}

async function applyTagItem(ctx: AppContext, item: BatchItem): Promise<'succeeded' | 'failed' | 'uncertain' | 'refreshed'> {
  if (!ctx.repos.batchItems.transition(item.id, ['approved'], 'running')) return 'refreshed'
  const plan = planOf(item)
  if (!plan.after || item.planHash !== sha256Hex(stableStringify({ before: plan.before, after: plan.after, base: item.baseFingerprint }))) {
    ctx.repos.batchItems.update(item.id, { status: 'awaiting_review', error: 'The approved change no longer matches the plan. Approve it again.' })
    return 'refreshed'
  }
  let current: { tags: string[]; updatedAt: string | null }
  try {
    current = await ctx.connector().getResource(item.resourceId!)
  } catch (error) {
    ctx.repos.batchItems.update(item.id, { status: 'failed', error: `Could not read the page before writing: ${toConnectorError(error).message} Nothing was written.`, result: { stage: 'write' } })
    return 'failed'
  }
  if (!sameTags(current.tags, plan.before)) {
    // Someone changed the tags since the suggestion: recompute on the current tags and ask again.
    const suggestions = plan.suggestions.filter((s) => !(s.action === 'add' && current.tags.some((t) => normalizeTag(t) === normalizeTag(s.tag))))
    ctx.repos.batchItems.update(item.id, {
      status: 'awaiting_review',
      approvedAt: null,
      planHash: null,
      plan: { ...plan, before: current.tags, suggestions, after: undefined },
      baseFingerprint: stableStringify({ tags: current.tags, updatedAt: current.updatedAt }),
      error: `The page’s tags changed in LegendKeeper since the suggestion (now: ${current.tags.join(', ') || 'none'}). The proposal was refreshed; approve it again.`,
    })
    return 'refreshed'
  }
  const after = applyTagChanges(current.tags, plan.suggestions)
  const auditBase = { projectId: knownProjectId(ctx), resourceId: item.resourceId }
  try {
    await ctx.connector().updateResourceTags(item.resourceId!, after)
  } catch (error) {
    const failure = toConnectorError(error)
    if (failure.details.outcome === 'unknown') {
      ctx.repos.batchItems.update(item.id, { status: 'needs_reconciliation', error: `${failure.message} The outcome is unknown; the app will check the page’s tags before anything else.`, result: { stage: 'write', target: after } })
      recordAudit(ctx, { ...auditBase, operation: 'tagging.update', outcome: 'uncertain', approval: 'approved', message: `Tag update for “${item.title}” uncertain`, details: { before: current.tags, after } })
      return 'uncertain'
    }
    ctx.repos.batchItems.update(item.id, { status: 'failed', error: `LegendKeeper refused the update: ${failure.message} Nothing was changed.`, result: { stage: 'write' } })
    recordAudit(ctx, { ...auditBase, operation: 'tagging.update', outcome: 'failure', approval: 'approved', errorCode: failure.details.code ?? failure.kind, message: failure.message })
    return 'failed'
  }
  // Read back to confirm.
  let readback: string[] | null = null
  try {
    readback = (await ctx.connector().getResource(item.resourceId!)).tags
  } catch {
    readback = null
  }
  const confirmed = readback !== null && sameTags(readback, after)
  ctx.repos.batchItems.update(item.id, {
    status: 'succeeded',
    error: confirmed ? null : 'Updated, but reading the tags back did not match exactly (another change may have happened at the same moment). Check the page.',
    attempts: item.attempts + 1,
    result: { stage: 'write', before: current.tags, after, readback },
  })
  recordAudit(ctx, { ...auditBase, operation: 'tagging.update', outcome: 'success', approval: 'approved', message: `Tags of “${item.title}”: ${current.tags.join(', ') || '(none)'} → ${after.join(', ')}`, details: { before: current.tags, after, readback } })
  return 'succeeded'
}

/** Decides an uncertain update by reading the page's tags (never by writing again). */
async function reconcileTagItem(ctx: AppContext, item: BatchItem) {
  const plan = planOf(item)
  const target = (item.result as { target?: string[] } | null)?.target ?? plan.after ?? []
  try {
    const tags = (await ctx.connector().getResource(item.resourceId!)).tags
    if (sameTags(tags, target)) ctx.repos.batchItems.update(item.id, { status: 'succeeded', error: null, result: { stage: 'write', before: plan.before, after: tags, reconciled: true } })
    else if (sameTags(tags, plan.before)) ctx.repos.batchItems.update(item.id, { status: 'failed', error: 'Checked: the update did not happen. Approve it again to retry.', result: { stage: 'write', reconciled: true } })
    else ctx.repos.batchItems.update(item.id, { status: 'awaiting_review', approvedAt: null, planHash: null, plan: { ...plan, before: tags, after: undefined }, error: `Checked: the page now has different tags (${tags.join(', ')}). Review again.` })
  } catch (error) {
    ctx.repos.batchItems.update(item.id, { error: `Could not check the outcome yet: ${toConnectorError(error).message}` })
  }
}

export async function reconcileTagging(ctx: AppContext, batchId: string) {
  const batch = getTaggingBatch(ctx, batchId)
  requireUsable(batch)
  for (const item of ctx.repos.batchItems.list(batchId, { status: ['needs_reconciliation'] })) await reconcileTagItem(ctx, item)
  return taggingView(ctx, batchId)
}

/** Failed suggestion → suggest again; failed update → review and approve again (never re-sent on its own). */
export function retryTagging(ctx: AppContext, batchId: string, itemIds: string[]) {
  const batch = getTaggingBatch(ctx, batchId)
  requireUsable(batch)
  for (const item of ctx.repos.batchItems.list(batchId, { status: ['failed'] })) {
    if (!itemIds.includes(item.id)) continue
    const stage = (item.result as { stage?: string } | null)?.stage
    ctx.repos.batchItems.update(item.id, { status: stage === 'write' && item.plan ? 'awaiting_review' : 'pending', error: null })
  }
  return taggingView(ctx, batchId)
}

export function skipTagging(ctx: AppContext, batchId: string, itemIds: string[]) {
  const batch = getTaggingBatch(ctx, batchId)
  requireUsable(batch)
  for (const item of ctx.repos.batchItems.list(batchId, { status: ['pending', 'awaiting_review', 'approved', 'failed'] })) if (itemIds.includes(item.id)) ctx.repos.batchItems.update(item.id, { status: 'skipped', decision: 'skip' })
  return taggingView(ctx, batchId)
}

export function closeTagging(ctx: AppContext, batchId: string, cancel = false) {
  const batch = getTaggingBatch(ctx, batchId)
  requireUsable(batch)
  if (ctx.repos.batchItems.list(batchId, { status: ['needs_reconciliation', 'running'] }).length) throw new ServiceError(409, 'Some updates have an unknown outcome. Check them first.')
  for (const item of ctx.repos.batchItems.list(batchId, { status: ['pending', 'awaiting_review', 'approved', 'failed'] })) ctx.repos.batchItems.update(item.id, { status: 'cancelled' })
  ctx.repos.batches.update(batchId, { status: cancel ? 'cancelled' : 'completed', finishedAt: ctx.now().toISOString() })
  recordAudit(ctx, { operation: cancel ? 'tagging.cancel' : 'tagging.close', outcome: 'success', message: batch.name, details: { batchId } })
  return taggingView(ctx, batchId)
}

export function taggingView(ctx: AppContext, batchId: string) {
  const batch = getTaggingBatch(ctx, batchId)
  const items = ctx.repos.batchItems.list(batchId).map((item) => {
    const plan = item.plan as TagPlan | null
    return {
      ...item,
      plan,
      statusExplanation: ITEM_STATUS_EXPLANATIONS[item.status],
      proposedAfter: plan ? (plan.after ?? applyTagChanges(plan.before, plan.suggestions)) : null,
    }
  })
  const counts = ctx.repos.batchItems.counts(batchId)
  const tokens = { input: items.reduce((n, i) => n + (i.inputTokens ?? 0), 0), output: items.reduce((n, i) => n + (i.outputTokens ?? 0), 0) }
  const model = ctx.config().ai.model
  const options = batch.options as { scope?: TaggingScope; taxonomyRevision?: number; lastDryRun?: unknown }
  return {
    batch: { ...batch, options: { ...batch.options, lastDryRun: undefined } },
    phase: runningPhase(batchId),
    taxonomy: taxonomyOf(batch),
    taxonomyRevision: options.taxonomyRevision ?? 0,
    currentTaxonomyRevision: getTaxonomy(ctx).revision,
    items,
    counts,
    overview: {
      pages: items.length,
      withSuggestions: items.filter((i) => i.plan?.suggestions.some((s) => s.refused === null)).length,
      confident: items.filter((i) => i.flags.includes('confident')).length,
      newTags: items.filter((i) => i.flags.includes('new_tags')).length,
      approved: counts.approved,
      succeeded: counts.succeeded,
      failedOrUnresolved: counts.failed + counts.needs_reconciliation,
    },
    usage: { ...tokens, model, estimatedCostUsd: estimateCostUsd(model, tokens.input, tokens.output), pricesAsOf: PRICES_AS_OF },
    hasDryRun: Boolean(options.lastDryRun),
  }
}

export function exportTagging(ctx: AppContext, batchId: string, input: { report: 'results' | 'dry_run'; format: 'json' | 'csv' }) {
  const batch = getTaggingBatch(ctx, batchId)
  const view = taggingView(ctx, batchId)
  const name = batch.name.replace(/[^A-Za-z0-9._-]+/g, '-').slice(0, 60) || 'tagging'
  const report = (batch.options as { lastDryRun?: { entries: Record<string, unknown>[] } }).lastDryRun
  if (input.report === 'dry_run' && !report) throw new ServiceError(404, 'No dry run has been made yet.')
  const doc = input.report === 'dry_run' ? report : { batch: view.batch, overview: view.overview, items: view.items }
  const rows =
    input.report === 'dry_run'
      ? report!.entries.map((e) => ({ page: e.page as string, resource_id: e.resourceId as string, add: (e.add as string[]).join('; '), remove: (e.remove as string[]).join('; '), after: (e.after as string[]).join('; '), new_tags: (e.newTags as string[]).join('; '), can_proceed: e.canProceed ? 'yes' : 'no', problems: (e.problems as string[]).join(' | ') }))
      : view.items.map((i) => ({ page: i.title, resource_id: i.resourceId, status: i.status, before: i.plan?.before.join('; ') ?? '', after: i.proposedAfter?.join('; ') ?? '', error: i.error }))
  const secrets = configuredSecrets()
  return input.format === 'json'
    ? { fileName: `${name}-${input.report}.json`, contentType: 'application/json', body: JSON.stringify(redactSecrets(doc, secrets), null, 2) }
    : { fileName: `${name}-${input.report}.csv`, contentType: 'text/csv', body: toCsv(redactSecrets(rows, secrets) as Record<string, string | number | null>[]) }
}
