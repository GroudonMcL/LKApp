import 'server-only'
import type { Db } from './connection'
import type { AuditCategory, Certainty, FindingDraft, Severity } from '@/core/audit-checks'
import type { PageStructure } from '../lk/structure'

const now = () => new Date().toISOString()
const json = (value: unknown) => JSON.stringify(value)
const parse = <T>(value: string | null | undefined, fallback: T): T => (value === null || value === undefined ? fallback : (JSON.parse(value) as T))

// ── Audit runs ────────────────────────────────────────────────────────────────

export type AuditRunStatus = 'running' | 'completed' | 'cancelled' | 'interrupted' | 'failed'

export interface AuditRun {
  id: string
  projectId: string
  status: AuditRunStatus
  scope: Record<string, unknown>
  checks: AuditCategory[]
  total: number
  processed: number
  fetched: number
  reused: number
  summary: Record<string, unknown>
  error: string | null
  cancelRequested: boolean
  startedAt: string
  updatedAt: string
  finishedAt: string | null
}

interface RunRow {
  id: string; project_id: string; status: AuditRunStatus; scope: string; checks: string; total: number; processed: number; fetched: number; reused: number
  summary: string; error: string | null; cancel_requested: number; started_at: string; updated_at: string; finished_at: string | null
}
const toRun = (row: RunRow): AuditRun => ({
  id: row.id,
  projectId: row.project_id,
  status: row.status,
  scope: parse(row.scope, {}),
  checks: parse(row.checks, []),
  total: row.total,
  processed: row.processed,
  fetched: row.fetched,
  reused: row.reused,
  summary: parse(row.summary, {}),
  error: row.error,
  cancelRequested: row.cancel_requested === 1,
  startedAt: row.started_at,
  updatedAt: row.updated_at,
  finishedAt: row.finished_at,
})

export class AuditRunsRepo {
  constructor(private readonly db: Db) {}
  insert(run: Pick<AuditRun, 'id' | 'projectId' | 'scope' | 'checks' | 'total'>) {
    const at = now()
    this.db
      .prepare(`INSERT INTO audit_runs (id, project_id, status, scope, checks, total, started_at, updated_at) VALUES (?, ?, 'running', ?, ?, ?, ?, ?)`)
      .run(run.id, run.projectId, json(run.scope), json(run.checks), run.total, at, at)
  }
  get(id: string): AuditRun | null {
    const row = this.db.prepare('SELECT * FROM audit_runs WHERE id = ?').get(id) as RunRow | undefined
    return row ? toRun(row) : null
  }
  latest(projectId: string, limit = 10): AuditRun[] {
    return (this.db.prepare('SELECT * FROM audit_runs WHERE project_id = ? ORDER BY started_at DESC LIMIT ?').all(projectId, limit) as RunRow[]).map(toRun)
  }
  update(id: string, patch: Partial<Pick<AuditRun, 'status' | 'total' | 'processed' | 'fetched' | 'reused' | 'summary' | 'error' | 'cancelRequested' | 'finishedAt'>>) {
    const current = this.get(id)
    if (!current) return
    const next = { ...current, ...patch }
    this.db
      .prepare(`UPDATE audit_runs SET status = ?, total = ?, processed = ?, fetched = ?, reused = ?, summary = ?, error = ?, cancel_requested = ?, finished_at = ?, updated_at = ? WHERE id = ?`)
      .run(next.status, next.total, next.processed, next.fetched, next.reused, json(next.summary), next.error, next.cancelRequested ? 1 : 0, next.finishedAt, now(), id)
  }
  markInterrupted(): number {
    return this.db.prepare(`UPDATE audit_runs SET status = 'interrupted', error = 'The server stopped during this audit. Resume it to continue where it stopped.', updated_at = ? WHERE status = 'running'`).run(now()).changes
  }
  countCompleted(projectId: string): number {
    return (this.db.prepare(`SELECT COUNT(*) AS n FROM audit_runs WHERE project_id = ? AND status = 'completed'`).get(projectId) as { n: number }).n
  }
}

// ── Findings ──────────────────────────────────────────────────────────────────

/**
 * - `open`: needs attention.
 * - `queued`: added to the maintenance queue.
 * - `dismissed`: not a problem (shown again only if the page changes).
 * - `intentional`: the difference is on purpose (shown again only if the page changes).
 * - `resolved`: no longer found by a later audit.
 */
export type FindingStatus = 'open' | 'queued' | 'dismissed' | 'intentional' | 'resolved'

export interface Finding {
  id: string
  projectId: string
  key: string
  category: AuditCategory
  severity: Severity
  certainty: Certainty
  resourceId: string | null
  resourceName: string | null
  related: { id: string; name: string }[]
  title: string
  explanation: string
  evidence: Record<string, unknown>
  remedy: string
  needsReview: boolean
  status: FindingStatus
  statusNote: string | null
  fingerprint: string | null
  statusFingerprint: string | null
  runId: string | null
  firstSeenAt: string
  lastSeenAt: string
  statusChangedAt: string | null
}

