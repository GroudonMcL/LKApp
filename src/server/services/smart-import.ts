import 'server-only'
import { z } from 'zod'
import { guessPageType } from '@/core/extraction'
import { newAppId } from '@/core/ids'
import { RecordRules, extractRecords } from '@/core/records'
import { resolvePageType } from '@/core/resolve'
import { applySort, linesText, numberLines, sortChunks, type Range, type SortResult } from '@/core/sorting'
import { SortSourceOutput, sortUserPrompt, type SortKind } from '../ai/prompts/sort'
import { ANALYSIS_TASKS } from '../ai/prompts/analysis'
import { AiError } from '../ai/provider'
import type { AppContext } from '../context'
import type { Batch, BatchSource } from '../db/batch-repositories'
import type { RecordMeta } from '../db/repositories'
import { sha256Hex, stableStringify } from '../hash'
import { recordAudit } from './audit'
import { cancelRequested, forEachLimited, noteModel, runningPhase, setPhase, startBatchWork } from './batch-engine'
import { activeDestinations, type Destination } from './destinations'
import { ServiceError } from './errors'
import { cancelImport } from './imports'
import { BatchOptions, addSources, batchView, draftItem, dryRunItems, getBatch, matchItems, transcribeSource, type BatchFileInput, type BatchPasteInput } from './import-batches'

/**
 * The import: files, pasted text or a saved web page in; pages of the right kinds out.
 *
 * 1. Sort (AI, one request per part of each source): the AI names, by line numbers only, each
 *    subject that deserves a page, the page kind (one per LegendKeeper template) and the clutter
 *    to leave out. The app cuts the source at those lines, so no text is reworded at this step,
 *    and lists anything left unplaced. Without AI: headings or statblocks split the source and
 *    keywords choose the kind.
 * 2. Draft each page with its kind's recipe (AI or structural), as a single import does.
 * 3. Check each draft against existing pages and the other drafts, and run every check of the
 *    final preview (a dry run: reads only).
 * 4. You look at the result and choose which pages to create; nothing is written before that.
 *
 * Every step runs in the background; progress is shown while it runs. The source is sent to the
 * AI only in AI mode, and only to the configured (free) model.
 */

/** Characters of numbered source lines per sorting request. */
export const SORT_CHUNK_CHARS = 60_000
/** Pages drafted with AI in one go (free models allow a limited number of requests a day). */
export const SMART_AI_ITEM_LIMIT = 40

export const SmartState = z.object({
  mode: z.enum(['ai', 'rules']).default('ai'),
  stage: z.enum(['new', 'sorted', 'drafted', 'checked']).default('new'),
  destinations: z.array(z.object({ key: z.string(), label: z.string(), recipeId: z.string() })).default([]),
  sources: z
    .array(
      z.object({
        sourceId: z.string(),
        discarded: z.array(z.object({ from: z.number(), to: z.number(), why: z.string(), preview: z.string() })).default([]),
        unplaced: z.array(z.object({ from: z.number(), to: z.number(), preview: z.string() })).default([]),
        notes: z.array(z.string()).default([]),
        requests: z.number().default(0),
      }),
    )
    .default([]),
  notes: z.array(z.string()).default([]),
  deferred: z.number().default(0),
})
export type SmartState = z.infer<typeof SmartState>

function stateOf(batch: Batch): SmartState {
  return SmartState.parse(BatchOptions.parse(batch.options ?? {}).smart ?? {})
}

function saveState(ctx: AppContext, batchId: string, state: SmartState) {
  const batch = getBatch(ctx, batchId)
  ctx.repos.batches.update(batchId, { options: { ...BatchOptions.parse(batch.options ?? {}), smart: state } })
}

function requireSmart(ctx: AppContext, batchId: string): Batch {
  const batch = getBatch(ctx, batchId)
  if (batch.kind !== 'import' || batch.recipeId || !BatchOptions.parse(batch.options ?? {}).smart) throw new ServiceError(400, 'This is not a sorted import.')
  return batch
}

