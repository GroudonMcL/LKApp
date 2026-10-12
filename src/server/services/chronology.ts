import 'server-only'
import { z } from 'zod'
import { DEFAULT_CALENDAR_SETTINGS, findCalendar, validateCalendarSettings, withAutoLinks, type CalendarSettings } from '@/core/chronology/calendar'
import { formatDate, orderKey, periodOf } from '@/core/chronology/dates'
import { buildChronology, type AcceptedEventInput, type ChronologyEntry, type NativeTimelineInput } from '@/core/chronology/entries'
import { newAppId } from '@/core/ids'
import { normalizeName } from '@/core/text'
import type { AppContext } from '../context'
import type { KnowledgeDraft, KnowledgeKind } from '../db/knowledge-repositories'
import { toConnectorError } from '../lk/errors'
import type { LkCalendarInfo } from '../lk/types'
import { recordAudit } from './audit'
import { sleep } from './batch-engine'
import { knownProjectId, requireProjectId } from './connection'
import { ServiceError } from './errors'
import { fingerprintOf } from './knowledge-items'
import { knowledgeBase } from './knowledge-base'

/**
 * The Chronology workspace: a local chronology built from verified page data, LegendKeeper
 * timelines as last read, and events you accepted. Reading it changes nothing anywhere.
 *
 * A LegendKeeper timeline is only ever changed by adding one event at a time through the
 * guarded write in timeline-writes.ts; nothing on this screen writes to LegendKeeper.
 */

const SETTINGS_KEY = 'chronology.calendars'
const LK_CALENDARS_KEY = 'chronology.lkCalendars'

export function calendarSettings(ctx: AppContext): CalendarSettings {
  const stored = ctx.repos.settings.get<unknown>(SETTINGS_KEY)
  if (!stored) return DEFAULT_CALENDAR_SETTINGS
  const checked = validateCalendarSettings(stored)
  return checked.ok ? checked.settings : DEFAULT_CALENDAR_SETTINGS
}

export function saveCalendarSettings(ctx: AppContext, input: unknown) {
  const checked = validateCalendarSettings(input)
  if (!checked.ok) throw new ServiceError(400, 'The calendar settings are not valid.', checked.issues)
  ctx.repos.settings.set(SETTINGS_KEY, checked.settings)
  recordAudit(ctx, { operation: 'chronology.calendars', outcome: 'success', message: `Calendar settings saved (${checked.settings.calendars.length} calendar(s)).` })
  return checked.settings
}

export function resetCalendarSettings(ctx: AppContext) {
  ctx.repos.settings.set(SETTINGS_KEY, DEFAULT_CALENDAR_SETTINGS)
  return DEFAULT_CALENDAR_SETTINGS
}

/** Pause between timeline reads (tests set 0). */
export const TIMELINE_TIMING = { readSpacingMs: 220 }

/**
 * Reads every LegendKeeper timeline the last scan found (documents of type "time"), with
 * their lanes, events and calendars. Read-only. Events of chained timelines are kept with
 * the timeline that holds them, so nothing is counted twice.
 */