interface FindingRow {
  id: string; project_id: string; key: string; category: AuditCategory; severity: Severity; certainty: Certainty; resource_id: string | null; resource_name: string | null
  related: string; title: string; explanation: string; evidence: string; remedy: string; needs_review: number; status: FindingStatus; status_note: string | null
  fingerprint: string | null; status_fingerprint: string | null; run_id: string | null; first_seen_at: string; last_seen_at: string; status_changed_at: string | null
}
const toFinding = (row: FindingRow): Finding => ({
  id: row.id,
  projectId: row.project_id,
  key: row.key,
  category: row.category,
  severity: row.severity,
  certainty: row.certainty,
  resourceId: row.resource_id,
  resourceName: row.resource_name,
  related: parse(row.related, []),
  title: row.title,
  explanation: row.explanation,
  evidence: parse(row.evidence, {}),
  remedy: row.remedy,
  needsReview: row.needs_review === 1,
  status: row.status,
  statusNote: row.status_note,
  fingerprint: row.fingerprint,
  statusFingerprint: row.status_fingerprint,
  runId: row.run_id,
  firstSeenAt: row.first_seen_at,
  lastSeenAt: row.last_seen_at,
  statusChangedAt: row.status_changed_at,
})

export interface FindingFilter {
  categories?: AuditCategory[]
  statuses?: FindingStatus[]
  severity?: Severity[]
  resourceId?: string
  search?: string
  limit?: number
  offset?: number
  sort?: 'severity' | 'newest' | 'name'
}

export class FindingsRepo {
  constructor(private readonly db: Db) {}
  getByKey(projectId: string, key: string): Finding | null {
    const row = this.db.prepare('SELECT * FROM audit_findings WHERE project_id = ? AND key = ?').get(projectId, key) as FindingRow | undefined
    return row ? toFinding(row) : null
  }
  get(id: string): Finding | null {
    const row = this.db.prepare('SELECT * FROM audit_findings WHERE id = ?').get(id) as FindingRow | undefined
    return row ? toFinding(row) : null
  }
  /**
   * Records a finding seen by a run. A finding you dismissed or marked intentional stays so,
   * unless what it was based on changed since (then it is opened again, with a note).
   */
  upsert(projectId: string, runId: string, draft: FindingDraft, id: string): Finding {
    const at = now()
    const existing = this.getByKey(projectId, draft.key)
    if (!existing) {
      this.db
        .prepare(
          `INSERT INTO audit_findings (id, project_id, key, category, severity, certainty, resource_id, resource_name, related, title, explanation, evidence, remedy, needs_review,
            status, fingerprint, run_id, first_seen_at, last_seen_at)
           VALUES (@id, @projectId, @key, @category, @severity, @certainty, @resourceId, @resourceName, @related, @title, @explanation, @evidence, @remedy, @needsReview,
            'open', @fingerprint, @runId, @at, @at)`,
        )
        .run({ ...draft, id, projectId, runId, at, related: json(draft.related), evidence: json(draft.evidence) })
      return this.getByKey(projectId, draft.key)!
    }
    let status = existing.status
    let note = existing.statusNote
    if ((status === 'dismissed' || status === 'intentional') && existing.statusFingerprint !== null && draft.fingerprint !== existing.statusFingerprint) {
      status = 'open'
      note = `Opened again: the page changed after it was marked ${existing.status}.`
    }
    if (status === 'resolved') {
      status = 'open'
      note = 'Found again by a later audit.'
    }
    this.db
      .prepare(
        `UPDATE audit_findings SET severity = @severity, certainty = @certainty, resource_name = @resourceName, related = @related, title = @title, explanation = @explanation,
          evidence = @evidence, remedy = @remedy, needs_review = @needsReview, status = @status, status_note = @note, fingerprint = @fingerprint, run_id = @runId, last_seen_at = @at
         WHERE id = @existingId`,
      )
      .run({ ...draft, related: json(draft.related), evidence: json(draft.evidence), status, note, runId, at, existingId: existing.id })
    return this.get(existing.id)!
  }
  /** Findings of the given categories and resources that a complete run no longer found. */
  resolveMissing(projectId: string, runId: string, categories: AuditCategory[], resourceIds: Set<string> | null) {
    const rows = this.db
      .prepare(`SELECT * FROM audit_findings WHERE project_id = ? AND status IN ('open', 'queued') AND (run_id IS NULL OR run_id != ?) AND category IN (${categories.map(() => '?').join(', ')})`)
      .all(projectId, runId, ...categories) as FindingRow[]
    let resolved = 0
    for (const row of rows) {
      if (resourceIds && row.resource_id && !resourceIds.has(row.resource_id)) continue
      if (resourceIds && !row.resource_id) continue
      this.db.prepare(`UPDATE audit_findings SET status = 'resolved', status_note = 'Not found by a later audit.', status_changed_at = ? WHERE id = ?`).run(now(), row.id)
      resolved++
    }
    return resolved
  }
  setStatus(id: string, status: FindingStatus, note: string | null, fingerprint: string | null) {
    this.db.prepare('UPDATE audit_findings SET status = ?, status_note = ?, status_fingerprint = ?, status_changed_at = ? WHERE id = ?').run(status, note, fingerprint, now(), id)
  }
  list(projectId: string, filter: FindingFilter = {}): { items: Finding[]; total: number } {
    const where: string[] = ['project_id = ?']
    const args: unknown[] = [projectId]
    const inList = (column: string, values?: string[]) => {
      if (!values?.length) return
      where.push(`${column} IN (${values.map(() => '?').join(', ')})`)
      args.push(...values)
    }
    inList('category', filter.categories)
    inList('status', filter.statuses)
    inList('severity', filter.severity)
    if (filter.resourceId) {
      where.push('(resource_id = ? OR related LIKE ?)')
      args.push(filter.resourceId, `%"${filter.resourceId}"%`)
    }
    if (filter.search) {
      where.push('(title LIKE ? OR resource_name LIKE ?)')
      args.push(`%${filter.search}%`, `%${filter.search}%`)
    }
    const order =
      filter.sort === 'newest'
        ? 'first_seen_at DESC'
        : filter.sort === 'name'
          ? 'resource_name COLLATE NOCASE ASC'
          : `CASE severity WHEN 'problem' THEN 0 WHEN 'suggestion' THEN 1 ELSE 2 END, CASE certainty WHEN 'definite' THEN 0 WHEN 'likely' THEN 1 ELSE 2 END, resource_name COLLATE NOCASE`
    const sql = `FROM audit_findings WHERE ${where.join(' AND ')}`
    const rows = this.db.prepare(`SELECT * ${sql} ORDER BY ${order} LIMIT ? OFFSET ?`).all(...args, filter.limit ?? 100, filter.offset ?? 0) as FindingRow[]
    const total = (this.db.prepare(`SELECT COUNT(*) AS n ${sql}`).get(...args) as { n: number }).n
    return { items: rows.map(toFinding), total }
  }
  countNeedingReview(projectId: string): number {
    return (this.db.prepare(`SELECT COUNT(*) AS n FROM audit_findings WHERE project_id = ? AND needs_review = 1 AND status IN ('open', 'queued')`).get(projectId) as { n: number }).n
  }
  counts(projectId: string): { category: AuditCategory; status: FindingStatus; severity: Severity; n: number }[] {
    return this.db.prepare('SELECT category, status, severity, COUNT(*) AS n FROM audit_findings WHERE project_id = ? GROUP BY category, status, severity').all(projectId) as {
      category: AuditCategory
      status: FindingStatus
      severity: Severity
      n: number
    }[]
  }
}