function requireOpenIdle(batch: Batch) {
  if (batch.status === 'completed' || batch.status === 'cancelled') throw new ServiceError(409, `This import is ${batch.status}.`)
  const phase = runningPhase(batch.id)
  if (phase) throw new ServiceError(409, `This import is busy (${phase}). Wait for it to finish, or stop it.`)
}

export const CreateSmartImportInput = z.object({
  name: z.string().trim().max(200).optional(),
  mode: z.enum(['ai', 'rules']).default('ai'),
  parentId: z.string().trim().max(256).nullable().optional(),
  attributionTitle: z.string().max(500).nullable().optional(),
  citation: z.string().max(1000).nullable().optional(),
  /** Start sorting and drafting straight away (default). */
  start: z.boolean().default(true),
})

export async function createSmartImport(ctx: AppContext, input: z.input<typeof CreateSmartImportInput> & { files: BatchFileInput[]; pastes: BatchPasteInput[] }) {
  const parsed = CreateSmartImportInput.parse(input)
  if (parsed.start && input.files.length + input.pastes.length === 0) throw new ServiceError(400, 'Add a file, a saved web page or some text.')
  if (input.files.length + input.pastes.length > 100) throw new ServiceError(400, 'An import takes at most 100 files.')
  const destinations = activeDestinations(ctx)
  if (!destinations.length) throw new ServiceError(409, 'There are no page kinds to import into. Set them up from your LegendKeeper templates first.')
  const id = newAppId('bat')
  const name = (parsed.name || input.files[0]?.fileName || input.pastes[0]?.name || 'Import').slice(0, 200)
  ctx.repos.batches.insert({
    id,
    kind: 'import',
    name,
    recipeId: null,
    recipeVersion: null,
    templateId: null,
    options: BatchOptions.parse({
      attributionTitle: parsed.attributionTitle?.trim() || null,
      citation: parsed.citation?.trim() || null,
      parentId: parsed.parentId?.trim() || null,
      aiItemLimit: SMART_AI_ITEM_LIMIT,
      smart: SmartState.parse({ mode: parsed.mode, destinations: destinations.map((d) => ({ key: d.key, label: d.label, recipeId: d.recipeId })) }),
    }),
  })
  await addSources(ctx, getBatch(ctx, id), null, input.files, input.pastes)
  recordAudit(ctx, { operation: 'import.smart.create', outcome: 'success', message: `${name}: ${input.files.length} file(s), ${input.pastes.length} pasted text(s)`, details: { batchId: id, mode: parsed.mode } })
  if (parsed.start) await startSmartImport(ctx, id, { mode: parsed.mode })
  return smartView(ctx, id)
}

