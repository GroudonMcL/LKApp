import 'server-only'
import { z } from 'zod'
import type { AppContext } from '../context'
import { knownProjectId } from './connection'

/**
 * The review queue: everything across the app that is waiting for a decision from you.
 * It is computed from the jobs, drafts and findings themselves (nothing extra is stored), so
 * an entry disappears as soon as its cause is dealt with where it lives.
 */

export const REVIEW_TYPES = {
  uncertain_write: 'Write with an unknown outcome',
  failed: 'Failed operation',
  import_match: 'Possible duplicate or ambiguous match',
  import_draft: 'Imported draft to review',
  tag_suggestion: 'Tag suggestion to decide',
  migration_mechanics: 'Migration changes a game mechanic',
  migration_unmapped: 'Migration has text that did not fit',
  migration_review: 'Migration to review',
  changed_after_audit: 'Page changed after an audit',
  gone: 'Page no longer found',
} as const
export type ReviewType = keyof typeof REVIEW_TYPES
export type ReviewSeverity = 'high' | 'medium' | 'low'

export interface ReviewEntry {
  key: string
  type: ReviewType
  severity: ReviewSeverity
  title: string
  resourceId: string | null
  explanation: string
  /** Where to deal with it. */
  href: string
  job: string | null
  at: string
}

const Filter = z.object({
  type: z.string().max(40).optional(),
  severity: z.enum(['high', 'medium', 'low']).optional(),
  q: z.string().max(200).optional(),
})

const SEVERITY_RANK: Record<ReviewSeverity, number> = { high: 0, medium: 1, low: 2 }

export function reviewQueue(ctx: AppContext, input: unknown = {}) {
  const filter = Filter.parse(input ?? {})
  const all = collect(ctx)
  const q = filter.q?.trim().toLowerCase()
  const items = all
    .filter((e) => !filter.type || e.type === filter.type)
    .filter((e) => !filter.severity || e.severity === filter.severity)
    .filter((e) => !q || e.title.toLowerCase().includes(q) || (e.resourceId ?? '').toLowerCase() === q || (e.job ?? '').toLowerCase().includes(q))
    .sort((a, b) => SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity] || b.at.localeCompare(a.at))
  const byType = Object.fromEntries(Object.keys(REVIEW_TYPES).map((t) => [t, all.filter((e) => e.type === t).length])) as Record<ReviewType, number>
  const bySeverity = { high: all.filter((e) => e.severity === 'high').length, medium: all.filter((e) => e.severity === 'medium').length, low: all.filter((e) => e.severity === 'low').length }
  return { items, total: all.length, byType, bySeverity, types: REVIEW_TYPES }
}

/** Just the counts (for the dashboard and navigation). */
export function reviewCounts(ctx: AppContext) {
  const { total, bySeverity } = reviewQueue(ctx)
  return { total, ...bySeverity }
}

