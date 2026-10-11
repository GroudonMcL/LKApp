import 'server-only'
import type { Db } from './connection'
import { CanonicalPage, SourceAttribution, type ValidationFinding } from '@/core/page-model'
import { RecipeDefinition, type Recipe } from '@/core/recipe'
import { LK_TEMPLATES_PARENT_ID } from '@/core/lk-layout'
import { TemplateDefinition, type PageTemplate, type TemplateOrigin } from '@/core/template'
import type { PageTypeGuess } from '@/core/extraction'
import type { IndexedResource } from '@/core/references'
import { AiCacheRepo, BatchesRepo, BatchItemsRepo, BatchSourcesRepo } from './batch-repositories'
import { AuditRunsRepo, ContentCacheRepo, FindingsRepo } from './health-repositories'

const now = () => new Date().toISOString()
const json = (value: unknown) => JSON.stringify(value)
const parse = <T>(value: string | null): T | null => (value === null ? null : (JSON.parse(value) as T))

// ── Settings (non-secret preferences only) ────────────────────────────────────

export class SettingsRepo {
  constructor(private readonly db: Db) {}
  get<T>(key: string): T | null {
    const row = this.db.prepare('SELECT value FROM settings WHERE key = ?').get(key) as { value: string } | undefined
    return row ? (JSON.parse(row.value) as T) : null
  }
  set(key: string, value: unknown) {
    this.db
      .prepare('INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at')
      .run(key, json(value), now())
  }
}

// ── Templates ─────────────────────────────────────────────────────────────────

interface TemplateRow { id: string; origin: TemplateOrigin; definition: string; created_at: string; updated_at: string }
const toTemplate = (row: TemplateRow): PageTemplate => ({
  id: row.id,
  origin: row.origin,
  definition: TemplateDefinition.parse(JSON.parse(row.definition)),
  createdAt: row.created_at,
  updatedAt: row.updated_at,
})

export class TemplatesRepo {
  constructor(private readonly db: Db) {}
  list(): PageTemplate[] {
    return (this.db.prepare('SELECT * FROM templates ORDER BY origin DESC, id').all() as TemplateRow[]).map(toTemplate)
  }
  get(id: string): PageTemplate | null {
    const row = this.db.prepare('SELECT * FROM templates WHERE id = ?').get(id) as TemplateRow | undefined
    return row ? toTemplate(row) : null
  }
  insert(id: string, origin: TemplateOrigin, definition: TemplateDefinition) {
    const at = now()
    this.db.prepare('INSERT INTO templates (id, origin, definition, created_at, updated_at) VALUES (?, ?, ?, ?, ?)').run(id, origin, json(definition), at, at)
  }
  update(id: string, definition: TemplateDefinition) {
    this.db.prepare('UPDATE templates SET definition = ?, updated_at = ? WHERE id = ?').run(json(definition), now(), id)
  }
  delete(id: string) {
    this.db.prepare('DELETE FROM templates WHERE id = ?').run(id)
  }
}

// ── Recipes (versioned) ───────────────────────────────────────────────────────

interface RecipeRow { id: string; version: number; definition: string; archived: number; created_at: string; updated_at: string }
const toRecipe = (row: RecipeRow): Recipe => ({
  id: row.id,
  version: row.version,
  definition: RecipeDefinition.parse(JSON.parse(row.definition)),
  createdAt: row.created_at,
  updatedAt: row.updated_at,
})

export class RecipesRepo {
  constructor(private readonly db: Db) {}
  list(): Recipe[] {
    return (this.db.prepare('SELECT * FROM recipes WHERE archived = 0 ORDER BY updated_at DESC').all() as RecipeRow[]).map(toRecipe)
  }
  get(id: string): Recipe | null {
    const row = this.db.prepare('SELECT * FROM recipes WHERE id = ? AND archived = 0').get(id) as RecipeRow | undefined
    return row ? toRecipe(row) : null
  }
  /** The exact definition used at a past version, for reproducibility. */
  getVersion(id: string, version: number): RecipeDefinition | null {
    const row = this.db.prepare('SELECT definition FROM recipe_versions WHERE recipe_id = ? AND version = ?').get(id, version) as { definition: string } | undefined
    return row ? RecipeDefinition.parse(JSON.parse(row.definition)) : null
  }
  insert(id: string, definition: RecipeDefinition): Recipe {
    const at = now()
    this.db.transaction(() => {
      this.db.prepare('INSERT INTO recipes (id, version, definition, created_at, updated_at) VALUES (?, 1, ?, ?, ?)').run(id, json(definition), at, at)
      this.db.prepare('INSERT INTO recipe_versions (recipe_id, version, definition, created_at) VALUES (?, 1, ?, ?)').run(id, json(definition), at)
    })()
    return this.get(id)!
  }
  /** Saves a new version. Earlier versions are kept so past drafts stay explainable. */
  update(id: string, definition: RecipeDefinition, expectedVersion: number): Recipe | 'conflict' | null {
    const current = this.get(id)
    if (!current) return null
    if (current.version !== expectedVersion) return 'conflict'
    const at = now()
    const version = current.version + 1
    this.db.transaction(() => {
      this.db.prepare('UPDATE recipes SET version = ?, definition = ?, updated_at = ? WHERE id = ?').run(version, json(definition), at, id)
      this.db.prepare('INSERT INTO recipe_versions (recipe_id, version, definition, created_at) VALUES (?, ?, ?, ?)').run(id, version, json(definition), at)
    })()
    return this.get(id)!
  }
  archive(id: string) {
    this.db.prepare('UPDATE recipes SET archived = 1, updated_at = ? WHERE id = ?').run(now(), id)
  }
  count(): number {
    return (this.db.prepare('SELECT COUNT(*) AS n FROM recipes WHERE archived = 0').get() as { n: number }).n
  }
}