/** Sorts every source again (replacing records not yet approved or written), then drafts and checks. */
export async function startSmartImport(ctx: AppContext, batchId: string, input: { mode?: 'ai' | 'rules'; wait?: boolean } = {}) {
  const batch = requireSmart(ctx, batchId)
  requireOpenIdle(batch)
  const items = ctx.repos.batchItems.list(batchId)
  if (items.some((item) => ['approved', 'running', 'succeeded', 'needs_reconciliation'].includes(item.status))) {
    throw new ServiceError(409, 'Some pages of this import were already approved or created, so it cannot be sorted again. Start a new import for the rest.')
  }
  const state = stateOf(batch)
  const mode = input.mode ?? state.mode
  await startBatchWork(ctx, batchId, 'sorting', { status: 'processing', wait: input.wait }, async () => {
    const destinations = activeDestinations(ctx)
    const next: SmartState = { ...state, mode, stage: 'new', destinations: destinations.map((d) => ({ key: d.key, label: d.label, recipeId: d.recipeId })), sources: [], notes: [], deferred: 0 }

    // Images and scans are read by the AI first (AI mode only).
    if (mode === 'ai') {
      for (const source of ctx.repos.batchSources.list(batchId).filter((s) => s.status === 'needs_transcription')) {
        setPhase(batchId, `reading ${source.fileName ?? 'a file'}`)
        try {
          await transcribeSource(ctx, batchId, source.id)
        } catch (error) {
          next.notes.push(`${source.fileName ?? 'A file'} could not be read: ${(error as Error).message}`)
        }
      }
    }

    // Earlier records that were never approved are replaced.
    for (const item of items) {
      if (item.jobId) {
        const job = ctx.repos.jobs.get(item.jobId)
        if (job && job.status !== 'cancelled' && job.status !== 'completed') cancelImport(ctx, item.jobId)
      }
    }
    ctx.repos.batchItems.deleteMany(items.map((i) => i.id))

    const sources = ctx.repos.batchSources.list(batchId).filter((s) => s.status === 'extracted' && s.text !== null)
    if (!sources.length) throw new Error('No file has readable text.')
    let seq = 1
    for (const [index, source] of sources.entries()) {
      if (cancelRequested(ctx, batchId)) return
      setPhase(batchId, `sorting ${sources.length > 1 ? `file ${index + 1} of ${sources.length}` : ''}`.trim())
      const sorted = mode === 'ai' ? await sortWithAi(ctx, batchId, source, destinations) : { result: sortWithRules(ctx, source, destinations), requests: 0 }
      next.sources.push({ sourceId: source.id, discarded: sorted.result.discarded, unplaced: sorted.result.unplaced, notes: sorted.result.notes, requests: sorted.requests })
      for (const [i, entry] of sorted.result.entries.entries()) {
        const destination = destinations.find((d) => d.key === entry.destination) ?? null
        addRecord(ctx, getBatch(ctx, batchId), source, { title: entry.title, text: entry.text, destination, ranges: entry.ranges, why: entry.why, confidence: entry.confidence, index: i, overlapsWith: entry.overlapsWith }, seq++)
      }
      ctx.repos.batchSources.update(source.id, { recordCount: sorted.result.entries.length })
    }
    next.stage = 'sorted'
    saveState(ctx, batchId, next)
    recordAudit(ctx, {
      operation: 'import.smart.sort',
      outcome: 'success',
      message: `${seq - 1} page(s) found in ${sources.length} file(s) (${mode === 'ai' ? 'AI' : 'without AI'})`,
      details: { batchId, discarded: next.sources.reduce((n, s) => n + s.discarded.length, 0), unplaced: next.sources.reduce((n, s) => n + s.unplaced.length, 0) },
    })
    await draftAndCheck(ctx, batchId, mode)
  })
  return smartView(ctx, batchId)
}

/** Drafts the records still waiting for a draft, then checks them (after a page kind was changed, or the AI limit was reached). */
export async function continueSmartImport(ctx: AppContext, batchId: string, input: { mode?: 'ai' | 'rules'; wait?: boolean } = {}) {
  const batch = requireSmart(ctx, batchId)
  requireOpenIdle(batch)
  const mode = input.mode ?? stateOf(batch).mode
  await startBatchWork(ctx, batchId, 'drafting', { status: 'processing', wait: input.wait }, async () => {
    await draftAndCheck(ctx, batchId, mode)
  })
  return smartView(ctx, batchId)
}

async function draftAndCheck(ctx: AppContext, batchId: string, mode: 'ai' | 'rules') {
  const batch = getBatch(ctx, batchId)
  let pending = ctx.repos.batchItems.list(batchId, { status: ['pending', 'failed'] }).filter((item) => item.jobId && (item.result as { stage?: string } | null)?.stage !== 'write')
  let deferred = 0
  if (mode === 'ai') {
    noteModel(ctx, batchId, ctx.ai().model)
    const limit = BatchOptions.parse(batch.options ?? {}).aiItemLimit
    if (pending.length > limit) {
      deferred = pending.length - limit
      pending = pending.slice(0, limit)
    }
  }
  let done = 0
  await forEachLimited(pending, mode === 'ai' ? 2 : 4, () => cancelRequested(ctx, batchId), async (item) => {
    setPhase(batchId, `drafting ${done + 1} of ${pending.length}`)
    await draftItem(ctx, batch, item, mode === 'ai' ? 'ai' : 'structural')
    done++
  })
  matchItems(ctx, batchId)
  saveState(ctx, batchId, { ...stateOf(getBatch(ctx, batchId)), stage: 'drafted', deferred })

  // Every check of the final preview, for every drafted page (reads only).
  const drafted = ctx.repos.batchItems.list(batchId, { status: ['awaiting_review'] })
  if (drafted.length && !cancelRequested(ctx, batchId)) {
    setPhase(batchId, 'checking against LegendKeeper')
    try {
      await dryRunItems(ctx, getBatch(ctx, batchId), drafted)
      saveState(ctx, batchId, { ...stateOf(getBatch(ctx, batchId)), stage: 'checked' })
    } catch (error) {
      const state = stateOf(getBatch(ctx, batchId))
      saveState(ctx, batchId, { ...state, notes: [...state.notes, `The pages could not be checked against LegendKeeper: ${(error as Error).message}`] })
    }
  }
}

