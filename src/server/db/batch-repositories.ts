import 'server-only'
import type { Db } from './connection'
import type { PageStart } from '@/core/records'

const now = () => new Date().toISOString()
const json = (value: unknown) => JSON.stringify(value)
const parse = <T>(value: string | null | undefined): T | null => (value === null || value === undefined ? null : (JSON.parse(value) as T))

// ── Batches ───────────────────────────────────────────────────────────────────

export type BatchKind = 'import' | 'tagging' | 'migration'
/**
 * - `draft`: being set up (files added, records extracted, drafts reviewed). Nothing written.
 * - `processing`: the app is extracting or drafting in the background.
 * - `ready`: work is waiting for your review or approval.
 * - `running`: approved operations are being executed.
 * - `completed`, `cancelled`: closed; source text has been deleted.
 * - `interrupted`: the server stopped during processing or running; open it to resume.
 */
export type BatchStatus = 'draft' | 'processing' | 'ready' | 'running' | 'completed' | 'cancelled' | 'interrupted'

export interface Batch {
  id: string
  kind: BatchKind
  name: string
  status: BatchStatus
  recipeId: string | null
  recipeVersion: number | null
  templateId: string | null
  options: Record<string, unknown>
  error: string | null
  cancelRequested: boolean
  createdAt: string
  updatedAt: string
  startedAt: string | null
  finishedAt: string | null
}

interface BatchRow {
  id: string; kind: BatchKind; name: string; status: BatchStatus; recipe_id: string | null; recipe_version: number | null; template_id: string | null
  options: string; error: string | null; cancel_requested: number; created_at: string; updated_at: string; started_at: string | null; finished_at: string | null
}
const toBatch = (row: BatchRow): Batch => ({
  id: row.id,
  kind: row.kind,
  name: row.name,
  status: row.status,
  recipeId: row.recipe_id,
  recipeVersion: row.recipe_version,
  templateId: row.template_id,
  options: parse<Record<string, unknown>>(row.options) ?? {},
  error: row.error,
  cancelRequested: row.cancel_requested === 1,
  createdAt: row.created_at,
  updatedAt: row.updated_at,
  startedAt: row.started_at,
  finishedAt: row.finished_at,
})

export class BatchesRepo {
  constructor(private readonly db: Db) {}
  insert(batch: Pick<Batch, 'id' | 'kind' | 'name' | 'recipeId' | 'recipeVersion' | 'templateId' | 'options'>) {
    const at = now()
    this.db
      .prepare(
        `INSERT INTO batches (id, kind, name, status, recipe_id, recipe_version, template_id, options, created_at, updated_at)
         VALUES (?, ?, ?, 'draft', ?, ?, ?, ?, ?, ?)`,
      )
      .run(batch.id, batch.kind, batch.name, batch.recipeId, batch.recipeVersion, batch.templateId, json(batch.options), at, at)
  }
  get(id: string): Batch | null {
    const row = this.db.prepare('SELECT * FROM batches WHERE id = ?').get(id) as BatchRow | undefined
    return row ? toBatch(row) : null
  }
  list(kind: BatchKind | null, limit = 50, offset = 0): { items: Batch[]; total: number } {
    const where = kind ? 'WHERE kind = ?' : ''
    const args = kind ? [kind] : []
    const rows = this.db.prepare(`SELECT * FROM batches ${where} ORDER BY created_at DESC LIMIT ? OFFSET ?`).all(...args, limit, offset) as BatchRow[]
    const total = (this.db.prepare(`SELECT COUNT(*) AS n FROM batches ${where}`).get(...args) as { n: number }).n
    return { items: rows.map(toBatch), total }
  }
  update(id: string, patch: Partial<Pick<Batch, 'name' | 'status' | 'recipeId' | 'recipeVersion' | 'templateId' | 'options' | 'error' | 'cancelRequested' | 'startedAt' | 'finishedAt'>>) {
    const current = this.get(id)
    if (!current) return
    const next = { ...current, ...patch }
    this.db
      .prepare(
        `UPDATE batches SET name = ?, status = ?, recipe_id = ?, recipe_version = ?, template_id = ?, options = ?, error = ?, cancel_requested = ?,
          started_at = ?, finished_at = ?, updated_at = ? WHERE id = ?`,
      )
      .run(next.name, next.status, next.recipeId, next.recipeVersion, next.templateId, json(next.options), next.error, next.cancelRequested ? 1 : 0, next.startedAt, next.finishedAt, now(), id)
  }
  /** Batches left processing or running by a server restart. */
  markInterrupted(): number {
    return this.db
      .prepare(`UPDATE batches SET status = 'interrupted', error = 'The server stopped while this batch was being processed. Open it to resume.', updated_at = ? WHERE status IN ('processing', 'running')`)
      .run(now()).changes
  }
}