// ── Import jobs ───────────────────────────────────────────────────────────────

export type JobStatus = 'extracted' | 'transforming' | 'drafted' | 'failed' | 'completed' | 'cancelled'

export interface ImportJob {
  id: string
  name: string
  status: JobStatus
  sourceName: string | null
  sourceKind: 'upload' | 'paste'
  sourceFormat: 'text' | 'markdown' | 'json'
  sourceSize: number
  sourceSha256: string
  sourceText: string | null
  sourceJson: unknown
  sourcePurgedAt: string | null
  attribution: SourceAttribution
  recipeId: string | null
  pageTypeGuesses: PageTypeGuess[]
  warnings: string[]
  error: string | null
  /** Set when this job is one record of a batch. */
  batchId: string | null
  recordMeta: RecordMeta | null
  createdAt: string
  updatedAt: string
}

/** Where a batch record came from in its source document. */
export interface RecordMeta {
  sourceId: string
  fileName: string | null
  documentTitle: string | null
  section: string | null
  page: number | null
  sourceRecordId: string | null
  index: number
  flags: string[]
}

interface JobRow {
  id: string; name: string; status: JobStatus; source_name: string | null; source_kind: 'upload' | 'paste'
  source_format: 'text' | 'markdown' | 'json'; source_size: number; source_sha256: string; source_text: string | null
  source_json: string | null; source_purged_at: string | null; attribution: string; recipe_id: string | null
  page_type_guesses: string | null; warnings: string; error: string | null; created_at: string; updated_at: string
  batch_id: string | null; record_meta: string | null
}
const toJob = (row: JobRow): ImportJob => ({
  id: row.id,
  name: row.name,
  status: row.status,
  sourceName: row.source_name,
  sourceKind: row.source_kind,
  sourceFormat: row.source_format,
  sourceSize: row.source_size,
  sourceSha256: row.source_sha256,
  sourceText: row.source_text,
  sourceJson: parse(row.source_json) ?? undefined,
  sourcePurgedAt: row.source_purged_at,
  attribution: SourceAttribution.parse(JSON.parse(row.attribution)),
  recipeId: row.recipe_id,
  pageTypeGuesses: parse<PageTypeGuess[]>(row.page_type_guesses) ?? [],
  warnings: JSON.parse(row.warnings) as string[],
  error: row.error,
  batchId: row.batch_id ?? null,
  recordMeta: parse<RecordMeta>(row.record_meta ?? null),
  createdAt: row.created_at,
  updatedAt: row.updated_at,
})