async function sortWithAi(ctx: AppContext, batchId: string, source: BatchSource, destinations: Destination[]): Promise<{ result: SortResult; requests: number }> {
  const provider = ctx.ai()
  noteModel(ctx, batchId, provider.model)
  const lines = numberLines(source.text!)
  const kinds: SortKind[] = destinations.map((d, i) => ({ code: `k${i + 1}`, label: d.label, pageType: d.pageTypeLabel, fields: d.fields, sections: d.sections }))
  const codes = new Map(kinds.map((kind, i) => [kind.code, destinations[i]!.key]))
  const chunks = sortChunks(lines, SORT_CHUNK_CHARS)
  const parts: SortSourceOutput[] = []
  let requests = 0
  for (const [i, chunk] of chunks.entries()) {
    if (chunks.length > 1) setPhase(batchId, `sorting part ${i + 1} of ${chunks.length}`)
    const user = sortUserPrompt({ sourceName: source.title ?? source.fileName ?? 'Source', kinds, lines: chunk, part: chunks.length > 1 ? { index: i + 1, of: chunks.length } : undefined })
    // The same request (same text, same kinds, same prompt and model) is answered from the cache.
    const key = sha256Hex(stableStringify({ kind: 'sort', version: ANALYSIS_TASKS.sort_source.version, model: provider.model, user: sha256Hex(user) }))
    const cached = ctx.repos.aiCache.get(key)
    const parsed = cached ? SortSourceOutput.safeParse(cached.output) : null
    if (parsed?.success) {
      parts.push(parsed.data)
      continue
    }
    try {
      const response = await provider.analyse('sort_source', user)
      requests++
      ctx.repos.aiCache.set(key, 'sort', response.output, response.servedByModel, response.inputTokens, response.outputTokens)
      const totals = ctx.repos.batchSources.get(source.id)
      ctx.repos.batchSources.update(source.id, { inputTokens: (totals?.inputTokens ?? 0) + (response.inputTokens ?? 0), outputTokens: (totals?.outputTokens ?? 0) + (response.outputTokens ?? 0) })
      parts.push(response.output)
    } catch (error) {
      if (error instanceof AiError) throw new Error(error.message)
      throw error
    }
  }
  const result = applySort(lines, parts.map((p) => ({ entries: p.entries, discarded: p.discarded })), codes)
  const suspected = parts.flatMap((p) => p.suspectedInstructions)
  if (suspected.length) result.notes.push(`The source contained text that reads like instructions to an AI; it was treated as data: ${suspected.slice(0, 5).map((s) => `“${s.slice(0, 120)}”`).join('; ')}`)
  return { result, requests }
}