// ── Batch sources (input files) ───────────────────────────────────────────────

/**
 * - `extracted`: text is ready.
 * - `needs_transcription`: an image or scanned PDF; AI transcription is needed (on request).
 * - `failed`: the file could not be read (see `error`).
 */
export type BatchSourceStatus = 'extracted' | 'needs_transcription' | 'failed'

export interface BatchSource {
  id: string
  batchId: string
  seq: number
  fileName: string | null
  mimeType: string | null
  originalFormat: string
  format: 'text' | 'markdown' | 'json'
  size: number
  sha256: string
  status: BatchSourceStatus
  method: 'parser' | 'ai_transcription'
  title: string | null
  text: string | null
  json: unknown
  pages: PageStart[]
  totalPages: number | null
  mediaType: string | null
  hasBlob: boolean
  warnings: string[]
  error: string | null
  recordCount: number
  inputTokens: number | null
  outputTokens: number | null
  purgedAt: string | null
  createdAt: string
  updatedAt: string
}

interface SourceRow {
  id: string; batch_id: string; seq: number; file_name: string | null; mime_type: string | null; original_format: string; format: 'text' | 'markdown' | 'json'
  size: number; sha256: string; status: BatchSourceStatus; method: 'parser' | 'ai_transcription'; title: string | null; text: string | null; json: string | null
  pages: string; total_pages: number | null; media_type: string | null; has_blob: number; warnings: string; error: string | null; record_count: number
  input_tokens: number | null; output_tokens: number | null; purged_at: string | null; created_at: string; updated_at: string
}
const SOURCE_COLUMNS = `id, batch_id, seq, file_name, mime_type, original_format, format, size, sha256, status, method, title, text, json, pages, total_pages,
  media_type, (blob IS NOT NULL) AS has_blob, warnings, error, record_count, input_tokens, output_tokens, purged_at, created_at, updated_at`
const toSource = (row: SourceRow): BatchSource => ({
  id: row.id,
  batchId: row.batch_id,
  seq: row.seq,
  fileName: row.file_name,
  mimeType: row.mime_type,
  originalFormat: row.original_format,
  format: row.format,
  size: row.size,
  sha256: row.sha256,
  status: row.status,
  method: row.method,
  title: row.title,
  text: row.text,
  json: parse(row.json),
  pages: parse<PageStart[]>(row.pages) ?? [],
  totalPages: row.total_pages,
  mediaType: row.media_type,
  hasBlob: row.has_blob === 1,
  warnings: parse<string[]>(row.warnings) ?? [],
  error: row.error,
  recordCount: row.record_count,
  inputTokens: row.input_tokens,
  outputTokens: row.output_tokens,
  purgedAt: row.purged_at,
  createdAt: row.created_at,
  updatedAt: row.updated_at,
})

