import 'server-only'
import { z } from 'zod'
import type { KbPage } from '@/core/chronology/entries'
import { RELATION_LABELS, buildRelations, findContradictions, missingEntities, nameVariants, similarNames, textRelations, unlinkedMentions } from '@/core/knowledge/analysis'
import { newAppId } from '@/core/ids'
import { containsLoosely, normalizeName } from '@/core/text'
import { AiError } from '../ai/provider'
import { pageBlock } from '../ai/prompts/analysis'
import type { AppContext } from '../context'
import type { Citation, KnowledgeDraft, KnowledgeKind } from '../db/knowledge-repositories'
import { recordAudit } from './audit'
import { calendarSettings } from './chronology'
import { requireProjectId } from './connection'
import { ServiceError } from './errors'
import { fingerprintOf } from './knowledge-items'
import { knowledgeBase } from './knowledge-base'
import { PageScope, resolvePageRefs, selectPages } from './page-scope'

/**
 * Knowledge Analysis: relationships, unlinked mentions, missing pages, contradictions and
 * naming inconsistencies across the project. Works only from the local index and the page
 * content audits read; it never calls LegendKeeper and never changes anything there. Results
 * are findings for you to decide on; your decisions persist and are reconsidered only when
 * the cited wording changes.
 */

export const CHECKS = ['relationships', 'links', 'missing', 'contradictions', 'terminology'] as const
export type Check = (typeof CHECKS)[number]

export const CHECK_LABELS: Record<Check, string> = {
  relationships: 'Relationships stated in the wording (not yet a link or field)',
  links: 'Pages that name another page without linking to it',
  missing: 'Names used on several pages that have no page',
  contradictions: 'Contradictions between pages',
  terminology: 'Naming inconsistencies and near-duplicate pages',
}

const KINDS_OF: Record<Check, KnowledgeKind[]> = {
  relationships: ['relationship'],
  links: ['link_suggestion'],
  missing: ['missing_page'],
  contradictions: ['contradiction'],
  terminology: ['terminology'],
}

export const AnalysisInput = z.object({
  scope: PageScope.default({ mode: 'all', pageTypes: [], folderId: null, tag: null, nameContains: null, resourceIds: [], maxPages: 2000 }),
  pageRefs: z.array(z.string().max(300)).max(500).optional(),
  checks: z.array(z.enum(CHECKS)).min(1).default([...CHECKS]),
  /** At most this many findings of each kind are recorded per run (the rest are counted). */
  maxPerKind: z.number().int().min(10).max(5000).default(500),
})

const MAX_EVIDENCE = 8

