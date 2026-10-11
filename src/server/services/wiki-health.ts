import 'server-only'
import { z } from 'zod'
import { AUDIT_CATEGORIES, pageTypeForTags, runChecks, type AuditCategory, type AuditResource, type PageSummary, type TypeExpectation } from '@/core/audit-checks'
import { newAppId } from '@/core/ids'
import { summarizeLayout } from '@/core/lk-layout'
import { allPageTypes, resolvePageType } from '@/core/resolve'
import type { AppContext } from '../context'
import type { AuditRun, Finding, FindingFilter, FindingStatus } from '../db/health-repositories'
import { toConnectorError } from '../lk/errors'
import { pageStructure } from '../lk/structure'
import { log } from '../log'
import { recordAudit } from './audit'
import { sleep } from './batch-engine'
import { requireProjectId, knownProjectId } from './connection'
import { ServiceError } from './errors'

/**
 * Wiki Health: a read-only audit of the LegendKeeper project.
 *
 * - Metadata checks (tags, names, duplicates) use the local index and cost no API calls.
 * - Content checks (layout, required fields, links, sources, unreadable parts) read each page
 *   once per audit, spaced to stay well under the read limit (300 requests a minute).
 *   LegendKeeper's "last updated" time does not change when page content is edited (verified
 *   live), so the only reliable change signal is the document version returned with the
 *   content; it is stored per page as the fingerprint.
 * - Findings persist across audits. Dismissed and intentional findings stay quiet until what
 *   they were based on changes. Findings a later audit no longer sees are marked resolved.
 * - Nothing is ever changed in LegendKeeper.
 */

const CATEGORY_IDS = AUDIT_CATEGORIES.map((c) => c.id) as [AuditCategory, ...AuditCategory[]]

export const AuditScope = z.object({
  mode: z.enum(['all', 'resources', 'page_types', 'folder', 'criteria', 'open_findings']).default('all'),
  resourceIds: z.array(z.string().min(1).max(100)).max(5000).default([]),
  pageTypes: z.array(z.string().min(1).max(64)).max(20).default([]),
  folderId: z.string().max(100).nullable().default(null),
  criteria: z
    .object({ tag: z.string().max(100).nullable().default(null), nameContains: z.string().max(200).nullable().default(null), untaggedOnly: z.boolean().default(false) })
    .default({ tag: null, nameContains: null, untaggedOnly: false }),
  /** Read page content for the content checks (slower). Off: content checks use what earlier audits read. */
  readContent: z.boolean().default(true),
  /** At most this many pages are read in one audit. */
  maxPages: z.number().int().min(1).max(20_000).default(2000),
  checks: z.array(z.enum(CATEGORY_IDS)).min(1).default(CATEGORY_IDS),
})
export type AuditScope = z.infer<typeof AuditScope>

/** Pause between page reads. 220 ms keeps an audit at ≤ 270 reads a minute. Tests set 0. */
export const AUDIT_TIMING = { readSpacingMs: 220 }

const RUNNING = Symbol.for('lk-companion.audit-runs')
function running(): Map<string, Promise<void>> {
  const g = globalThis as unknown as Record<symbol, Map<string, Promise<void>> | undefined>
  if (!g[RUNNING]) g[RUNNING] = new Map()
  return g[RUNNING]!
}

export async function waitForAudit(runId: string) {
  await running().get(runId)
}

type IndexedPage = ReturnType<AppContext['repos']['index']['forAudit']>[number]

