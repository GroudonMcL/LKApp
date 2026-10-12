import 'server-only'
import { formatDate } from '@/core/chronology/dates'
import { truncateForDisplay } from '@/core/text'
import { configuredSecrets } from '../config'
import type { AppContext } from '../context'
import { redactSecrets } from '../redact'
import { chronologyView } from './chronology'
import { knownProjectId } from './connection'
import { ServiceError } from './errors'
import { toCsv } from './import-batches'
import { listItems } from './knowledge-items'
import { knowledgeBase } from './knowledge-base'
import { RELATION_LABELS, SUPPORT_LABELS, buildRelations, textRelations } from '@/core/knowledge/analysis'

/**
 * Exports of chronology and knowledge analysis. Each row carries the resource ids and the
 * short cited passage it rests on (at most 300 characters), never whole pages, and passes
 * through secret redaction like every other export.
 */

type Row = Record<string, string | number | null>
const PASSAGE = 300

function file(name: string, format: 'csv' | 'json', rows: Row[], json: unknown) {
  const secrets = configuredSecrets()
  return format === 'json'
    ? { fileName: `${name}.json`, contentType: 'application/json', body: JSON.stringify(redactSecrets(json, secrets), null, 2) }
    : { fileName: `${name}.csv`, contentType: 'text/csv', body: toCsv(redactSecrets(rows, secrets) as Row[]) }
}

export function exportChronology(ctx: AppContext, params: Record<string, string>, format: 'csv' | 'json') {
  const view = chronologyView(ctx, { ...params, limit: 5000 })
  const entries = view.entries.map((e) => ({
    id: e.id,
    title: e.title,
    origin: e.origin,
    status: e.status,
    resourceId: e.resourceId,
    date: {
      asWritten: e.date.original,
      readAs: formatDate(e.date),
      kind: e.date.kind,
      precision: e.date.precision,
      approximate: e.date.approximate,
      calendar: e.date.calendarId,
      start: e.date.start,
      end: e.date.end,
      relative: e.date.relative,
      sortRange: e.date.sort,
      notes: e.date.notes,
    },
    participants: e.participants,
    timeline: e.timeline,
    conflictsWith: e.conflictsWith,
    sources: e.sources.map((s) => ({ ...s, passage: truncateForDisplay(s.passage, PASSAGE) })),
  }))
  const rows: Row[] = entries.map((e) => ({
    title: e.title,
    date_as_written: e.date.asWritten,
    date_read_as: e.date.readAs,
    kind: e.date.kind,
    precision: e.date.precision,
    approximate: e.date.approximate ? 'yes' : 'no',
    calendar: e.date.calendar,
    sort_from: e.date.sortRange ? Math.floor(e.date.sortRange.lo) : null,
    sort_to: e.date.sortRange ? Math.floor(e.date.sortRange.hi) : null,
    date_notes: e.date.notes.join(' '),
    status: e.status,
    origin: e.origin,
    resource_id: e.resourceId,
    participants: e.participants.map((p) => `${p.name} [${p.resourceId}]`).join('; '),
    timeline_event: e.timeline ? `${e.timeline.resourceId}/${e.timeline.documentId}/${e.timeline.eventId}` : null,
    conflicts_with: e.conflictsWith.join('; '),
    source_resource_ids: e.sources.map((s) => s.resourceId).join('; '),
    source_fields: e.sources.map((s) => s.field ?? '').join('; '),
    source_passages: e.sources.map((s) => s.passage).join(' | '),
  }))
  return file(`chronology-${view.calendar}`, format, rows, { exportedAt: ctx.now().toISOString(), calendar: view.calendar, conflicts: view.conflicts, entries })
}