// ── Page content cache ────────────────────────────────────────────────────────

export interface ContentSnapshot {
  resourceId: string
  documentId: string
  version: string
  structure: PageStructure | null
  fetchedAt: string
  error: string | null
}

export class ContentCacheRepo {
  constructor(private readonly db: Db) {}
  get(projectId: string, resourceId: string): ContentSnapshot | null {
    const row = this.db.prepare('SELECT * FROM lk_content_cache WHERE project_id = ? AND resource_id = ?').get(projectId, resourceId) as
      | { resource_id: string; document_id: string; version: string; structure: string; fetched_at: string; error: string | null }
      | undefined
    return row ? { resourceId: row.resource_id, documentId: row.document_id, version: row.version, structure: parse<PageStructure | null>(row.structure, null), fetchedAt: row.fetched_at, error: row.error } : null
  }
  put(projectId: string, snapshot: ContentSnapshot) {
    this.db
      .prepare(
        `INSERT INTO lk_content_cache (project_id, resource_id, document_id, version, structure, fetched_at, error) VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(project_id, resource_id) DO UPDATE SET document_id = excluded.document_id, version = excluded.version, structure = excluded.structure,
           fetched_at = excluded.fetched_at, error = excluded.error`,
      )
      .run(projectId, snapshot.resourceId, snapshot.documentId, snapshot.version, json(snapshot.structure), snapshot.fetchedAt, snapshot.error)
  }
  count(projectId: string): number {
    return (this.db.prepare('SELECT COUNT(*) AS n FROM lk_content_cache WHERE project_id = ?').get(projectId) as { n: number }).n
  }
  clear(projectId: string) {
    this.db.prepare('DELETE FROM lk_content_cache WHERE project_id = ?').run(projectId)
  }
}