function scopeResources(ctx: AppContext, projectId: string, pages: IndexedPage[], scope: AuditScope): IndexedPage[] {
  const types = allPageTypes()
  switch (scope.mode) {
    case 'resources': {
      const ids = new Set(scope.resourceIds)
      return pages.filter((p) => ids.has(p.id))
    }
    case 'page_types':
      return pages.filter((p) => {
        const type = pageTypeForTags(p.tags, types)
        return type !== null && scope.pageTypes.includes(type.id)
      })
    case 'folder': {
      if (!scope.folderId) throw new ServiceError(400, 'Choose a folder (a parent page).')
      const children = new Map<string, string[]>()
      for (const p of pages) if (p.parentId) children.set(p.parentId, [...(children.get(p.parentId) ?? []), p.id])
      const ids = new Set<string>([scope.folderId])
      const queue = [scope.folderId]
      while (queue.length) for (const child of children.get(queue.pop()!) ?? []) if (!ids.has(child)) (ids.add(child), queue.push(child))
      return pages.filter((p) => ids.has(p.id))
    }
    case 'criteria': {
      const { tag, nameContains, untaggedOnly } = scope.criteria
      return pages.filter((p) => (!tag || p.tags.includes(tag)) && (!nameContains || p.name.toLowerCase().includes(nameContains.toLowerCase())) && (!untaggedOnly || p.tags.length === 0))
    }
    case 'open_findings': {
      const ids = new Set(ctx.repos.findings.list(projectId, { statuses: ['open', 'queued'], limit: 100_000 }).items.flatMap((f) => [f.resourceId, ...f.related.map((r) => r.id)].filter((x): x is string => Boolean(x))))
      return pages.filter((p) => ids.has(p.id))
    }
    default:
      return pages
  }
}

/** What pages of each type should have, from your LegendKeeper templates and your recipes. */
export function typeExpectations(ctx: AppContext): Map<string, TypeExpectation> {
  const out = new Map<string, TypeExpectation>()
  const templates = ctx.repos.templates.list()
  const recipes = ctx.repos.recipes.list()
  for (const type of allPageTypes()) {
    const forType = recipes.filter((r) => resolvePageType(r.definition)?.id === type.id)
    // Prefer a copied LegendKeeper layout that a recipe uses; else any copied layout for the type.
    const used = new Set(forType.map((r) => r.definition.templateId).filter(Boolean))
    const layouts = templates.filter((t) => t.definition.pageType === type.id && t.definition.lkLayout)
    const layout = layouts.find((t) => used.has(t.id)) ?? layouts[0] ?? null
    let template: TypeExpectation['template'] = null
    if (layout?.definition.lkLayout) {
      const summary = summarizeLayout(layout.definition.lkLayout.blocks, type)
      template = {
        name: layout.definition.name,
        keyValueKeys: summary.rows.map((r) => r.key).filter(Boolean),
        sections: summary.sections,
        hasInfobox: layout.definition.lkLayout.blocks.some((b) => b.kind === 'infobox'),
      }
    }
    const requiredKeys = [...new Set(forType.flatMap((r) => r.definition.requiredFields))]
    const requiredFields = requiredKeys
      .map((key) => type.fields.find((f) => f.key === key))
      .filter((f): f is NonNullable<typeof f> => Boolean(f))
      .map((f) => ({ key: f.key, label: f.label, aliases: [...f.aliases, ...forType.flatMap((r) => r.definition.fieldMappings.find((m) => m.fieldKey === f.key)?.labels ?? [])] }))
    const attributionRequired = forType.some((r) => r.definition.attribution.required)
    if (template || requiredFields.length || attributionRequired) out.set(type.id, { pageTypeId: type.id, pageTypeLabel: type.label, template, requiredFields, attributionRequired })
  }
  return out
}