export class JobsRepo {
  constructor(private readonly db: Db) {}
  insert(job: Omit<ImportJob, 'createdAt' | 'updatedAt' | 'sourcePurgedAt' | 'error' | 'batchId' | 'recordMeta'> & { batchId?: string | null; recordMeta?: RecordMeta | null }) {
    const at = now()
    this.db
      .prepare(
        `INSERT INTO import_jobs (id, name, status, source_name, source_kind, source_format, source_size, source_sha256, source_text, source_json,
          attribution, recipe_id, page_type_guesses, warnings, batch_id, record_meta, created_at, updated_at)
         VALUES (@id, @name, @status, @sourceName, @sourceKind, @sourceFormat, @sourceSize, @sourceSha256, @sourceText, @sourceJson,
          @attribution, @recipeId, @guesses, @warnings, @batchId, @recordMeta, @at, @at)`,
      )
      .run({
        ...job,
        sourceJson: job.sourceJson === undefined ? null : json(job.sourceJson),
        attribution: json(job.attribution),
        guesses: json(job.pageTypeGuesses),
        warnings: json(job.warnings),
        batchId: job.batchId ?? null,
        recordMeta: job.recordMeta ? json(job.recordMeta) : null,
        at,
      })
  }
  get(id: string): ImportJob | null {
    const row = this.db.prepare('SELECT * FROM import_jobs WHERE id = ?').get(id) as JobRow | undefined
    return row ? toJob(row) : null
  }
  /** Single imports (batch records are listed with their batch). */
  list(limit = 50, offset = 0): { items: Omit<ImportJob, 'sourceText' | 'sourceJson'>[]; total: number } {
    const rows = this.db.prepare('SELECT * FROM import_jobs WHERE batch_id IS NULL ORDER BY created_at DESC LIMIT ? OFFSET ?').all(limit, offset) as JobRow[]
    const total = (this.db.prepare('SELECT COUNT(*) AS n FROM import_jobs WHERE batch_id IS NULL').get() as { n: number }).n
    return { items: rows.map((row) => ({ ...toJob({ ...row, source_text: null, source_json: null }) })), total }
  }
  update(id: string, patch: { status?: JobStatus; error?: string | null; recipeId?: string | null; name?: string; attribution?: SourceAttribution }) {
    const current = this.get(id)
    if (!current) return
    this.db
      .prepare('UPDATE import_jobs SET status = ?, error = ?, recipe_id = ?, name = ?, attribution = ?, updated_at = ? WHERE id = ?')
      .run(
        patch.status ?? current.status,
        patch.error === undefined ? current.error : patch.error,
        patch.recipeId === undefined ? current.recipeId : patch.recipeId,
        patch.name ?? current.name,
        json(patch.attribution ?? current.attribution),
        now(),
        id,
      )
  }
  listByBatch(batchId: string): ImportJob[] {
    return (this.db.prepare('SELECT * FROM import_jobs WHERE batch_id = ? ORDER BY created_at').all(batchId) as JobRow[]).map(toJob)
  }
  /** Replaces a batch record's text (after the reviewer re-splits it); only while no draft exists. */
  updateSource(id: string, patch: { sourceText: string; sourceJson?: unknown; sourceSha256: string; sourceSize: number; recordMeta?: RecordMeta }) {
    const current = this.get(id)
    if (!current) return
    this.db
      .prepare('UPDATE import_jobs SET source_text = ?, source_json = ?, source_sha256 = ?, source_size = ?, record_meta = ?, updated_at = ? WHERE id = ?')
      .run(patch.sourceText, patch.sourceJson === undefined ? null : json(patch.sourceJson), patch.sourceSha256, patch.sourceSize, json(patch.recordMeta ?? current.recordMeta), now(), id)
  }
  /** Deletes the stored source text (the hash stays, so the source can still be identified). */
  purgeSource(id: string) {
    this.db.prepare('UPDATE import_jobs SET source_text = NULL, source_json = NULL, source_purged_at = ?, updated_at = ? WHERE id = ?').run(now(), now(), id)
  }
  /** Jobs left mid-transformation by a server restart are marked as interrupted. */
  markInterrupted(): number {
    return this.db
      .prepare(`UPDATE import_jobs SET status = 'failed', error = 'Interrupted: the server stopped while this job was being processed. Run the transformation again.', updated_at = ? WHERE status = 'transforming'`)
      .run(now()).changes
  }
  countByStatus(): Record<string, number> {
    const rows = this.db.prepare('SELECT status, COUNT(*) AS n FROM import_jobs GROUP BY status').all() as { status: string; n: number }[]
    return Object.fromEntries(rows.map((r) => [r.status, r.n]))
  }
}

// ── Drafts ────────────────────────────────────────────────────────────────────

export type DraftStatus = 'draft' | 'awaiting_approval' | 'writing' | 'created' | 'write_failed' | 'write_uncertain' | 'cancelled'

export interface Draft {
  id: string
  jobId: string
  revision: number
  page: CanonicalPage
  status: DraftStatus
  findings: ValidationFinding[]
  validatedAt: string | null
  recipeId: string | null
  recipeVersion: number | null
  plannedResourceId: string | null
  idempotencyKey: string | null
  approvalToken: string | null
  approvalPayloadHash: string | null
  approvalExpiresAt: string | null
  createdResourceId: string | null
  createdDocumentId: string | null
  createdVersion: string | null
  writeError: string | null
  createdAt: string
  updatedAt: string
}

interface DraftRow {
  id: string; job_id: string; revision: number; page: string; status: DraftStatus; findings: string; validated_at: string | null
  recipe_id: string | null; recipe_version: number | null; planned_resource_id: string | null; idempotency_key: string | null
  approval_token: string | null; approval_payload_hash: string | null; approval_expires_at: string | null
  created_resource_id: string | null; created_document_id: string | null; created_version: string | null; write_error: string | null
  created_at: string; updated_at: string
}
const toDraft = (row: DraftRow): Draft => ({
  id: row.id,
  jobId: row.job_id,
  revision: row.revision,
  page: CanonicalPage.parse(JSON.parse(row.page)),
  status: row.status,
  findings: JSON.parse(row.findings) as ValidationFinding[],
  validatedAt: row.validated_at,
  recipeId: row.recipe_id,
  recipeVersion: row.recipe_version,
  plannedResourceId: row.planned_resource_id,
  idempotencyKey: row.idempotency_key,
  approvalToken: row.approval_token,
  approvalPayloadHash: row.approval_payload_hash,
  approvalExpiresAt: row.approval_expires_at,
  createdResourceId: row.created_resource_id,
  createdDocumentId: row.created_document_id,
  createdVersion: row.created_version,
  writeError: row.write_error,
  createdAt: row.created_at,
  updatedAt: row.updated_at,
})

