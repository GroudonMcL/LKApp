import 'server-only'
import { ExtractionError, extractSource, guessPageType, splitSource, type ExtractedFormat } from '@/core/extraction'
import { newAppId } from '@/core/ids'
import { allPageTypes } from '@/core/resolve'
import type { AppContext } from '../context'
import type { ImportJob } from '../db/repositories'
import { sha256Hex } from '../hash'
import { recordAudit } from './audit'
import { ServiceError } from './errors'

export interface CreateImportInput {
  bytes: Uint8Array
  fileName: string | null
  mimeType: string | null
  declaredFormat: ExtractedFormat | null
  sourceKind: 'upload' | 'paste'
  name: string | null
  attributionTitle: string | null
  citation: string | null
  recipeId: string | null
}

function customPageTypes(ctx: AppContext) {
  return ctx.repos.recipes
    .list()
    .map((recipe) => recipe.definition.customPageType)
    .filter((type): type is NonNullable<typeof type> => type !== null)
}

/**
 * Creates an import job from an upload or pasted text.
 *
 * The source is validated (type, size, encoding) and extracted. Its text is kept in the
 * database only while the job is open, so it can be reviewed side by side with the draft;
 * it is deleted when the job is completed or cancelled. The audit log records the size and
 * a SHA-256 hash, never the content.
 */
export function createImport(ctx: AppContext, input: CreateImportInput): ImportJob {
  const limits = ctx.config().limits
  let extracted
  try {
    extracted = extractSource(
      { bytes: input.bytes, fileName: input.fileName, mimeType: input.mimeType, declaredFormat: input.declaredFormat },
      { maxBytes: limits.maxUploadBytes, maxChars: limits.maxSourceChars },
    )
  } catch (error) {
    if (error instanceof ExtractionError) {
      recordAudit(ctx, { operation: 'import.create', outcome: 'blocked', errorCode: error.code, message: error.message, details: { bytes: input.bytes.byteLength, fileName: input.fileName } })
      throw new ServiceError(error.code === 'TOO_LARGE' ? 413 : 400, error.message, [], error.code)
    }
    throw error
  }

  if (input.recipeId && !ctx.repos.recipes.get(input.recipeId)) throw new ServiceError(400, 'The chosen recipe does not exist.')

  const id = newAppId('job')
  const at = ctx.now().toISOString()
  const name = (input.name?.trim() || extracted.title || input.fileName || 'Pasted text').slice(0, 200)
  const job = {
    id,
    name,
    status: 'extracted' as const,
    sourceName: input.fileName,
    sourceKind: input.sourceKind,
    sourceFormat: extracted.format,
    sourceSize: input.bytes.byteLength,
    sourceSha256: sha256Hex(input.bytes),
    sourceText: extracted.text,
    sourceJson: extracted.json,
    attribution: {
      title: (input.attributionTitle?.trim() || input.fileName || name).slice(0, 500),
      kind: input.sourceKind,
      citation: input.citation?.trim() ? input.citation.trim().slice(0, 1000) : null,
      jobId: id,
      importedAt: at,
    },
    recipeId: input.recipeId,
    pageTypeGuesses: guessPageType(extracted.text, allPageTypes(customPageTypes(ctx))).slice(0, 3),
    warnings: extracted.warnings,
  }
  ctx.repos.jobs.insert(job)
  recordAudit(ctx, {
    operation: 'import.create',
    outcome: 'success',
    jobId: id,
    recipeId: input.recipeId,
    message: name,
    details: { format: extracted.format, bytes: input.bytes.byteLength, chars: extracted.stats.chars, sha256: job.sourceSha256, kind: input.sourceKind },
  })
  return ctx.repos.jobs.get(id)!
}

/** Splits a source that is too long for one import into sections, without losing any text. */
export function previewSplit(ctx: AppContext, input: { bytes: Uint8Array }): { chunks: { index: number; heading: string; chars: number; text: string }[]; maxChars: number } {
  const limits = ctx.config().limits
  if (input.bytes.byteLength > limits.maxUploadBytes) {
    throw new ServiceError(413, `The source is larger than the ${limits.maxUploadBytes.toLocaleString('en-GB')} byte upload limit. Split the file before uploading.`)
  }
  let text: string
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(input.bytes).replace(/\r\n?/g, '\n')
  } catch {
    throw new ServiceError(400, 'The source is not valid UTF-8 text.')
  }
  return { chunks: splitSource(text, limits.maxSourceChars), maxChars: limits.maxSourceChars }
}

export function getImport(ctx: AppContext, id: string): ImportJob {
  const job = ctx.repos.jobs.get(id)
  if (!job) throw new ServiceError(404, 'Import job not found.')
  return job
}

export function listImports(ctx: AppContext, page: number, pageSize: number) {
  const size = Math.min(Math.max(pageSize, 1), 100)
  const result = ctx.repos.jobs.list(size, (Math.max(page, 1) - 1) * size)
  return {
    ...result,
    items: result.items.map((job) => {
      const draft = ctx.repos.drafts.getByJob(job.id)
      return { ...job, draft: draft ? { id: draft.id, status: draft.status, name: draft.page.name, createdResourceId: draft.createdResourceId } : null }
    }),
  }
}

/** Cancels an import: the draft is closed and the stored source text is deleted. Nothing is written to LegendKeeper. */
export function cancelImport(ctx: AppContext, id: string) {
  const job = getImport(ctx, id)
  const draft = ctx.repos.drafts.getByJob(id)
  if (draft && ['writing', 'write_uncertain'].includes(draft.status)) {
    throw new ServiceError(409, 'A write for this draft is in progress or its outcome is unknown. Check the outcome first.')
  }
  if (job.status === 'completed') throw new ServiceError(409, 'This import is already completed.')
  if (draft && draft.status !== 'created') ctx.repos.drafts.setStatus(draft.id, 'cancelled')
  ctx.repos.jobs.update(id, { status: 'cancelled' })
  ctx.repos.jobs.purgeSource(id)
  recordAudit(ctx, { operation: 'import.cancel', outcome: 'success', jobId: id, draftId: draft?.id ?? null })
}

export function renameImport(ctx: AppContext, id: string, patch: { name?: string; attributionTitle?: string; citation?: string | null; recipeId?: string | null }) {
  const job = getImport(ctx, id)
  if (patch.recipeId && !ctx.repos.recipes.get(patch.recipeId)) throw new ServiceError(400, 'The chosen recipe does not exist.')
  ctx.repos.jobs.update(id, {
    name: patch.name?.trim() ? patch.name.trim().slice(0, 200) : undefined,
    recipeId: patch.recipeId,
    attribution: {
      ...job.attribution,
      title: patch.attributionTitle?.trim() ? patch.attributionTitle.trim().slice(0, 500) : job.attribution.title,
      citation: patch.citation === undefined ? job.attribution.citation : patch.citation?.trim() || null,
    },
  })
  return getImport(ctx, id)
}
