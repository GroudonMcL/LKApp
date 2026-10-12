import 'server-only'
import { z } from 'zod'
import { dateFromQuote, existingMatches, extractEventsFromPage, groupCandidates, participantsIn, referenceIndexFor, type EventCandidate } from '@/core/chronology/discovery'
import { formatDate } from '@/core/chronology/dates'
import type { KbPage } from '@/core/chronology/entries'
import { newAppId } from '@/core/ids'
import { containsLoosely, normalizeName } from '@/core/text'
import { AiError } from '../ai/provider'
import { pageBlock } from '../ai/prompts/analysis'
import type { AppContext } from '../context'
import type { Citation } from '../db/knowledge-repositories'
import { log } from '../log'
import { recordAudit } from './audit'
import { calendarSettings, chronologyData } from './chronology'
import { requireProjectId } from './connection'
import { ServiceError } from './errors'
import { fingerprintOf } from './knowledge-items'
import { PageScope, resolvePageRefs, selectPages } from './page-scope'

/**
 * Event discovery: finds historical events described in ordinary pages and records them as
 * candidates for you to accept, edit, reject or defer. Works from the page content the last
 * audits read; nothing is read from or written to LegendKeeper.
 *
 * - The rule-based reader runs on every selected page and needs no AI.
 * - Optionally, the AI reads up to `aiPageLimit` pages too. Only those pages' text (up to 8,000
 *   characters each) and names are sent, to the provider chosen in Settings. Every AI proposal
 *   must quote the page word for word, and its date must be words from that quote; anything
 *   else is dropped. The app, not the model, reads the date.
 * - The same passage never produces a second candidate: candidates are keyed by event name and
 *   date, and a decision you took stays unless the cited wording changes.
 */

export const DiscoveryInput = z.object({
  scope: PageScope.default({ mode: 'all', pageTypes: [], folderId: null, tag: null, nameContains: null, resourceIds: [], maxPages: 2000 }),
  /** Page names, ids or links (resolved to ids; replaces scope.resourceIds). */
  pageRefs: z.array(z.string().max(300)).max(500).optional(),
  useAi: z.boolean().default(false),
  aiPageLimit: z.number().int().min(1).max(25).default(5),
})
export type DiscoveryInput = z.infer<typeof DiscoveryInput>

const AI_TEXT_LIMIT = 8000

const RUNNING = Symbol.for('lk-companion.discovery-runs')
function running(): Map<string, Promise<void>> {
  const g = globalThis as unknown as Record<symbol, Map<string, Promise<void>> | undefined>
  if (!g[RUNNING]) g[RUNNING] = new Map()
  return g[RUNNING]!
}

export function discoveryPreview(ctx: AppContext, projectId: string, input: DiscoveryInput) {
  const scope = input.pageRefs?.length ? { ...input.scope, mode: 'resources' as const, resourceIds: resolvePageRefs(ctx.repos.index.forAudit(projectId), input.pageRefs) } : input.scope
  const selected = selectPages(ctx.repos.index.forAudit(projectId), scope)
  const { kb } = chronologyData(ctx, projectId)
  const pages = selected.map((p) => kb.byId.get(p.id)).filter((p): p is KbPage => Boolean(p))
  const readable = pages.filter((p) => p.content)
  const aiPages = input.useAi ? readable.slice(0, input.aiPageLimit) : []
  return {
    scope,
    pages: pages.length,
    readable: readable.length,
    notRead: pages.filter((p) => !p.content).map((p) => ({ id: p.id, name: p.name })).slice(0, 50),
    ai: input.useAi
      ? {
          provider: ctx.config().ai.provider,
          model: ctx.config().ai.model,
          pages: aiPages.map((p) => ({ id: p.id, name: p.name, chars: Math.min(AI_TEXT_LIMIT, p.content!.text.length) })),
          sends: 'Each listed page’s name and its text (up to 8,000 characters), with fixed instructions. Never your keys or other pages.',
          requests: aiPages.length,
        }
      : null,
  }
}