export class DraftsRepo {
  constructor(private readonly db: Db) {}
  get(id: string): Draft | null {
    const row = this.db.prepare('SELECT * FROM drafts WHERE id = ?').get(id) as DraftRow | undefined
    return row ? toDraft(row) : null
  }
  getByJob(jobId: string): Draft | null {
    const row = this.db.prepare('SELECT * FROM drafts WHERE job_id = ?').get(jobId) as DraftRow | undefined
    return row ? toDraft(row) : null
  }
  /** Creates the job's draft, or replaces its content (keeping the old content as a revision). */
  upsertContent(input: { id: string; jobId: string; page: CanonicalPage; findings: ValidationFinding[]; recipeId: string | null; recipeVersion: number | null; reason: string }): Draft {
    const at = now()
    const existing = this.getByJob(input.jobId)
    this.db.transaction(() => {
      if (!existing) {
        this.db
          .prepare(
            `INSERT INTO drafts (id, job_id, revision, page, status, findings, validated_at, recipe_id, recipe_version, created_at, updated_at)
             VALUES (?, ?, 1, ?, 'draft', ?, ?, ?, ?, ?, ?)`,
          )
          .run(input.id, input.jobId, json(input.page), json(input.findings), at, input.recipeId, input.recipeVersion, at, at)
        this.db.prepare('INSERT INTO draft_revisions (draft_id, revision, page, reason, created_at) VALUES (?, 1, ?, ?, ?)').run(input.id, json(input.page), input.reason, at)
      } else {
        const revision = existing.revision + 1
        this.db
          .prepare(
            `UPDATE drafts SET revision = ?, page = ?, status = 'draft', findings = ?, validated_at = ?, recipe_id = ?, recipe_version = ?,
               approval_token = NULL, approval_payload_hash = NULL, approval_expires_at = NULL, updated_at = ? WHERE id = ?`,
          )
          .run(revision, json(input.page), json(input.findings), at, input.recipeId, input.recipeVersion, at, existing.id)
        this.db.prepare('INSERT INTO draft_revisions (draft_id, revision, page, reason, created_at) VALUES (?, ?, ?, ?, ?)').run(existing.id, revision, json(input.page), input.reason, at)
      }
    })()
    return this.getByJob(input.jobId)!
  }
  /** Saves an edit, but only if nobody else saved in between (optimistic concurrency). */
  saveEdit(id: string, page: CanonicalPage, findings: ValidationFinding[], expectedRevision: number): Draft | 'conflict' | null {
    const current = this.get(id)
    if (!current) return null
    if (current.revision !== expectedRevision) return 'conflict'
    const at = now()
    const revision = current.revision + 1
    this.db.transaction(() => {
      this.db
        .prepare(
          `UPDATE drafts SET revision = ?, page = ?, findings = ?, validated_at = ?, status = CASE WHEN status = 'awaiting_approval' THEN 'draft' ELSE status END,
             approval_token = NULL, approval_payload_hash = NULL, approval_expires_at = NULL, updated_at = ? WHERE id = ?`,
        )
        .run(revision, json(page), json(findings), at, at, id)
      this.db.prepare('INSERT INTO draft_revisions (draft_id, revision, page, reason, created_at) VALUES (?, ?, ?, ?, ?)').run(id, revision, json(page), 'edited', at)
    })()
    return this.get(id)
  }
  setFindings(id: string, findings: ValidationFinding[]) {
    this.db.prepare('UPDATE drafts SET findings = ?, validated_at = ?, updated_at = ? WHERE id = ?').run(json(findings), now(), now(), id)
  }
  setPlannedWrite(id: string, plannedResourceId: string, idempotencyKey: string) {
    this.db.prepare('UPDATE drafts SET planned_resource_id = ?, idempotency_key = ?, updated_at = ? WHERE id = ?').run(plannedResourceId, idempotencyKey, now(), id)
  }
  setApproval(id: string, token: string, payloadHash: string, expiresAt: string) {
    this.db
      .prepare(`UPDATE drafts SET status = 'awaiting_approval', approval_token = ?, approval_payload_hash = ?, approval_expires_at = ?, updated_at = ? WHERE id = ?`)
      .run(token, payloadHash, expiresAt, now(), id)
  }
  /** Withdraws a pending approval (the draft goes back to review). */
  revokeApproval(id: string) {
    this.db
      .prepare(`UPDATE drafts SET status = CASE WHEN status = 'awaiting_approval' THEN 'draft' ELSE status END, approval_token = NULL, approval_payload_hash = NULL, approval_expires_at = NULL, updated_at = ? WHERE id = ?`)
      .run(now(), id)
  }
  /**
   * Atomically moves an approved draft into `writing`. Returns false when another request
   * got there first (e.g. a double click), so only one write can ever start.
   */
  claimForWrite(id: string, token: string): boolean {
    const result = this.db
      .prepare(`UPDATE drafts SET status = 'writing', approval_token = NULL, updated_at = ? WHERE id = ? AND status = 'awaiting_approval' AND approval_token = ?`)
      .run(now(), id, token)
    return result.changes === 1
  }
  setStatus(id: string, status: DraftStatus, patch: { writeError?: string | null; createdResourceId?: string | null; createdDocumentId?: string | null; createdVersion?: string | null; page?: CanonicalPage } = {}) {
    const current = this.get(id)
    if (!current) return
    this.db
      .prepare(
        `UPDATE drafts SET status = ?, write_error = ?, created_resource_id = ?, created_document_id = ?, created_version = ?, page = ?, updated_at = ? WHERE id = ?`,
      )
      .run(
        status,
        patch.writeError === undefined ? current.writeError : patch.writeError,
        patch.createdResourceId === undefined ? current.createdResourceId : patch.createdResourceId,
        patch.createdDocumentId === undefined ? current.createdDocumentId : patch.createdDocumentId,
        patch.createdVersion === undefined ? current.createdVersion : patch.createdVersion,
        json(patch.page ?? current.page),
        now(),
        id,
      )
  }
  /** Drafts left in `writing` by a server restart: the outcome is unknown until checked. */
  markInterruptedWrites(): number {
    return this.db
      .prepare(`UPDATE drafts SET status = 'write_uncertain', write_error = 'The server stopped during the write. Use “Check outcome” to see whether the page was created.', updated_at = ? WHERE status = 'writing'`)
      .run(now()).changes
  }
  revisions(id: string): { revision: number; reason: string; createdAt: string }[] {
    return (this.db.prepare('SELECT revision, reason, created_at FROM draft_revisions WHERE draft_id = ? ORDER BY revision DESC').all(id) as { revision: number; reason: string; created_at: string }[]).map(
      (r) => ({ revision: r.revision, reason: r.reason, createdAt: r.created_at }),
    )
  }
  countCreated(): number {
    return (this.db.prepare(`SELECT COUNT(*) AS n FROM drafts WHERE status = 'created'`).get() as { n: number }).n
  }
}

