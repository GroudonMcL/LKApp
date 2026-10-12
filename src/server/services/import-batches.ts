import 'server-only'
import { z } from 'zod'
import { ExtractionError, guessPageType } from '@/core/extraction'
import { newAppId } from '@/core/ids'
import { Matcher, NO_INDEX_MATCH, duplicatesWithinBatch, type MatchResult } from '@/core/matching'
import { estimateCostUsd, PRICES_AS_OF } from '@/core/pricing'
import { FLAG_EXPLANATIONS, RecordRules, extractRecords, type ExtractedRecord } from '@/core/records'
import type { RecipeDefinition } from '@/core/recipe'
import { allPageTypes, resolvePageType } from '@/core/resolve'
import { pagesFromTranscription } from '../ai/prompts/transcribe'
import { AiError } from '../ai/provider'
import type { AppContext } from '../context'
import type { Batch, BatchItem, BatchItemStatus, BatchSource } from '../db/batch-repositories'
import { ITEM_STATUS_EXPLANATIONS } from '../db/batch-repositories'
import type { RecordMeta } from '../db/repositories'
import { extractDocument } from '../extraction/documents'
import { sha256Hex } from '../hash'
import { toConnectorError } from '../lk/errors'
import { redactSecrets } from '../redact'
import { configuredSecrets } from '../config'
import { recordAudit } from './audit'
import { BATCH_TIMING, cancelRequested, forEachLimited, noteModel, runningPhase, sleep, startBatchWork } from './batch-engine'
import { knownProjectId, requireProjectId } from './connection'
import { getDraft } from './drafts'
import { ServiceError } from './errors'
import { cancelImport } from './imports'
import { runTransform, type TransformMode } from './transform'
import { approveWrite, checkOutcome, dryRunWrite, prepareWrite, writesPerPage } from './write'

/**
 * Batch import: many files, many records, one reviewable job.
 *
 * Stages: add files → extract text (deterministic parsers; AI transcription only on request)
 * → split into records (recipe rules) → draft each record (structural or AI) → match against
 * existing pages → review and edit → dry run → approve → run → report.
 *
 * Every record is an ordinary import job with its own draft, so each one gets the same review
 * screen and the same guarded single-page write as a single import. One bad record never
 * blocks the others. Nothing reaches LegendKeeper before the run step, and the run step only
 * executes items you approved, after re-checking them.
 */

export const MAX_FILES_PER_BATCH = 100
export const DEFAULT_MAX_RECORDS = 500
export const DEFAULT_AI_ITEM_LIMIT = 25
/** Approvals in a batch stay valid for a week; each item is re-checked right before it is written. */
const BATCH_APPROVAL_TTL_MS = 7 * 24 * 60 * 60 * 1000

export const BatchOptions = z.object({
  extraction: RecordRules.nullable().default(null),
  aiItemLimit: z.number().int().min(1).max(500).default(DEFAULT_AI_ITEM_LIMIT),
  maxRecords: z.number().int().min(1).max(2000).default(DEFAULT_MAX_RECORDS),
  attributionTitle: z.string().max(500).nullable().default(null),
  citation: z.string().max(1000).nullable().default(null),
  lastDryRun: z.unknown().optional(),
})
export type BatchOptions = z.infer<typeof BatchOptions>

function optionsOf(batch: Batch): BatchOptions {
  return BatchOptions.parse(batch.options ?? {})
}

export interface BatchFileInput {
  bytes: Uint8Array
  fileName: string | null
  mimeType: string | null
}
export interface BatchPasteInput {
  name: string | null
  text: string
  format?: 'text' | 'markdown' | 'json' | null
}

// ── Helpers ───────────────────────────────────────────────────────────────────

export function getBatch(ctx: AppContext, batchId: string): Batch {
  const batch = ctx.repos.batches.get(batchId)
  if (!batch) throw new ServiceError(404, 'Batch not found.')
  return batch
}

function requireImportBatch(ctx: AppContext, batchId: string): Batch {
  const batch = getBatch(ctx, batchId)
  if (batch.kind !== 'import') throw new ServiceError(400, 'This is not an import batch.')
  return batch
}

function requireOpen(batch: Batch) {
  if (batch.status === 'completed' || batch.status === 'cancelled') throw new ServiceError(409, `This batch is ${batch.status}.`)
}

function requireIdle(batch: Batch) {
  const phase = runningPhase(batch.id)
  if (phase) throw new ServiceError(409, `This batch is busy (${phase}). Wait for it to finish, or stop it.`)
}

/** The recipe definition the batch was started with (its pinned version). */
export function batchRecipe(ctx: AppContext, batch: Batch): { id: string; version: number; definition: RecipeDefinition; latestVersion: number | null } {
  if (!batch.recipeId || batch.recipeVersion === null) throw new ServiceError(400, 'This batch has no recipe.')
  const definition = ctx.repos.recipes.getVersion(batch.recipeId, batch.recipeVersion)
  if (!definition) throw new ServiceError(400, 'The recipe version this batch uses no longer exists.')
  return { id: batch.recipeId, version: batch.recipeVersion, definition, latestVersion: ctx.repos.recipes.get(batch.recipeId)?.version ?? null }
}

function rulesFor(ctx: AppContext, batch: Batch): RecordRules {
  return optionsOf(batch).extraction ?? batchRecipe(ctx, batch).definition.extraction
}

function errorMessage(error: unknown): string {
  if (error instanceof ServiceError) return [error.message, ...error.issues].join(' ')
  return (error as Error)?.message ?? String(error)
}

// ── 1. Create a batch and add sources ─────────────────────────────────────────

export const CreateBatchInput = z.object({
  name: z.string().trim().min(1).max(200),
  recipeId: z.string().min(1),
  templateId: z.string().nullable().optional(),
  attributionTitle: z.string().max(500).nullable().optional(),
  citation: z.string().max(1000).nullable().optional(),
})

export async function createImportBatch(ctx: AppContext, input: z.infer<typeof CreateBatchInput> & { files: BatchFileInput[]; pastes: BatchPasteInput[] }) {
  const recipe = ctx.repos.recipes.get(input.recipeId)
  if (!recipe) throw new ServiceError(400, 'Choose a recipe that exists.')
  if (input.files.length + input.pastes.length > MAX_FILES_PER_BATCH) throw new ServiceError(400, `A batch takes at most ${MAX_FILES_PER_BATCH} files. Split them into several batches.`)
  if (input.templateId) {
    const template = ctx.repos.templates.get(input.templateId)
    const pageType = resolvePageType(recipe.definition)
    if (!template) throw new ServiceError(400, 'The chosen template does not exist.')
    if (pageType && template.definition.pageType !== pageType.id) throw new ServiceError(400, `The template “${template.definition.name}” is for “${template.definition.pageType}” pages, not “${pageType.id}”.`)
  }

  const id = newAppId('bat')
  ctx.repos.batches.insert({
    id,
    kind: 'import',
    name: input.name,
    recipeId: recipe.id,
    recipeVersion: recipe.version,
    templateId: input.templateId ?? null,
    options: BatchOptions.parse({ attributionTitle: input.attributionTitle?.trim() || null, citation: input.citation?.trim() || null }),
  })
  const batch = getBatch(ctx, id)
  await addSources(ctx, batch, recipe.definition, input.files, input.pastes)
  recordAudit(ctx, {
    operation: 'batch.create',
    outcome: 'success',
    recipeId: recipe.id,
    recipeVersion: recipe.version,
    message: `${input.name}: ${input.files.length} file(s), ${input.pastes.length} pasted text(s)`,
    details: { batchId: id },
  })
  return batchView(ctx, id)
}