export function exportKnowledge(ctx: AppContext, params: Record<string, string>, format: 'csv' | 'json') {
  if (!knownProjectId(ctx)) throw new ServiceError(409, 'Connect to LegendKeeper first.')
  const { items } = listItems(ctx, { ...params, limit: 2000 })
  const trimmed = items.map((i) => ({
    id: i.id,
    kind: i.kind,
    title: i.title,
    summary: i.summary,
    status: i.status,
    statusNote: i.statusNote,
    origin: i.origin,
    support: i.origin === 'ai' ? 'AI suggestion (not verified)' : i.certainty === 'stated' ? 'explicitly stated' : `inferred (${i.certainty})`,
    resourceIds: i.resourceIds,
    data: i.data,
    edits: i.edits,
    evidence: i.evidence.map((c) => ({ ...c, passage: truncateForDisplay(c.passage, PASSAGE) })),
    firstSeenAt: i.firstSeenAt,
    lastSeenAt: i.lastSeenAt,
  }))
  const rows: Row[] = trimmed.map((i) => ({
    kind: i.kind,
    title: i.title,
    summary: i.summary,
    status: i.status,
    support: i.support,
    resource_ids: i.resourceIds.join('; '),
    evidence_pages: i.evidence.map((c) => `${c.resourceName} [${c.resourceId}]`).join('; '),
    evidence_fields: i.evidence.map((c) => c.field ?? '').join('; '),
    evidence_passages: i.evidence.map((c) => c.passage).join(' | '),
    note: i.statusNote,
    first_seen: i.firstSeenAt,
    last_seen: i.lastSeenAt,
  }))
  return file('knowledge-findings', format, rows, { exportedAt: ctx.now().toISOString(), items: trimmed })
}

/** Every relationship the app knows, with how directly it is supported. */
export function exportRelationships(ctx: AppContext, params: Record<string, string>, format: 'csv' | 'json') {
  const projectId = knownProjectId(ctx)
  if (!projectId) throw new ServiceError(409, 'Connect to LegendKeeper first.')
  const kb = knowledgeBase(ctx, projectId)
  const all = new Set(kb.pages.map((p) => p.id))
  const relations = [...buildRelations(kb.pages), ...textRelations(kb.pages, all)].filter((r) => !params.resourceId || r.from === params.resourceId || r.to === params.resourceId)
  const accepted = ctx.repos.knowledge.list(projectId, { kinds: ['relationship'], statuses: ['accepted'], limit: 100_000 }).items
  const decided = new Map(ctx.repos.knowledge.list(projectId, { kinds: ['relationship'], limit: 100_000 }).items.map((i) => [i.key, i.status]))
  const name = (id: string) => kb.byId.get(id)?.name ?? id
  const items = [
    ...relations.map((r) => ({
      from: { id: r.from, name: name(r.from) },
      relationship: RELATION_LABELS[r.type],
      to: { id: r.to, name: name(r.to) },
      support: r.support,
      explicit: r.support !== 'text' && r.support !== 'ai',
      decision: r.support === 'text' ? decided.get(`rel:${r.from}:${r.to}:${r.type}`) ?? 'open' : null,
      evidence: { ...r.evidence, passage: truncateForDisplay(r.evidence.passage, PASSAGE) },
    })),
    ...accepted
      .filter((i) => i.origin === 'ai')
      .map((i) => {
        const d = i.data as { from: string; to: string; type: keyof typeof RELATION_LABELS }
        return { from: { id: d.from, name: name(d.from) }, relationship: RELATION_LABELS[d.type], to: { id: d.to, name: name(d.to) }, support: 'ai' as const, explicit: false, decision: 'accepted', evidence: { ...i.evidence[0]!, passage: truncateForDisplay(i.evidence[0]?.passage ?? '', PASSAGE) } }
      }),
  ]
  const rows: Row[] = items.map((r) => ({
    from_id: r.from.id,
    from: r.from.name,
    relationship: r.relationship,
    to_id: r.to.id,
    to: r.to.name,
    support: SUPPORT_LABELS[r.support],
    explicitly_supported: r.explicit ? 'yes' : 'no (suggested)',
    decision: r.decision,
    evidence_page_id: r.evidence.resourceId,
    evidence_field: r.evidence.field,
    evidence_passage: r.evidence.passage,
  }))
  return file(params.resourceId ? `relationships-${params.resourceId}` : 'relationships', format, rows, { exportedAt: ctx.now().toISOString(), note: 'Incoming links are derived by reading pages; LegendKeeper has no backlinks endpoint.', relationships: items })
}