// ── Audit log ─────────────────────────────────────────────────────────────────

export interface AuditEvent {
  id: number
  at: string
  operation: string
  outcome: 'success' | 'failure' | 'uncertain' | 'blocked' | 'info'
  approval: 'not_required' | 'approved' | 'not_approved'
  projectId: string | null
  resourceId: string | null
  jobId: string | null
  draftId: string | null
  recipeId: string | null
  recipeVersion: number | null
  model: string | null
  requestId: string | null
  errorCode: string | null
  message: string | null
  details: Record<string, unknown> | null
}
export type AuditEventInput = Omit<AuditEvent, 'id' | 'at' | 'approval' | 'projectId' | 'resourceId' | 'jobId' | 'draftId' | 'recipeId' | 'recipeVersion' | 'model' | 'requestId' | 'errorCode' | 'message' | 'details'> &
  Partial<Pick<AuditEvent, 'approval' | 'projectId' | 'resourceId' | 'jobId' | 'draftId' | 'recipeId' | 'recipeVersion' | 'model' | 'requestId' | 'errorCode' | 'message' | 'details'>>

interface AuditRow {
  id: number; at: string; operation: string; outcome: AuditEvent['outcome']; approval: AuditEvent['approval']; project_id: string | null
  resource_id: string | null; job_id: string | null; draft_id: string | null; recipe_id: string | null; recipe_version: number | null
  model: string | null; request_id: string | null; error_code: string | null; message: string | null; details: string | null
}

