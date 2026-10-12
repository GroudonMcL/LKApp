import 'server-only'
import type { Db } from './connection'

const now = () => new Date().toISOString()
const json = (value: unknown) => JSON.stringify(value)
const parse = <T>(value: string | null | undefined, fallback: T): T => (value === null || value === undefined ? fallback : (JSON.parse(value) as T))

// ── Native timelines (read-only copies) ─────────────────────────────────────────

export interface TimelineLane {
  id: string
  name: string
  /** True when the lane comes from a chained timeline. */
  external: boolean
}

export interface CachedTimeline {
  resourceId: string
  documentId: string
  resourceName: string
  name: string
  calendarId: string | null
  lanes: TimelineLane[]
  eventCount: number
  fetchedAt: string
  error: string | null
}

export interface LkEventDate {
  year: number
  month: number
  monthName: string
  day: number
  era: { id?: string; name?: string; abbr?: string } | null
}

export interface CachedTimelineEvent {
  documentId: string
  eventId: string
  resourceId: string
  laneId: string | null
  laneName: string | null
  type: string
  name: string
  formattedStart: string | null
  formattedEnd: string | null
  startDate: LkEventDate | null
  endDate: LkEventDate | null
  detail: number | null
  uri: string | null
  isHidden: boolean
  fetchedAt: string
}

