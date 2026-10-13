import 'server-only'
import { z } from 'zod'
import { OPERATIONS, TaskPlan, interpretRequest, stepUsesAi, withoutPlaceholders, type NamedPage, type Step } from '@/core/assistant/plan'
import type { KbPage } from '@/core/chronology/entries'
import { ENTITY_KIND_LABELS } from '@/core/knowledge/entities'
import { unlinkedMentions } from '@/core/knowledge/analysis'
import { normalizeName, normalizeTag } from '@/core/text'
import { AiError } from '../ai/provider'
import { fenced } from '../ai/prompts/analysis'
import type { AppContext } from '../context'
import { recordAudit } from './audit'
import { calendarSettings, chronologyView } from './chronology'
import { orderKey, parseDate } from '@/core/chronology/dates'
import { requireProjectId } from './connection'
import { ServiceError } from './errors'
import { startDiscovery } from './event-discovery'
import { compareWithAi, relationshipsFor, runKnowledgeAnalysis } from './knowledge-analysis'
import { knowledgeBase } from './knowledge-base'

/**
 * The Task Assistant: a plain-English request becomes a plan of steps from a fixed list of
 * operations (core/assistant/plan.ts), and each step runs an existing app service.
 *
 * - The model never calls LegendKeeper, the database or the file system, and never chooses
 *   an API call: at most it proposes a plan, which is validated against the same schema
 *   as the rule-based planner's and run by this file's own switch over the allowed operations.
 * - Steps only read, or record findings in the app for your review. Nothing writes to
 *   LegendKeeper here; requests for changes are handed to the tool that makes them with
 *   its own final preview and approval.
 * - Steps that send page text to the AI provider need your explicit confirmation, after the
 *   plan has said exactly what will be sent.
 */

const PlanInput = z.object({ request: z.string().trim().min(3).max(1000), useAi: z.boolean().default(false) })
const RunInput = z.object({
  plan: z.unknown(),
  /** Your answer when a name matched several pages: the words as written → the page id. */
  choices: z.record(z.string(), z.string()).default({}),
  confirmAi: z.boolean().default(false),
})

const HANDOFF: Record<string, { label: string; href: string }> = {
  tagging: { label: 'Tagging assistant', href: '/tagging' },
  migration: { label: 'Template migration', href: '/migrations' },
  import: { label: 'Import', href: '/import' },
  timeline: { label: 'Chronology (add an event to a timeline)', href: '/chronology' },
  health: { label: 'Wiki Health', href: '/health' },
}

function namedPages(kb: ReturnType<typeof knowledgeBase>): NamedPage[] {
  const parents = new Set(kb.pages.map((p) => p.parentId).filter(Boolean))
  return kb.pages.map((p) => ({ id: p.id, name: p.name, aliases: p.aliases, hasChildren: parents.has(p.id) }))
}

type Resolution = { asWritten: string; page: { id: string; name: string } | null; candidates: { id: string; name: string; path: string }[] }

function resolveRef(ref: string, kb: ReturnType<typeof knowledgeBase>, choices: Record<string, string>): Resolution {
  const chosen = choices[ref]
  const page = (id: string) => kb.byId.get(id)
  if (chosen && page(chosen)) return { asWritten: ref, page: { id: chosen, name: page(chosen)!.name }, candidates: [] }
  const fromLink = ref.match(/resources\/([a-z0-9]{6,32})/i)?.[1] ?? ref.trim()
  if (page(fromLink)) return { asWritten: ref, page: { id: fromLink, name: page(fromLink)!.name }, candidates: [] }
  const key = normalizeName(ref)
  const exact = kb.pages.filter((p) => normalizeName(p.name) === key || p.aliases.some((a) => normalizeName(a) === key))
  const describe = (p: KbPage) => ({ id: p.id, name: p.name, path: p.ancestors.join(' / ') })
  if (exact.length === 1) return { asWritten: ref, page: { id: exact[0]!.id, name: exact[0]!.name }, candidates: [] }
  if (exact.length > 1) return { asWritten: ref, page: null, candidates: exact.map(describe) }
  const near = kb.pages.filter((p) => key.length >= 4 && [p.name, ...p.aliases].some((n) => normalizeName(n).includes(key))).slice(0, 8)
  return { asWritten: ref, page: null, candidates: near.map(describe) }
}

function refsOf(step: Step): string[] {
  switch (step.op) {
    case 'find_pages':
      return [step.within, step.linksTo].filter((r): r is string => Boolean(r))
    case 'events':
      return step.involving ? [step.involving] : []
    case 'references_to':
    case 'unlinked_mentions':
    case 'relationships':
      return [step.target]
    case 'discover_events':
    case 'compare_pages':
      return step.pages
    case 'knowledge_analysis':
      return step.within ? [step.within] : []
    default:
      return []
  }
}