export class AuditRepo {
  constructor(private readonly db: Db) {}
  /** Callers must pass already-redacted values; see services/audit.ts. */
  insert(event: AuditEventInput): number {
    const result = this.db
      .prepare(
        `INSERT INTO audit_events (at, operation, outcome, approval, project_id, resource_id, job_id, draft_id, recipe_id, recipe_version, model, request_id, error_code, message, details)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        now(), event.operation, event.outcome, event.approval ?? 'not_required', event.projectId ?? null, event.resourceId ?? null,
        event.jobId ?? null, event.draftId ?? null, event.recipeId ?? null, event.recipeVersion ?? null, event.model ?? null,
        event.requestId ?? null, event.errorCode ?? null, event.message ?? null, event.details ? json(event.details) : null,
      )
    return Number(result.lastInsertRowid)
  }
  list(filter: { limit: number; beforeId?: number; operation?: string; draftId?: string }): AuditEvent[] {
    const clauses: string[] = []
    const params: unknown[] = []
    if (filter.beforeId) { clauses.push('id < ?'); params.push(filter.beforeId) }
    if (filter.operation) { clauses.push('operation = ?'); params.push(filter.operation) }
    if (filter.draftId) { clauses.push('draft_id = ?'); params.push(filter.draftId) }
    const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : ''
    const rows = this.db.prepare(`SELECT * FROM audit_events ${where} ORDER BY id DESC LIMIT ?`).all(...params, filter.limit) as AuditRow[]
    return rows.map((row) => ({
      id: row.id, at: row.at, operation: row.operation, outcome: row.outcome, approval: row.approval, projectId: row.project_id,
      resourceId: row.resource_id, jobId: row.job_id, draftId: row.draft_id, recipeId: row.recipe_id, recipeVersion: row.recipe_version,
      model: row.model, requestId: row.request_id, errorCode: row.error_code, message: row.message,
      details: row.details ? (JSON.parse(row.details) as Record<string, unknown>) : null,
    }))
  }
}

// ── Resource index (metadata only) ────────────────────────────────────────────

export interface IndexedResourceRow {
  id: string
  name: string
  parentId: string | null
  tags: string[]
  aliases: string[]
  documents: { id: string; name: string; type: string }[]
  iconGlyph: string | null
  isHidden: boolean
  rank: string | null
  updatedAt: string | null
  scannedAt: string
}

export interface ScanRecord {
  id: string
  projectId: string
  status: 'running' | 'paused' | 'interrupted' | 'completed' | 'failed'
  cursor: string | null
  pages: number
  resources: number
  error: string | null
  startedAt: string
  updatedAt: string
  finishedAt: string | null
}

interface IndexRow {
  id: string; name: string; parent_id: string | null; tags: string; aliases: string; documents: string; icon_glyph: string | null
  is_hidden: number; rank: string | null; updated_at: string | null; scanned_at: string
}
const toIndexed = (row: IndexRow): IndexedResourceRow => ({
  id: row.id, name: row.name, parentId: row.parent_id, tags: JSON.parse(row.tags), aliases: JSON.parse(row.aliases),
  documents: JSON.parse(row.documents), iconGlyph: row.icon_glyph, isHidden: row.is_hidden === 1, rank: row.rank,
  updatedAt: row.updated_at, scannedAt: row.scanned_at,
})

interface ScanRow { id: string; project_id: string; status: ScanRecord['status']; cursor: string | null; pages: number; resources: number; error: string | null; started_at: string; updated_at: string; finished_at: string | null }
const toScan = (row: ScanRow): ScanRecord => ({
  id: row.id, projectId: row.project_id, status: row.status, cursor: row.cursor, pages: row.pages, resources: row.resources,
  error: row.error, startedAt: row.started_at, updatedAt: row.updated_at, finishedAt: row.finished_at,
})

export class IndexRepo {
  constructor(private readonly db: Db) {}

  upsertPage(projectId: string, scanId: string, items: Omit<IndexedResourceRow, 'scannedAt'>[], cursor: string | null) {
    const at = now()
    const upsert = this.db.prepare(
      `INSERT INTO lk_index_resources (project_id, id, name, name_lower, parent_id, tags, tag_count, aliases, documents, icon_glyph, is_hidden, rank, updated_at, scan_id, scanned_at)
       VALUES (@projectId, @id, @name, @nameLower, @parentId, @tags, @tagCount, @aliases, @documents, @iconGlyph, @isHidden, @rank, @updatedAt, @scanId, @at)
       ON CONFLICT(project_id, id) DO UPDATE SET name = excluded.name, name_lower = excluded.name_lower, parent_id = excluded.parent_id,
         tags = excluded.tags, tag_count = excluded.tag_count, aliases = excluded.aliases, documents = excluded.documents,
         icon_glyph = excluded.icon_glyph, is_hidden = excluded.is_hidden, rank = excluded.rank, updated_at = excluded.updated_at,
         scan_id = excluded.scan_id, scanned_at = excluded.scanned_at`,
    )
    this.db.transaction(() => {
      for (const item of items) {
        upsert.run({
          projectId, scanId, at, id: item.id, name: item.name, nameLower: item.name.toLowerCase(), parentId: item.parentId,
          tags: json(item.tags), tagCount: item.tags.length, aliases: json(item.aliases), documents: json(item.documents),
          iconGlyph: item.iconGlyph, isHidden: item.isHidden ? 1 : 0, rank: item.rank, updatedAt: item.updatedAt,
        })
      }
      this.db
        .prepare('UPDATE lk_index_scans SET cursor = ?, pages = pages + 1, resources = resources + ?, updated_at = ? WHERE id = ?')
        .run(cursor, items.length, at, scanId)
    })()
  }

  /** After a complete scan, drops entries that no longer exist in LegendKeeper. */
  removeStale(projectId: string, scanId: string): number {
    return this.db.prepare('DELETE FROM lk_index_resources WHERE project_id = ? AND scan_id != ?').run(projectId, scanId).changes
  }

  query(projectId: string, filter: { q?: string; tag?: string; untagged?: boolean; parentId?: string | null; offset: number; limit: number }) {
    const clauses = ['project_id = @projectId']
    const params: Record<string, unknown> = { projectId, limit: filter.limit, offset: filter.offset }
    if (filter.q) {
      clauses.push(`(name_lower LIKE @q ESCAPE '\\' OR EXISTS (SELECT 1 FROM json_each(aliases) WHERE lower(value) LIKE @q ESCAPE '\\') OR id = @exact)`)
      params.q = `%${filter.q.toLowerCase().replace(/[\\%_]/g, (c) => `\\${c}`)}%`
      params.exact = filter.q
    }
    if (filter.tag) {
      clauses.push('EXISTS (SELECT 1 FROM json_each(tags) WHERE value = @tag)')
      params.tag = filter.tag
    }
    // LegendKeeper templates are listed under the parent "templates"; they are not pages to tag.
    if (filter.untagged) clauses.push(`tag_count = 0 AND (parent_id IS NULL OR parent_id != '${LK_TEMPLATES_PARENT_ID}')`)
    if (filter.parentId !== undefined) {
      if (filter.parentId === null) clauses.push('parent_id IS NULL')
      else {
        clauses.push('parent_id = @parentId')
        params.parentId = filter.parentId
      }
    }
    const where = clauses.join(' AND ')
    const items = (this.db.prepare(`SELECT * FROM lk_index_resources WHERE ${where} ORDER BY name_lower LIMIT @limit OFFSET @offset`).all(params) as IndexRow[]).map(toIndexed)
    const total = (this.db.prepare(`SELECT COUNT(*) AS n FROM lk_index_resources WHERE ${where}`).get(params) as { n: number }).n
    return { items, total }
  }

  get(projectId: string, id: string): IndexedResourceRow | null {
    const row = this.db.prepare('SELECT * FROM lk_index_resources WHERE project_id = ? AND id = ?').get(projectId, id) as IndexRow | undefined
    return row ? toIndexed(row) : null
  }

  byExactName(projectId: string, name: string): { id: string; name: string }[] {
    return this.db.prepare('SELECT id, name FROM lk_index_resources WHERE project_id = ? AND name = ?').all(projectId, name) as { id: string; name: string }[]
  }

  stats(projectId: string) {
    const counts = this.db
      .prepare(`SELECT COUNT(*) AS total, SUM(CASE WHEN parent_id IS NULL OR parent_id != '${LK_TEMPLATES_PARENT_ID}' THEN 1 ELSE 0 END) AS pages, SUM(CASE WHEN tag_count = 0 AND (parent_id IS NULL OR parent_id != '${LK_TEMPLATES_PARENT_ID}') THEN 1 ELSE 0 END) AS untagged FROM lk_index_resources WHERE project_id = ?`)
      .get(projectId) as { total: number; pages: number | null; untagged: number | null }
    const tags = (this.db.prepare('SELECT COUNT(DISTINCT value) AS n FROM lk_index_resources, json_each(tags) WHERE project_id = ?').get(projectId) as { n: number }).n
    return { total: counts.total, pages: counts.pages ?? 0, untagged: counts.untagged ?? 0, distinctTags: tags }
  }

  tagCounts(projectId: string): { tag: string; count: number }[] {
    return this.db
      .prepare(`SELECT value AS tag, COUNT(*) AS count FROM lk_index_resources, json_each(tags) WHERE project_id = ? AND (parent_id IS NULL OR parent_id != '${LK_TEMPLATES_PARENT_ID}') GROUP BY value ORDER BY count DESC, value`)
      .all(projectId) as { tag: string; count: number }[]
  }

  /** Every indexed page (templates excluded) with its path, tags, documents and last update, for Wiki Health. */
  forAudit(projectId: string): (IndexedResourceRow & { path: string | null })[] {
    const rows = (this.db.prepare('SELECT * FROM lk_index_resources WHERE project_id = ?').all(projectId) as IndexRow[]).map(toIndexed)
    const byId = new Map(rows.map((row) => [row.id, row]))
    const pathOf = (row: IndexedResourceRow): string | null => {
      const names: string[] = []
      let parent = row.parentId ? byId.get(row.parentId) : undefined
      let guard = 0
      while (parent && guard++ < 50) {
        names.unshift(parent.name)
        parent = parent.parentId ? byId.get(parent.parentId) : undefined
      }
      return names.length ? names.join(' / ') : null
    }
    return rows.filter((row) => row.parentId !== LK_TEMPLATES_PARENT_ID).map((row) => ({ ...row, path: pathOf(row) }))
  }

  /** Every indexed resource with a readable path, for reference resolution. */
  forReferences(projectId: string): IndexedResource[] {
    const rows = this.db.prepare('SELECT id, name, parent_id, aliases, tags FROM lk_index_resources WHERE project_id = ?').all(projectId) as {
      id: string; name: string; parent_id: string | null; aliases: string; tags: string
    }[]
    const byId = new Map(rows.map((row) => [row.id, row]))
    const pathOf = (row: { parent_id: string | null }): string | null => {
      const names: string[] = []
      let parent = row.parent_id ? byId.get(row.parent_id) : undefined
      let guard = 0
      while (parent && guard++ < 50) {
        names.unshift(parent.name)
        parent = parent.parent_id ? byId.get(parent.parent_id) : undefined
      }
      return names.length ? names.join(' / ') : null
    }
    // Templates are listed like pages (with the parent "templates") but are not pages to link to.
    return rows
      .filter((row) => row.parent_id !== LK_TEMPLATES_PARENT_ID)
      .map((row) => ({ id: row.id, name: row.name, aliases: JSON.parse(row.aliases), parentId: row.parent_id, path: pathOf(row), tags: JSON.parse(row.tags) as string[] }))
  }

  clear(projectId: string) {
    this.db.transaction(() => {
      this.db.prepare('DELETE FROM lk_index_resources WHERE project_id = ?').run(projectId)
      this.db.prepare('DELETE FROM lk_index_scans WHERE project_id = ?').run(projectId)
    })()
  }

  // Scans
  createScan(id: string, projectId: string): ScanRecord {
    const at = now()
    this.db.prepare(`INSERT INTO lk_index_scans (id, project_id, status, started_at, updated_at) VALUES (?, ?, 'running', ?, ?)`).run(id, projectId, at, at)
    return this.getScan(id)!
  }
  getScan(id: string): ScanRecord | null {
    const row = this.db.prepare('SELECT * FROM lk_index_scans WHERE id = ?').get(id) as ScanRow | undefined
    return row ? toScan(row) : null
  }
  latestScan(projectId: string): ScanRecord | null {
    const row = this.db.prepare('SELECT * FROM lk_index_scans WHERE project_id = ? ORDER BY started_at DESC LIMIT 1').get(projectId) as ScanRow | undefined
    return row ? toScan(row) : null
  }
  lastCompletedScan(projectId: string): ScanRecord | null {
    const row = this.db.prepare(`SELECT * FROM lk_index_scans WHERE project_id = ? AND status = 'completed' ORDER BY finished_at DESC LIMIT 1`).get(projectId) as ScanRow | undefined
    return row ? toScan(row) : null
  }
  setScanStatus(id: string, status: ScanRecord['status'], error: string | null = null) {
    const at = now()
    this.db
      .prepare('UPDATE lk_index_scans SET status = ?, error = ?, updated_at = ?, finished_at = CASE WHEN ? IN (\'completed\', \'failed\') THEN ? ELSE finished_at END WHERE id = ?')
      .run(status, error, at, status, at, id)
  }
  markRunningInterrupted(): number {
    return this.db.prepare(`UPDATE lk_index_scans SET status = 'interrupted', updated_at = ? WHERE status = 'running'`).run(now()).changes
  }
}

// ── Write verification ────────────────────────────────────────────────────────

export interface WriteVerification {
  id: string
  projectId: string
  sdkVersion: string
  resourceId: string
  documentId: string | null
  details: Record<string, unknown>
  verifiedAt: string
}

export class VerificationRepo {
  constructor(private readonly db: Db) {}
  insert(v: Omit<WriteVerification, 'verifiedAt'>) {
    this.db
      .prepare('INSERT INTO write_verifications (id, project_id, sdk_version, resource_id, document_id, details, verified_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(v.id, v.projectId, v.sdkVersion, v.resourceId, v.documentId, json(v.details), now())
  }
  latest(projectId: string, sdkVersion: string): WriteVerification | null {
    const row = this.db
      .prepare('SELECT * FROM write_verifications WHERE project_id = ? AND sdk_version = ? ORDER BY verified_at DESC LIMIT 1')
      .get(projectId, sdkVersion) as
      | { id: string; project_id: string; sdk_version: string; resource_id: string; document_id: string | null; details: string; verified_at: string }
      | undefined
    return row
      ? { id: row.id, projectId: row.project_id, sdkVersion: row.sdk_version, resourceId: row.resource_id, documentId: row.document_id, details: JSON.parse(row.details), verifiedAt: row.verified_at }
      : null
  }
}

export interface Repos {
  settings: SettingsRepo
  templates: TemplatesRepo
  recipes: RecipesRepo
  jobs: JobsRepo
  drafts: DraftsRepo
  audit: AuditRepo
  index: IndexRepo
  verifications: VerificationRepo
  batches: BatchesRepo
  batchSources: BatchSourcesRepo
  batchItems: BatchItemsRepo
  aiCache: AiCacheRepo
  auditRuns: AuditRunsRepo
  findings: FindingsRepo
  contentCache: ContentCacheRepo
}

export function createRepos(db: Db): Repos {
  return {
    settings: new SettingsRepo(db),
    templates: new TemplatesRepo(db),
    recipes: new RecipesRepo(db),
    jobs: new JobsRepo(db),
    drafts: new DraftsRepo(db),
    audit: new AuditRepo(db),
    index: new IndexRepo(db),
    verifications: new VerificationRepo(db),
    batches: new BatchesRepo(db),
    batchSources: new BatchSourcesRepo(db),
    batchItems: new BatchItemsRepo(db),
    aiCache: new AiCacheRepo(db),
    auditRuns: new AuditRunsRepo(db),
    findings: new FindingsRepo(db),
    contentCache: new ContentCacheRepo(db),
  }
}