export async function addBatchSources(ctx: AppContext, batchId: string, files: BatchFileInput[], pastes: BatchPasteInput[]) {
  const batch = requireImportBatch(ctx, batchId)
  requireOpen(batch)
  requireIdle(batch)
  const existing = ctx.repos.batchSources.list(batchId).length
  if (existing + files.length + pastes.length > MAX_FILES_PER_BATCH) throw new ServiceError(400, `A batch takes at most ${MAX_FILES_PER_BATCH} files.`)
  await addSources(ctx, batch, batchRecipe(ctx, batch).definition, files, pastes)
  return batchView(ctx, batchId)
}

async function addSources(ctx: AppContext, batch: Batch, recipe: RecipeDefinition, files: BatchFileInput[], pastes: BatchPasteInput[]) {
  const limits = ctx.config().limits
  let seq = ctx.repos.batchSources.list(batch.id).length
  const inputs = [
    ...files.map((f) => ({ ...f, declaredFormat: null as 'text' | 'markdown' | 'json' | null, kind: 'upload' as const, label: f.fileName })),
    ...pastes.map((p) => ({ bytes: new TextEncoder().encode(p.text), fileName: null, mimeType: 'text/plain', declaredFormat: p.format ?? null, kind: 'paste' as const, label: p.name })),
  ]
  for (const input of inputs) {
    const base = {
      id: newAppId('src'),
      batchId: batch.id,
      seq: seq++,
      fileName: input.fileName,
      mimeType: input.mimeType,
      size: input.bytes.byteLength,
      sha256: sha256Hex(input.bytes),
      json: undefined as unknown,
      totalPages: null as number | null,
      mediaType: null as string | null,
    }
    try {
      const extracted = await extractDocument(
        { bytes: input.bytes, fileName: input.fileName, mimeType: input.mimeType, declaredFormat: input.declaredFormat },
        { maxBytes: limits.maxUploadBytes, maxChars: limits.maxSourceChars, maxDocumentBytes: limits.maxDocumentBytes },
      )
      const accepted = recipe.acceptedFormats
      if (accepted.length > 0 && !accepted.includes(extracted.originalFormat)) {
        throw new ExtractionError(`The recipe accepts only ${accepted.join(', ')} files; this is ${extracted.originalFormat}.`, 'UNSUPPORTED_TYPE')
      }
      ctx.repos.batchSources.insert({
        ...base,
        originalFormat: extracted.originalFormat,
        format: extracted.format,
        status: extracted.needsTranscription ? 'needs_transcription' : 'extracted',
        method: extracted.method,
        title: input.label?.trim() || extracted.title,
        text: extracted.needsTranscription ? null : extracted.text,
        json: extracted.json,
        pages: extracted.pages,
        totalPages: extracted.totalPages,
        mediaType: extracted.mediaType,
        // The file itself is kept only when it still has to be transcribed.
        blob: extracted.needsTranscription ? input.bytes : null,
        warnings: extracted.warnings,
        error: null,
      })
    } catch (error) {
      if (!(error instanceof ExtractionError)) throw error
      // A file that cannot be read is recorded with the reason; the rest of the batch goes on.
      ctx.repos.batchSources.insert({
        ...base,
        originalFormat: input.fileName?.split('.').pop()?.toLowerCase() ?? 'text',
        format: 'text',
        status: 'failed',
        method: 'parser',
        title: input.label?.trim() || null,
        text: null,
        pages: [],
        blob: null,
        warnings: [],
        error: error.message,
      })
    }
  }
}

/** The extracted text of one source, for the inspection view. */
export function sourceText(ctx: AppContext, batchId: string, sourceId: string) {
  const source = ctx.repos.batchSources.get(sourceId)
  if (!source || source.batchId !== batchId) throw new ServiceError(404, 'Source not found.')
  return { id: source.id, title: source.title, fileName: source.fileName, format: source.format, text: source.text, pages: source.pages, purged: source.purgedAt !== null }
}

// ── 2. AI transcription (images and scanned PDFs, only on request) ────────────

const MAX_TRANSCRIBE_PDF_PAGES = 100
const MAX_TRANSCRIBE_BYTES = 30 * 1024 * 1024

export async function transcribeSource(ctx: AppContext, batchId: string, sourceId: string) {
  const batch = requireImportBatch(ctx, batchId)
  requireOpen(batch)
  const source = ctx.repos.batchSources.get(sourceId)
  if (!source || source.batchId !== batchId) throw new ServiceError(404, 'Source not found.')
  if (source.status !== 'needs_transcription') throw new ServiceError(409, 'This file does not need transcription.')
  const blob = ctx.repos.batchSources.blob(sourceId)
  if (!blob) throw new ServiceError(409, 'The file contents are no longer stored. Add the file again.')
  const kind = source.originalFormat === 'pdf' ? 'pdf' : 'image'
  if (kind === 'pdf' && (source.totalPages ?? 0) > MAX_TRANSCRIBE_PDF_PAGES) {
    throw new ServiceError(400, `The PDF has ${source.totalPages} pages; AI transcription takes at most ${MAX_TRANSCRIBE_PDF_PAGES} per file. Split it into smaller PDFs.`)
  }
  if (blob.byteLength > MAX_TRANSCRIBE_BYTES) throw new ServiceError(400, 'The file is too large to send for AI transcription (over 30 MB). Split it.')

  let provider
  try {
    provider = ctx.ai()
  } catch (error) {
    throw new ServiceError(400, (error as Error).message, [], error instanceof AiError ? error.kind : null)
  }
  noteModel(ctx, batchId, provider.model)
  let response
  try {
    response = await provider.transcribe({ kind, mediaType: source.mediaType ?? (kind === 'pdf' ? 'application/pdf' : 'image/png'), base64: Buffer.from(blob).toString('base64'), name: source.fileName ?? source.title ?? 'file' })
  } catch (error) {
    const message = error instanceof AiError ? error.message : `Transcription failed: ${(error as Error).message}`
    recordAudit(ctx, { operation: 'batch.transcribe', outcome: 'failure', model: provider.model, message, details: { batchId, sourceId } })
    throw new ServiceError(error instanceof AiError && (error.kind === 'not_configured' || error.kind === 'disabled') ? 400 : 502, message)
  }
  const { text, pages } = kind === 'pdf' ? pagesFromTranscription(response.output.markdown) : { text: response.output.markdown.trim(), pages: [] }
  const warnings = [
    `Transcribed by AI (${response.servedByModel}). Check every number, name and rules term against the original before approving.`,
    ...response.output.uncertainPassages.map((p) => `Hard to read: “${p.text}” — ${p.reason}`),
    ...(response.output.suspectedInstructions.length ? ['The file contains text that reads like instructions to an AI; it was transcribed as plain text.'] : []),
    ...response.output.notes,
  ]
  ctx.repos.batchSources.update(sourceId, {
    status: text ? 'extracted' : 'failed',
    method: 'ai_transcription',
    format: 'markdown',
    text: text || null,
    pages,
    warnings,
    error: text ? null : 'The transcription was empty.',
    inputTokens: response.inputTokens,
    outputTokens: response.outputTokens,
  })
  ctx.repos.batchSources.dropBlob(sourceId)
  recordAudit(ctx, {
    operation: 'batch.transcribe',
    outcome: 'success',
    model: response.servedByModel,
    message: `Transcribed ${source.fileName ?? 'file'} (${text.length} characters)`,
    details: { batchId, sourceId, promptVersion: response.promptVersion, inputTokens: response.inputTokens, outputTokens: response.outputTokens },
  })
  return batchView(ctx, batchId)
}

// ── 3. Records ────────────────────────────────────────────────────────────────