function collect(ctx: AppContext): ReviewEntry[] {
  const out: ReviewEntry[] = []

  const projectId = knownProjectId(ctx)
  const indexed = projectId ? ctx.repos.index.stats(projectId).total > 0 : false

  // Batch items of open jobs (imports, tagging, migrations).
  for (const item of ctx.repos.batchItems.listNeedingAttention()) {
    const base = { title: item.title, resourceId: item.resourceId, job: item.batchName, at: item.updatedAt }
    const jobHref = item.batchKind === 'import' ? `/batches/${item.batchId}` : item.batchKind === 'tagging' ? `/tagging/${item.batchId}` : `/migrations/${item.batchId}`
    // An existing page (tagging, migration) that the last scan no longer found.
    if (item.batchKind !== 'import' && item.resourceId && indexed && projectId && !ctx.repos.index.get(projectId, item.resourceId) && item.status !== 'needs_reconciliation') {
      out.push({ ...base, key: `item:${item.id}`, type: 'gone', severity: 'low', href: jobHref, explanation: 'This page was not found in the last project scan (deleted or moved to the trash?). Skip it, or close the job.' })
      continue
    }
    if (item.status === 'needs_reconciliation') {
      out.push({ ...base, key: `item:${item.id}`, type: 'uncertain_write', severity: 'high', href: jobHref, explanation: `A write was sent but its outcome is unknown (${item.error ?? 'no reply'}). Open the job and use “Check unresolved”; it reads LegendKeeper before anything is retried.` })
      continue
    }
    if (item.status === 'failed') {
      out.push({ ...base, key: `item:${item.id}`, type: 'failed', severity: 'high', href: jobHref, explanation: item.error ?? 'Failed. Open the job to see why; retrying never re-sends a write on its own.' })
      continue
    }
    // awaiting_review
    if (item.batchKind === 'import') {
      const match = item.match as { category?: string; explanation?: string } | null
      if (item.flags.includes('possible_duplicate') || item.flags.includes('duplicate_in_batch')) {
        out.push({ ...base, key: `item:${item.id}`, type: 'import_match', severity: match?.category === 'exact' ? 'high' : 'medium', href: jobHref, explanation: match?.explanation ?? 'This record may already exist (in LegendKeeper or twice in the batch). Decide whether to create it or skip it.' })
      } else {
        const draft = item.jobId ? ctx.repos.drafts.getByJob(item.jobId) : null
        const errors = draft?.findings.filter((f) => f.severity === 'error').length ?? 0
        out.push({ ...base, key: `item:${item.id}`, type: 'import_draft', severity: errors ? 'medium' : 'low', href: item.jobId ? `/import/${item.jobId}` : jobHref, explanation: errors ? `The draft has ${errors} problem(s) to fix before it can be approved.` : 'The draft is ready for your review and approval.' })
      }
    } else if (item.batchKind === 'tagging') {
      const plan = item.plan as { suggestions?: { refused: string | null; certainty: string; selected: boolean }[] } | null
      const live = plan?.suggestions?.filter((s) => s.refused === null) ?? []
      const newTags = item.flags.includes('new_tags')
      const unsure = live.length > 0 && live.every((s) => s.certainty === 'possible')
      out.push({
        ...base,
        key: `item:${item.id}`,
        type: 'tag_suggestion',
        severity: newTags ? 'medium' : 'low',
        href: jobHref,
        explanation: newTags ? 'A suggestion would add a tag that does not exist yet; new tags need your explicit approval.' : unsure ? 'All suggestions are only “possible”; none was ticked for you.' : `${live.filter((s) => s.selected).length} suggestion(s) ticked; approve or change them.`,
      })
    } else {
      const plan = item.plan as { mechanics?: unknown[]; unmapped?: unknown[]; blockers?: string[] } | null
      if (item.flags.includes('mechanics_changed')) {
        out.push({ ...base, key: `item:${item.id}`, type: 'migration_mechanics', severity: 'high', href: jobHref, explanation: `${plan?.mechanics?.length ?? 0} number(s) differ between the old and proposed page. Each must be checked and ticked off.` })
      } else if (item.flags.includes('unmapped')) {
        out.push({ ...base, key: `item:${item.id}`, type: 'migration_unmapped', severity: 'medium', href: jobHref, explanation: `${plan?.unmapped?.length ?? 0} passage(s) did not fit the new layout and are kept in a notes section. Check whether they belong somewhere else.` })
      } else {
        out.push({ ...base, key: `item:${item.id}`, type: 'migration_review', severity: plan?.blockers?.length ? 'medium' : 'low', href: jobHref, explanation: plan?.blockers?.length ? `Needs fixing: ${plan.blockers.join(' ')}` : 'The comparison is ready for your review.' })
      }
    }
  }

  // Single imports (outside batches): uncertain or failed writes, drafts waiting.
  for (const draft of ctx.repos.drafts.listByStatus(['write_uncertain', 'write_failed', 'awaiting_approval'])) {
    const job = ctx.repos.jobs.get(draft.jobId)
    if (!job || job.batchId) continue
    const base = { key: `draft:${draft.id}`, title: draft.page.name || job.name, resourceId: draft.createdResourceId, job: null, at: draft.updatedAt, href: `/import/${job.id}` }
    if (draft.status === 'write_uncertain') out.push({ ...base, type: 'uncertain_write', severity: 'high', explanation: 'The page may or may not have been created. Open the import and check it; it is never created twice.' })
    else if (draft.status === 'write_failed') out.push({ ...base, type: 'failed', severity: 'high', explanation: draft.writeError ?? 'Creating the page failed.' })
    else out.push({ ...base, type: 'import_draft', severity: 'low', explanation: 'Approved for the final preview but not written yet.' })
  }

  // Wiki Health: open findings whose page changed since the audit saw it.
  if (projectId) {
    const findings = ctx.repos.findings.list(projectId, { statuses: ['open', 'queued'], limit: 2000 }).items
    const seen = new Set<string>()
    for (const f of findings) {
      if (!f.resourceId || seen.has(f.resourceId)) continue
      const page = ctx.repos.index.get(projectId, f.resourceId)
      if (!page?.updatedAt || page.updatedAt <= f.lastSeenAt) continue
      seen.add(f.resourceId)
      out.push({ key: `finding:${f.id}`, type: 'changed_after_audit', severity: 'low', title: f.resourceName ?? f.title, resourceId: f.resourceId, job: null, at: page.updatedAt, href: `/health`, explanation: `“${f.title}” was found by an audit, and the page has changed since. Audit it again to see whether the finding still applies.` })
    }
  }
  return out
}