export async function startAudit(ctx: AppContext, input: unknown, options: { wait?: boolean; resumeRunId?: string } = {}) {
  const projectId = await requireProjectId(ctx)
  const parsed = AuditScope.safeParse(input ?? {})
  if (!parsed.success) throw new ServiceError(400, 'The audit settings are not valid.', parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`))
  if ([...running().keys()].length) throw new ServiceError(409, 'An audit is already running. Wait for it, or stop it.')
  const pages = ctx.repos.index.forAudit(projectId)
  if (pages.length === 0) throw new ServiceError(409, 'The project has not been scanned yet. Run a scan in the Page browser first (it reads names and tags only).')

  let run: AuditRun
  let scope = parsed.data
  if (options.resumeRunId) {
    const previous = ctx.repos.auditRuns.get(options.resumeRunId)
    if (!previous || previous.projectId !== projectId) throw new ServiceError(404, 'Audit run not found.')
    if (previous.status === 'completed') throw new ServiceError(409, 'This audit already finished.')
    scope = AuditScope.parse(previous.scope)
    ctx.repos.auditRuns.update(previous.id, { status: 'running', error: null, cancelRequested: false, finishedAt: null })
    run = ctx.repos.auditRuns.get(previous.id)!
  } else {
    const inScope = scopeResources(ctx, projectId, pages, scope)
    const id = newAppId('aud')
    ctx.repos.auditRuns.insert({ id, projectId, scope, checks: scope.checks, total: inScope.length })
    run = ctx.repos.auditRuns.get(id)!
    recordAudit(ctx, { operation: 'health.audit', outcome: 'info', projectId, message: `Audit started: ${scope.mode}, ${inScope.length} page(s)`, details: { runId: id, scope } })
  }

  const promise = execute(ctx, run, scope, pages).catch((error) => {
    log.error('Audit failed', { runId: run.id, error })
    ctx.repos.auditRuns.update(run.id, { status: 'failed', error: (error as Error).message, finishedAt: ctx.now().toISOString() })
  }).finally(() => running().delete(run.id))
  running().set(run.id, promise)
  if (options.wait) await promise
  return healthDashboard(ctx)
}

async function execute(ctx: AppContext, run: AuditRun, scope: AuditScope, pages: IndexedPage[]) {
  const projectId = run.projectId
  const inScope = scopeResources(ctx, projectId, pages, scope)
  const checks = new Set(scope.checks)
  const contentChecks = AUDIT_CATEGORIES.filter((c) => c.needsContent && checks.has(c.id)).length > 0
  const toRead = contentChecks && scope.readContent ? inScope.filter((p) => p.documents.some((d) => d.type === 'page')).slice(0, scope.maxPages) : []
  let { processed, fetched, reused } = run
  let unchanged = 0
  ctx.repos.auditRuns.update(run.id, { total: toRead.length })

  for (const page of toRead) {
    if (ctx.repos.auditRuns.get(run.id)?.cancelRequested) {
      ctx.repos.auditRuns.update(run.id, { status: 'cancelled', finishedAt: ctx.now().toISOString(), processed, fetched, reused })
      return
    }
    const cached = ctx.repos.contentCache.get(projectId, page.id)
    // Already read during this run (a resumed run): no second read.
    if (cached && cached.fetchedAt >= run.startedAt) {
      reused++
      processed++
      continue
    }
    const document = page.documents.find((d) => d.type === 'page')!
    try {
      const content = await ctx.connector().getDocumentContent(page.id, document.id)
      if (cached && cached.version === content.version) unchanged++
      ctx.repos.contentCache.put(projectId, { resourceId: page.id, documentId: document.id, version: content.version, structure: pageStructure(content.blocks), fetchedAt: ctx.now().toISOString(), error: null })
    } catch (error) {
      const failure = toConnectorError(error)
      if (failure.kind === 'rate_limited' || failure.kind === 'connection' || failure.kind === 'authentication') {
        ctx.repos.auditRuns.update(run.id, { status: 'interrupted', error: `Stopped: ${failure.message} Resume the audit later; pages read so far are kept.`, processed, fetched, reused })
        return
      }
      ctx.repos.contentCache.put(projectId, { resourceId: page.id, documentId: document.id, version: 'unreadable', structure: null, fetchedAt: ctx.now().toISOString(), error: failure.message })
    }
    fetched++
    processed++
    if (processed % 10 === 0) ctx.repos.auditRuns.update(run.id, { processed, fetched, reused })
    if (AUDIT_TIMING.readSpacingMs) await sleep(AUDIT_TIMING.readSpacingMs)
  }

  // Checks.
  const summaries = new Map<string, PageSummary>()
  for (const page of inScope) {
    const snapshot = ctx.repos.contentCache.get(projectId, page.id)
    if (!snapshot) continue
    const s = snapshot.structure
    summaries.set(page.id, {
      version: snapshot.version,
      error: snapshot.error,
      hasInfobox: s?.hasInfobox ?? false,
      headings: s?.headings ?? [],
      textFieldTitles: s?.textFieldTitles ?? [],
      keyValueKeys: s?.keyValueKeys ?? [],
      mentionIds: s?.mentionIds ?? [],
      unsupportedCount: s?.unsupportedCount ?? 0,
      text: s?.text ?? '',
    })
  }
  const resources: AuditResource[] = pages.map((p) => ({ id: p.id, name: p.name, parentId: p.parentId, tags: p.tags, aliases: p.aliases, path: p.path, updatedAt: p.updatedAt }))
  const fullProject = scope.mode === 'all'
  const drafts = runChecks({ resources, inScope: new Set(inScope.map((p) => p.id)), fullProject, summaries, pageTypes: allPageTypes(), expectations: typeExpectations(ctx), checks })
  for (const draft of drafts) ctx.repos.findings.upsert(projectId, run.id, draft, newAppId('fnd'))

  // Findings no longer seen: metadata checks cover the scope; content checks cover pages read now.
  const metadataCategories = scope.checks.filter((c) => !AUDIT_CATEGORIES.find((x) => x.id === c)!.needsContent)
  const contentCategories = scope.checks.filter((c) => AUDIT_CATEGORIES.find((x) => x.id === c)!.needsContent)
  let resolved = 0
  if (metadataCategories.length) resolved += ctx.repos.findings.resolveMissing(projectId, run.id, metadataCategories, fullProject ? null : new Set(inScope.map((p) => p.id)))
  if (contentCategories.length && toRead.length) resolved += ctx.repos.findings.resolveMissing(projectId, run.id, contentCategories, new Set(toRead.map((p) => p.id)))

  const byCategory: Record<string, number> = {}
  for (const d of drafts) byCategory[d.category] = (byCategory[d.category] ?? 0) + 1
  ctx.repos.auditRuns.update(run.id, {
    status: 'completed',
    processed,
    fetched,
    reused,
    finishedAt: ctx.now().toISOString(),
    summary: { findings: drafts.length, byCategory, resolved, unchangedPages: unchanged, pagesInScope: inScope.length, pagesRead: toRead.length, contentFromEarlierAudits: !scope.readContent },
  })
  recordAudit(ctx, { operation: 'health.audit', outcome: 'success', projectId, message: `Audit finished: ${drafts.length} finding(s), ${resolved} resolved, ${fetched} page(s) read`, details: { runId: run.id, byCategory } })
}

export function stopAudit(ctx: AppContext, runId: string) {
  const run = ctx.repos.auditRuns.get(runId)
  if (!run) throw new ServiceError(404, 'Audit run not found.')
  if (!running().has(runId)) throw new ServiceError(409, 'This audit is not running.')
  ctx.repos.auditRuns.update(runId, { cancelRequested: true })
  return healthDashboard(ctx)
}

export function resumeAudit(ctx: AppContext, runId: string) {
  return startAudit(ctx, null, { resumeRunId: runId })
}

// ── Findings ──────────────────────────────────────────────────────────────────

export const FindingQuery = z.object({
  categories: z.array(z.enum(CATEGORY_IDS)).optional(),
  statuses: z.array(z.enum(['open', 'queued', 'dismissed', 'intentional', 'resolved'])).optional(),
  severity: z.array(z.enum(['problem', 'suggestion', 'info'])).optional(),
  resourceId: z.string().max(100).optional(),
  search: z.string().max(200).optional(),
  sort: z.enum(['severity', 'newest', 'name']).optional(),
  limit: z.number().int().min(1).max(500).optional(),
  offset: z.number().int().min(0).optional(),
})

export function listFindings(ctx: AppContext, input: unknown) {
  const projectId = knownProjectId(ctx)
  if (!projectId) return { items: [], total: 0 }
  const filter = FindingQuery.parse(input ?? {}) as FindingFilter
  const result = ctx.repos.findings.list(projectId, { statuses: ['open', 'queued'], ...filter })
  return { ...result, items: result.items.map((f) => withChange(ctx, projectId, f)) }
}

/** Whether the page's metadata changed since the finding was last seen (content edits are only noticed by the next audit). */
function withChange(ctx: AppContext, projectId: string, finding: Finding) {
  const page = finding.resourceId ? ctx.repos.index.get(projectId, finding.resourceId) : null
  const changedSinceAudit = Boolean(page?.updatedAt && page.updatedAt > finding.lastSeenAt)
  return { ...finding, changedSinceAudit, exists: finding.resourceId ? page !== null : null }
}

export function updateFindings(ctx: AppContext, input: unknown) {
  const parsed = z
    .object({ ids: z.array(z.string()).min(1).max(1000), status: z.enum(['open', 'queued', 'dismissed', 'intentional']), note: z.string().max(1000).nullable().optional() })
    .safeParse(input)
  if (!parsed.success) throw new ServiceError(400, 'Choose findings and a status.')
  const projectId = knownProjectId(ctx)
  let changed = 0
  for (const id of parsed.data.ids) {
    const finding = ctx.repos.findings.get(id)
    if (!finding || finding.projectId !== projectId) continue
    // Remember what the finding was based on, so it comes back only if that changes.
    const quiet = parsed.data.status === 'dismissed' || parsed.data.status === 'intentional'
    ctx.repos.findings.setStatus(id, parsed.data.status as FindingStatus, parsed.data.note ?? null, quiet ? finding.fingerprint : null)
    changed++
  }
  recordAudit(ctx, { operation: 'health.findings', outcome: 'success', projectId, message: `${changed} finding(s) marked ${parsed.data.status}` })
  return { changed }
}

// ── Dashboard ─────────────────────────────────────────────────────────────────

export function healthDashboard(ctx: AppContext) {
  const projectId = knownProjectId(ctx)
  if (!projectId) return { projectId: null, indexed: 0, contentRead: 0, categories: [], runs: [], running: null, totals: null, completedMaintenanceJobs: 0 }
  const stats = ctx.repos.index.stats(projectId)
  const counts = ctx.repos.findings.counts(projectId)
  const open = (category?: AuditCategory) => counts.filter((c) => (c.status === 'open' || c.status === 'queued') && (!category || c.category === category)).reduce((n, c) => n + c.n, 0)
  const runs = ctx.repos.auditRuns.latest(projectId, 8)
  const maintenance = ctx.repos.batches.list(null, 1000).items.filter((b) => (b.kind === 'tagging' || b.kind === 'migration') && b.status === 'completed').length
  return {
    projectId,
    indexed: stats.pages,
    contentRead: ctx.repos.contentCache.count(projectId),
    // Counted from the index directly (always current after a scan), not only from audits.
    untaggedInIndex: stats.untagged,
    categories: AUDIT_CATEGORIES.map((c) => ({
      ...c,
      open: open(c.id),
      problems: counts.filter((x) => x.category === c.id && x.severity === 'problem' && (x.status === 'open' || x.status === 'queued')).reduce((n, x) => n + x.n, 0),
      dismissed: counts.filter((x) => x.category === c.id && (x.status === 'dismissed' || x.status === 'intentional')).reduce((n, x) => n + x.n, 0),
    })),
    totals: {
      open: open(),
      queued: counts.filter((c) => c.status === 'queued').reduce((n, c) => n + c.n, 0),
      needsReview: ctx.repos.findings.countNeedingReview(projectId),
      validationErrors: open('missing_fields') + open('unreadable') - counts.filter((c) => c.category === 'unreadable' && c.severity === 'info' && (c.status === 'open' || c.status === 'queued')).reduce((n, c) => n + c.n, 0),
    },
    runs,
    running: runs.find((r) => r.status === 'running' && running().has(r.id)) ?? null,
    completedMaintenanceJobs: maintenance,
  }
}