/** Splits every extracted source into records (one import job and one batch item each). */
export function extractBatchRecords(ctx: AppContext, batchId: string, input: { rules?: unknown } = {}) {
  const batch = requireImportBatch(ctx, batchId)
  requireOpen(batch)
  requireIdle(batch)
  const items = ctx.repos.batchItems.list(batchId)
  if (items.some((item) => ['approved', 'running', 'succeeded', 'needs_reconciliation'].includes(item.status))) {
    throw new ServiceError(409, 'Records cannot be extracted again after some were approved or written. Start a new batch for the rest of the content.')
  }
  const recipe = batchRecipe(ctx, batch)
  let rules = rulesFor(ctx, batch)
  if (input.rules !== undefined) {
    const parsed = RecordRules.safeParse(input.rules)
    if (!parsed.success) throw new ServiceError(400, 'The record rules are not valid.', parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`))
    rules = parsed.data
  }
  const options = optionsOf(batch)
  const limits = ctx.config().limits
  const sources = ctx.repos.batchSources.list(batchId).filter((s) => s.status === 'extracted' && s.text !== null)
  if (sources.length === 0) throw new ServiceError(409, 'No file has extracted text yet.')

  const perSource = sources.map((source) => ({ source, records: extractRecords({ text: source.text!, json: source.json, format: source.format, title: source.title, pages: source.pages }, rules, { maxChars: limits.maxSourceChars }) }))
  const total = perSource.reduce((n, s) => n + s.records.filter((r) => !r.flags.includes('preamble')).length, 0)
  if (total > options.maxRecords) {
    throw new ServiceError(400, `The rules found ${total} records, more than this batch's limit of ${options.maxRecords}. Check the split rules, raise the limit, or split the files into several batches.`)
  }

  // Replace earlier, never-executed records.
  for (const item of items) {
    if (item.jobId) {
      const job = ctx.repos.jobs.get(item.jobId)
      if (job && job.status !== 'cancelled' && job.status !== 'completed') cancelImport(ctx, item.jobId)
    }
  }
  ctx.repos.batchItems.deleteMany(items.map((i) => i.id))

  let seq = ctx.repos.batchItems.maxSeq(batchId) + 1
  const types = allPageTypes()
  for (const { source, records } of perSource) {
    for (const record of records) createRecordItem(ctx, batch, recipe, source, record, seq++, types)
    ctx.repos.batchSources.update(source.id, { recordCount: records.filter((r) => !r.flags.includes('preamble')).length })
  }
  ctx.repos.batches.update(batchId, { options: { ...options, extraction: input.rules !== undefined ? rules : options.extraction }, status: 'ready' })
  recordAudit(ctx, {
    operation: 'batch.extract',
    outcome: 'success',
    recipeId: recipe.id,
    recipeVersion: recipe.version,
    message: `${total} record(s) from ${sources.length} file(s) (${rules.mode})`,
    details: { batchId, rules },
  })
  return batchView(ctx, batchId)
}

function citationFor(recipe: RecipeDefinition, batchCitation: string | null, source: BatchSource, record: ExtractedRecord): string | null {
  const rules = recipe.attribution
  const parts = [
    batchCitation,
    rules.includeFile ? source.fileName : null,
    rules.includeSection ? record.section : null,
    rules.includePage && record.page !== null ? `p. ${record.page}` : null,
    record.sourceRecordId ? `entry ${record.sourceRecordId}` : null,
  ].filter((part): part is string => Boolean(part && part.trim()))
  return parts.length ? parts.join(' — ').slice(0, 1000) : null
}

function createRecordItem(ctx: AppContext, batch: Batch, recipe: ReturnType<typeof batchRecipe>, source: BatchSource, record: ExtractedRecord, seq: number, types: ReturnType<typeof allPageTypes>) {
  const options = optionsOf(batch)
  const jobId = newAppId('job')
  const meta: RecordMeta = {
    sourceId: source.id,
    fileName: source.fileName,
    documentTitle: source.title,
    section: record.section,
    page: record.page,
    sourceRecordId: record.sourceRecordId,
    index: record.index,
    flags: record.flags,
  }
  const isJson = record.json !== undefined
  ctx.repos.jobs.insert({
    id: jobId,
    name: record.title.slice(0, 200),
    status: 'extracted',
    sourceName: source.fileName ?? source.title,
    sourceKind: source.fileName ? 'upload' : 'paste',
    sourceFormat: isJson ? 'json' : source.format,
    sourceSize: new TextEncoder().encode(record.text).byteLength,
    sourceSha256: sha256Hex(record.text),
    sourceText: record.text,
    sourceJson: record.json,
    attribution: {
      title: (options.attributionTitle || source.title || source.fileName || batch.name).slice(0, 500),
      kind: source.fileName ? 'upload' : 'paste',
      citation: citationFor(recipe.definition, options.citation, source, record),
      jobId,
      importedAt: ctx.now().toISOString(),
    },
    recipeId: recipe.id,
    pageTypeGuesses: guessPageType(record.text, types).slice(0, 3),
    warnings: record.flags.map((flag) => FLAG_EXPLANATIONS[flag]),
    batchId: batch.id,
    recordMeta: meta,
  })
  const preamble = record.flags.includes('preamble')
  ctx.repos.batchItems.insert({
    id: newAppId('itm'),
    batchId: batch.id,
    seq,
    kind: 'create_page',
    status: preamble ? 'skipped' : 'pending',
    title: record.title,
    sourceId: source.id,
    jobId,
    resourceId: null,
    flags: record.flags,
  })
}

/** Puts a skipped record (e.g. a preamble) back into the batch, or skips records. */
export function decideItems(ctx: AppContext, batchId: string, itemIds: string[], decision: 'create' | 'skip' | 'include' | 'undecide') {
  const batch = requireImportBatch(ctx, batchId)
  requireOpen(batch)
  for (const id of itemIds) {
    const item = ctx.repos.batchItems.get(id)
    if (!item || item.batchId !== batchId) continue
    if (decision === 'skip') {
      if (!['pending', 'awaiting_review', 'approved', 'failed'].includes(item.status)) continue
      if (item.status === 'approved' && item.jobId) revokeItemApproval(ctx, item)
      ctx.repos.batchItems.update(id, { status: 'skipped', decision: 'skip', error: null })
    } else if (decision === 'include') {
      if (item.status !== 'skipped') continue
      const job = item.jobId ? ctx.repos.jobs.get(item.jobId) : null
      const hasDraft = item.jobId ? ctx.repos.drafts.getByJob(item.jobId) !== null : false
      if (job?.status === 'cancelled') continue
      ctx.repos.batchItems.update(id, { status: hasDraft ? 'awaiting_review' : 'pending', decision: null })
    } else if (decision === 'create') {
      if (!['awaiting_review', 'approved'].includes(item.status)) continue
      ctx.repos.batchItems.update(id, { decision: 'create' })
    } else {
      ctx.repos.batchItems.update(id, { decision: null })
    }
  }
  recordAudit(ctx, { operation: 'batch.decide', outcome: 'success', message: `${decision}: ${itemIds.length} item(s)`, details: { batchId, itemIds: itemIds.slice(0, 200) } })
  return batchView(ctx, batchId)
}

function revokeItemApproval(ctx: AppContext, item: BatchItem) {
  const draft = item.jobId ? ctx.repos.drafts.getByJob(item.jobId) : null
  if (draft) ctx.repos.drafts.revokeApproval(draft.id)
  ctx.repos.batchItems.update(item.id, { status: 'awaiting_review', approvedAt: null, plan: null, planHash: null })
}

// ── 4. Drafts ─────────────────────────────────────────────────────────────────

export interface GenerateOptions {
  mode: TransformMode
  itemIds?: string[]
  /** Also redo records that already have a draft (your edits are kept in the draft history). */
  regenerate?: boolean
  wait?: boolean
}

export async function generateDrafts(ctx: AppContext, batchId: string, options: GenerateOptions) {
  const batch = requireImportBatch(ctx, batchId)
  requireOpen(batch)
  requireIdle(batch)
  const statuses: BatchItemStatus[] = options.regenerate ? ['pending', 'failed', 'awaiting_review'] : ['pending', 'failed']
  let items = ctx.repos.batchItems
    .list(batchId, { status: statuses })
    .filter((item) => item.kind === 'create_page' && item.jobId && (!options.itemIds || options.itemIds.includes(item.id)))
    // A failed *write* is retried by approving again, not by redrafting.
    .filter((item) => !(item.status === 'failed' && (item.result as { stage?: string } | null)?.stage === 'write'))
  if (items.length === 0) throw new ServiceError(409, 'There are no records waiting for a draft.')

  let deferred = 0
  if (options.mode === 'ai') {
    try {
      noteModel(ctx, batchId, ctx.ai().model)
    } catch (error) {
      throw new ServiceError(400, (error as Error).message)
    }
    const limit = optionsOf(batch).aiItemLimit
    if (items.length > limit) {
      deferred = items.length - limit
      items = items.slice(0, limit)
    }
  }
  const recipe = batchRecipe(ctx, batch)
  recordAudit(ctx, {
    operation: 'batch.draft',
    outcome: 'info',
    recipeId: recipe.id,
    recipeVersion: recipe.version,
    message: `Drafting ${items.length} record(s) (${options.mode})${deferred ? `; ${deferred} left for the next run (AI limit per run)` : ''}`,
    details: { batchId },
  })

  await startBatchWork(ctx, batchId, 'drafting', { status: 'processing', wait: options.wait }, async () => {
    await forEachLimited(items, options.mode === 'ai' ? 2 : 4, () => cancelRequested(ctx, batchId), async (item) => {
      if (!ctx.repos.batchItems.transition(item.id, statuses, 'processing')) return
      try {
        const view = await runTransform(ctx, item.jobId!, { mode: options.mode, recipeId: recipe.id, recipeVersion: recipe.version, templateId: batch.templateId })
        const processing = view.draft.page.processing
        ctx.repos.batchItems.update(item.id, {
          status: 'awaiting_review',
          title: view.draft.page.name || item.title,
          error: null,
          result: { stage: 'draft' },
          attempts: item.attempts + 1,
          inputTokens: (item.inputTokens ?? 0) + (processing?.inputTokens ?? 0),
          outputTokens: (item.outputTokens ?? 0) + (processing?.outputTokens ?? 0),
        })
      } catch (error) {
        ctx.repos.batchItems.update(item.id, { status: 'failed', error: errorMessage(error), result: { stage: 'draft' }, attempts: item.attempts + 1 })
      }
    })
    matchItems(ctx, batchId)
  })
  return { ...batchView(ctx, batchId), deferred }
}

// ── 5. Matching existing pages ────────────────────────────────────────────────

/**
 * Matches every drafted record against the project index and against the other records of
 * the batch, then applies the recipe's duplicate policy. Never merges or overwrites pages.
 */
export function matchItems(ctx: AppContext, batchId: string) {
  const batch = requireImportBatch(ctx, batchId)
  const recipe = batchRecipe(ctx, batch)
  const pageType = resolvePageType(recipe.definition)
  const projectId = knownProjectId(ctx)
  const resources = projectId ? ctx.repos.index.forReferences(projectId) : []
  const matcher = resources.length ? new Matcher(resources) : null
  const items = ctx.repos.batchItems.list(batchId).filter((item) => item.jobId && ['awaiting_review', 'approved', 'failed', 'skipped'].includes(item.status))
  const drafted = items
    .map((item) => ({ item, draft: ctx.repos.drafts.getByJob(item.jobId!) }))
    .filter((entry): entry is { item: BatchItem; draft: NonNullable<typeof entry.draft> } => entry.draft !== null)
  const live = drafted.filter(({ item }) => item.status !== 'skipped' || item.decision !== 'skip')
  const inBatch = duplicatesWithinBatch(live.map(({ item, draft }) => ({ id: item.id, name: draft.page.name })))

  for (const { item, draft } of drafted) {
    const match: MatchResult = matcher ? matcher.match({ name: draft.page.name, aliases: draft.page.aliases, parentId: draft.page.parentId }, pageType) : NO_INDEX_MATCH
    const others = (inBatch.get(item.id) ?? []).map((id) => ctx.repos.batchItems.get(id)?.title ?? id)
    const flags = item.flags.filter((f) => f !== 'possible_duplicate' && f !== 'duplicate_in_batch' && f !== 'no_index')
    if (match.category !== 'none') flags.push('possible_duplicate')
    if (others.length) flags.push('duplicate_in_batch')
    if (!match.indexAvailable) flags.push('no_index')
    const patch: Parameters<typeof ctx.repos.batchItems.update>[1] = { flags, match: { ...match, withinBatch: others } }
    if (recipe.definition.duplicatePolicy === 'skip_exact' && match.category === 'exact' && !item.decision && item.status === 'awaiting_review') {
      patch.status = 'skipped'
      patch.decision = 'skip'
      patch.result = { stage: 'match', reason: 'Skipped by the recipe’s duplicate policy: an exact, verified match exists.' }
    }
    ctx.repos.batchItems.update(item.id, patch)
  }
  return batchView(ctx, batchId)
}

/** Why an item cannot be approved yet because of an unresolved match, or null. */
function matchBlocker(recipe: RecipeDefinition, item: BatchItem): string | null {
  const match = item.match as (MatchResult & { withinBatch?: string[] }) | null
  if (item.decision === 'create' || recipe.duplicatePolicy === 'create_anyway') return null
  if (match && match.category !== 'none') return `Possible duplicate: ${match.explanation} Choose “Create anyway” or “Skip”.`
  if (match?.withinBatch?.length) return `Another record in this batch has the same name (${match.withinBatch.join(', ')}). Choose “Create anyway” or “Skip”.`
  return null
}

// ── 6. Dry run, approval, execution ───────────────────────────────────────────

interface PlanEntry {
  itemId: string
  seq: number
  title: string
  status: BatchItemStatus
  operation: 'create_page'
  name: string | null
  parentId: string | null
  parentName: string | null
  tags: string[]
  links: number
  bytes: number | null
  warnings: string[]
  problems: string[]
  matchCategory: string | null
  decision: string | null
  canProceed: boolean
}

async function liveProject(ctx: AppContext) {
  try {
    const project = await ctx.connector().getProject()
    await ctx.connector().pingProject(project.id)
    const expected = knownProjectId(ctx)
    if (expected && expected !== project.id) throw new ServiceError(409, `The API key now belongs to a different project (${project.name}).`)
    return project
  } catch (error) {
    if (error instanceof ServiceError) throw error
    throw new ServiceError(502, `The LegendKeeper connection is not working: ${toConnectorError(error).message}`)
  }
}

/** Whether the key can create pages at the top level of the project (needs ADMIN). Read-only check. */
async function keyIsAdmin(ctx: AppContext): Promise<boolean | null> {
  try {
    await ctx.connector().listTags()
    return true
  } catch (error) {
    return toConnectorError(error).kind === 'permission' ? false : null
  }
}

async function planEntry(ctx: AppContext, recipe: RecipeDefinition, item: BatchItem, project: { id: string; name: string }, isAdmin: boolean | null, mode: 'dry' | 'approve', acknowledgeWarnings: boolean): Promise<PlanEntry> {
  const entry: PlanEntry = {
    itemId: item.id,
    seq: item.seq,
    title: item.title,
    status: item.status,
    operation: 'create_page',
    name: null,
    parentId: null,
    parentName: null,
    tags: [],
    links: 0,
    bytes: null,
    warnings: [],
    problems: [],
    matchCategory: (item.match as MatchResult | null)?.category ?? null,
    decision: item.decision,
    canProceed: false,
  }
  const draft = item.jobId ? ctx.repos.drafts.getByJob(item.jobId) : null
  if (!draft) {
    entry.problems.push('No draft yet.')
    return entry
  }
  entry.name = draft.page.name
  entry.parentId = draft.page.parentId
  const blocker = matchBlocker(recipe, item)
  if (blocker) entry.problems.push(blocker)
  if (!draft.page.parentId && isAdmin === false) entry.problems.push('No parent page is set, and creating a page at the top level needs an ADMIN key. Set a parent (or a default parent in the recipe).')
  try {
    const prepared =
      mode === 'dry' || entry.problems.length
        ? await dryRunWrite(ctx, draft.id, { project })
        : await prepareWrite(ctx, draft.id, { project, ttlMs: BATCH_APPROVAL_TTL_MS })
    entry.name = prepared.name
    entry.parentName = prepared.parent?.name ?? null
    entry.tags = prepared.tags.map((t) => t.value)
    entry.links = prepared.links.length
    entry.bytes = prepared.bytes
    entry.warnings = prepared.warnings
    if (mode === 'approve' && entry.warnings.length && !acknowledgeWarnings) {
      entry.problems.push('This record has warnings. Review them, then approve with “I have reviewed the warnings” ticked.')
      ctx.repos.drafts.revokeApproval(draft.id)
    }
    if (mode === 'approve' && !entry.problems.length) {
      ctx.repos.batchItems.update(item.id, {
        status: 'approved',
        approvedAt: ctx.now().toISOString(),
        plan: { name: prepared.name, parentId: draft.page.parentId, parentName: entry.parentName, tags: entry.tags, links: entry.links, bytes: prepared.bytes, warnings: prepared.warnings, plannedResourceId: prepared.plannedResourceId, sameName: prepared.sameName.map((s) => s.id) },
        planHash: prepared.payloadHash,
        error: null,
      })
    }
  } catch (error) {
    entry.problems.push(errorMessage(error))
  }
  entry.canProceed = entry.problems.length === 0
  if (mode === 'approve' && !entry.canProceed) ctx.repos.batchItems.update(item.id, { error: entry.problems.join(' ') })
  return entry
}

/**
 * A dry run: every check of the final preview for the selected records (live connection,
 * parent, links, same-name search, validation, duplicate policy, key permissions), without
 * planning or writing anything. The report is kept on the batch and can be exported.
 */
export async function dryRunBatch(ctx: AppContext, batchId: string, input: { itemIds?: string[]; wait?: boolean } = {}) {
  const batch = requireImportBatch(ctx, batchId)
  requireOpen(batch)
  requireIdle(batch)
  const recipe = batchRecipe(ctx, batch)
  const items = ctx.repos.batchItems.list(batchId, { status: ['awaiting_review', 'approved'] }).filter((i) => !input.itemIds || input.itemIds.includes(i.id))
  if (items.length === 0) throw new ServiceError(409, 'There are no reviewed records to check.')
  await startBatchWork(ctx, batchId, 'dry run', { status: 'processing', wait: input.wait }, async () => {
    const project = await liveProject(ctx)
    const isAdmin = await keyIsAdmin(ctx)
    const entries: PlanEntry[] = []
    for (const item of items) {
      if (cancelRequested(ctx, batchId)) break
      entries.push(await planEntry(ctx, recipe.definition, item, project, isAdmin, 'dry', true))
      await sleep(BATCH_TIMING.checkSpacingMs)
    }
    const report = {
      kind: 'dry_run',
      batchId,
      batchName: batch.name,
      at: ctx.now().toISOString(),
      recipe: { id: recipe.id, name: recipe.definition.name, version: recipe.version },
      project: { id: project.id, name: project.name },
      keyRole: isAdmin === null ? 'unknown' : isAdmin ? 'ADMIN' : 'MEMBER',
      totals: { items: entries.length, ready: entries.filter((e) => e.canProceed).length, blocked: entries.filter((e) => !e.canProceed).length, withWarnings: entries.filter((e) => e.warnings.length).length },
      entries,
    }
    ctx.repos.batches.update(batchId, { options: { ...optionsOf(getBatch(ctx, batchId)), lastDryRun: report } })
    recordAudit(ctx, { operation: 'batch.dry_run', outcome: 'success', projectId: project.id, recipeId: recipe.id, recipeVersion: recipe.version, message: `${report.totals.ready} ready, ${report.totals.blocked} blocked`, details: { batchId } })
  })
  return batchView(ctx, batchId)
}

/** Approves the selected records: each is checked like a final preview and bound to its exact content. */
export async function approveItems(ctx: AppContext, batchId: string, input: { itemIds: string[]; acknowledgeWarnings: boolean; wait?: boolean }) {
  const batch = requireImportBatch(ctx, batchId)
  requireOpen(batch)
  requireIdle(batch)
  const recipe = batchRecipe(ctx, batch)
  if (!recipe.definition.allowCreate) throw new ServiceError(409, `The recipe “${recipe.definition.name}” (version ${recipe.version}) does not allow creating pages.`)
  const items = ctx.repos.batchItems.list(batchId, { status: ['awaiting_review'] }).filter((i) => input.itemIds.includes(i.id))
  if (items.length === 0) throw new ServiceError(409, 'Select records that are ready for review.')
  await startBatchWork(ctx, batchId, 'approving', { status: 'processing', wait: input.wait }, async () => {
    const project = await liveProject(ctx)
    const isAdmin = await keyIsAdmin(ctx)
    let approved = 0
    for (const item of items) {
      if (cancelRequested(ctx, batchId)) break
      const entry = await planEntry(ctx, recipe.definition, item, project, isAdmin, 'approve', input.acknowledgeWarnings)
      if (entry.canProceed) approved++
      await sleep(BATCH_TIMING.checkSpacingMs)
    }
    recordAudit(ctx, { operation: 'batch.approve', outcome: 'success', approval: 'approved', projectId: project.id, recipeId: recipe.id, recipeVersion: recipe.version, message: `${approved} of ${items.length} record(s) approved`, details: { batchId } })
  })
  return batchView(ctx, batchId)
}

/** Withdraws approvals (the records go back to review). */
export function unapproveItems(ctx: AppContext, batchId: string, itemIds: string[]) {
  const batch = requireImportBatch(ctx, batchId)
  requireIdle(batch)
  for (const item of ctx.repos.batchItems.list(batchId, { status: ['approved'] })) if (itemIds.includes(item.id)) revokeItemApproval(ctx, item)
  return batchView(ctx, batchId)
}

/**
 * Executes the approved records, one at a time, spaced out. Before each write: the approval
 * must still be valid for exactly the approved content, the parent must still exist, and no
 * new page with the same name may have appeared. Anything that changed goes back to review.
 * Uncertain outcomes are reconciled by reading, never by writing again.
 */
export async function runBatch(ctx: AppContext, batchId: string, input: { wait?: boolean } = {}) {
  const batch = requireImportBatch(ctx, batchId)
  requireOpen(batch)
  requireIdle(batch)
  const pending = ctx.repos.batchItems.list(batchId, { status: ['approved', 'needs_reconciliation'] })
  if (pending.length === 0) throw new ServiceError(409, 'There are no approved records to run.')
  const recipe = batchRecipe(ctx, batch)
  await startBatchWork(ctx, batchId, 'running', { status: 'running', wait: input.wait }, async () => {
    for (const item of ctx.repos.batchItems.list(batchId, { status: ['needs_reconciliation'] })) await reconcileItem(ctx, item)
    const parents = new Map<string, boolean>()
    const counts = { succeeded: 0, failed: 0, uncertain: 0, returned: 0 }
    const approved = ctx.repos.batchItems.list(batchId, { status: ['approved'] })
    for (const [index, item] of approved.entries()) {
      if (cancelRequested(ctx, batchId)) break
      const outcome = await runItem(ctx, item, parents)
      counts[outcome]++
      // Pages created from a LegendKeeper template take up to 3 writes: keep under 120 writes a minute.
      const draft = item.jobId ? ctx.repos.drafts.getByJob(item.jobId) : null
      if (index < approved.length - 1) await sleep(BATCH_TIMING.writeSpacingMs * (draft ? writesPerPage(ctx, draft) : 1))
    }
    recordAudit(ctx, {
      operation: 'batch.run',
      outcome: counts.failed || counts.uncertain ? 'failure' : 'success',
      approval: 'approved',
      projectId: knownProjectId(ctx),
      recipeId: recipe.id,
      recipeVersion: recipe.version,
      message: `${counts.succeeded} created, ${counts.failed} failed, ${counts.uncertain} uncertain, ${counts.returned} back to review`,
      details: { batchId, ...counts },
    })
  })
  return batchView(ctx, batchId)
}

async function runItem(ctx: AppContext, item: BatchItem, parents: Map<string, boolean>): Promise<'succeeded' | 'failed' | 'uncertain' | 'returned'> {
  if (!ctx.repos.batchItems.transition(item.id, ['approved'], 'running')) return 'returned'
  const backToReview = (reason: string) => {
    revokeItemApproval(ctx, item)
    ctx.repos.batchItems.update(item.id, { status: 'awaiting_review', error: reason })
    return 'returned' as const
  }
  const draft = item.jobId ? ctx.repos.drafts.getByJob(item.jobId) : null
  if (!draft || draft.status !== 'awaiting_approval' || !draft.approvalToken) return backToReview('The approval is no longer valid (the draft was edited or re-drafted). Approve it again.')

  // Freshness checks against LegendKeeper (reads only).
  try {
    const parentId = draft.page.parentId
    if (parentId) {
      if (!parents.has(parentId)) {
        try {
          await ctx.connector().getResource(parentId)
          parents.set(parentId, true)
        } catch (error) {
          parents.set(parentId, toConnectorError(error).kind !== 'not_found')
        }
      }
      if (!parents.get(parentId)) return backToReview(`The parent page ${parentId} no longer exists.`)
    }
    const known = new Set(((item.plan as { sameName?: string[] } | null)?.sameName) ?? [])
    const appeared = (await ctx.connector().search(draft.page.name, 10)).filter((hit) => hit.name === draft.page.name && !known.has(hit.resourceId))
    if (appeared.length) return backToReview(`A page named “${draft.page.name}” appeared in LegendKeeper after approval (${appeared.map((h) => h.resourceId).join(', ')}). Check it is not a duplicate, then approve again.`)
  } catch (error) {
    ctx.repos.batchItems.update(item.id, { status: 'approved', error: `Could not check LegendKeeper before writing: ${toConnectorError(error).message} Nothing was written; run again later.` })
    return 'returned'
  }

  try {
    const result = await approveWrite(ctx, draft.id, { approvalToken: draft.approvalToken, acknowledgeWarnings: true })
    if (result.status === 'created') {
      ctx.repos.batchItems.update(item.id, { status: 'succeeded', resourceId: result.resourceId, error: null, attempts: item.attempts + 1, result: { stage: 'write', resourceId: result.resourceId, documentId: result.documentId, mismatches: result.mismatches } })
      return 'succeeded'
    }
    if (result.status === 'write_uncertain') {
      ctx.repos.batchItems.update(item.id, { status: 'needs_reconciliation', error: result.message, attempts: item.attempts + 1, result: { stage: 'write' } })
      return 'uncertain'
    }
    if (result.status === 'write_incomplete') {
      // The page exists (created from its template); only filling it is left, on the record's page.
      ctx.repos.batchItems.update(item.id, { status: 'failed', resourceId: result.resourceId, error: result.message, attempts: item.attempts + 1, result: { stage: 'write', incomplete: true } })
      return 'failed'
    }
    ctx.repos.batchItems.update(item.id, { status: 'failed', error: [result.message, ...(result.issues ?? []).map((i) => `${(i as { path?: string }).path ?? ''}: ${(i as { message?: string }).message ?? ''}`)].join(' '), attempts: item.attempts + 1, result: { stage: 'write' } })
    return 'failed'
  } catch (error) {
    // Refused before anything was sent (content changed, expired, blocked): back to review.
    if (error instanceof ServiceError) return backToReview(errorMessage(error))
    ctx.repos.batchItems.update(item.id, { status: 'failed', error: errorMessage(error), attempts: item.attempts + 1, result: { stage: 'write' } })
    return 'failed'
  }
}

/** Finds out, by reading, whether an uncertain write created its page. */
async function reconcileItem(ctx: AppContext, item: BatchItem) {
  const draft = item.jobId ? ctx.repos.drafts.getByJob(item.jobId) : null
  if (!draft) return
  if (draft.status === 'created') {
    ctx.repos.batchItems.update(item.id, { status: 'succeeded', resourceId: draft.createdResourceId, error: null })
    return
  }
  if (draft.status === 'writing') ctx.repos.drafts.setStatus(draft.id, 'write_uncertain')
  try {
    const outcome = await checkOutcome(ctx, draft.id)
    if (outcome.status === 'created' && 'resourceId' in outcome) ctx.repos.batchItems.update(item.id, { status: 'succeeded', resourceId: outcome.resourceId, error: null, result: { stage: 'write', reconciled: true } })
    else if (outcome.status === 'write_incomplete') ctx.repos.batchItems.update(item.id, { status: 'failed', resourceId: outcome.resourceId, error: outcome.message, result: { stage: 'write', reconciled: true, incomplete: true } })
    else if (outcome.status === 'write_failed') ctx.repos.batchItems.update(item.id, { status: 'failed', error: `${outcome.message}`, result: { stage: 'write', reconciled: true } })
    else ctx.repos.batchItems.update(item.id, { error: outcome.message })
  } catch (error) {
    ctx.repos.batchItems.update(item.id, { error: errorMessage(error) })
  }
}

/** Checks uncertain items now (read-only). */
export async function reconcileBatch(ctx: AppContext, batchId: string) {
  const batch = requireImportBatch(ctx, batchId)
  requireIdle(batch)
  for (const item of ctx.repos.batchItems.list(batchId, { status: ['needs_reconciliation'] })) await reconcileItem(ctx, item)
  return batchView(ctx, batchId)
}

/**
 * Retry failed items. A failed draft goes back to "pending" (draft again). A failed write goes
 * back to review: it must be approved again, so nothing is ever re-sent without approval.
 */
export function retryItems(ctx: AppContext, batchId: string, itemIds: string[]) {
  const batch = requireImportBatch(ctx, batchId)
  requireOpen(batch)
  requireIdle(batch)
  for (const item of ctx.repos.batchItems.list(batchId, { status: ['failed'] })) {
    if (!itemIds.includes(item.id)) continue
    const stage = (item.result as { stage?: string } | null)?.stage
    ctx.repos.batchItems.update(item.id, { status: stage === 'write' ? 'awaiting_review' : 'pending', error: null })
  }
  return batchView(ctx, batchId)
}

/** Asks running work to stop after the current item. */
export function stopBatch(ctx: AppContext, batchId: string) {
  getBatch(ctx, batchId)
  if (!runningPhase(batchId)) throw new ServiceError(409, 'Nothing is running.')
  ctx.repos.batches.update(batchId, { cancelRequested: true })
  return batchView(ctx, batchId)
}

/** Cancels the batch: nothing more is written; unfinished records are cancelled; stored source text is deleted. */
export function cancelBatch(ctx: AppContext, batchId: string) {
  const batch = getBatch(ctx, batchId)
  requireOpen(batch)
  requireIdle(batch)
  if (ctx.repos.batchItems.list(batchId, { status: ['needs_reconciliation', 'running'] }).length) {
    throw new ServiceError(409, 'Some writes have an unknown outcome. Use “Check outcomes” first, so nothing is left half-done.')
  }
  closeOut(ctx, batch, 'cancelled')
  recordAudit(ctx, { operation: 'batch.cancel', outcome: 'success', message: batch.name, details: { batchId } })
  return batchView(ctx, batchId)
}

/** Closes a finished batch: records that were not written are cancelled; stored source text is deleted. */
export function closeBatch(ctx: AppContext, batchId: string) {
  const batch = getBatch(ctx, batchId)
  requireOpen(batch)
  requireIdle(batch)
  const open = ctx.repos.batchItems.list(batchId, { status: ['approved', 'running', 'needs_reconciliation', 'processing'] })
  if (open.length) throw new ServiceError(409, 'Some records are approved but not written, or have an unknown outcome. Run or check them, or withdraw the approvals, first.')
  closeOut(ctx, batch, 'completed')
  recordAudit(ctx, { operation: 'batch.close', outcome: 'success', message: batch.name, details: { batchId } })
  return batchView(ctx, batchId)
}

function closeOut(ctx: AppContext, batch: Batch, status: 'completed' | 'cancelled') {
  for (const item of ctx.repos.batchItems.list(batch.id, { status: ['pending', 'awaiting_review', 'approved', 'failed'] })) {
    if (item.status === 'approved') revokeItemApproval(ctx, item)
    ctx.repos.batchItems.update(item.id, { status: 'cancelled' })
  }
  for (const job of ctx.repos.jobs.listByBatch(batch.id)) {
    if (job.status !== 'cancelled' && job.status !== 'completed') {
      try {
        cancelImport(ctx, job.id)
      } catch {
        /* a job with an uncertain write stays open; it was checked above */
      }
    }
  }
  ctx.repos.batchSources.purge(batch.id)
  ctx.repos.batches.update(batch.id, { status, finishedAt: ctx.now().toISOString(), cancelRequested: false })
}

// ── 7. Views and reports ──────────────────────────────────────────────────────

/** Keeps batch items in step with their drafts (a record can also be written from its own review page). */
function syncFromDrafts(ctx: AppContext, items: BatchItem[]) {
  for (const item of items) {
    if (!item.jobId || ['succeeded', 'cancelled', 'running'].includes(item.status)) continue
    const draft = ctx.repos.drafts.getByJob(item.jobId)
    if (!draft) continue
    if (draft.status === 'created') {
      ctx.repos.batchItems.update(item.id, { status: 'succeeded', resourceId: draft.createdResourceId, error: null, result: { stage: 'write', viaReviewPage: true } })
      item.status = 'succeeded'
      item.resourceId = draft.createdResourceId
    } else if (draft.status === 'write_uncertain' && item.status !== 'needs_reconciliation') {
      ctx.repos.batchItems.update(item.id, { status: 'needs_reconciliation' })
      item.status = 'needs_reconciliation'
    } else if (item.status === 'approved' && draft.status !== 'awaiting_approval') {
      // The draft was edited after approval: the approval no longer applies.
      ctx.repos.batchItems.update(item.id, { status: 'awaiting_review', approvedAt: null, plan: null, planHash: null, error: 'The draft changed after approval. Approve it again.' })
      item.status = 'awaiting_review'
    }
  }
}

export function batchView(ctx: AppContext, batchId: string) {
  const batch = getBatch(ctx, batchId)
  const options = optionsOf(batch)
  let recipe: ReturnType<typeof batchRecipe> | null = null
  try {
    recipe = batchRecipe(ctx, batch)
  } catch {
    recipe = null
  }
  if (!runningPhase(batchId)) syncFromDrafts(ctx, ctx.repos.batchItems.list(batchId))
  const items = ctx.repos.batchItems.list(batchId)
  const sources = ctx.repos.batchSources.list(batchId).map(({ text, json, ...rest }) => ({ ...rest, chars: text?.length ?? 0, preview: text?.slice(0, 300) ?? null, hasJson: json !== null && json !== undefined }))

  const rows = items.map((item) => {
    const job = item.jobId ? ctx.repos.jobs.get(item.jobId) : null
    const draft = item.jobId ? ctx.repos.drafts.getByJob(item.jobId) : null
    const errors = draft?.findings.filter((f) => f.severity === 'error') ?? []
    const warnings = draft?.findings.filter((f) => f.severity === 'warning') ?? []
    return {
      ...item,
      statusExplanation: ITEM_STATUS_EXPLANATIONS[item.status],
      flagExplanations: item.flags.map((flag) => FLAG_EXPLANATIONS[flag as keyof typeof FLAG_EXPLANATIONS] ?? null).filter(Boolean),
      record: job?.recordMeta ?? null,
      draft: draft
        ? {
            id: draft.id,
            status: draft.status,
            name: draft.page.name,
            parentId: draft.page.parentId,
            errors: errors.length,
            warnings: warnings.length,
            missingRequired: errors.filter((f) => f.code === 'REQUIRED_FIELD_MISSING').length,
            mode: draft.page.processing?.mode ?? null,
          }
        : null,
      matchBlocker: recipe ? matchBlocker(recipe.definition, item) : null,
    }
  })

  const counts = ctx.repos.batchItems.counts(batchId)
  const records = rows.filter((r) => !r.flags.includes('preamble'))
  const active = records.filter((r) => r.status !== 'skipped' && r.status !== 'cancelled')
  const tokens = {
    input: items.reduce((n, i) => n + (i.inputTokens ?? 0), 0) + sources.reduce((n, s) => n + (s.inputTokens ?? 0), 0),
    output: items.reduce((n, i) => n + (i.outputTokens ?? 0), 0) + sources.reduce((n, s) => n + (s.outputTokens ?? 0), 0),
  }
  const model = ctx.config().ai.model
  return {
    batch: { ...batch, options: { ...options, lastDryRun: undefined } },
    phase: runningPhase(batchId),
    recipe: recipe ? { id: recipe.id, name: recipe.definition.name, version: recipe.version, latestVersion: recipe.latestVersion, pageType: recipe.definition.targetPageType, duplicatePolicy: recipe.definition.duplicatePolicy, allowCreate: recipe.definition.allowCreate, rules: rulesFor(ctx, batch), defaultParentId: recipe.definition.defaultParentId } : null,
    template: batch.templateId ? (ctx.repos.templates.get(batch.templateId)?.definition.name ?? null) : null,
    sources,
    items: rows,
    overview: {
      inputFiles: sources.length,
      failedFiles: sources.filter((s) => s.status === 'failed').length,
      needsTranscription: sources.filter((s) => s.status === 'needs_transcription').length,
      records: records.length,
      validDrafts: active.filter((r) => r.draft && r.draft.errors === 0).length,
      needsReview: counts.awaiting_review,
      possibleDuplicates: active.filter((r) => r.flags.includes('possible_duplicate') || r.flags.includes('duplicate_in_batch')).length,
      missingRequired: active.filter((r) => (r.draft?.missingRequired ?? 0) > 0).length,
      approved: counts.approved,
      succeeded: counts.succeeded,
      failedOrUnresolved: counts.failed + counts.needs_reconciliation,
      skipped: counts.skipped,
      pending: counts.pending + counts.processing,
      counts,
    },
    usage: { ...tokens, model, estimatedCostUsd: estimateCostUsd(model, tokens.input, tokens.output), pricesAsOf: PRICES_AS_OF },
    hasDryRun: options.lastDryRun !== undefined && options.lastDryRun !== null,
  }
}

/** The end-of-job summary: what was processed, what worked, what is left. */
export function jobSummary(counts: Record<BatchItemStatus, number>) {
  const total = Object.values(counts).reduce((a, b) => a + b, 0)
  return {
    total,
    succeeded: counts.succeeded,
    failed: counts.failed + counts.needs_reconciliation,
    skipped: counts.skipped + counts.cancelled,
    needsReview: counts.awaiting_review + counts.needs_reconciliation,
    remaining: counts.pending + counts.processing + counts.awaiting_review + counts.approved + counts.running,
  }
}

export function listBatches(ctx: AppContext, kind: 'import' | 'tagging' | 'migration' | null, page = 1, pageSize = 25) {
  const size = Math.min(Math.max(pageSize, 1), 100)
  const result = ctx.repos.batches.list(kind, size, (Math.max(page, 1) - 1) * size)
  return {
    total: result.total,
    items: result.items.map((batch) => {
      const counts = ctx.repos.batchItems.counts(batch.id)
      const recipe = batch.recipeId ? ctx.repos.recipes.get(batch.recipeId) : null
      return {
        ...batch,
        options: undefined,
        phase: runningPhase(batch.id),
        counts,
        summary: jobSummary(counts),
        recipeName: recipe?.definition.name ?? null,
        models: (batch.options as { models?: string[] }).models ?? [],
        files: ctx.repos.batchSources.list(batch.id).length,
      }
    }),
  }
}

/** One row per job (all kinds): the operation history as CSV or JSON. Contains no credentials. */
export function exportHistory(ctx: AppContext, format: 'json' | 'csv') {
  const rows: ExportRow[] = []
  for (let page = 1; ; page++) {
    const { items } = listBatches(ctx, null, page, 100)
    for (const b of items) {
      rows.push({
        job_id: b.id,
        kind: b.kind,
        name: b.name,
        status: b.status,
        recipe: b.recipeName,
        recipe_version: b.recipeVersion,
        ai_models: b.models.join('; '),
        created: b.createdAt,
        started: b.startedAt,
        finished: b.finishedAt,
        items: b.summary.total,
        succeeded: b.summary.succeeded,
        failed_or_unresolved: b.summary.failed,
        skipped: b.summary.skipped,
        needs_review: b.summary.needsReview,
        remaining: b.summary.remaining,
        error: b.error,
      })
    }
    if (items.length < 100) break
  }
  const secrets = configuredSecrets()
  const stamp = ctx.now().toISOString().slice(0, 10)
  return format === 'json'
    ? { fileName: `lk-companion-jobs-${stamp}.json`, contentType: 'application/json', body: JSON.stringify(redactSecrets(rows, secrets), null, 2) }
    : { fileName: `lk-companion-jobs-${stamp}.csv`, contentType: 'text/csv', body: toCsv(redactSecrets(rows, secrets) as ExportRow[]) }
}

type ExportRow = Record<string, string | number | null>

/** Results or the last dry run, as JSON or CSV. Contains no credentials; scrubbed of secrets regardless. */
export function exportBatch(ctx: AppContext, batchId: string, input: { report: 'results' | 'dry_run'; format: 'json' | 'csv' }) {
  const batch = getBatch(ctx, batchId)
  const view = batchView(ctx, batchId)
  const safeName = batch.name.replace(/[^A-Za-z0-9._-]+/g, '-').slice(0, 60) || 'batch'
  let rows: ExportRow[]
  let document: unknown
  if (input.report === 'dry_run') {
    const report = optionsOf(batch).lastDryRun as { entries?: PlanEntry[] } | undefined
    if (!report) throw new ServiceError(404, 'No dry run has been made for this batch yet.')
    document = report
    rows = (report.entries ?? []).map((e) => ({
      seq: e.seq + 1,
      title: e.title,
      operation: e.operation,
      can_proceed: e.canProceed ? 'yes' : 'no',
      page_name: e.name,
      parent: e.parentName ?? e.parentId,
      tags: e.tags.join('; '),
      links: e.links,
      match: e.matchCategory,
      decision: e.decision,
      problems: e.problems.join(' | '),
      warnings: e.warnings.join(' | '),
    }))
  } else {
    document = { kind: 'results', batch: view.batch, recipe: view.recipe, overview: view.overview, usage: view.usage, sources: view.sources.map(({ preview: _p, ...s }) => s), items: view.items }
    rows = view.items.map((item) => ({
      seq: item.seq + 1,
      title: item.title,
      status: item.status,
      file: item.record?.fileName ?? null,
      section: item.record?.section ?? null,
      source_page: item.record?.page ?? null,
      page_name: item.draft?.name ?? null,
      match: (item.match as MatchResult | null)?.category ?? null,
      decision: item.decision,
      resource_id: item.resourceId,
      errors: item.draft?.errors ?? null,
      warnings: item.draft?.warnings ?? null,
      error: item.error,
    }))
  }
  const secrets = configuredSecrets()
  if (input.format === 'json') {
    return { fileName: `${safeName}-${input.report}.json`, contentType: 'application/json', body: JSON.stringify(redactSecrets(document, secrets), null, 2) }
  }
  return { fileName: `${safeName}-${input.report}.csv`, contentType: 'text/csv', body: toCsv(redactSecrets(rows, secrets) as ExportRow[]) }
}

export function toCsv(rows: ExportRow[]): string {
  if (rows.length === 0) return ''
  const headers = Object.keys(rows[0]!)
  const cell = (value: unknown) => {
    const text = value === null || value === undefined ? '' : String(value)
    // Quote everything that needs it; neutralise spreadsheet formulas.
    const safe = /^[=+\-@\t\r]/.test(text) ? `'${text}` : text
    return /[",\n\r]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe
  }
  return [headers.join(','), ...rows.map((row) => headers.map((h) => cell(row[h])).join(','))].join('\r\n') + '\r\n'
}

/** Updates batch settings that are safe to change while drafting (limits, attribution). */
export function updateBatchOptions(ctx: AppContext, batchId: string, input: unknown) {
  const batch = requireImportBatch(ctx, batchId)
  requireOpen(batch)
  const parsed = z
    .object({ name: z.string().trim().min(1).max(200).optional(), aiItemLimit: z.number().int().min(1).max(500).optional(), maxRecords: z.number().int().min(1).max(2000).optional(), useLatestRecipe: z.boolean().optional(), templateId: z.string().nullable().optional() })
    .safeParse(input)
  if (!parsed.success) throw new ServiceError(400, 'The settings are not valid.', parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`))
  const patch: Parameters<typeof ctx.repos.batches.update>[1] = { options: { ...optionsOf(batch), ...(parsed.data.aiItemLimit ? { aiItemLimit: parsed.data.aiItemLimit } : {}), ...(parsed.data.maxRecords ? { maxRecords: parsed.data.maxRecords } : {}) } }
  if (parsed.data.name) patch.name = parsed.data.name
  const items = ctx.repos.batchItems.list(batchId)
  const drafted = items.some((i) => i.jobId && ctx.repos.drafts.getByJob(i.jobId))
  if (parsed.data.useLatestRecipe) {
    // Switching the recipe version is only allowed before any draft exists, so a batch never mixes rules.
    if (drafted) throw new ServiceError(409, 'Drafts already exist with the current recipe version. Start a new batch to use the newer version.')
    patch.recipeVersion = ctx.repos.recipes.get(batch.recipeId!)?.version ?? batch.recipeVersion
  }
  if (parsed.data.templateId !== undefined) {
    if (drafted) throw new ServiceError(409, 'Drafts already exist. Change the template per record on its review page instead.')
    patch.templateId = parsed.data.templateId
  }
  ctx.repos.batches.update(batchId, patch)
  return batchView(ctx, batchId)
}

export { getDraft }