export class BatchSourcesRepo {
  constructor(private readonly db: Db) {}
  insert(source: Omit<BatchSource, 'createdAt' | 'updatedAt' | 'hasBlob' | 'purgedAt' | 'recordCount' | 'inputTokens' | 'outputTokens'> & { blob: Uint8Array | null }) {
    const at = now()
    this.db
      .prepare(
        `INSERT INTO batch_sources (id, batch_id, seq, file_name, mime_type, original_format, format, size, sha256, status, method, title, text, json, pages,
          total_pages, media_type, blob, warnings, error, created_at, updated_at)
         VALUES (@id, @batchId, @seq, @fileName, @mimeType, @originalFormat, @format, @size, @sha256, @status, @method, @title, @text, @json, @pages,
          @totalPages, @mediaType, @blob, @warnings, @error, @at, @at)`,
      )
      .run({ ...source, json: source.json === undefined ? null : json(source.json), pages: json(source.pages), warnings: json(source.warnings), at })
  }
  get(id: string): BatchSource | null {
    const row = this.db.prepare(`SELECT ${SOURCE_COLUMNS} FROM batch_sources WHERE id = ?`).get(id) as SourceRow | undefined
    return row ? toSource(row) : null
  }
  list(batchId: string): BatchSource[] {
    return (this.db.prepare(`SELECT ${SOURCE_COLUMNS} FROM batch_sources WHERE batch_id = ? ORDER BY seq`).all(batchId) as SourceRow[]).map(toSource)
  }
  blob(id: string): Uint8Array | null {
    const row = this.db.prepare('SELECT blob FROM batch_sources WHERE id = ?').get(id) as { blob: Uint8Array | null } | undefined
    return row?.blob ?? null
  }
  update(id: string, patch: Partial<Pick<BatchSource, 'status' | 'method' | 'title' | 'text' | 'format' | 'pages' | 'warnings' | 'error' | 'recordCount' | 'inputTokens' | 'outputTokens'>>) {
    const current = this.get(id)
    if (!current) return
    const next = { ...current, ...patch }
    this.db
      .prepare(
        `UPDATE batch_sources SET status = ?, method = ?, title = ?, text = ?, format = ?, pages = ?, warnings = ?, error = ?, record_count = ?,
          input_tokens = ?, output_tokens = ?, updated_at = ? WHERE id = ?`,
      )
      .run(next.status, next.method, next.title, next.text, next.format, json(next.pages), json(next.warnings), next.error, next.recordCount, next.inputTokens, next.outputTokens, now(), id)
  }
  /** Deletes stored text and file contents of a batch (hashes, names and sizes stay). */
  purge(batchId: string) {
    this.db.prepare('UPDATE batch_sources SET text = NULL, json = NULL, blob = NULL, purged_at = ?, updated_at = ? WHERE batch_id = ? AND purged_at IS NULL').run(now(), now(), batchId)
  }
  dropBlob(id: string) {
    this.db.prepare('UPDATE batch_sources SET blob = NULL, updated_at = ? WHERE id = ?').run(now(), id)
  }
}

// ── Batch items ───────────────────────────────────────────────────────────────

export type BatchItemKind = 'create_page' | 'update_tags' | 'migrate_page'
export type BatchItemStatus =
  | 'pending'
  | 'processing'
  | 'awaiting_review'
  | 'approved'
  | 'running'
  | 'succeeded'
  | 'failed'
  | 'skipped'
  | 'cancelled'
  | 'needs_reconciliation'

export const ITEM_STATUS_EXPLANATIONS: Record<BatchItemStatus, string> = {
  pending: 'Waiting to be processed.',
  processing: 'Being processed now.',
  awaiting_review: 'Ready for your review. Nothing is written until you approve it.',
  approved: 'Approved; will be executed when you run the batch.',
  running: 'Being written to LegendKeeper now.',
  succeeded: 'Done.',
  failed: 'Failed. The error says why; it can be retried after fixing the cause.',
  skipped: 'Skipped (for example a duplicate). Nothing was written.',
  cancelled: 'Cancelled. Nothing was written.',
  needs_reconciliation: 'The outcome of a write is unknown. The app will check LegendKeeper (read-only) before anything else.',
}

export interface BatchItem {
  id: string
  batchId: string
  seq: number
  kind: BatchItemKind
  status: BatchItemStatus
  title: string
  sourceId: string | null
  jobId: string | null
  resourceId: string | null
  flags: string[]
  match: unknown
  /** The reviewer's decision on a match: create anyway, skip. */
  decision: string | null
  plan: unknown
  planHash: string | null
  baseFingerprint: string | null
  approvedAt: string | null
  result: unknown
  error: string | null
  attempts: number
  inputTokens: number | null
  outputTokens: number | null
  createdAt: string
  updatedAt: string
}