export class TimelinesRepo {
  constructor(private readonly db: Db) {}
  /** Replaces what is known of one timeline document with a fresh read. */
  replace(projectId: string, timeline: Omit<CachedTimeline, 'eventCount'>, events: Omit<CachedTimelineEvent, 'fetchedAt'>[]) {
    const at = timeline.fetchedAt
    this.db.prepare('DELETE FROM lk_timeline_events WHERE project_id = ? AND document_id = ?').run(projectId, timeline.documentId)
    const insert = this.db.prepare(
      `INSERT INTO lk_timeline_events (project_id, document_id, event_id, resource_id, lane_id, lane_name, type, name, formatted_start, formatted_end, start_date, end_date, detail, uri, is_hidden, fetched_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    for (const e of events)
      insert.run(projectId, e.documentId, e.eventId, e.resourceId, e.laneId, e.laneName, e.type, e.name, e.formattedStart, e.formattedEnd, json(e.startDate), json(e.endDate), e.detail, e.uri, e.isHidden ? 1 : 0, at)
    this.db
      .prepare(
        `INSERT INTO lk_timelines (project_id, resource_id, document_id, resource_name, name, calendar_id, lanes, event_count, fetched_at, error) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(project_id, document_id) DO UPDATE SET resource_id = excluded.resource_id, resource_name = excluded.resource_name, name = excluded.name, calendar_id = excluded.calendar_id,
           lanes = excluded.lanes, event_count = excluded.event_count, fetched_at = excluded.fetched_at, error = excluded.error`,
      )
      .run(projectId, timeline.resourceId, timeline.documentId, timeline.resourceName, timeline.name, timeline.calendarId, json(timeline.lanes), events.length, at, timeline.error)
  }
  markError(projectId: string, timeline: { resourceId: string; documentId: string; resourceName: string; name: string }, error: string) {
    this.db
      .prepare(
        `INSERT INTO lk_timelines (project_id, resource_id, document_id, resource_name, name, calendar_id, lanes, event_count, fetched_at, error) VALUES (?, ?, ?, ?, ?, NULL, '[]', 0, ?, ?)
         ON CONFLICT(project_id, document_id) DO UPDATE SET fetched_at = excluded.fetched_at, error = excluded.error`,
      )
      .run(projectId, timeline.resourceId, timeline.documentId, timeline.resourceName, timeline.name, now(), error)
  }
  list(projectId: string): CachedTimeline[] {
    const rows = this.db.prepare('SELECT * FROM lk_timelines WHERE project_id = ? ORDER BY resource_name, name').all(projectId) as Record<string, unknown>[]
    return rows.map((r) => ({
      resourceId: String(r.resource_id),
      documentId: String(r.document_id),
      resourceName: String(r.resource_name),
      name: String(r.name),
      calendarId: (r.calendar_id as string | null) ?? null,
      lanes: parse(r.lanes as string, []),
      eventCount: Number(r.event_count),
      fetchedAt: String(r.fetched_at),
      error: (r.error as string | null) ?? null,
    }))
  }
  events(projectId: string, documentId?: string): CachedTimelineEvent[] {
    const rows = (
      documentId
        ? this.db.prepare('SELECT * FROM lk_timeline_events WHERE project_id = ? AND document_id = ?').all(projectId, documentId)
        : this.db.prepare('SELECT * FROM lk_timeline_events WHERE project_id = ?').all(projectId)
    ) as Record<string, unknown>[]
    return rows.map((r) => ({
      documentId: String(r.document_id),
      eventId: String(r.event_id),
      resourceId: String(r.resource_id),
      laneId: (r.lane_id as string | null) ?? null,
      laneName: (r.lane_name as string | null) ?? null,
      type: String(r.type),
      name: String(r.name),
      formattedStart: (r.formatted_start as string | null) ?? null,
      formattedEnd: (r.formatted_end as string | null) ?? null,
      startDate: parse(r.start_date as string | null, null),
      endDate: parse(r.end_date as string | null, null),
      detail: (r.detail as number | null) ?? null,
      uri: (r.uri as string | null) ?? null,
      isHidden: r.is_hidden === 1,
      fetchedAt: String(r.fetched_at),
    }))
  }
  /** Adds or replaces one event after an app write (and its read-back). */
  putEvent(projectId: string, e: Omit<CachedTimelineEvent, 'fetchedAt'>) {
    this.db
      .prepare(
        `INSERT OR REPLACE INTO lk_timeline_events (project_id, document_id, event_id, resource_id, lane_id, lane_name, type, name, formatted_start, formatted_end, start_date, end_date, detail, uri, is_hidden, fetched_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(projectId, e.documentId, e.eventId, e.resourceId, e.laneId, e.laneName, e.type, e.name, e.formattedStart, e.formattedEnd, json(e.startDate), json(e.endDate), e.detail, e.uri, e.isHidden ? 1 : 0, now())
    this.db.prepare('UPDATE lk_timelines SET event_count = (SELECT COUNT(*) FROM lk_timeline_events WHERE project_id = ? AND document_id = ?) WHERE project_id = ? AND document_id = ?').run(projectId, e.documentId, projectId, e.documentId)
  }
}

// ── Knowledge items: findings, candidates and your decisions ───────────────────

export const KNOWLEDGE_KINDS = {
  event_candidate: 'Proposed historical event',
  chronology_conflict: 'Conflicting historical claims',
  unresolved_date: 'Unresolved chronology',
  missing_page: 'Missing entity page',
  relationship: 'Suggested relationship',
  terminology: 'Possible entity-name inconsistency',
  contradiction: 'Possible contradiction',
  link_suggestion: 'Suggested link',
} as const
export type KnowledgeKind = keyof typeof KNOWLEDGE_KINDS

/**
 * - `open`: waiting for a decision.
 * - `accepted`: you agree (an accepted event becomes part of the local chronology).
 * - `drafted`: a draft page was made from it (the draft then goes through the usual approval).
 * - `deferred`: needs further research.
 * - `rejected`: not right, or not useful.
 * - `intentional`: a difference that is on purpose (e.g. an unreliable narrator).
 * - `resolved`: fixed, or no longer found by a later analysis of the same pages.
 */
export type KnowledgeStatus = 'open' | 'accepted' | 'drafted' | 'deferred' | 'rejected' | 'intentional' | 'resolved'

export interface Citation {
  resourceId: string
  resourceName: string
  /** The labelled field the claim comes from, or null for running text. */
  field: string | null
  /** The words the claim rests on, as they appear on the page. */
  passage: string
  /** The page's document version when it was read. */
  version: string | null
}

export interface KnowledgeItem {
  id: string
  projectId: string
  kind: KnowledgeKind
  key: string
  title: string
  summary: string
  resourceIds: string[]
  data: Record<string, unknown>
  evidence: Citation[]
  edits: Record<string, unknown> | null
  origin: 'deterministic' | 'ai'
  certainty: 'stated' | 'likely' | 'possible'
  fingerprint: string
  status: KnowledgeStatus
  statusNote: string | null
  statusFingerprint: string | null
  draftJobId: string | null
  runId: string | null
  firstSeenAt: string
  lastSeenAt: string
  statusChangedAt: string | null
}

export type KnowledgeDraft = Pick<KnowledgeItem, 'kind' | 'key' | 'title' | 'summary' | 'resourceIds' | 'data' | 'evidence' | 'origin' | 'certainty' | 'fingerprint'>

const toItem = (r: Record<string, unknown>): KnowledgeItem => ({
  id: String(r.id),
  projectId: String(r.project_id),
  kind: r.kind as KnowledgeKind,
  key: String(r.key),
  title: String(r.title),
  summary: String(r.summary),
  resourceIds: parse(r.resource_ids as string, []),
  data: parse(r.data as string, {}),
  evidence: parse(r.evidence as string, []),
  edits: parse(r.edits as string | null, null),
  origin: r.origin as KnowledgeItem['origin'],
  certainty: r.certainty as KnowledgeItem['certainty'],
  fingerprint: String(r.fingerprint),
  status: r.status as KnowledgeStatus,
  statusNote: (r.status_note as string | null) ?? null,
  statusFingerprint: (r.status_fingerprint as string | null) ?? null,
  draftJobId: (r.draft_job_id as string | null) ?? null,
  runId: (r.run_id as string | null) ?? null,
  firstSeenAt: String(r.first_seen_at),
  lastSeenAt: String(r.last_seen_at),
  statusChangedAt: (r.status_changed_at as string | null) ?? null,
})

export interface KnowledgeFilter {
  kinds?: KnowledgeKind[]
  statuses?: KnowledgeStatus[]
  resourceId?: string
  search?: string
  limit?: number
  offset?: number
}

/** Decisions that a change in the cited passages re-opens. */
const REOPEN_ON_CHANGE: KnowledgeStatus[] = ['rejected', 'intentional', 'deferred', 'resolved']

export class KnowledgeRepo {
  constructor(private readonly db: Db) {}
  get(id: string): KnowledgeItem | null {
    const row = this.db.prepare('SELECT * FROM knowledge_items WHERE id = ?').get(id) as Record<string, unknown> | undefined
    return row ? toItem(row) : null
  }
  getByKey(projectId: string, key: string): KnowledgeItem | null {
    const row = this.db.prepare('SELECT * FROM knowledge_items WHERE project_id = ? AND key = ?').get(projectId, key) as Record<string, unknown> | undefined
    return row ? toItem(row) : null
  }
  /**
   * Records an item found by a run. Seen before: your decision stands, unless the cited
   * passages changed since you took it (then it is opened again, with a note saying why).
   * Returns whether it is new.
   */
  upsert(projectId: string, runId: string | null, draft: KnowledgeDraft, id: string): { item: KnowledgeItem; created: boolean } {
    const at = now()
    const existing = this.getByKey(projectId, draft.key)
    if (!existing) {
      this.db
        .prepare(
          `INSERT INTO knowledge_items (id, project_id, kind, key, title, summary, resource_ids, data, evidence, origin, certainty, fingerprint, status, run_id, first_seen_at, last_seen_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'open', ?, ?, ?)`,
        )
        .run(id, projectId, draft.kind, draft.key, draft.title, draft.summary, json(draft.resourceIds), json(draft.data), json(draft.evidence), draft.origin, draft.certainty, draft.fingerprint, runId, at, at)
      return { item: this.get(id)!, created: true }
    }
    let status = existing.status
    let note = existing.statusNote
    if (REOPEN_ON_CHANGE.includes(status) && existing.statusFingerprint !== null && existing.statusFingerprint !== draft.fingerprint) {
      note = `Opened again: the source wording changed after it was marked ${status}.`
      status = 'open'
    }
    this.db
      .prepare(
        `UPDATE knowledge_items SET title = ?, summary = ?, resource_ids = ?, data = ?, evidence = ?, origin = ?, certainty = ?, fingerprint = ?, status = ?, status_note = ?, run_id = ?, last_seen_at = ? WHERE id = ?`,
      )
      .run(draft.title, draft.summary, json(draft.resourceIds), json(draft.data), json(draft.evidence), draft.origin, draft.certainty, draft.fingerprint, status, note, runId, at, existing.id)
    return { item: this.get(existing.id)!, created: false }
  }
  setStatus(id: string, status: KnowledgeStatus, note: string | null) {
    const item = this.get(id)
    if (!item) return
    this.db.prepare('UPDATE knowledge_items SET status = ?, status_note = ?, status_fingerprint = ?, status_changed_at = ? WHERE id = ?').run(status, note, item.fingerprint, now(), id)
  }
  setEdits(id: string, edits: Record<string, unknown> | null) {
    this.db.prepare('UPDATE knowledge_items SET edits = ? WHERE id = ?').run(edits === null ? null : json(edits), id)
  }
  setDraftJob(id: string, jobId: string) {
    this.db.prepare("UPDATE knowledge_items SET draft_job_id = ?, status = 'drafted', status_fingerprint = fingerprint, status_changed_at = ? WHERE id = ?").run(jobId, now(), id)
  }
  /**
   * Items of the given kinds, for the given pages, that a complete run over those pages no
   * longer found. Open ones are marked resolved; decisions you took are kept as they are.
   */
  resolveMissing(projectId: string, runId: string, kinds: KnowledgeKind[], resourceIds: Set<string>): number {
    const rows = this.db
      .prepare(`SELECT * FROM knowledge_items WHERE project_id = ? AND status = 'open' AND (run_id IS NULL OR run_id != ?) AND kind IN (${kinds.map(() => '?').join(', ')})`)
      .all(projectId, runId, ...kinds) as Record<string, unknown>[]
    let n = 0
    for (const row of rows) {
      const item = toItem(row)
      // Only items that rest entirely on pages this run looked at.
      if (!item.evidence.length || !item.evidence.every((c) => resourceIds.has(c.resourceId))) continue
      this.db.prepare("UPDATE knowledge_items SET status = 'resolved', status_note = 'Not found by a later analysis of the same pages.', status_changed_at = ? WHERE id = ?").run(now(), item.id)
      n++
    }
    return n
  }
  list(projectId: string, filter: KnowledgeFilter = {}): { items: KnowledgeItem[]; total: number } {
    const where = ['project_id = ?']
    const args: unknown[] = [projectId]
    if (filter.kinds?.length) {
      where.push(`kind IN (${filter.kinds.map(() => '?').join(', ')})`)
      args.push(...filter.kinds)
    }
    if (filter.statuses?.length) {
      where.push(`status IN (${filter.statuses.map(() => '?').join(', ')})`)
      args.push(...filter.statuses)
    }
    if (filter.resourceId) {
      where.push('resource_ids LIKE ?')
      args.push(`%"${filter.resourceId.replace(/[%_"]/g, '')}"%`)
    }
    if (filter.search) {
      where.push('(title LIKE ? OR summary LIKE ?)')
      args.push(`%${filter.search}%`, `%${filter.search}%`)
    }
    const total = (this.db.prepare(`SELECT COUNT(*) AS n FROM knowledge_items WHERE ${where.join(' AND ')}`).get(...args) as { n: number }).n
    const rows = this.db
      .prepare(`SELECT * FROM knowledge_items WHERE ${where.join(' AND ')} ORDER BY last_seen_at DESC, title LIMIT ? OFFSET ?`)
      .all(...args, filter.limit ?? 200, filter.offset ?? 0) as Record<string, unknown>[]
    return { items: rows.map(toItem), total }
  }
  counts(projectId: string): { kind: KnowledgeKind; status: KnowledgeStatus; n: number }[] {
    return this.db.prepare('SELECT kind, status, COUNT(*) AS n FROM knowledge_items WHERE project_id = ? GROUP BY kind, status').all(projectId) as { kind: KnowledgeKind; status: KnowledgeStatus; n: number }[]
  }
}

// ── Analysis runs ───────────────────────────────────────────────────────────────

export interface AnalysisRun {
  id: string
  projectId: string
  kind: 'event_discovery' | 'knowledge' | 'timelines'
  scope: Record<string, unknown>
  status: 'running' | 'completed' | 'failed'
  summary: Record<string, unknown>
  ai: Record<string, unknown> | null
  error: string | null
  startedAt: string
  finishedAt: string | null
}

export class AnalysisRunsRepo {
  constructor(private readonly db: Db) {}
  insert(run: Pick<AnalysisRun, 'id' | 'projectId' | 'kind' | 'scope'>) {
    this.db.prepare("INSERT INTO analysis_runs (id, project_id, kind, scope, status, started_at) VALUES (?, ?, ?, ?, 'running', ?)").run(run.id, run.projectId, run.kind, json(run.scope), now())
  }
  finish(id: string, outcome: { status: 'completed' | 'failed'; summary?: Record<string, unknown>; ai?: Record<string, unknown> | null; error?: string | null }) {
    this.db.prepare('UPDATE analysis_runs SET status = ?, summary = ?, ai = ?, error = ?, finished_at = ? WHERE id = ?').run(outcome.status, json(outcome.summary ?? {}), outcome.ai ? json(outcome.ai) : null, outcome.error ?? null, now(), id)
  }
  get(id: string): AnalysisRun | null {
    const r = this.db.prepare('SELECT * FROM analysis_runs WHERE id = ?').get(id) as Record<string, unknown> | undefined
    return r ? toRun(r) : null
  }
  list(projectId: string, kind?: AnalysisRun['kind'], limit = 20): AnalysisRun[] {
    const rows = (
      kind
        ? this.db.prepare('SELECT * FROM analysis_runs WHERE project_id = ? AND kind = ? ORDER BY started_at DESC LIMIT ?').all(projectId, kind, limit)
        : this.db.prepare('SELECT * FROM analysis_runs WHERE project_id = ? ORDER BY started_at DESC LIMIT ?').all(projectId, limit)
    ) as Record<string, unknown>[]
    return rows.map(toRun)
  }
}

const toRun = (r: Record<string, unknown>): AnalysisRun => ({
  id: String(r.id),
  projectId: String(r.project_id),
  kind: r.kind as AnalysisRun['kind'],
  scope: parse(r.scope as string, {}),
  status: r.status as AnalysisRun['status'],
  summary: parse(r.summary as string, {}),
  ai: parse(r.ai as string | null, null),
  error: (r.error as string | null) ?? null,
  startedAt: String(r.started_at),
  finishedAt: (r.finished_at as string | null) ?? null,
})

// ── Saved searches ─────────────────────────────────────────────────────────────

export interface SavedSearch {
  id: string
  name: string
  query: Record<string, unknown>
  createdAt: string
}

export class SavedSearchesRepo {
  constructor(private readonly db: Db) {}
  list(): SavedSearch[] {
    return (this.db.prepare('SELECT * FROM saved_searches ORDER BY name').all() as Record<string, unknown>[]).map((r) => ({ id: String(r.id), name: String(r.name), query: parse(r.query as string, {}), createdAt: String(r.created_at) }))
  }
  insert(search: Omit<SavedSearch, 'createdAt'>) {
    this.db.prepare('INSERT INTO saved_searches (id, name, query, created_at) VALUES (?, ?, ?, ?)').run(search.id, search.name, json(search.query), now())
  }
  remove(id: string) {
    this.db.prepare('DELETE FROM saved_searches WHERE id = ?').run(id)
  }
}

// ── Native timeline writes ─────────────────────────────────────────────────────

export type TimelineWriteStatus = 'prepared' | 'writing' | 'verified' | 'mismatch' | 'uncertain' | 'failed'

export interface TimelineWrite {
  id: string
  projectId: string
  itemId: string | null
  resourceId: string
  documentId: string
  eventId: string
  payload: Record<string, unknown>
  status: TimelineWriteStatus
  readback: Record<string, unknown> | null
  error: string | null
  createdAt: string
  writtenAt: string | null
}

export class TimelineWritesRepo {
  constructor(private readonly db: Db) {}
  insert(w: Pick<TimelineWrite, 'id' | 'projectId' | 'itemId' | 'resourceId' | 'documentId' | 'eventId' | 'payload'>) {
    this.db
      .prepare("INSERT INTO timeline_writes (id, project_id, item_id, resource_id, document_id, event_id, payload, status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, 'prepared', ?)")
      .run(w.id, w.projectId, w.itemId, w.resourceId, w.documentId, w.eventId, json(w.payload), now())
  }
  update(id: string, patch: { status: TimelineWriteStatus; readback?: Record<string, unknown> | null; error?: string | null; written?: boolean }) {
    this.db
      .prepare('UPDATE timeline_writes SET status = ?, readback = COALESCE(?, readback), error = ?, written_at = CASE WHEN ? THEN ? ELSE written_at END WHERE id = ?')
      .run(patch.status, patch.readback ? json(patch.readback) : null, patch.error ?? null, patch.written ? 1 : 0, now(), id)
  }
  get(id: string): TimelineWrite | null {
    const r = this.db.prepare('SELECT * FROM timeline_writes WHERE id = ?').get(id) as Record<string, unknown> | undefined
    return r ? toWrite(r) : null
  }
  list(projectId: string, limit = 100): TimelineWrite[] {
    return (this.db.prepare('SELECT * FROM timeline_writes WHERE project_id = ? ORDER BY created_at DESC LIMIT ?').all(projectId, limit) as Record<string, unknown>[]).map(toWrite)
  }
  forItem(itemId: string): TimelineWrite[] {
    return (this.db.prepare('SELECT * FROM timeline_writes WHERE item_id = ? ORDER BY created_at DESC').all(itemId) as Record<string, unknown>[]).map(toWrite)
  }
}

const toWrite = (r: Record<string, unknown>): TimelineWrite => ({
  id: String(r.id),
  projectId: String(r.project_id),
  itemId: (r.item_id as string | null) ?? null,
  resourceId: String(r.resource_id),
  documentId: String(r.document_id),
  eventId: String(r.event_id),
  payload: parse(r.payload as string, {}),
  status: r.status as TimelineWriteStatus,
  readback: parse(r.readback as string | null, null),
  error: (r.error as string | null) ?? null,
  createdAt: String(r.created_at),
  writtenAt: (r.written_at as string | null) ?? null,
})