/** Without AI: split by headings or statblocks; the page kind from keywords. */
export function sortWithRules(ctx: AppContext, source: BatchSource, destinations: Destination[]): SortResult {
  const text = source.text!
  const lines = numberLines(text)
  const levels = [1, 2, 3].map((level) => ({ level, count: lines.filter((l) => new RegExp(`^#{${level}}\\s`).test(l.text)).length }))
  const statblocks = (text.match(/^.+\n(?:Tiny|Small|Medium|Large|Huge|Gargantuan)\b[^\n]*,[^\n]*$/gim) ?? []).length
  const heading = levels.find((l) => l.count >= 2)
  const rules = RecordRules.parse(statblocks >= 2 ? { mode: 'statblock' } : heading ? { mode: 'heading', headingLevel: heading.level } : { mode: 'whole' })
  const records = extractRecords({ text, json: source.json, format: source.format, title: source.title, pages: source.pages }, rules, { maxChars: ctx.config().limits.maxSourceChars })
  const types = destinations.map((d) => resolvePageType(ctx.repos.recipes.get(d.recipeId)!.definition)).filter((t): t is NonNullable<typeof t> => t !== null)
  return {
    entries: records
      .filter((record) => !record.flags.includes('preamble') && record.text.trim())
      .map((record) => {
        const guess = guessPageType(record.text, types)[0]
        const destination = guess ? destinations.find((d) => d.pageType === guess.pageType) ?? null : null
        return { title: record.title, destination: destination?.key ?? destinations[0]?.key ?? null, ranges: [], text: record.text, confidence: 'low' as const, why: guess ? `Words that suggest ${destinations.find((d) => d.pageType === guess.pageType)?.pageTypeLabel ?? guess.pageType}.` : 'No clear signs; the first page kind was used.', overlapsWith: [] }
      }),
    discarded: [],
    unplaced: [],
    notes: [`Sorted without AI (${rules.mode === 'whole' ? 'the whole source as one page' : rules.mode === 'statblock' ? 'one page per statblock' : `one page per level-${rules.headingLevel} heading`}). Check the page kinds.`],
  }
}

function addRecord(
  ctx: AppContext,
  batch: Batch,
  source: BatchSource,
  entry: { title: string; text: string; destination: Destination | null; ranges: Range[]; why: string; confidence: 'high' | 'medium' | 'low'; index: number; overlapsWith: string[] },
  seq: number,
) {
  const options = BatchOptions.parse(batch.options ?? {})
  const jobId = newAppId('job')
  const flags = [...(entry.confidence === 'low' ? ['low_confidence'] : []), ...(entry.overlapsWith.length ? ['overlaps'] : [])]
  const meta: RecordMeta & { ranges: Range[]; why: string; confidence: string; overlapsWith: string[] } = {
    sourceId: source.id,
    fileName: source.fileName,
    documentTitle: source.title,
    section: null,
    page: null,
    sourceRecordId: null,
    index: entry.index,
    flags,
    ranges: entry.ranges,
    why: entry.why,
    confidence: entry.confidence,
    overlapsWith: entry.overlapsWith,
  }
  ctx.repos.jobs.insert({
    id: jobId,
    name: entry.title.slice(0, 200),
    status: 'extracted',
    sourceName: source.fileName ?? source.title,
    sourceKind: source.fileName ? 'upload' : 'paste',
    sourceFormat: source.format === 'json' ? 'text' : source.format,
    sourceSize: new TextEncoder().encode(entry.text).byteLength,
    sourceSha256: sha256Hex(entry.text),
    sourceText: entry.text,
    sourceJson: undefined,
    attribution: {
      title: (options.attributionTitle || source.title || source.fileName || batch.name).slice(0, 500),
      kind: source.fileName ? 'upload' : 'paste',
      citation: options.citation,
      jobId,
      importedAt: ctx.now().toISOString(),
    },
    recipeId: entry.destination?.recipeId ?? null,
    pageTypeGuesses: [],
    warnings: [],
    batchId: batch.id,
    recordMeta: meta,
  })
  ctx.repos.batchItems.insert({
    id: newAppId('itm'),
    batchId: batch.id,
    seq,
    kind: 'create_page',
    // A part no page kind fits waits for you to choose one.
    status: entry.destination ? 'pending' : 'skipped',
    title: entry.title,
    sourceId: source.id,
    jobId,
    resourceId: null,
    flags,
  })
}