export async function readTimelines(ctx: AppContext) {
  const projectId = await requireProjectId(ctx)
  const connector = ctx.connector()
  const docs = ctx.repos.index
    .forAudit(projectId)
    .flatMap((r) => r.documents.filter((d) => d.type === 'time').map((d) => ({ resourceId: r.id, resourceName: r.name, documentId: d.id, name: d.name })))
  if (!ctx.repos.index.stats(projectId).total) throw new ServiceError(409, 'The project has not been scanned yet. Run a scan in the Page browser first.')
  let calendars: LkCalendarInfo[] = []
  try {
    calendars = await connector.listCalendars()
    ctx.repos.settings.set(LK_CALENDARS_KEY, calendars)
  } catch (error) {
    throw toConnectorError(error)
  }
  let events = 0
  const failed: string[] = []
  for (const doc of docs) {
    try {
      const info = await connector.getTimelineDocument(doc.resourceId, doc.documentId)
      const lanes = await connector.listTimelineLanes(doc.resourceId, doc.documentId)
      const list = (await connector.listTimelineEvents(doc.resourceId, doc.documentId, 5000)).filter((e) => !e.external)
      const laneNames = new Map(lanes.map((l) => [l.id, l.name]))
      ctx.repos.timelines.replace(
        projectId,
        { resourceId: doc.resourceId, documentId: doc.documentId, resourceName: doc.resourceName, name: info.name, calendarId: info.calendarId, lanes, fetchedAt: ctx.now().toISOString(), error: null },
        list.map((e) => ({
          documentId: doc.documentId,
          eventId: e.id,
          resourceId: doc.resourceId,
          laneId: e.laneId,
          laneName: e.laneId ? laneNames.get(e.laneId) ?? null : null,
          type: e.type,
          name: e.name,
          formattedStart: e.formattedStart,
          formattedEnd: e.formattedEnd,
          startDate: e.startDate,
          endDate: e.endDate,
          detail: e.detail,
          uri: e.uri,
          isHidden: e.isHidden,
        })),
      )
      events += list.length
    } catch (error) {
      const failure = toConnectorError(error)
      if (failure.kind === 'rate_limited' || failure.kind === 'authentication' || failure.kind === 'connection') throw failure
      ctx.repos.timelines.markError(projectId, doc, failure.message)
      failed.push(`${doc.resourceName} / ${doc.name}: ${failure.message}`)
    }
    if (TIMELINE_TIMING.readSpacingMs) await sleep(TIMELINE_TIMING.readSpacingMs)
  }
  recordAudit(ctx, { operation: 'chronology.read_timelines', outcome: failed.length ? 'failure' : 'success', projectId, message: `Read ${docs.length} timeline(s), ${events} event(s).`, details: { timelines: docs.length, events, failed: failed.length } })
  return { timelines: docs.length, events, failed, calendars: calendars.length }
}

export function lkCalendars(ctx: AppContext): LkCalendarInfo[] {
  return ctx.repos.settings.get<LkCalendarInfo[]>(LK_CALENDARS_KEY) ?? []
}

/** Everything the chronology is built from, and the chronology itself. */
export function chronologyData(ctx: AppContext, projectId: string) {
  const { settings, autoLinked } = withAutoLinks(calendarSettings(ctx), lkCalendars(ctx))
  const kb = knowledgeBase(ctx, projectId)
  const cachedTimelines = ctx.repos.timelines.list(projectId)
  const allEvents = ctx.repos.timelines.events(projectId)
  const timelines: NativeTimelineInput[] = cachedTimelines.map((t) => ({ ...t, events: allEvents.filter((e) => e.documentId === t.documentId) }))
  const accepted: AcceptedEventInput[] = ctx.repos.knowledge
    .list(projectId, { kinds: ['event_candidate'], statuses: ['accepted', 'drafted'], limit: 10_000 })
    .items.map((item) => {
      const proposal = { ...item.data, ...(item.edits ?? {}) } as { title?: string; date?: string; summary?: string | null; participantIds?: string[] }
      const draft = item.draftJobId ? ctx.repos.drafts.getByJob(item.draftJobId) : null
      return {
        itemId: item.id,
        title: proposal.title ?? item.title,
        dateText: proposal.date ?? '',
        summary: proposal.summary ?? null,
        participantIds: proposal.participantIds ?? [],
        evidence: item.evidence,
        resourceId: draft?.createdResourceId ?? null,
      }
    })
  const { entries, conflicts } = buildChronology({ pages: kb.pages, timelines, accepted, settings })
  return { settings, autoLinked, kb, timelines: cachedTimelines, entries, conflicts }
}

export const ChronologyFilter = z.object({
  calendar: z.string().max(40).optional(),
  from: z.coerce.number().int().optional(),
  to: z.coerce.number().int().optional(),
  q: z.string().max(200).optional(),
  participant: z.string().max(100).optional(),
  participantKind: z.string().max(20).optional(),
  category: z.string().max(200).optional(),
  origin: z.enum(['event_page', 'page_field', 'native_timeline', 'accepted_candidate']).optional(),
  status: z.enum(['all', 'dated', 'uncertain', 'undated', 'conflicts']).default('all'),
  grouping: z.enum(['auto', 'year', 'decade', 'century']).default('auto'),
  limit: z.coerce.number().int().min(1).max(5000).default(1000),
})

function periodLabel(start: number, grouping: 'year' | 'decade' | 'century', settings: CalendarSettings, calendarId: string) {
  const calendar = findCalendar(settings, calendarId)
  const back = calendar.eras.find((e) => e.direction === 'backward')
  const fwd = calendar.primaryEra
  const suffix = grouping === 'year' ? '' : 's'
  if (start < 0) {
    const hi = Math.abs(start)
    return back ? `${grouping === 'year' ? hi : `${hi - (grouping === 'decade' ? 9 : 99)}–${hi}`} ${back.abbr}` : `${start}${suffix}`
  }
  if (grouping === 'century') return `${Math.max(start, 1)}–${start + 99} ${fwd}`
  return `${start}${suffix} ${fwd}`
}