export async function runKnowledgeAnalysis(ctx: AppContext, rawInput: unknown) {
  const projectId = await requireProjectId(ctx)
  const parsed = AnalysisInput.safeParse(rawInput ?? {})
  if (!parsed.success) throw new ServiceError(400, 'The analysis settings are not valid.', parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`))
  const input = parsed.data
  if (!ctx.repos.index.stats(projectId).total) throw new ServiceError(409, 'The project has not been scanned yet. Run a scan in the Page browser first.')
  const indexed = ctx.repos.index.forAudit(projectId)
  const scopeDef = input.pageRefs?.length ? { ...input.scope, mode: 'resources' as const, resourceIds: resolvePageRefs(indexed, input.pageRefs) } : input.scope
  const kb = knowledgeBase(ctx, projectId)
  const selected = selectPages(indexed, scopeDef).map((p) => kb.byId.get(p.id)).filter((p): p is KbPage => Boolean(p?.content))
  if (!selected.length) throw new ServiceError(409, 'None of the selected pages has been read yet. Run a Wiki Health audit on them first (it only reads).')
  const scope = new Set(selected.map((p) => p.id))
  const runId = newAppId('anr')
  ctx.repos.analysisRuns.insert({ id: runId, projectId, kind: 'knowledge', scope: { ...scopeDef, checks: input.checks } })

  const drafts: KnowledgeDraft[] = []
  const counts: Record<string, number> = {}
  const add = (d: KnowledgeDraft) => {
    counts[d.kind] = (counts[d.kind] ?? 0) + 1
    if (counts[d.kind]! <= input.maxPerKind) drafts.push(d)
  }
  const name = (id: string) => kb.byId.get(id)?.name ?? id
  const citation = (p: KbPage, passage: string, field: string | null = null): Citation => ({ resourceId: p.id, resourceName: p.name, field, passage: passage.slice(0, 500), version: p.content?.version ?? null })

  if (input.checks.includes('relationships')) {
    const backed = new Set(buildRelations(kb.pages).filter((r) => r.support !== 'api').flatMap((r) => [`${r.from}|${r.to}`, `${r.to}|${r.from}`]))
    for (const r of textRelations(kb.pages, scope)) {
      if (backed.has(`${r.from}|${r.to}`)) continue
      add({
        kind: 'relationship',
        key: `rel:${r.from}:${r.to}:${r.type}`,
        title: `${name(r.from)} — ${RELATION_LABELS[r.type]} — ${name(r.to)}`,
        summary: `The wording on ${r.evidence.resourceName} suggests this relationship; neither page links to the other or names it in a field.`,
        resourceIds: [r.from, r.to],
        data: { from: r.from, to: r.to, type: r.type, support: 'text', fromName: name(r.from), toName: name(r.to) },
        evidence: [r.evidence],
        origin: 'deterministic',
        certainty: 'likely',
        fingerprint: fingerprintOf([r.evidence.passage]),
      })
    }
  }

  if (input.checks.includes('links')) {
    for (const m of unlinkedMentions(kb.pages, scope)) {
      add({
        kind: 'link_suggestion',
        key: `link:${m.page.id}:${m.target.id}`,
        title: `${m.page.name} names ${m.target.name} without linking to it`,
        summary: `“${m.name}” appears on ${m.page.name}, but the page has no link to ${m.target.name}.`,
        resourceIds: [m.page.id, m.target.id],
        data: { pageId: m.page.id, targetId: m.target.id, name: m.name, targetName: m.target.name },
        evidence: [citation(m.page, m.passage)],
        origin: 'deterministic',
        certainty: 'stated',
        fingerprint: fingerprintOf([m.passage]),
      })
    }
  }

  if (input.checks.includes('missing')) {
    const settings = calendarSettings(ctx)
    const calendarWords = settings.calendars.flatMap((c) => [...c.months.flatMap((m) => [m.name, ...m.aliases]), ...c.eras.flatMap((e) => [e.abbr, e.label, ...e.names])])
    for (const m of missingEntities(kb.pages, scope, calendarWords)) {
      const evidence = m.mentions.slice(0, MAX_EVIDENCE).map((x) => citation(x.page, x.passage))
      add({
        kind: 'missing_page',
        key: `missing:${normalizeName(m.name)}`,
        title: m.name,
        summary: `Named on ${m.mentions.length} page(s) (${m.mentions.slice(0, 4).map((x) => x.page.name).join(', ')}${m.mentions.length > 4 ? '…' : ''}) but no page or alias has this name.`,
        resourceIds: [...new Set(m.mentions.map((x) => x.page.id))],
        data: { name: m.name, kindGuess: m.kind, pageCount: m.mentions.length, title: m.name },
        evidence,
        origin: 'deterministic',
        certainty: m.mentions.length >= 3 ? 'likely' : 'possible',
        fingerprint: fingerprintOf(evidence.map((e) => e.passage)),
      })
    }
  }

  if (input.checks.includes('contradictions')) {
    for (const c of findContradictions(kb.pages, scope))
      add({ kind: 'contradiction', key: `contr:${c.key}`, title: c.title, summary: c.explanation, resourceIds: c.resourceIds, data: { contradictionKind: c.kind }, evidence: c.evidence, origin: 'deterministic', certainty: c.certainty, fingerprint: fingerprintOf(c.evidence.map((e) => e.passage)) })
  }

  if (input.checks.includes('terminology')) {
    for (const v of nameVariants(kb.pages, scope)) {
      const evidence = v.mentions.slice(0, MAX_EVIDENCE).map((x) => citation(x.page, x.passage))
      add({
        kind: 'terminology',
        key: `variant:${v.target.id}:${v.variant}`,
        title: `“${v.variant}” for ${v.canonical}`,
        summary: `${v.mentions.length} page(s) write “${v.variant}”; the page is called “${v.canonical}” and has no alias “${v.variant}”. Add it as an alias in LegendKeeper if both spellings are right, or correct the text.`,
        resourceIds: [v.target.id, ...v.mentions.map((x) => x.page.id)],
        data: { targetId: v.target.id, canonical: v.canonical, variant: v.variant },
        evidence,
        origin: 'deterministic',
        certainty: 'likely',
        fingerprint: fingerprintOf(evidence.map((e) => e.passage)),
      })
    }
    for (const s of similarNames(kb.pages.filter((p) => scope.has(p.id)))) {
      const evidence = [citation(s.a, s.a.name, 'Page name'), citation(s.b, s.b.name, 'Page name')]
      add({
        kind: 'terminology',
        key: `similar:${[s.a.id, s.b.id].sort().join(':')}`,
        title: `“${s.a.name}” and “${s.b.name}”`,
        summary: `${s.reason} They may be the same thing recorded twice, or a naming inconsistency. Nothing is merged or renamed automatically.`,
        resourceIds: [s.a.id, s.b.id],
        data: { a: s.a.id, b: s.b.id },
        evidence,
        origin: 'deterministic',
        certainty: 'possible',
        fingerprint: fingerprintOf([s.a.name, s.b.name]),
      })
    }
  }

  let created = 0
  for (const d of drafts) if (ctx.repos.knowledge.upsert(projectId, runId, d, newAppId('kni')).created) created++
  let resolved = 0
  for (const check of input.checks) resolved += ctx.repos.knowledge.resolveMissing(projectId, runId, KINDS_OF[check], scope, 'deterministic')
  const summary = { pages: selected.length, found: counts, recorded: drafts.length, created, resolved, capped: Object.entries(counts).filter(([, n]) => n > input.maxPerKind).map(([k]) => k) }
  ctx.repos.analysisRuns.finish(runId, { status: 'completed', summary })
  recordAudit(ctx, { operation: 'knowledge.analyse', outcome: 'success', projectId, message: `Knowledge analysis: ${selected.length} page(s), ${drafts.length} finding(s), ${created} new.`, details: { runId, ...summary } })
  return { runId, summary }
}

// ── AI comparison of a few pages ──────────────────────────────────────────────────

const CompareInput = z.object({ pageRefs: z.array(z.string().max(300)).min(2).max(5) })
const AI_TEXT_LIMIT = 6000

export function comparePreview(ctx: AppContext, projectId: string, rawInput: unknown) {
  const { pageRefs } = CompareInput.parse(rawInput ?? {})
  const ids = resolvePageRefs(ctx.repos.index.forAudit(projectId), pageRefs)
  const kb = knowledgeBase(ctx, projectId)
  const pages = ids.map((id) => kb.byId.get(id)!).filter(Boolean)
  const unread = pages.filter((p) => !p.content)
  if (unread.length) throw new ServiceError(409, `Not read yet (run a Wiki Health audit on them first): ${unread.map((p) => p.name).join(', ')}.`)
  if (new Set(pages.map((p) => p.name)).size !== pages.length) throw new ServiceError(400, 'Two of the chosen pages have the same name; the AI could not tell them apart in its quotes.')
  return { pages, provider: ctx.config().ai.provider, model: ctx.config().ai.model, sends: pages.map((p) => ({ id: p.id, name: p.name, chars: Math.min(AI_TEXT_LIMIT, p.content!.text.length) })) }
}

/**
 * Asks the AI to compare 2–5 pages for contradictions (one request). Every finding must quote
 * at least two of the pages word for word; findings that do not are dropped. The AI's
 * explanation is shown as its suggestion; it is never treated as a fact.
 */
export async function compareWithAi(ctx: AppContext, rawInput: unknown) {
  const projectId = await requireProjectId(ctx)
  const preview = comparePreview(ctx, projectId, rawInput)
  const runId = newAppId('anr')
  ctx.repos.analysisRuns.insert({ id: runId, projectId, kind: 'knowledge', scope: { compare: preview.pages.map((p) => p.id) } })
  const texts = new Map(preview.pages.map((p) => [p.name, p.content!.text.slice(0, AI_TEXT_LIMIT)]))
  const user = `Compare these ${preview.pages.length} pages and list where they contradict each other.\n\n${preview.pages.map((p) => pageBlock(p.name, texts.get(p.name)!)).join('\n\n')}`
  let reply
  try {
    reply = await ctx.ai().analyse('compare_pages', user)
  } catch (error) {
    const message = error instanceof AiError ? error.message : (error as Error).message
    ctx.repos.analysisRuns.finish(runId, { status: 'failed', error: message, ai: { provider: preview.provider, model: preview.model, requests: 1 } })
    throw error instanceof AiError ? new ServiceError(502, message, [], error.kind) : error
  }
  let kept = 0
  let dropped = 0
  let created = 0
  const byName = new Map(preview.pages.map((p) => [p.name, p]))
  for (const f of reply.output.findings) {
    const quotes = f.quotes.filter((q) => texts.has(q.page) && q.quote.trim().length >= 3 && containsLoosely(texts.get(q.page)!, q.quote))
    if (new Set(quotes.map((q) => q.page)).size < 2) {
      dropped++
      continue
    }
    kept++
    const evidence: Citation[] = quotes.map((q) => ({ resourceId: byName.get(q.page)!.id, resourceName: q.page, field: null, passage: q.quote.slice(0, 500), version: byName.get(q.page)!.content!.version }))
    const fingerprint = fingerprintOf(evidence.map((e) => e.passage))
    const result = ctx.repos.knowledge.upsert(
      projectId,
      runId,
      { kind: 'contradiction', key: `ai-contr:${fingerprint}`, title: f.topic.slice(0, 200), summary: f.explanation.slice(0, 1000), resourceIds: [...new Set(evidence.map((e) => e.resourceId))], data: { contradictionKind: f.kind, comparedPages: preview.pages.map((p) => p.id) }, evidence, origin: 'ai', certainty: 'possible', fingerprint },
      newAppId('kni'),
    )
    if (result.created) created++
  }
  const ai = { provider: preview.provider, model: preview.model, servedBy: reply.servedByModel, requests: 1, inputTokens: reply.inputTokens, outputTokens: reply.outputTokens, proposed: reply.output.findings.length, dropped, suspectedInstructions: reply.output.suspectedInstructions }
  ctx.repos.analysisRuns.finish(runId, { status: 'completed', summary: { pages: preview.pages.length, kept, created }, ai })
  recordAudit(ctx, { operation: 'knowledge.compare', outcome: 'success', projectId, model: reply.servedByModel, message: `AI comparison of ${preview.pages.length} pages: ${kept} finding(s), ${dropped} dropped.`, details: { runId, kept, dropped, created } })
  return { runId, kept, dropped, created, ai }
}

/** Relationships for one page and its immediate neighbours (relationship browser). */
export function relationshipsFor(ctx: AppContext, projectId: string, resourceId: string) {
  const kb = knowledgeBase(ctx, projectId)
  const page = kb.byId.get(resourceId)
  if (!page) throw new ServiceError(404, 'That page is not in the last project scan.')
  const all = buildRelations(kb.pages)
  const inferred = textRelations(kb.pages, new Set(kb.pages.map((p) => p.id))).filter((r) => r.from === resourceId || r.to === resourceId)
  const decisions = new Map(ctx.repos.knowledge.list(projectId, { kinds: ['relationship'], resourceId, limit: 2000 }).items.map((i) => [i.key, i]))
  const edges = [...all.filter((r) => r.from === resourceId || r.to === resourceId), ...inferred].map((r) => ({
    ...r,
    direction: r.from === resourceId ? ('outgoing' as const) : ('incoming' as const),
    other: r.from === resourceId ? r.to : r.from,
    decision: r.support === 'text' ? decisions.get(`rel:${r.from}:${r.to}:${r.type}`)?.status ?? null : null,
  }))
  // AI-suggested relationships you accepted are shown as such.
  const accepted = ctx.repos.knowledge.list(projectId, { kinds: ['relationship'], statuses: ['accepted'], resourceId, limit: 500 }).items.filter((i) => i.origin === 'ai')
  for (const item of accepted) {
    const d = item.data as { from: string; to: string; type: keyof typeof RELATION_LABELS }
    edges.push({ from: d.from, to: d.to, type: d.type, support: 'ai', evidence: item.evidence[0]!, direction: d.from === resourceId ? 'outgoing' : 'incoming', other: d.from === resourceId ? d.to : d.from, decision: 'accepted' })
  }
  const neighbours = [...new Set(edges.map((e) => e.other))].map((id) => {
    const p = kb.byId.get(id)
    return { id, name: p?.name ?? id, kind: p?.kind ?? 'other', tags: p?.tags ?? [], read: Boolean(p?.content) }
  })
  return {
    page: { id: page.id, name: page.name, kind: page.kind, tags: page.tags, aliases: page.aliases, read: Boolean(page.content), parentId: page.parentId },
    edges,
    neighbours,
    labels: RELATION_LABELS,
    coverage: kb.stats,
    note: 'Incoming links are found by reading every page the audits have read (LegendKeeper has no backlinks endpoint), so they are only as complete as those audits.',
  }
}