interface ItemRow {
  id: string; batch_id: string; seq: number; kind: BatchItemKind; status: BatchItemStatus; title: string; source_id: string | null; job_id: string | null
  resource_id: string | null; flags: string; match: string | null; decision: string | null; plan: string | null; plan_hash: string | null
  base_fingerprint: string | null; approved_at: string | null; result: string | null; error: string | null; attempts: number
  input_tokens: number | null; output_tokens: number | null; created_at: string; updated_at: string
}
const toItem = (row: ItemRow): BatchItem => ({
  id: row.id,
  batchId: row.batch_id,
  seq: row.seq,
  kind: row.kind,
  status: row.status,
  title: row.title,
  sourceId: row.source_id,
  jobId: row.job_id,
  resourceId: row.resource_id,
  flags: parse<string[]>(row.flags) ?? [],
  match: parse(row.match),
  decision: row.decision,
  plan: parse(row.plan),
  planHash: row.plan_hash,
  baseFingerprint: row.base_fingerprint,
  approvedAt: row.approved_at,
  result: parse(row.result),
  error: row.error,
  attempts: row.attempts,
  inputTokens: row.input_tokens,
  outputTokens: row.output_tokens,
  createdAt: row.created_at,
  updatedAt: row.updated_at,
})

export type ItemPatch = Partial<
  Pick<BatchItem, 'status' | 'title' | 'jobId' | 'resourceId' | 'flags' | 'match' | 'decision' | 'plan' | 'planHash' | 'baseFingerprint' | 'approvedAt' | 'result' | 'error' | 'attempts' | 'inputTokens' | 'outputTokens'>
>