export function chronologyView(ctx: AppContext, input: unknown) {
  const projectId = knownProjectId(ctx)
  if (!projectId) throw new ServiceError(409, 'Connect to LegendKeeper first.')
  const filter = ChronologyFilter.parse(input ?? {})
  const { settings, autoLinked, kb, timelines, entries, conflicts } = chronologyData(ctx, projectId)
  const calendarId = filter.calendar ?? settings.defaultCalendarId
  const q = filter.q?.trim().toLowerCase()
  const decisions = new Map(ctx.repos.knowledge.list(projectId, { kinds: ['chronology_conflict'], limit: 10_000 }).items.map((i) => [i.key, i]))

  const matches = (e: ChronologyEntry) => {
    if (e.date.kind !== 'unknown' && e.date.calendarId !== calendarId && e.date.kind !== 'relative') return false
    if (filter.origin && e.origin !== filter.origin) return false
    if (filter.participant && !e.participants.some((p) => p.resourceId === filter.participant) && e.resourceId !== filter.participant) return false
    if (filter.participantKind && !e.participants.some((p) => p.kind === filter.participantKind)) return false
    if (filter.category && !e.categories.includes(filter.category)) return false
    if (q && !`${e.title} ${e.summary ?? ''} ${e.date.original} ${e.participants.map((p) => p.name).join(' ')}`.toLowerCase().includes(q)) return false
    const key = orderKey(e.date)
    if ((filter.from !== undefined || filter.to !== undefined) && key === null) return false
    if (filter.from !== undefined && key !== null && (e.date.sort?.hi ?? key) < filter.from) return false
    if (filter.to !== undefined && key !== null && key > filter.to + 0.999) return false
    switch (filter.status) {
      case 'dated':
        return e.status === 'dated'
      case 'uncertain':
        return e.status === 'approximate' || e.status === 'relative' || e.status === 'unplaced'
      case 'undated':
        return e.status === 'undated'
      case 'conflicts':
        return e.conflictsWith.length > 0
      default:
        return true
    }
  }
  const shown = entries.filter(matches)
  const keys = shown.map((e) => orderKey(e.date)).filter((k): k is number => k !== null)
  const span = keys.length ? Math.max(...keys) - Math.min(...keys) : 0
  const grouping = filter.grouping !== 'auto' ? filter.grouping : span > 400 ? 'century' : span > 40 ? 'decade' : 'year'
  const periods = new Map<number, number>()
  for (const e of shown) {
    const p = periodOf(e.date, grouping)
    if (p !== null) periods.set(p, (periods.get(p) ?? 0) + 1)
  }
  const participantCounts = new Map<string, { resourceId: string; name: string; kind: string; count: number }>()
  const categoryCounts = new Map<string, number>()
  for (const e of entries) {
    for (const p of e.participants) participantCounts.set(p.resourceId, { ...p, count: (participantCounts.get(p.resourceId)?.count ?? 0) + 1 })
    for (const c of e.categories) categoryCounts.set(c, (categoryCounts.get(c) ?? 0) + 1)
  }
  const inCalendar = entries.filter((e) => e.date.calendarId === calendarId || e.date.kind === 'unknown')
  return {
    calendar: calendarId,
    calendars: settings.calendars.map((c) => ({ id: c.id, name: c.name, lkCalendarIds: c.lkCalendarIds, count: entries.filter((e) => e.date.calendarId === c.id && e.date.kind !== 'unknown').length })),
    settings: calendarSettings(ctx),
    autoLinked,
    grouping,
    entries: shown.slice(0, filter.limit).map((e) => ({ ...e, display: formatDate(e.date), period: periodOf(e.date, grouping) })),
    total: shown.length,
    periods: [...periods.entries()].sort((a, b) => a[0] - b[0]).map(([start, count]) => ({ start, count, label: periodLabel(start, grouping, settings, calendarId) })),
    counts: {
      all: inCalendar.length,
      dated: inCalendar.filter((e) => e.status === 'dated').length,
      uncertain: inCalendar.filter((e) => e.status === 'approximate' || e.status === 'relative' || e.status === 'unplaced').length,
      undated: inCalendar.filter((e) => e.status === 'undated').length,
      conflicts: inCalendar.filter((e) => e.conflictsWith.length > 0).length,
    },
    conflicts: conflicts.map((c) => {
      const item = decisions.get(`chronology:${c.key}`)
      return { ...c, itemId: item?.id ?? null, decision: item?.status ?? null }
    }),
    sources: {
      ...kb.stats,
      eventPages: entries.filter((e) => e.origin === 'event_page').length,
      pageFields: entries.filter((e) => e.origin === 'page_field').length,
      accepted: entries.filter((e) => e.origin === 'accepted_candidate').length,
      native: entries.filter((e) => e.origin === 'native_timeline').length,
      timelines: timelines.map((t) => ({ ...t })),
    },
    lkCalendars: lkCalendars(ctx),
    participants: [...participantCounts.values()].sort((a, b) => b.count - a.count || a.name.localeCompare(b.name)).slice(0, 400),
    categories: [...categoryCounts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 200).map(([name, count]) => ({ name, count })),
  }
}