/** Chooses (or changes) the page kind of a record; it is drafted again with the next "Draft". */
export function setRecordDestination(ctx: AppContext, batchId: string, itemId: string, key: string | null) {
  const batch = requireSmart(ctx, batchId)
  requireOpenIdle(batch)
  const item = ctx.repos.batchItems.get(itemId)
  if (!item || item.batchId !== batchId || !item.jobId) throw new ServiceError(404, 'Page not found in this import.')
  if (!['pending', 'awaiting_review', 'failed', 'skipped'].includes(item.status)) throw new ServiceError(409, 'This page was already approved or created.')
  const destination = key ? activeDestinations(ctx).find((d) => d.key === key) : null
  if (key && !destination) throw new ServiceError(400, 'That page kind does not exist.')
  ctx.repos.jobs.update(item.jobId, { recipeId: destination?.recipeId ?? null })
  ctx.repos.batchItems.update(itemId, { status: destination ? 'pending' : 'skipped', decision: null, error: null, match: null })
  return smartView(ctx, batchId)
}

/** Makes a page from lines the sorting left unplaced (or discarded). */
export function addRecordFromLines(ctx: AppContext, batchId: string, input: { sourceId: string; from: number; to: number; title: string; key: string }) {
  const batch = requireSmart(ctx, batchId)
  requireOpenIdle(batch)
  const source = ctx.repos.batchSources.get(input.sourceId)
  if (!source || source.batchId !== batchId || source.text === null) throw new ServiceError(404, 'Source not found.')
  const destination = activeDestinations(ctx).find((d) => d.key === input.key)
  if (!destination) throw new ServiceError(400, 'Choose a page kind.')
  const lines = numberLines(source.text)
  const text = linesText(lines, [{ from: input.from, to: input.to }])
  if (!text) throw new ServiceError(400, 'Those lines are empty.')
  const seq = ctx.repos.batchItems.maxSeq(batchId) + 1
  addRecord(ctx, batch, source, { title: input.title.trim() || 'Untitled', text, destination, ranges: [{ from: input.from, to: input.to }], why: 'Added by you.', confidence: 'high', index: seq, overlapsWith: [] }, seq)
  const state = stateOf(batch)
  state.sources = state.sources.map((s) => (s.sourceId === source.id ? { ...s, unplaced: s.unplaced.filter((u) => !(u.from >= input.from && u.to <= input.to)), discarded: s.discarded.filter((d) => !(d.from >= input.from && d.to <= input.to)) } : s))
  saveState(ctx, batchId, state)
  return smartView(ctx, batchId)
}

interface DryRunEntry {
  itemId: string
  name: string | null
  parentName: string | null
  tags: string[]
  links: number
  warnings: string[]
  problems: string[]
  canProceed: boolean
}