export async function startDiscovery(ctx: AppContext, rawInput: unknown, options: { wait?: boolean } = {}) {
  const projectId = await requireProjectId(ctx)
  const parsed = DiscoveryInput.safeParse(rawInput ?? {})
  if (!parsed.success) throw new ServiceError(400, 'The discovery settings are not valid.', parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`))
  if (running().size) throw new ServiceError(409, 'Event discovery is already running. Wait for it to finish.')
  if (!ctx.repos.index.stats(projectId).total) throw new ServiceError(409, 'The project has not been scanned yet. Run a scan in the Page browser first.')
  const preview = discoveryPreview(ctx, projectId, parsed.data)
  if (preview.readable === 0) throw new ServiceError(409, 'None of the selected pages has been read yet. Run a Wiki Health audit on them first (it only reads).')
  const input = { ...parsed.data, scope: preview.scope }
  const runId = newAppId('anr')
  ctx.repos.analysisRuns.insert({ id: runId, projectId, kind: 'event_discovery', scope: { ...input.scope, useAi: input.useAi, aiPageLimit: input.aiPageLimit } })
  const promise = execute(ctx, projectId, runId, input)
    .catch((error) => {
      log.error('Event discovery failed', { runId, error })
      ctx.repos.analysisRuns.finish(runId, { status: 'failed', error: (error as Error).message })
    })
    .finally(() => running().delete(runId))
  running().set(runId, promise)
  if (options.wait) await promise
  return { runId, preview }
}

async function execute(ctx: AppContext, projectId: string, runId: string, input: DiscoveryInput) {
  const settings = calendarSettings(ctx)
  const { kb, entries } = chronologyData(ctx, projectId)
  const selected = selectPages(ctx.repos.index.forAudit(projectId), input.scope)
  const pages = selected.map((p) => kb.byId.get(p.id)).filter((p): p is KbPage => Boolean(p?.content))
  const dctx = { settings, pages: kb.byId, refs: referenceIndexFor(kb.pages) }

  const candidates: EventCandidate[] = pages.flatMap((page) => extractEventsFromPage(page, dctx))

  const ai = { used: false, provider: null as string | null, model: null as string | null, servedBy: [] as string[], requests: 0, inputTokens: 0, outputTokens: 0, proposed: 0, dropped: 0, stopped: null as string | null, suspectedInstructions: [] as string[] }
  const aiPageIds: string[] = []
  if (input.useAi) {
    ai.used = true
    ai.provider = ctx.config().ai.provider
    ai.model = ctx.config().ai.model
    for (const page of pages.slice(0, input.aiPageLimit)) {
      aiPageIds.push(page.id)
      try {
        const text = page.content!.text.slice(0, AI_TEXT_LIMIT)
        const reply = await ctx.ai().analyse('extract_events', `Find the historical events described in this page.\n\n${pageBlock(page.name, text)}`)
        ai.requests++
        ai.servedBy.push(reply.servedByModel)
        ai.inputTokens += reply.inputTokens ?? 0
        ai.outputTokens += reply.outputTokens ?? 0
        ai.suspectedInstructions.push(...reply.output.suspectedInstructions.map((s) => `${page.name}: ${s}`))
        ai.proposed += reply.output.events.length
        for (const event of reply.output.events) {
          // The quote must really be on the page; the date must be words from the quote.
          if (!event.passage.trim() || !containsLoosely(text, event.passage)) {
            ai.dropped++
            continue
          }
          const notes: string[] = []
          let dateText = event.dateText?.trim() || null
          if (dateText && !containsLoosely(event.passage, dateText)) {
            notes.push(`The AI gave the date “${dateText}”, which is not in the quoted passage; it was ignored.`)
            dateText = null
          }
          const date = dateFromQuote(dateText, settings)
          if (dateText && !date) notes.push(`“${dateText}” could not be read as a date; it is kept as written.`)
          if (event.note) notes.push(`AI note: ${event.note}`)
          const { ids, unmatched } = participantsIn(`${event.passage} ${[...event.people, ...event.factions, ...event.places].join(' ')}`, page, dctx)
          // Names the AI lists are matched exactly against page names and aliases (short names
          // such as "Iuz" too); a name matching several pages is reported, not guessed.
          const named = [...new Set([...event.people, ...event.factions, ...event.places].map((n) => n.trim()).filter(Boolean))]
          const unmatchedNames = [...unmatched]
          for (const n of named) {
            const exact = dctx.refs.find(n).exact
            if (exact.length === 1) {
              if (!ids.includes(exact[0]!.resourceId)) ids.push(exact[0]!.resourceId)
            } else if (!ids.some((id) => kb.byId.get(id)?.name === n || kb.byId.get(id)?.aliases.includes(n))) unmatchedNames.push(exact.length > 1 ? `${n} (matches ${exact.length} pages)` : n)
          }
          candidates.push({
            title: event.title.trim().slice(0, 200) || 'Untitled event',
            kind: event.kind,
            dateText: date ? dateText : null,
            date,
            summary: event.summary.trim().slice(0, 600),
            participantIds: ids,
            unmatchedNames: [...new Set(unmatchedNames)],
            evidence: [{ resourceId: page.id, resourceName: page.name, field: null, passage: event.passage.trim().slice(0, 1000), version: page.content!.version }],
            origin: 'ai',
            notes,
          })
        }
      } catch (error) {
        if (error instanceof AiError) {
          ai.stopped = error.message
          break
        }
        throw error
      }
    }
  }

  const grouped = groupCandidates(candidates, settings.approximateToleranceYears)
  const scopeIds = new Set(pages.map((p) => p.id))
  let created = 0
  for (const c of grouped) {
    const dateKey = c.date?.sort ? String(Math.floor(c.date.sort.lo)) : 'undated'
    const key = `event:${normalizeName(c.title)}:${dateKey}`
    const previous = ctx.repos.knowledge.getByKey(projectId, key)
    // Keep what earlier runs found on pages outside this run's scope.
    const evidence: Citation[] = [...(previous?.evidence.filter((e) => !scopeIds.has(e.resourceId)) ?? []), ...c.evidence]
    const sources = new Set(evidence.map((e) => e.resourceId)).size
    const existing = existingMatches(c.title, c.date, entries.filter((e) => e.id !== (previous ? `item:${previous.id}` : '')), settings.approximateToleranceYears)
    const participants = c.participantIds.map((id) => kb.byId.get(id)).filter((p): p is KbPage => Boolean(p))
    const result = ctx.repos.knowledge.upsert(
      projectId,
      runId,
      {
        kind: 'event_candidate',
        key,
        title: c.title,
        summary: c.summary,
        resourceIds: [...new Set([...evidence.map((e) => e.resourceId), ...c.participantIds])],
        data: {
          title: c.title,
          eventKind: c.kind,
          date: c.dateText ?? '',
          dateReading: c.date ? { display: formatDate(c.date), kind: c.date.kind, precision: c.date.precision, approximate: c.date.approximate, notes: c.date.notes } : null,
          summary: c.summary,
          participantIds: c.participantIds,
          participants: participants.map((p) => ({ resourceId: p.id, name: p.name, kind: p.kind })),
          unmatchedNames: c.unmatchedNames,
          notes: c.notes,
          existing,
          sourceCount: sources,
          singleSource: sources === 1,
        },
        evidence,
        origin: c.origin,
        certainty: c.origin === 'ai' ? (c.date ? 'likely' : 'possible') : c.date ? 'stated' : 'possible',
        fingerprint: fingerprintOf(evidence.map((e) => e.passage)),
      },
      newAppId('kni'),
    )
    if (result.created) created++
  }
  let resolved = ctx.repos.knowledge.resolveMissing(projectId, runId, ['event_candidate'], scopeIds, 'deterministic')
  if (ai.used && !ai.stopped) resolved += ctx.repos.knowledge.resolveMissing(projectId, runId, ['event_candidate'], new Set(aiPageIds), 'ai')
  const summary = { pages: pages.length, candidates: grouped.length, created, resolved, ruleBased: candidates.filter((c) => c.origin === 'deterministic').length, fromAi: candidates.filter((c) => c.origin === 'ai').length }
  ctx.repos.analysisRuns.finish(runId, { status: 'completed', summary, ai: ai.used ? ai : null })
  recordAudit(ctx, {
    operation: 'chronology.discover',
    outcome: ai.stopped ? 'failure' : 'success',
    projectId,
    model: ai.used ? ai.model : null,
    message: `Event discovery: ${pages.length} page(s), ${grouped.length} candidate(s), ${created} new${ai.used ? `, ${ai.requests} AI request(s)` : ''}.`,
    details: { runId, ...summary, aiRequests: ai.requests, aiStopped: ai.stopped },
  })
}

export async function waitForDiscovery() {
  await Promise.all([...running().values()])
}

export function discoveryState(ctx: AppContext, projectId: string) {
  return { running: running().size > 0, runs: ctx.repos.analysisRuns.list(projectId, 'event_discovery', 10) }
}