/** Describes a validated plan: what each step does, which names it refers to, and what goes to the AI. */
function annotate(ctx: AppContext, plan: TaskPlan, kb: ReturnType<typeof knowledgeBase>, choices: Record<string, string> = {}) {
  const steps = plan.steps.map((step) => {
    const meta = OPERATIONS[step.op]
    const refs = refsOf(step).map((r) => resolveRef(r, kb, choices))
    const ai = stepUsesAi(step)
    const pagesForAi = ai ? refs.filter((r) => r.page).map((r) => r.page!) : []
    return {
      step,
      label: meta.label,
      effect: meta.effect,
      describes: meta.describes,
      usesAi: ai,
      refs,
      sends: ai ? `The name and text of ${pagesForAi.map((p) => `“${p.name}”`).join(', ') || 'the chosen pages'} (up to ${step.op === 'compare_pages' ? '6,000' : '8,000'} characters each), to ${ctx.config().ai.provider} (${ctx.config().ai.model}).` : null,
    }
  })
  const unresolved = steps.flatMap((s) => s.refs.filter((r) => !r.page))
  const clarification =
    plan.clarification ??
    (unresolved.length
      ? {
          question: unresolved[0]!.candidates.length > 1 ? `“${unresolved[0]!.asWritten}” matches ${unresolved[0]!.candidates.length} pages. Which one?` : unresolved[0]!.candidates.length === 1 ? `Did you mean “${unresolved[0]!.candidates[0]!.name}” for “${unresolved[0]!.asWritten}”?` : `No page is called “${unresolved[0]!.asWritten}”. Which page did you mean?`,
          options: unresolved[0]!.candidates.map((c) => c.name),
        }
      : null)
  const limitations = [
    `Page content is as of the last Wiki Health audit (${kb.stats.read} of ${kb.stats.indexed} pages read).`,
    ...(steps.some((s) => s.step.op === 'old_layout') ? ['Layout checks come from the last audit that ran the layout check.'] : []),
    ...(steps.some((s) => s.step.op === 'references_to' || s.step.op === 'relationships') ? ['LegendKeeper has no backlinks endpoint: incoming links are found by reading the pages audits have read.'] : []),
  ]
  return {
    plan,
    steps,
    needsAi: steps.some((s) => s.usesAi),
    writes: false,
    clarification,
    pendingChoices: unresolved.map((r) => ({ asWritten: r.asWritten, candidates: r.candidates })),
    canRun: plan.steps.length > 0 && unresolved.length === 0 && !plan.clarification,
    limitations,
  }
}

export async function planTask(ctx: AppContext, rawInput: unknown) {
  const projectId = await requireProjectId(ctx)
  const input = PlanInput.parse(rawInput ?? {})
  const kb = knowledgeBase(ctx, projectId)
  let plan: TaskPlan | null = null
  let source: 'rules' | 'ai' = 'rules'
  let ai: Record<string, unknown> | null = null
  if (input.useAi) {
    const tags = ctx.repos.index.tagCounts(projectId).slice(0, 200).map((t) => t.tag)
    const ops = Object.entries(OPERATIONS).map(([op, m]) => `- ${op}: ${m.describes}`).join('\n')
    const user = [
      fenced('request', input.request),
      'Operations (use only these "op" values; fields as in the output schema):',
      ops,
      `Entity kinds: ${Object.keys(ENTITY_KIND_LABELS).join(', ')}.`,
      `Tags in the wiki: ${tags.map((t) => JSON.stringify(t)).join(', ') || '(none)'}.`,
    ].join('\n\n')
    try {
      const reply = await ctx.ai().analyse('plan_task', user)
      plan = TaskPlan.parse(withoutPlaceholders(reply.output))
      source = 'ai'
      ai = { provider: ctx.config().ai.provider, model: ctx.config().ai.model, servedBy: reply.servedByModel, sent: 'Your request, the list of operations, entity kinds and your tag names. No page text.' }
    } catch (error) {
      if (error instanceof AiError) throw new ServiceError(502, error.message, [], error.kind)
      if (error instanceof z.ZodError) throw new ServiceError(502, 'The AI proposed a plan the app does not allow; it was discarded.', error.issues.map((i) => `${i.path.join('.')}: ${i.message}`))
      throw error
    }
  } else {
    plan = interpretRequest(input.request, namedPages(kb))
  }
  recordAudit(ctx, { operation: 'assistant.plan', outcome: plan ? 'success' : 'info', projectId, model: source === 'ai' ? ctx.config().ai.model : null, message: `Plan (${source}) for: ${input.request.slice(0, 200)}`, details: { steps: plan?.steps.map((s) => s.op) ?? [] } })
  if (!plan)
    return {
      source,
      ai,
      recognised: false,
      message: 'This request did not match a known kind of task. Rephrase it (e.g. “Find all untagged NPC pages in …”, “Report references to …”), or ask the AI to plan it; only your request, the list of operations and your tag names are sent.',
    }
  return { source, ai, recognised: true, ...annotate(ctx, plan, kb) }
}

