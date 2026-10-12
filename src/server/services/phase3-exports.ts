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

/** Filled in with the relationship browser (Milestone 5). */
export function exportRelationships(_ctx: AppContext, _params: Record<string, string>, _format: 'csv' | 'json'): { fileName: string; contentType: string; body: string } {
  throw new ServiceError(404, 'Relationship export is not available yet.')
}