/** Everything the import screen shows, page by page. */
export function smartView(ctx: AppContext, batchId: string) {
  const batch = requireSmart(ctx, batchId)
  const view = batchView(ctx, batchId)
  const state = stateOf(batch)
  const dryRun = (BatchOptions.parse(batch.options ?? {}).lastDryRun ?? null) as { at: string; entries: DryRunEntry[]; keyRole: string } | null
  const checks = new Map((dryRun?.entries ?? []).map((entry) => [entry.itemId, entry]))
  const destinations = activeDestinations(ctx)
  const byRecipe = new Map(destinations.map((d) => [d.recipeId, d]))
  const pages = view.items.map((item) => {
    const job = item.jobId ? ctx.repos.jobs.get(item.jobId) : null
    const meta = (job?.recordMeta ?? null) as (RecordMeta & { why?: string; confidence?: string; ranges?: Range[]; overlapsWith?: string[] }) | null
    const check = checks.get(item.id)
    const fresh = check && item.draft && item.status === 'awaiting_review'
    const destination = job?.recipeId ? byRecipe.get(job.recipeId) ?? null : null
    const problems = [...(item.matchBlocker ? [item.matchBlocker] : []), ...(fresh ? check.problems.filter((p) => p !== item.matchBlocker) : []), ...(item.status === 'failed' && item.error ? [item.error] : [])]
    const warnings = fresh ? check.warnings : []
    return {
      id: item.id,
      title: item.draft?.name ?? item.title,
      status: item.status,
      statusExplanation: item.statusExplanation,
      destination: destination ? { key: destination.key, label: destination.label } : job?.recipeId ? { key: null, label: ctx.repos.recipes.get(job.recipeId)?.definition.name ?? 'Unknown' } : null,
      draftId: item.draft?.id ?? null,
      resourceId: item.resourceId,
      why: meta?.why ?? null,
      confidence: meta?.confidence ?? null,
      overlapsWith: meta?.overlapsWith ?? [],
      sourceId: item.sourceId,
      ranges: meta?.ranges ?? [],
      chars: job?.sourceSize ?? null,
      parentName: fresh ? check.parentName : null,
      tags: fresh ? check.tags : [],
      links: fresh ? check.links : 0,
      warnings,
      problems,
      match: item.match,
      checked: Boolean(fresh),
      ready: Boolean(fresh && check.canProceed && !item.matchBlocker),
      error: item.error,
    }
  })
  return {
    batch: { id: batch.id, name: batch.name, status: batch.status, createdAt: batch.createdAt, error: batch.error, parentId: BatchOptions.parse(batch.options ?? {}).parentId },
    phase: view.phase,
    state: { ...state, sources: state.sources.map((s) => ({ ...s, name: view.sources.find((src) => src.id === s.sourceId)?.fileName ?? view.sources.find((src) => src.id === s.sourceId)?.title ?? 'Pasted text' })) },
    sources: view.sources.map((s) => ({ id: s.id, name: s.fileName ?? s.title ?? 'Pasted text', status: s.status, chars: s.chars, method: s.method, warnings: s.warnings, error: s.error, originalFormat: s.originalFormat })),
    pages,
    destinations: destinations.map((d) => ({ key: d.key, label: d.label, pageTypeLabel: d.pageTypeLabel })),
    totals: {
      pages: pages.filter((p) => p.status !== 'skipped' && p.status !== 'cancelled').length,
      ready: pages.filter((p) => p.ready).length,
      needsLook: pages.filter((p) => p.status === 'awaiting_review' && !p.ready).length,
      created: pages.filter((p) => p.status === 'succeeded').length,
      failed: pages.filter((p) => p.status === 'failed' || p.status === 'needs_reconciliation').length,
      waiting: pages.filter((p) => p.status === 'pending' || p.status === 'processing').length,
      noKind: pages.filter((p) => p.status === 'skipped' && !p.destination).length,
      discarded: state.sources.reduce((n, s) => n + s.discarded.length, 0),
      unplaced: state.sources.reduce((n, s) => n + s.unplaced.length, 0),
      aiRequests: state.sources.reduce((n, s) => n + s.requests, 0) + view.items.filter((i) => i.draft?.mode === 'ai').length,
    },
    checkedAt: dryRun?.at ?? null,
    keyRole: dryRun?.keyRole ?? null,
    usage: view.usage,
  }
}

export function listSmartImports(ctx: AppContext) {
  return ctx.repos.batches
    .list('import', 50, 0)
    .items.filter((batch) => !batch.recipeId && BatchOptions.parse(batch.options ?? {}).smart)
    .map((batch) => {
      const counts = ctx.repos.batchItems.counts(batch.id)
      return { id: batch.id, name: batch.name, status: batch.status, createdAt: batch.createdAt, phase: runningPhase(batch.id), created: counts.succeeded, toReview: counts.awaiting_review, total: Object.values(counts).reduce((a, b) => a + b, 0) - counts.cancelled }
    })
}

/** The source lines of one page, for "show the source". */
export function recordSource(ctx: AppContext, batchId: string, itemId: string) {
  requireSmart(ctx, batchId)
  const item = ctx.repos.batchItems.get(itemId)
  if (!item || item.batchId !== batchId) throw new ServiceError(404, 'Page not found in this import.')
  const job = item.jobId ? ctx.repos.jobs.get(item.jobId) : null
  return { title: item.title, text: job?.sourceText ?? null }
}

/** Lines of a source, for showing discarded or unplaced parts in full. */
export function sourceLines(ctx: AppContext, batchId: string, sourceId: string, range: Range) {
  requireSmart(ctx, batchId)
  const source = ctx.repos.batchSources.get(sourceId)
  if (!source || source.batchId !== batchId) throw new ServiceError(404, 'Source not found.')
  if (source.text === null) return { text: null }
  return { text: linesText(numberLines(source.text), [range]) }
}