export class BatchItemsRepo {
  constructor(private readonly db: Db) {}
  insert(item: Pick<BatchItem, 'id' | 'batchId' | 'seq' | 'kind' | 'status' | 'title' | 'sourceId' | 'jobId' | 'resourceId' | 'flags'> & Partial<Pick<BatchItem, 'plan' | 'planHash' | 'baseFingerprint' | 'match'>>) {
    const at = now()
    this.db
      .prepare(
        `INSERT INTO batch_items (id, batch_id, seq, kind, status, title, source_id, job_id, resource_id, flags, match, plan, plan_hash, base_fingerprint, created_at, updated_at)
         VALUES (@id, @batchId, @seq, @kind, @status, @title, @sourceId, @jobId, @resourceId, @flags, @match, @plan, @planHash, @baseFingerprint, @at, @at)`,
      )
      .run({ ...item, flags: json(item.flags), match: item.match === undefined ? null : json(item.match), plan: item.plan === undefined ? null : json(item.plan), at })
  }
  get(id: string): BatchItem | null {
    const row = this.db.prepare('SELECT * FROM batch_items WHERE id = ?').get(id) as ItemRow | undefined
    return row ? toItem(row) : null
  }
  getByJob(jobId: string): BatchItem | null {
    const row = this.db.prepare('SELECT * FROM batch_items WHERE job_id = ?').get(jobId) as ItemRow | undefined
    return row ? toItem(row) : null
  }
  list(batchId: string, filter: { status?: BatchItemStatus[]; limit?: number; offset?: number } = {}): BatchItem[] {
    const statuses = filter.status ?? []
    const where = statuses.length ? `AND status IN (${statuses.map(() => '?').join(', ')})` : ''
    const rows = this.db
      .prepare(`SELECT * FROM batch_items WHERE batch_id = ? ${where} ORDER BY seq LIMIT ? OFFSET ?`)
      .all(batchId, ...statuses, filter.limit ?? 100_000, filter.offset ?? 0) as ItemRow[]
    return rows.map(toItem)
  }
  counts(batchId: string): Record<BatchItemStatus, number> {
    const rows = this.db.prepare('SELECT status, COUNT(*) AS n FROM batch_items WHERE batch_id = ? GROUP BY status').all(batchId) as { status: BatchItemStatus; n: number }[]
    const out = Object.fromEntries(Object.keys(ITEM_STATUS_EXPLANATIONS).map((s) => [s, 0])) as Record<BatchItemStatus, number>
    for (const row of rows) out[row.status] = row.n
    return out
  }
  maxSeq(batchId: string): number {
    return (this.db.prepare('SELECT COALESCE(MAX(seq), -1) AS n FROM batch_items WHERE batch_id = ?').get(batchId) as { n: number }).n
  }
  update(id: string, patch: ItemPatch) {
    const current = this.get(id)
    if (!current) return
    const next = { ...current, ...patch }
    this.db
      .prepare(
        `UPDATE batch_items SET status = ?, title = ?, job_id = ?, resource_id = ?, flags = ?, match = ?, decision = ?, plan = ?, plan_hash = ?, base_fingerprint = ?,
          approved_at = ?, result = ?, error = ?, attempts = ?, input_tokens = ?, output_tokens = ?, updated_at = ? WHERE id = ?`,
      )
      .run(
        next.status,
        next.title,
        next.jobId,
        next.resourceId,
        json(next.flags),
        next.match === null || next.match === undefined ? null : json(next.match),
        next.decision,
        next.plan === null || next.plan === undefined ? null : json(next.plan),
        next.planHash,
        next.baseFingerprint,
        next.approvedAt,
        next.result === null || next.result === undefined ? null : json(next.result),
        next.error,
        next.attempts,
        next.inputTokens,
        next.outputTokens,
        now(),
        id,
      )
  }
  /**
   * Moves an item from one status to another only if it is still in the expected status.
   * Returns false when another request changed it first (so an item is never run twice).
   */
  transition(id: string, from: BatchItemStatus[], to: BatchItemStatus): boolean {
    return (
      this.db
        .prepare(`UPDATE batch_items SET status = ?, updated_at = ? WHERE id = ? AND status IN (${from.map(() => '?').join(', ')})`)
        .run(to, now(), id, ...from).changes === 1
    )
  }
  /** Removes items that were never executed (used when records are extracted again). */
  deleteMany(ids: string[]) {
    for (const id of ids) this.db.prepare(`DELETE FROM batch_items WHERE id = ? AND status IN ('pending', 'awaiting_review', 'failed', 'skipped', 'cancelled')`).run(id)
  }
  /** Items left mid-flight by a server restart: drafting is safe to redo; a write's outcome is unknown. */
  markInterrupted(): { processing: number; running: number } {
    const processing = this.db.prepare(`UPDATE batch_items SET status = 'pending', error = 'Interrupted; will be processed again.', updated_at = ? WHERE status = 'processing'`).run(now()).changes
    const running = this.db
      .prepare(`UPDATE batch_items SET status = 'needs_reconciliation', error = 'The server stopped during the write; the outcome is unknown and will be checked before anything else.', updated_at = ? WHERE status = 'running'`)
      .run(now()).changes
    return { processing, running }
  }
}

// ── AI result cache ───────────────────────────────────────────────────────────

export class AiCacheRepo {
  constructor(private readonly db: Db) {}
  get(key: string): { output: unknown; model: string | null; inputTokens: number | null; outputTokens: number | null } | null {
    const row = this.db.prepare('SELECT output, model, input_tokens, output_tokens FROM ai_cache WHERE key = ?').get(key) as
      | { output: string; model: string | null; input_tokens: number | null; output_tokens: number | null }
      | undefined
    return row ? { output: JSON.parse(row.output), model: row.model, inputTokens: row.input_tokens, outputTokens: row.output_tokens } : null
  }
  set(key: string, kind: string, output: unknown, model: string | null, inputTokens: number | null, outputTokens: number | null) {
    this.db
      .prepare('INSERT INTO ai_cache (key, kind, output, model, input_tokens, output_tokens, created_at) VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT(key) DO NOTHING')
      .run(key, kind, json(output), model, inputTokens, outputTokens, now())
  }
}