interface ResultRow {
  resourceId: string | null
  cells: Record<string, string>
}
interface StepResult {
  op: Step['op']
  title: string
  summary: string
  columns: string[]
  rows: ResultRow[]
  links: { label: string; href: string }[]
  notes: string[]
}

function descendants(kb: ReturnType<typeof knowledgeBase>, rootId: string): Set<string> {
  const ids = new Set<string>([rootId])
  let grew = true
  while (grew) {
    grew = false
    for (const p of kb.pages) if (p.parentId && ids.has(p.parentId) && !ids.has(p.id)) (ids.add(p.id), (grew = true))
  }
  ids.delete(rootId)
  return ids
}

export async function runTask(ctx: AppContext, rawInput: unknown) {
  const projectId = await requireProjectId(ctx)
  const input = RunInput.parse(rawInput ?? {})
  // The plan is validated again: whatever the browser sends, only allowed operations run.
  const parsed = TaskPlan.safeParse(input.plan)
  if (!parsed.success) throw new ServiceError(400, 'The plan is not valid; only the listed operations can run.', parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`))
  const kb = knowledgeBase(ctx, projectId)
  const view = annotate(ctx, parsed.data, kb, input.choices)
  if (!view.canRun) throw new ServiceError(409, view.clarification?.question ?? 'The plan needs more information before it can run.')
  if (view.needsAi && !input.confirmAi) throw new ServiceError(409, 'This plan sends page text to the AI provider. Confirm that first.', [], 'AI_CONFIRMATION_REQUIRED')
  const results: StepResult[] = []
  for (const annotated of view.steps) results.push(await execute(ctx, projectId, kb, annotated.step, annotated.refs))
  recordAudit(ctx, { operation: 'assistant.run', outcome: 'success', projectId, message: `Ran ${results.length} step(s): ${results.map((r) => r.op).join(', ')}`, details: { steps: results.map((r) => ({ op: r.op, rows: r.rows.length })), ai: view.needsAi } })
  return { results, plan: parsed.data }
}

async function execute(ctx: AppContext, projectId: string, kb: ReturnType<typeof knowledgeBase>, step: Step, refs: Resolution[]): Promise<StepResult> {
  const id = (i = 0) => refs[i]!.page!.id
  const pageName = (rid: string) => kb.byId.get(rid)?.name ?? rid
  const base = { op: step.op, links: [] as StepResult['links'], notes: [] as string[] }
  switch (step.op) {
    case 'find_pages': {
      const within = step.within ? descendants(kb, id(0)) : null
      const linksTo = step.linksTo ? refs[step.within ? 1 : 0]!.page!.id : null
      const tag = step.tag ? normalizeTag(step.tag) : null
      const needle = step.textContains?.toLowerCase()
      const rows = kb.pages.filter(
        (p) =>
          (!step.kind || p.kind === step.kind) &&
          (!step.untagged || p.tags.length === 0) &&
          (!tag || p.tags.some((t) => normalizeTag(t) === tag)) &&
          (!within || within.has(p.id)) &&
          (!linksTo || Boolean(p.content?.mentionIds.includes(linksTo) || p.content?.fields.some((f) => f.mentionIds.includes(linksTo)))) &&
          (!step.nameContains || p.name.toLowerCase().includes(step.nameContains.toLowerCase())) &&
          (!needle || Boolean(p.content?.text.toLowerCase().includes(needle))),
      )
      if (linksTo || needle) base.notes.push(`Links and text are as of the last audit; ${kb.stats.indexed - kb.stats.read} page(s) have not been read.`)
      if (step.kind) base.notes.push(`“${ENTITY_KIND_LABELS[step.kind]}” pages are recognised by their tags, page type or folder.`)
      return {
        ...base,
        title: 'Pages',
        summary: `${rows.length} page(s).`,
        columns: ['Page', 'Kind', 'Tags', 'Folder'],
        rows: rows.slice(0, 500).map((p) => ({ resourceId: p.id, cells: { Page: p.name, Kind: p.kind, Tags: p.tags.join(', ') || '(none)', Folder: p.ancestors.join(' / ') } })),
        links: rows.length && step.untagged ? [{ label: 'Tag them with the Tagging assistant', href: '/tagging' }] : [],
      }
    }
    case 'events': {
      const query = (status: string) => chronologyView(ctx, { status, participant: step.involving ? id(0) : undefined, participantKind: step.involvingKind, from: step.from, to: step.to, q: step.text, limit: 2000 }).entries
      const entries = step.dates === 'unconfirmed' ? [...query('uncertain'), ...query('undated')] : query(step.dates === 'any' ? 'all' : step.dates)
      base.notes.push('Events come from event pages, dated fields, LegendKeeper timelines as last read, and events you accepted. To find more in ordinary pages, run event discovery.')
      return {
        ...base,
        title: 'Events',
        summary: `${entries.length} event(s).`,
        columns: ['Date', 'Event', 'Status', 'Source'],
        rows: entries.map((e) => ({ resourceId: e.resourceId, cells: { Date: e.display, Event: e.title, Status: e.status, Source: e.sources[0]?.resourceName ?? '' } })),
        links: [{ label: 'Open the Chronology', href: '/chronology' }, { label: 'Event discovery', href: '/chronology/discover' }],
      }
    }
    case 'references_to': {
      const target = id(0)
      const rel = relationshipsFor(ctx, projectId, target).edges.filter((e) => e.direction === 'incoming' && e.type !== 'part_of')
      const unlinked = unlinkedMentions(kb.pages, new Set(kb.pages.map((p) => p.id)), { minNameLength: 3 }).filter((m) => m.target.id === target)
      const rows: ResultRow[] = [
        ...rel.map((e) => ({ resourceId: e.from, cells: { Page: pageName(e.from), How: e.support === 'field' ? `field “${e.evidence.field}”` : e.support === 'link' ? 'links to it' : 'wording', Passage: e.evidence.passage } })),
        ...unlinked.map((m) => ({ resourceId: m.page.id, cells: { Page: m.page.name, How: 'names it without a link', Passage: m.passage } })),
      ]
      base.notes.push('Incoming links are found by reading the pages audits have read; LegendKeeper has no backlinks endpoint.')
      return { ...base, title: `References to ${pageName(target)}`, summary: `${rows.length} reference(s) on ${new Set(rows.map((r) => r.resourceId)).size} page(s).`, columns: ['Page', 'How', 'Passage'], rows, links: [{ label: 'Relationship browser', href: `/relationships?id=${target}` }] }
    }
    case 'unlinked_mentions': {
      const target = id(0)
      const found = unlinkedMentions(kb.pages, new Set(kb.pages.map((p) => p.id)), { minNameLength: 3 }).filter((m) => m.target.id === target)
      return {
        ...base,
        title: `Pages naming ${pageName(target)} without linking to it`,
        summary: `${found.length} page(s).`,
        columns: ['Page', 'Name used', 'Passage'],
        rows: found.map((m) => ({ resourceId: m.page.id, cells: { Page: m.page.name, 'Name used': m.name, Passage: m.passage } })),
        links: found.length ? [{ label: 'Add links with a template migration (it adds links and changes nothing else)', href: '/migrations' }] : [],
        notes: ['A name used by several pages is skipped, as it cannot be linked unambiguously.'],
      }
    }
    case 'relationships': {
      const r = relationshipsFor(ctx, projectId, id(0))
      return {
        ...base,
        title: `Relationships of ${r.page.name}`,
        summary: `${r.edges.length} relationship(s) with ${r.neighbours.length} page(s).`,
        columns: ['Page', 'Relationship', 'Direction', 'Support'],
        rows: r.edges.map((e) => ({ resourceId: e.other, cells: { Page: pageName(e.other), Relationship: r.labels[e.type], Direction: e.direction === 'outgoing' ? `${r.page.name} → this page` : `this page → ${r.page.name}`, Support: e.support } })),
        links: [{ label: 'Open in the relationship browser', href: `/relationships?id=${r.page.id}` }],
        notes: [r.note],
      }
    }
    case 'old_layout': {
      const tag = step.tag ? normalizeTag(step.tag) : null
      const findings = ctx.repos.findings.list(projectId, { categories: ['template'], statuses: ['open', 'queued'], limit: 2000 }).items.filter((f) => {
        const p = f.resourceId ? kb.byId.get(f.resourceId) : null
        return p && (!step.kind || p.kind === step.kind) && (!tag || p.tags.some((t) => normalizeTag(t) === tag))
      })
      return {
        ...base,
        title: 'Pages that do not match their template',
        summary: `${findings.length} page(s), from the layout findings of the last Wiki Health audit.`,
        columns: ['Page', 'Finding'],
        rows: findings.map((f) => ({ resourceId: f.resourceId, cells: { Page: f.resourceName ?? '', Finding: f.explanation } })),
        links: [
          { label: 'Wiki Health', href: '/health' },
          { label: 'Move them to the template (Template migration)', href: '/migrations' },
        ],
        notes: findings.length ? [] : ['No layout findings. If no audit has run the layout check recently, run one in Wiki Health first.'],
      }
    }
    case 'discover_events': {
      const ids = refs.map((r) => r.page!.id)
      await startDiscovery(ctx, { pageRefs: ids, useAi: step.useAi, aiPageLimit: Math.min(25, ids.length) }, { wait: true })
      const wanted = new Set(ids)
      const items = ctx.repos.knowledge.list(projectId, { kinds: ['event_candidate'], limit: 2000 }).items.filter((i) => i.status !== 'resolved' && i.evidence.some((e) => wanted.has(e.resourceId)))
      const settings = calendarSettings(ctx)
      const withKey = items
        .map((i) => {
          const d = i.data as { date?: string; dateReading?: { display: string } | null }
          const date = { ...(i.edits ?? {}) }.date as string | undefined
          return { i, d, key: orderKey(parseDate(date ?? d.date ?? '', settings, { allowBareYear: false })) }
        })
        .sort((a, b) => (a.key ?? Infinity) - (b.key ?? Infinity) || a.i.title.localeCompare(b.i.title))
      return {
        ...base,
        title: 'Suggested chronology',
        summary: `${items.length} event candidate(s) from ${ids.length} page(s), recorded for your review (nothing was written).`,
        columns: ['Date', 'Event', 'Status', 'Sources'],
        rows: withKey.map(({ i, d }) => ({ resourceId: i.evidence[0]?.resourceId ?? null, cells: { Date: d.dateReading?.display ?? (d.date || 'no date'), Event: i.title, Status: i.status, Sources: [...new Set(i.evidence.map((e) => e.resourceName))].join(', ') } })),
        links: [{ label: 'Review the candidates', href: '/chronology/discover' }],
        notes: ['Each candidate states what a page says, not that it is true. Accept the ones you agree with to add them to the chronology.'],
      }
    }
    case 'compare_pages': {
      const ids = refs.map((r) => r.page!.id)
      const result = await compareWithAi(ctx, { pageRefs: ids })
      const items = ctx.repos.knowledge.list(projectId, { kinds: ['contradiction'], limit: 2000 }).items.filter((i) => i.origin === 'ai' && ids.every((pid) => ((i.data as { comparedPages?: string[] }).comparedPages ?? []).includes(pid)))
      return {
        ...base,
        title: 'Inconsistencies found by the AI',
        summary: `${result.kept} finding(s) with quotes from both sides; ${result.dropped} dropped because their quotes were not on the pages.`,
        columns: ['Topic', 'Explanation (AI)', 'Quotes'],
        rows: items.map((i) => ({ resourceId: i.resourceIds[0] ?? null, cells: { Topic: i.title, 'Explanation (AI)': i.summary, Quotes: i.evidence.map((e) => `${e.resourceName}: “${e.passage}”`).join(' | ') } })),
        links: [{ label: 'Decide on them in Knowledge analysis', href: '/knowledge?tab=contradiction' }],
        notes: ['The AI’s explanations are suggestions; the app does not decide which page is right.'],
      }
    }
    case 'knowledge_analysis': {
      const scope = step.within ? { mode: 'folder' as const, folderId: id(0) } : { mode: 'all' as const }
      const { summary } = await runKnowledgeAnalysis(ctx, { scope, checks: step.checks })
      return {
        ...base,
        title: 'Knowledge analysis',
        summary: `${summary.pages} page(s) analysed: ${summary.recorded} finding(s), ${summary.created} new.`,
        columns: ['Kind', 'Found'],
        rows: Object.entries(summary.found).map(([k, n]) => ({ resourceId: null, cells: { Kind: k, Found: String(n) } })),
        links: [{ label: 'Review the findings', href: '/knowledge' }],
      }
    }
    case 'handoff': {
      const tool = HANDOFF[step.tool]!
      return { ...base, title: tool.label, summary: step.reason, columns: [], rows: [], links: [{ label: `Open ${tool.label}`, href: tool.href }], notes: ['The assistant does not write to LegendKeeper.'] }
    }
  }
}