/**
 * Records chronology conflicts and unresolved event dates as review items, so they reach the
 * review queue and your decisions on them persist. Run after reading timelines, after event
 * discovery, and on request.
 */
export function syncChronologyFindings(ctx: AppContext, projectId: string, runId: string | null = null) {
  const { entries, conflicts, kb } = chronologyData(ctx, projectId)
  const byId = new Map(entries.map((e) => [e.id, e]))
  const run = runId ?? newAppId('anr')
  if (!runId) ctx.repos.analysisRuns.insert({ id: run, projectId, kind: 'knowledge', scope: { chronology: true } })
  let created = 0
  const seen = new Set<string>()
  const upsert = (draft: KnowledgeDraft) => {
    seen.add(draft.key)
    if (ctx.repos.knowledge.upsert(projectId, run, draft, newAppId('kni')).created) created++
  }
  for (const c of conflicts) {
    const involved = c.entryIds.map((id) => byId.get(id)).filter((e): e is ChronologyEntry => Boolean(e))
    const evidence = involved.flatMap((e) => e.sources)
    upsert({
      kind: 'chronology_conflict',
      key: `chronology:${c.key}`,
      title: c.title,
      summary: c.explanation,
      resourceIds: [...new Set(involved.flatMap((e) => [e.resourceId, ...e.sources.map((s) => s.resourceId)]).filter((x): x is string => Boolean(x)))],
      data: { conflictKind: c.kind, entries: involved.map((e) => ({ id: e.id, title: e.title, date: e.date.original, display: formatDate(e.date), origin: e.origin })) },
      evidence,
      origin: 'deterministic',
      certainty: c.certainty === 'likely' ? 'likely' : 'possible',
      fingerprint: fingerprintOf(evidence.map((s) => s.passage)),
    })
  }
  for (const e of entries) {
    if (e.origin !== 'event_page' || (e.status !== 'undated' && e.status !== 'unplaced')) continue
    const page = kb.byId.get(e.resourceId ?? '')
    if (!page?.content) continue
    upsert({
      kind: 'unresolved_date',
      key: `undated:${e.resourceId}`,
      title: `“${e.title}” has no usable date`,
      summary: e.date.notes.join(' ') || 'The event page has no date the app can read.',
      resourceIds: [e.resourceId!],
      data: { entryId: e.id, original: e.date.original },
      evidence: e.sources,
      origin: 'deterministic',
      certainty: 'stated',
      fingerprint: fingerprintOf(e.sources.map((s) => s.passage)),
    })
  }
  // Conflicts and undated pages that are no longer there.
  const kinds: KnowledgeKind[] = ['chronology_conflict', 'unresolved_date']
  let resolved = 0
  for (const item of ctx.repos.knowledge.list(projectId, { kinds, statuses: ['open'], limit: 10_000 }).items) {
    if (seen.has(item.key)) continue
    ctx.repos.knowledge.setStatus(item.id, 'resolved', 'No longer found: the dates now agree, or the page changed.')
    resolved++
  }
  if (!runId) ctx.repos.analysisRuns.finish(run, { status: 'completed', summary: { conflicts: conflicts.length, created, resolved } })
  return { conflicts: conflicts.length, created, resolved }
}

export function entryKeyForTitle(title: string) {
  return normalizeName(title)
}
