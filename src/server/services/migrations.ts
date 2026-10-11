import 'server-only'
import { h, links } from '@legendkeeper/sdk/blocks'
import { z } from 'zod'
import { newAppId } from '@/core/ids'
import { compareContent, formattingLost, mechanicsChanges, normalizeForCompare, type PageReading, type PreservedPart } from '@/core/migration-check'
import { PageReference, TagProposal, type CanonicalPage, type ValidationFinding } from '@/core/page-model'
import { estimateCostUsd, PRICES_AS_OF } from '@/core/pricing'
import type { RecipeDefinition } from '@/core/recipe'
import { resolvePageType, resolveTemplate } from '@/core/resolve'
import { configuredSecrets } from '../config'
import type { AppContext } from '../context'
import type { Batch, BatchItem } from '../db/batch-repositories'
import { ITEM_STATUS_EXPLANATIONS } from '../db/batch-repositories'
import type { PageTemplate } from '@/core/template'
import { sha256Hex, stableStringify } from '../hash'
import { toConnectorError } from '../lk/errors'
import { LOOSE_TEXT_HEADING, readPage } from '../lk/page-reader'
import { renderPageBlocks } from '../lk/render'
import { paragraphBlocks } from '../lk/render-text'
import { redactSecrets } from '../redact'
import { recordAudit } from './audit'
import { BATCH_TIMING, cancelRequested, noteModel, runningPhase, sleep, startBatchWork } from './batch-engine'
import { knownProjectId, requireProjectId } from './connection'
import { validateWithRender } from './drafts'
import { ServiceError } from './errors'
import { batchRecipe, toCsv } from './import-batches'
import { PageScope, resolvePageRefs, selectPages } from './page-scope'
import { runTransform } from './transform'

/**
 * Template migration: bring existing pages into a newer layout without losing information.
 *
 * For each page:
 * 1. Read its current content and metadata (read-only).
 * 2. Turn its readable text into Markdown; keep everything else (images, secrets, tables,
 *    embeds, unreadable blocks…) exactly as it is, to be sent back by id.
 * 3. Draft it with the chosen recipe and template, exactly like an import (structural, or AI
 *    told to reorganise, not rewrite). The draft can be corrected in the normal draft editor.
 * 4. Build the proposed page, then check it literally against the old one: every sentence,
 *    every number, every link. Old text that is missing goes into a notes section; links that
 *    would be lost are added as a link list; number changes must be acknowledged one by one.
 * 5. After approval, save the original in the recovery list, then replace the page content
 *    with a version check (`ifMatch`). The page keeps its id, name, parent, tags (unless the
 *    recipe adds tags), aliases and sidebar properties. Nothing is deleted or recreated.
 * 6. Restore writes the saved original back, only while the page is unchanged since the
 *    migration (or when you explicitly accept overwriting later edits).
 */

const MigrationInput = z.object({
  name: z.string().trim().min(1).max(200),
  recipeId: z.string().min(1),
  templateId: z.string().min(1).nullable().default(null),
  mode: z.enum(['structural', 'ai']).default('structural'),
  scope: PageScope,
  /** Page names, ids or links (used with scope mode `resources`). */
  pageRefs: z.array(z.string().max(500)).max(500).default([]),
})

export type TemplateKind = 'native' | 'example' | 'local' | 'default'

/** What kind of layout the target is, in plain words. Never claims a page "uses" a template. */
export function describeTemplate(record: PageTemplate | null): { kind: TemplateKind; name: string; explanation: string } {
  if (!record) return { kind: 'default', name: 'Built-in default layout', explanation: 'The app’s built-in layout for this page type.' }
  const layout = record.definition.lkLayout
  if (layout?.sourceKind === 'template') {
    return { kind: 'native', name: record.definition.name, explanation: `A copy of the LegendKeeper template “${layout.sourceName}”, read on ${layout.fetchedAt.slice(0, 10)}. Pages migrated to it get this layout; LegendKeeper does not record which template a page came from.` }
  }
  if (layout?.sourceKind === 'page') {
    return { kind: 'example', name: record.definition.name, explanation: `A layout copied from the example page “${layout.sourceName}” on ${layout.fetchedAt.slice(0, 10)}.` }
  }
  return { kind: 'local', name: record.definition.name, explanation: 'A layout defined in this app (sections and infobox fields), not copied from LegendKeeper.' }
}

interface MigrationOptions {
  mode: 'structural' | 'ai'
  scope: PageScope
  lastDryRun?: unknown
}

export interface MigrationPlan {
  version: 1
  resourceId: string
  documentId: string
  documentName: string
  sourceVersion: string
  pageName: string
  draftId: string
  draftRevision: number
  template: { id: string | null; kind: TemplateKind; name: string; explanation: string }
  before: OutlineEntry[]
  after: OutlineEntry[]
  sections: { added: string[]; removed: string[]; kept: string[] }
  fields: ReturnType<typeof compareContent>['fields']
  relocated: ReturnType<typeof compareContent>['relocated']
  unmapped: { text: string; section: string | null }[]
  reworded: ReturnType<typeof compareContent>['reworded']
  mechanics: ReturnType<typeof mechanicsChanges>
  links: { before: string[]; after: string[]; lost: string[]; addedBack: string[]; added: string[]; names: Record<string, string> }
  kept: { id: string | null; kind: string; label: string; placement: string }[]
  dropped: Record<string, number>
  formatting: { lost: string[] }
  metadata: { tagsBefore: string[]; tagsAfter: string[]; unchanged: string[] }
  findings: ValidationFinding[]
  /** Reasons approval is not possible yet. */
  blockers: string[]
  /** Acknowledgements approval needs (one per number change; one for reworded text). */
  acknowledgements: { id: string; label: string }[]
  originalBlocks: unknown[]
  proposedBlocks: unknown[]
  proposedHash: string
}

interface OutlineEntry {
  kind: string
  label: string
  kept: boolean
}

// ── Creating a migration job ──────────────────────────────────────────────────

function getMigration(ctx: AppContext, batchId: string): Batch {
  const batch = ctx.repos.batches.get(batchId)
  if (!batch || batch.kind !== 'migration') throw new ServiceError(404, 'Migration job not found.')
  return batch
}

function requireUsable(batch: Batch) {
  if (batch.status === 'completed' || batch.status === 'cancelled') throw new ServiceError(409, `This migration job is ${batch.status}.`)
  const phase = runningPhase(batch.id)
  if (phase) throw new ServiceError(409, `This job is busy (${phase}).`)
}

const optionsOf = (batch: Batch) => batch.options as unknown as MigrationOptions

export async function createMigration(ctx: AppContext, input: unknown) {
  const parsed = MigrationInput.safeParse(input)
  if (!parsed.success) throw new ServiceError(400, 'The migration is not valid.', parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`))
  const data = parsed.data
  const recipe = ctx.repos.recipes.get(data.recipeId)
  if (!recipe) throw new ServiceError(400, 'The chosen recipe does not exist.')
  const pageType = resolvePageType(recipe.definition)
  if (!pageType) throw new ServiceError(400, `The recipe’s page type “${recipe.definition.targetPageType}” is not defined.`)
  const templateId = data.templateId ?? recipe.definition.templateId
  const template = templateId ? ctx.repos.templates.get(templateId) : null
  if (templateId && !template) throw new ServiceError(400, 'The chosen target template does not exist.')
  if (template && template.definition.pageType !== pageType.id) {
    throw new ServiceError(400, `The template “${template.definition.name}” is for “${template.definition.pageType}” pages, but the recipe makes “${pageType.id}” pages. Choose a matching template or recipe.`)
  }
  if (template?.definition.lkLayout && template.definition.lkLayout.blocks.length === 0) throw new ServiceError(400, `The template “${template.definition.name}” has no layout blocks. Copy it from LegendKeeper again.`)
  if (data.mode === 'ai') {
    try {
      ctx.ai()
    } catch (error) {
      throw new ServiceError(400, (error as Error).message)
    }
  }
  const projectId = await requireProjectId(ctx)
  const pages = ctx.repos.index.forAudit(projectId)
  if (pages.length === 0) throw new ServiceError(409, 'Scan the project first (Page browser → Scan project).')
  const scope = data.scope.mode === 'resources' && data.pageRefs.length ? { ...data.scope, resourceIds: resolvePageRefs(pages, data.pageRefs) } : data.scope
  const selected = selectPages(pages, scope)
  if (selected.length === 0) throw new ServiceError(400, 'No pages match this selection.')

  const id = newAppId('bat')
  ctx.repos.batches.insert({ id, kind: 'migration', name: data.name, recipeId: recipe.id, recipeVersion: recipe.version, templateId: template?.id ?? null, options: { mode: data.mode, scope } })
  selected.forEach((page, seq) => {
    ctx.repos.batchItems.insert({ id: newAppId('itm'), batchId: id, seq, kind: 'migrate_page', status: 'pending', title: page.name, sourceId: null, jobId: null, resourceId: page.id, flags: [] })
  })
  ctx.repos.batches.update(id, { status: 'ready' })
  recordAudit(ctx, { operation: 'migration.create', outcome: 'success', projectId, recipeId: recipe.id, recipeVersion: recipe.version, message: `${data.name}: ${selected.length} page(s)`, details: { batchId: id, templateId: template?.id ?? null, mode: data.mode, scope } })
  return migrationView(ctx, id)
}

// ── Analysis: read, draft, compare (no writes) ────────────────────────────────

export async function analyseMigration(ctx: AppContext, batchId: string, input: { itemIds?: string[]; wait?: boolean } = {}) {
  const batch = getMigration(ctx, batchId)
  requireUsable(batch)
  const items = ctx.repos.batchItems.list(batchId, { status: ['pending', 'failed'] }).filter((i) => !input.itemIds || input.itemIds.includes(i.id))
  if (items.length === 0) throw new ServiceError(409, 'There are no pages waiting to be analysed.')
  const options = optionsOf(batch)
  if (options.mode === 'ai') {
    try {
      noteModel(ctx, batchId, ctx.ai().model)
    } catch (error) {
      throw new ServiceError(400, (error as Error).message)
    }
  }
  await startBatchWork(ctx, batchId, 'analysing', { status: 'processing', wait: input.wait }, async () => {
    for (const item of items) {
      if (cancelRequested(ctx, batchId)) break
      if (!ctx.repos.batchItems.transition(item.id, ['pending', 'failed'], 'processing')) continue
      try {
        await analyseItem(ctx, batch, item)
      } catch (error) {
        const message = error instanceof ServiceError ? [error.message, ...error.issues].join(' ') : toConnectorError(error).message
        ctx.repos.batchItems.update(item.id, { status: 'failed', error: message, result: { stage: 'analyse' }, attempts: item.attempts + 1 })
      }
      if (BATCH_TIMING.checkSpacingMs) await sleep(BATCH_TIMING.checkSpacingMs)
    }
  })
  return migrationView(ctx, batchId)
}

async function analyseItem(ctx: AppContext, batch: Batch, item: BatchItem) {
  const recipe = batchRecipe(ctx, batch)
  const live = await ctx.connector().getResource(item.resourceId!)
  const doc = live.documents.find((d) => d.type === 'page')
  if (!doc) throw new ServiceError(400, 'This page has no page document (it may be a map, board or timeline only), so there is nothing to migrate.')
  const content = await ctx.connector().getDocumentContent(live.id, doc.id)
  const before = readPage(content.blocks, live.name)
  if (!before.markdown.trim() && before.preserved.length === 0) throw new ServiceError(400, 'The page is empty; there is nothing to migrate.')

  // The page's readable text becomes the source of an import job (one per page, reused).
  const sourceText = before.markdown || `# ${live.name}`
  let jobId = item.jobId
  const attribution = { title: `LegendKeeper page “${live.name}”`, kind: 'lk_page', citation: null, jobId: '', importedAt: ctx.now().toISOString() }
  if (!jobId) {
    jobId = newAppId('job')
    ctx.repos.jobs.insert({
      id: jobId,
      name: live.name.slice(0, 200),
      status: 'extracted',
      sourceName: live.name,
      sourceKind: 'lk_page',
      sourceFormat: 'markdown',
      sourceSize: new TextEncoder().encode(sourceText).byteLength,
      sourceSha256: sha256Hex(sourceText),
      sourceText,
      sourceJson: null,
      attribution: { ...attribution, jobId },
      recipeId: recipe.id,
      pageTypeGuesses: [],
      warnings: [],
      batchId: batch.id,
      recordMeta: null,
    })
  } else {
    ctx.repos.jobs.updateSource(jobId, { sourceText, sourceSha256: sha256Hex(sourceText), sourceSize: new TextEncoder().encode(sourceText).byteLength })
    const existing = ctx.repos.drafts.getByJob(jobId)
    if (existing) ctx.repos.drafts.revokeApproval(existing.id)
    ctx.repos.jobs.update(jobId, { status: 'extracted', error: null })
  }
  const options = optionsOf(batch)
  const view = await runTransform(ctx, jobId, { mode: options.mode, recipeId: recipe.id, recipeVersion: recipe.version, templateId: batch.templateId, purpose: 'migration' })

  // Identity and metadata come from the live page, never from the draft.
  const page: CanonicalPage = structuredClone(view.draft.page)
  page.name = live.name
  page.parentId = live.parentId
  page.aliases = live.aliases
  page.lkResourceId = live.id
  page.sources = []
  page.migration = { sourceResourceId: live.id, sourceDocumentId: doc.id, sourceVersion: content.version, notes: '' }
  const keepTags = live.tags.map((tag) => TagProposal.parse({ value: tag, status: 'existing', existingMatch: tag, origin: 'user', accepted: true, reason: 'Already on the page.' }))
  if (recipe.definition.migration.tagHandling === 'keep') page.tags = keepTags
  else page.tags = [...keepTags, ...page.tags.filter((t) => !live.tags.some((x) => x.toLowerCase() === (t.existingMatch ?? t.value).toLowerCase())).map((t) => ({ ...t, accepted: false }))]
  // Links of the old page point at the same pages again.
  const known = new Map(page.references.filter((r) => r.resourceId).map((r) => [r.mention, r]))
  for (const [i, m] of before.mentions.entries()) {
    if (known.get(m.text)?.resourceId === m.resourceId) continue
    page.references = page.references.filter((r) => r.mention !== m.text)
    page.references.push(PageReference.parse({ id: `old_${i}`, mention: m.text, status: 'resolved', resourceId: m.resourceId, resolvedBy: 'auto_exact', origin: 'index_scan', candidates: [{ resourceId: m.resourceId, name: m.text, matchType: 'exact_name' }] }))
  }
  const job = ctx.repos.jobs.get(jobId)
  const { findings } = validateWithRender(ctx, page, recipe.definition, job)
  const draft = ctx.repos.drafts.upsertContent({ id: view.draft.id, jobId, page, findings: migrationFindings(findings), recipeId: recipe.id, recipeVersion: recipe.version, reason: 'Migration: identity and links taken from the live page' })

  const plan = buildPlan(ctx, batch, recipe.definition, { draftId: draft.id, draftRevision: draft.revision, page, live, documentId: doc.id, documentName: doc.name, version: content.version, originalBlocks: content.blocks, before })
  ctx.repos.batchItems.update(item.id, {
    status: 'awaiting_review',
    jobId,
    title: live.name,
    plan,
    planHash: null,
    approvedAt: null,
    baseFingerprint: content.version,
    error: null,
    flags: flagsFor(plan),
    result: { stage: 'analyse' },
    attempts: item.attempts + 1,
    inputTokens: (item.inputTokens ?? 0) + (page.processing?.inputTokens ?? 0),
    outputTokens: (item.outputTokens ?? 0) + (page.processing?.outputTokens ?? 0),
  })
}

/** Findings that do not apply to a migration (the page already exists; its sources are its own text). */
function migrationFindings(findings: ValidationFinding[]): ValidationFinding[] {
  return findings.filter((f) => f.code !== 'ATTRIBUTION_MISSING' && f.code !== 'POSSIBLE_DUPLICATE')
}

interface PlanInput {
  draftId: string
  draftRevision: number
  page: CanonicalPage
  live: { id: string; name: string; tags: string[] }
  documentId: string
  documentName: string
  version: string
  originalBlocks: unknown[]
  before: PageReading
}

/** Builds the proposed page and every comparison. Pure apart from reading templates and the index. */
function buildPlan(ctx: AppContext, batch: Batch, recipe: RecipeDefinition, input: PlanInput): MigrationPlan {
  const pageType = resolvePageType(recipe)
  if (!pageType) throw new ServiceError(400, 'The recipe’s page type is not defined.')
  const record = batch.templateId ? ctx.repos.templates.get(batch.templateId) : recipe.templateId ? ctx.repos.templates.get(recipe.templateId) : null
  if ((batch.templateId || recipe.templateId) && !record) throw new ServiceError(400, 'The target template no longer exists.')
  const template = resolveTemplate(pageType, record)
  const settings = recipe.migration
  const { before } = input

  const blocks = structuredClone(renderPageBlocks(input.page, { pageType, template })) as Record<string, unknown>[]
  const firstPass = readPage(blocks, input.live.name)
  const coverage = compareContent(before, firstPass)

  // Old text that did not find a place is kept, word for word, under the notes heading.
  const targets = new Map([...before.mentions].sort((a, b) => b.text.length - a.text.length).map((m) => [m.text, m.resourceId]))
  if (coverage.unmapped.length && recipe.unmappedHandling === 'keep') {
    blocks.push(h(2, settings.notesHeading) as never)
    for (const u of coverage.unmapped) blocks.push(...(paragraphBlocks(u.markdown, targets, new Set()) as never[]))
  }

  // Blocks kept as they are go back where they were, as far as the new layout allows.
  const kept = placeKept(blocks, before.preserved, settings.keptHeading)

  // Links the new page would no longer have are added back as a link list.
  const afterLinks = readPage(blocks, input.live.name).linkIds
  const lost = before.linkIds.filter((id) => !afterLinks.includes(id))
  if (lost.length && settings.linkHandling === 'keep_all') blocks.push(links(lost, { title: 'Links from the previous version' }) as never)

  const after = readPage(blocks, input.live.name)
  const finalCoverage = compareContent(before, after)
  const mechanics = mechanicsChanges(before, after)
  const lostAfter = before.linkIds.filter((id) => !after.linkIds.includes(id))
  const names: Record<string, string> = {}
  const projectId = knownProjectId(ctx)
  for (const id of new Set([...before.linkIds, ...after.linkIds])) {
    const hit = projectId ? ctx.repos.index.get(projectId, id) : null
    names[id] = hit?.name ?? before.mentions.find((m) => m.resourceId === id)?.text ?? id
  }

  const headingsOf = (r: PageReading) => r.lines.filter((l) => l.kind === 'heading').map((l) => l.text)
  const norm = (list: string[]) => new Map(list.map((x) => [normalizeForCompare(x), x]))
  const hb = norm(headingsOf(before))
  const ha = norm(headingsOf(after))

  const tagsAfter = settings.tagHandling === 'add_accepted' ? [...new Set([...input.live.tags, ...input.page.tags.filter((t) => t.accepted && t.status !== 'rejected').map((t) => t.existingMatch ?? t.value)])] : input.live.tags
  const draft = ctx.repos.drafts.get(input.draftId)
  const findings: ValidationFinding[] = [...migrationFindings(draft?.findings ?? [])]
  const add = (severity: ValidationFinding['severity'], code: string, message: string) => findings.push({ severity, code, path: null, message })
  if (coverage.unmapped.length) {
    add(recipe.unmappedHandling === 'keep' ? 'warning' : 'error', 'UNMAPPED_CONTENT', recipe.unmappedHandling === 'keep' ? `${coverage.unmapped.length} passage(s) did not fit the new layout. They are kept word for word under “${settings.notesHeading}”.` : `${coverage.unmapped.length} passage(s) did not fit the new layout, and the recipe says unmapped content must be resolved first. Edit the draft so every passage has a place.`)
  }
  if (finalCoverage.unmapped.length) add('error', 'CONTENT_MISSING', `${finalCoverage.unmapped.length} passage(s) of the old page are still not in the proposed page.`)
  if (mechanics.length) add('warning', 'MECHANICS_CHANGED', `${mechanics.length} number(s) differ between the old and the proposed page. Each must be checked and acknowledged.`)
  if (coverage.reworded.length) add('warning', 'REWORDED_TEXT', `${coverage.reworded.length} sentence(s) in the proposed page are not word for word from the old page. Check that nothing was rewritten or invented.`)
  if (lostAfter.length) add(settings.linkHandling === 'keep_all' ? 'error' : 'warning', 'LINKS_LOST', `${lostAfter.length} link(s) of the old page are not in the proposed page.`)
  else if (lost.length) add('info', 'LINKS_ADDED_BACK', `${lost.length} link(s) did not fit the new layout and are kept in a link list at the end.`)
  const lostFormatting = formattingLost(before.formatting, after.formatting)
  if (lostFormatting.length) add('warning', 'FORMATTING_SIMPLIFIED', `Some formatting is not carried over: ${lostFormatting.join(', ')}.`)
  if (before.dropped.rule) add('info', 'DIVIDERS_REMOVED', `${before.dropped.rule} divider line(s) are not carried over.`)
  if (kept.length) add('info', 'BLOCKS_KEPT', `${kept.length} block(s) are kept exactly as they are (sent back by id).`)
  const bytes = new TextEncoder().encode(JSON.stringify(blocks)).byteLength
  if (bytes > 900_000) add('error', 'PAYLOAD_TOO_LARGE', `The proposed page is about ${Math.round(bytes / 1024)} KB, over the request limit.`)

  const acknowledgements = [
    ...mechanics.map((m) => ({ id: m.id, label: `${m.change === 'missing' ? 'Number no longer present' : 'New number'}: ${m.value} — “${m.context}”` })),
    ...(coverage.reworded.length ? [{ id: 'reworded', label: `${coverage.reworded.length} sentence(s) are not word for word from the old page` }] : []),
  ]
  const blockers = findings.filter((f) => f.severity === 'error').map((f) => f.message)
  const proposedHash = sha256Hex(stableStringify({ blocks, tagsAfter, version: input.version }))
  return {
    version: 1,
    resourceId: input.live.id,
    documentId: input.documentId,
    documentName: input.documentName,
    sourceVersion: input.version,
    pageName: input.live.name,
    draftId: input.draftId,
    draftRevision: input.draftRevision,
    template: { id: record?.id ?? null, ...describeTemplate(record) },
    before: outline(input.originalBlocks, new Set()),
    after: outline(blocks, new Set(kept.map((k) => k.id).filter((x): x is string => Boolean(x)))),
    sections: { added: [...ha.keys()].filter((k) => !hb.has(k)).map((k) => ha.get(k)!), removed: [...hb.keys()].filter((k) => !ha.has(k)).map((k) => hb.get(k)!), kept: [...hb.keys()].filter((k) => ha.has(k)).map((k) => ha.get(k)!) },
    fields: coverage.fields,
    relocated: coverage.relocated,
    unmapped: coverage.unmapped.map((u) => ({ text: u.text, section: u.section })),
    reworded: coverage.reworded,
    mechanics,
    links: { before: before.linkIds, after: after.linkIds, lost: lostAfter, addedBack: settings.linkHandling === 'keep_all' ? lost : [], added: after.linkIds.filter((id) => !before.linkIds.includes(id)), names },
    kept,
    dropped: before.dropped,
    formatting: { lost: lostFormatting },
    metadata: { tagsBefore: input.live.tags, tagsAfter, unchanged: ['Page id', 'Name', 'Parent', 'Aliases', 'Sidebar properties', ...(sameTags(tagsAfter, input.live.tags) ? ['Tags'] : [])] },
    findings,
    blockers,
    acknowledgements,
    originalBlocks: input.originalBlocks,
    proposedBlocks: blocks,
    proposedHash,
  }
}

/** Puts kept blocks back: infobox rows into the new infobox, others under their old heading. */
function placeKept(blocks: Record<string, unknown>[], parts: PreservedPart[], keptHeading: string): MigrationPlan['kept'] {
  const out: MigrationPlan['kept'] = []
  const leftovers: Record<string, unknown>[] = []
  const findSection = (section: string): { container: Record<string, unknown>[]; index: number } | null => {
    const key = normalizeForCompare(section)
    for (const [i, b] of blocks.entries()) {
      if (b.kind === 'textField' && typeof b.title === 'string' && normalizeForCompare(b.title) === key) return { container: b.children as Record<string, unknown>[], index: (b.children as unknown[]).length }
      if (b.kind === 'heading' && normalizeForCompare(headingText(b)) === key) {
        let end = i + 1
        while (end < blocks.length && !(blocks[end]!.kind === 'heading' && Number(blocks[end]!.level) <= Number(b.level))) end++
        return { container: blocks, index: end }
      }
    }
    return null
  }
  let topIndex = 0
  while (topIndex < blocks.length && (blocks[topIndex]!.kind === 'infobox' || (blocks[topIndex]!.kind === 'heading' && Number(blocks[topIndex]!.level) === 1))) topIndex++
  for (const part of parts) {
    if (part.container === 'infobox') {
      const box = blocks.find((b) => b.kind === 'infobox')
      if (box) (box.rows as unknown[]).push(part.block)
      else blocks.splice(0, 0, { kind: 'infobox', rows: [part.block] })
      if (!box) topIndex++
      out.push({ id: part.id, kind: part.kind, label: part.label, placement: 'In the infobox' })
      continue
    }
    if (!part.section) {
      if (part.atTop) {
        blocks.splice(topIndex++, 0, part.block)
        out.push({ id: part.id, kind: part.kind, label: part.label, placement: 'At the top of the page' })
      } else {
        leftovers.push(part.block)
        out.push({ id: part.id, kind: part.kind, label: part.label, placement: `Under “${keptHeading}”` })
      }
      continue
    }
    const target = findSection(part.section)
    if (!target && part.section === LOOSE_TEXT_HEADING) {
      // It followed loose text at the bottom of the old page; that text is at the bottom now too.
      blocks.push(part.block)
      out.push({ id: part.id, kind: part.kind, label: part.label, placement: 'At the end of the page' })
      continue
    }
    if (target) {
      target.container.splice(target.index, 0, part.block)
      out.push({ id: part.id, kind: part.kind, label: part.label, placement: `Under “${part.section}”` })
    } else {
      leftovers.push(part.block)
      out.push({ id: part.id, kind: part.kind, label: part.label, placement: `Under “${keptHeading}” (the new layout has no “${part.section}” section)` })
    }
  }
  if (leftovers.length) blocks.push(h(2, keptHeading) as never, ...leftovers)
  return out
}

function headingText(b: Record<string, unknown>): string {
  return ((b.content as { text?: string }[] | undefined) ?? []).map((r) => r.text ?? '').join('')
}

function outline(blocks: unknown[], keptIds: Set<string>): OutlineEntry[] {
  const out: OutlineEntry[] = []
  for (const raw of blocks as Record<string, unknown>[]) {
    const kind = String(raw.kind)
    const kept = typeof raw.id === 'string' && keptIds.has(raw.id)
    let label: string
    if (kind === 'heading') label = headingText(raw)
    else if (kind === 'textField' || kind === 'keyValue' || kind === 'resourceLink' || kind === 'resourceCollection') label = typeof raw.title === 'string' && raw.title ? raw.title : kind
    else if (kind === 'infobox') {
      const rows = (raw.rows as Record<string, unknown>[] | undefined) ?? []
      label = `Infobox: ${rows.map((r) => (typeof r.title === 'string' && r.title && r.isTitleHidden !== true ? r.title : String(r.kind))).join(', ')}`
    } else if (kind === 'paragraph') label = readPage([raw], '').lines[0]?.text.slice(0, 90) ?? ''
    else label = kind
    out.push({ kind, label, kept })
  }
  return out
}

function flagsFor(plan: MigrationPlan): string[] {
  const flags: string[] = []
  if (plan.mechanics.length) flags.push('mechanics_changed')
  if (plan.unmapped.length) flags.push('unmapped')
  if (plan.reworded.length) flags.push('reworded')
  if (plan.links.addedBack.length || plan.links.lost.length) flags.push('links')
  if (plan.kept.length) flags.push('kept_blocks')
  if (plan.formatting.lost.length) flags.push('formatting')
  if (plan.blockers.length) flags.push('errors')
  return flags
}

const planOf = (item: BatchItem) => item.plan as MigrationPlan | null
const sameTags = (a: string[], b: string[]) => stableStringify([...a].sort()) === stableStringify([...b].sort())

/** Recomputes the comparison after the draft was edited (no LegendKeeper call). */
export function refreshMigration(ctx: AppContext, batchId: string, itemIds: string[]) {
  const batch = getMigration(ctx, batchId)
  requireUsable(batch)
  const recipe = batchRecipe(ctx, batch)
  for (const item of ctx.repos.batchItems.list(batchId, { status: ['awaiting_review', 'approved'] })) {
    if (!itemIds.includes(item.id)) continue
    const plan = planOf(item)
    if (!plan) continue
    const draft = ctx.repos.drafts.get(plan.draftId)
    if (!draft) continue
    const page = { ...draft.page, name: plan.pageName, migration: draft.page.migration }
    const next = buildPlan(ctx, batch, recipe.definition, {
      draftId: draft.id,
      draftRevision: draft.revision,
      page,
      live: { id: plan.resourceId, name: plan.pageName, tags: plan.metadata.tagsBefore },
      documentId: plan.documentId,
      documentName: plan.documentName,
      version: plan.sourceVersion,
      originalBlocks: plan.originalBlocks,
      before: readPage(plan.originalBlocks, plan.pageName),
    })
    ctx.repos.batchItems.update(item.id, { status: 'awaiting_review', plan: next, planHash: null, approvedAt: null, flags: flagsFor(next), error: null })
  }
  return migrationView(ctx, batchId)
}

// ── Approval ──────────────────────────────────────────────────────────────────

const ApproveInput = z.object({
  itemIds: z.array(z.string()).min(1).max(5000),
  /** Per page: the acknowledgement ids you ticked (number changes, reworded text). */
  acknowledged: z.record(z.string(), z.array(z.string().max(200)).max(2000)).default({}),
})

export function approveMigration(ctx: AppContext, batchId: string, input: unknown) {
  const batch = getMigration(ctx, batchId)
  requireUsable(batch)
  const parsed = ApproveInput.safeParse(input)
  if (!parsed.success) throw new ServiceError(400, 'Choose pages to approve.')
  let approved = 0
  for (const item of ctx.repos.batchItems.list(batchId, { status: ['awaiting_review'] })) {
    if (!parsed.data.itemIds.includes(item.id)) continue
    const plan = planOf(item)
    if (!plan) continue
    const draft = ctx.repos.drafts.get(plan.draftId)
    let problem: string | null = null
    if (!draft || draft.revision !== plan.draftRevision) problem = 'The draft was edited after this comparison. Refresh the comparison, check it, then approve.'
    else if (plan.blockers.length) problem = `Cannot be approved yet: ${plan.blockers.join(' ')}`
    else {
      const ticked = new Set(parsed.data.acknowledged[item.id] ?? [])
      const missing = plan.acknowledgements.filter((a) => !ticked.has(a.id))
      if (missing.length) problem = `Tick every change you have checked first (${missing.length} left).`
    }
    if (problem) {
      ctx.repos.batchItems.update(item.id, { error: problem })
      continue
    }
    ctx.repos.batchItems.update(item.id, { status: 'approved', approvedAt: ctx.now().toISOString(), planHash: plan.proposedHash, error: null, decision: JSON.stringify(parsed.data.acknowledged[item.id] ?? []) })
    approved++
  }
  recordAudit(ctx, { operation: 'migration.approve', outcome: 'success', approval: 'approved', projectId: knownProjectId(ctx), message: `${approved} page(s) approved`, details: { batchId } })
  return migrationView(ctx, batchId)
}

export function unapproveMigration(ctx: AppContext, batchId: string, itemIds: string[]) {
  const batch = getMigration(ctx, batchId)
  requireUsable(batch)
  for (const item of ctx.repos.batchItems.list(batchId, { status: ['approved'] })) if (itemIds.includes(item.id)) ctx.repos.batchItems.update(item.id, { status: 'awaiting_review', approvedAt: null, planHash: null })
  return migrationView(ctx, batchId)
}

// ── Dry run, apply, reconcile ─────────────────────────────────────────────────

/** Reads every approved page again and reports whether it can be migrated as approved. Writes nothing. */
export async function dryRunMigration(ctx: AppContext, batchId: string, input: { wait?: boolean } = {}) {
  const batch = getMigration(ctx, batchId)
  requireUsable(batch)
  const items = ctx.repos.batchItems.list(batchId, { status: ['approved', 'awaiting_review'] })
  if (items.length === 0) throw new ServiceError(409, 'There is nothing to check yet.')
  await startBatchWork(ctx, batchId, 'dry run', { status: 'processing', wait: input.wait }, async () => {
    const entries = []
    for (const item of items) {
      if (cancelRequested(ctx, batchId)) break
      const plan = planOf(item)!
      const problems: string[] = []
      if (!ctx.config().lk.allowWrites) problems.push('Writes are switched off (LKC_ALLOW_WRITES=false), so nothing could be written.')
      try {
        const current = await ctx.connector().getDocumentContent(plan.resourceId, plan.documentId)
        if (current.version !== plan.sourceVersion) problems.push('The page changed in LegendKeeper after the analysis. It would not be written; analyse it again.')
      } catch (error) {
        problems.push(toConnectorError(error).message)
      }
      if (item.status !== 'approved') problems.push('Not approved yet.')
      problems.push(...plan.blockers)
      entries.push({ itemId: item.id, page: item.title, resourceId: plan.resourceId, status: item.status, template: plan.template.name, numberChanges: plan.mechanics.length, unmapped: plan.unmapped.length, kept: plan.kept.length, linksAddedBack: plan.links.addedBack.length, tagsAfter: plan.metadata.tagsAfter, problems, canProceed: problems.length === 0 })
      if (BATCH_TIMING.checkSpacingMs) await sleep(BATCH_TIMING.checkSpacingMs)
    }
    const report = { kind: 'migration_dry_run', batchId, at: ctx.now().toISOString(), totals: { pages: entries.length, ready: entries.filter((e) => e.canProceed).length }, entries }
    ctx.repos.batches.update(batchId, { options: { ...getMigration(ctx, batchId).options, lastDryRun: report } })
    recordAudit(ctx, { operation: 'migration.dry_run', outcome: 'success', projectId: knownProjectId(ctx), message: `${report.totals.ready} of ${entries.length} ready`, details: { batchId } })
  })
  return migrationView(ctx, batchId)
}

export async function runMigration(ctx: AppContext, batchId: string, input: { wait?: boolean } = {}) {
  const batch = getMigration(ctx, batchId)
  requireUsable(batch)
  if (!ctx.config().lk.allowWrites) throw new ServiceError(409, 'Writes are switched off (LKC_ALLOW_WRITES=false).')
  if (ctx.repos.batchItems.list(batchId, { status: ['approved', 'needs_reconciliation'] }).length === 0) throw new ServiceError(409, 'There are no approved pages to migrate.')
  await startBatchWork(ctx, batchId, 'running', { status: 'running', wait: input.wait }, async () => {
    for (const item of ctx.repos.batchItems.list(batchId, { status: ['needs_reconciliation'] })) await reconcileItem(ctx, item)
    const counts = { succeeded: 0, failed: 0, uncertain: 0, stale: 0 }
    const approved = ctx.repos.batchItems.list(batchId, { status: ['approved'] })
    for (const [index, item] of approved.entries()) {
      if (cancelRequested(ctx, batchId)) break
      counts[await applyItem(ctx, batch, item)]++
      if (index < approved.length - 1) await sleep(BATCH_TIMING.writeSpacingMs)
    }
    recordAudit(ctx, { operation: 'migration.run', outcome: counts.failed || counts.uncertain ? 'failure' : 'success', approval: 'approved', projectId: knownProjectId(ctx), message: `${counts.succeeded} migrated, ${counts.stale} changed meanwhile, ${counts.failed} failed, ${counts.uncertain} uncertain`, details: { batchId, ...counts } })
  })
  return migrationView(ctx, batchId)
}

async function applyItem(ctx: AppContext, batch: Batch, item: BatchItem): Promise<'succeeded' | 'failed' | 'uncertain' | 'stale'> {
  if (!ctx.repos.batchItems.transition(item.id, ['approved'], 'running')) return 'stale'
  const plan = planOf(item)!
  const auditBase = { projectId: knownProjectId(ctx), resourceId: plan.resourceId, draftId: plan.draftId }
  if (item.planHash !== plan.proposedHash) {
    ctx.repos.batchItems.update(item.id, { status: 'awaiting_review', error: 'The approved proposal no longer matches. Approve it again.' })
    return 'stale'
  }
  let tagsNow: string[]
  try {
    const current = await ctx.connector().getDocumentContent(plan.resourceId, plan.documentId)
    if (current.version !== plan.sourceVersion) {
      ctx.repos.batchItems.update(item.id, { status: 'pending', approvedAt: null, planHash: null, error: 'The page was edited in LegendKeeper after the analysis, so nothing was written. Analyse it again to compare with the current content.' })
      return 'stale'
    }
    tagsNow = (await ctx.connector().getResource(plan.resourceId)).tags
  } catch (error) {
    ctx.repos.batchItems.update(item.id, { status: 'failed', error: `Could not read the page before writing: ${toConnectorError(error).message} Nothing was written.`, result: { stage: 'write' } })
    return 'failed'
  }

  // Recovery record first: the original exactly as read, and what will be written.
  const backup = ctx.repos.migrationBackups.insert({
    id: newAppId('bak'),
    batchId: batch.id,
    itemId: item.id,
    projectId: knownProjectId(ctx),
    resourceId: plan.resourceId,
    resourceName: plan.pageName,
    documentId: plan.documentId,
    originalVersion: plan.sourceVersion,
    originalBlocks: plan.originalBlocks,
    originalTags: tagsNow,
    proposedBlocks: plan.proposedBlocks,
    proposedTags: sameTags(plan.metadata.tagsAfter, plan.metadata.tagsBefore) ? null : plan.metadata.tagsAfter,
  })

  let newVersion: string
  try {
    newVersion = (await ctx.connector().replaceDocumentBlocks(plan.resourceId, plan.documentId, plan.proposedBlocks, plan.sourceVersion)).version
  } catch (error) {
    const failure = toConnectorError(error)
    if (failure.kind === 'version_conflict') {
      ctx.repos.migrationBackups.mark(backup.id, { status: 'not_applied', note: 'Version check failed: the page changed.' })
      ctx.repos.batchItems.update(item.id, { status: 'pending', approvedAt: null, planHash: null, error: 'The page changed in LegendKeeper at the last moment (version check), so nothing was written. Analyse it again.' })
      recordAudit(ctx, { ...auditBase, operation: 'migration.write', outcome: 'failure', approval: 'approved', errorCode: 'version_conflict', message: `“${plan.pageName}” changed before the write; nothing written` })
      return 'stale'
    }
    if (failure.details.outcome === 'unknown') {
      ctx.repos.batchItems.update(item.id, { status: 'needs_reconciliation', error: `${failure.message} The outcome is unknown; the app will read the page before doing anything else.`, result: { stage: 'write', backupId: backup.id } })
      recordAudit(ctx, { ...auditBase, operation: 'migration.write', outcome: 'uncertain', approval: 'approved', message: `Migration of “${plan.pageName}” uncertain`, details: { backupId: backup.id } })
      return 'uncertain'
    }
    ctx.repos.migrationBackups.mark(backup.id, { status: 'not_applied', note: failure.message })
    ctx.repos.batchItems.update(item.id, { status: 'failed', error: `LegendKeeper refused the change: ${failure.message} Nothing was changed.`, result: { stage: 'write', backupId: backup.id } })
    recordAudit(ctx, { ...auditBase, operation: 'migration.write', outcome: 'failure', approval: 'approved', errorCode: failure.details.code ?? failure.kind, message: failure.message })
    return 'failed'
  }
  ctx.repos.migrationBackups.mark(backup.id, { status: 'applied', resultVersion: newVersion })
  const notes = await finishItem(ctx, plan, tagsNow, newVersion)
  ctx.repos.batchItems.update(item.id, { status: 'succeeded', error: notes.length ? notes.join(' ') : null, attempts: item.attempts + 1, result: { stage: 'write', backupId: backup.id, newVersion } })
  recordAudit(ctx, { ...auditBase, operation: 'migration.write', outcome: 'success', approval: 'approved', message: `Migrated “${plan.pageName}” to “${plan.template.name}”`, details: { backupId: backup.id, newVersion, notes } })
  return 'succeeded'
}

/** After the content write: optional tag additions, then a read-back check. */
async function finishItem(ctx: AppContext, plan: MigrationPlan, tagsNow: string[], newVersion: string): Promise<string[]> {
  const notes: string[] = []
  if (!sameTags(plan.metadata.tagsAfter, plan.metadata.tagsBefore)) {
    try {
      const current = (await ctx.connector().getResource(plan.resourceId)).tags
      const additions = plan.metadata.tagsAfter.filter((t) => !plan.metadata.tagsBefore.includes(t))
      const next = [...current, ...additions.filter((t) => !current.some((c) => c.toLowerCase() === t.toLowerCase()))]
      if (!sameTags(next, current)) await ctx.connector().updateResourceTags(plan.resourceId, next)
    } catch (error) {
      notes.push(`The content was migrated, but adding tags failed: ${toConnectorError(error).message}`)
    }
  } else void tagsNow
  try {
    const read = await ctx.connector().getDocumentContent(plan.resourceId, plan.documentId)
    const expected = readPage(plan.proposedBlocks, plan.pageName).lines.map((l) => normalizeForCompare(l.text)).join('|')
    const actual = readPage(read.blocks, plan.pageName).lines.map((l) => normalizeForCompare(l.text)).join('|')
    if (expected !== actual) notes.push('Reading the page back did not match the proposal exactly (it may have been edited at the same moment). Check the page.')
    else if (read.version !== newVersion) notes.push('The page was edited again right after the migration.')
  } catch (error) {
    notes.push(`Migrated, but reading it back failed: ${toConnectorError(error).message}`)
  }
  return notes
}

/** Decides an unknown outcome by reading the page (never by writing again). */
async function reconcileItem(ctx: AppContext, item: BatchItem) {
  const plan = planOf(item)!
  const backupId = (item.result as { backupId?: string } | null)?.backupId
  try {
    const current = await ctx.connector().getDocumentContent(plan.resourceId, plan.documentId)
    if (current.version === plan.sourceVersion) {
      if (backupId) ctx.repos.migrationBackups.mark(backupId, { status: 'not_applied', note: 'Checked: not written.' })
      ctx.repos.batchItems.update(item.id, { status: 'failed', error: 'Checked: the migration did not happen. Approve it again to retry.', approvedAt: null, planHash: null, result: { stage: 'write', reconciled: true } })
      return
    }
    const expected = readPage(plan.proposedBlocks, plan.pageName).lines.map((l) => normalizeForCompare(l.text)).join('|')
    const actual = readPage(current.blocks, plan.pageName).lines.map((l) => normalizeForCompare(l.text)).join('|')
    if (expected === actual) {
      if (backupId) ctx.repos.migrationBackups.mark(backupId, { status: 'applied', resultVersion: current.version })
      ctx.repos.batchItems.update(item.id, { status: 'succeeded', error: null, result: { stage: 'write', backupId, newVersion: current.version, reconciled: true } })
      return
    }
    ctx.repos.batchItems.update(item.id, { status: 'failed', error: 'Checked: the page changed, but not to the proposed content. Check it in LegendKeeper; the original is saved in the recovery list.', result: { stage: 'write', backupId, reconciled: true } })
  } catch (error) {
    ctx.repos.batchItems.update(item.id, { error: `Could not check the outcome yet: ${toConnectorError(error).message}` })
  }
}

export async function reconcileMigration(ctx: AppContext, batchId: string) {
  const batch = getMigration(ctx, batchId)
  requireUsable(batch)
  for (const item of ctx.repos.batchItems.list(batchId, { status: ['needs_reconciliation'] })) await reconcileItem(ctx, item)
  return migrationView(ctx, batchId)
}

/** Failed pages go back to analysis (which reads the current page); nothing is re-sent on its own. */
export function retryMigration(ctx: AppContext, batchId: string, itemIds: string[]) {
  const batch = getMigration(ctx, batchId)
  requireUsable(batch)
  for (const item of ctx.repos.batchItems.list(batchId, { status: ['failed'] })) if (itemIds.includes(item.id)) ctx.repos.batchItems.update(item.id, { status: 'pending', error: null, approvedAt: null, planHash: null })
  return migrationView(ctx, batchId)
}

export function skipMigration(ctx: AppContext, batchId: string, itemIds: string[]) {
  const batch = getMigration(ctx, batchId)
  requireUsable(batch)
  for (const item of ctx.repos.batchItems.list(batchId, { status: ['pending', 'awaiting_review', 'approved', 'failed'] })) if (itemIds.includes(item.id)) ctx.repos.batchItems.update(item.id, { status: 'skipped', decision: 'skip' })
  return migrationView(ctx, batchId)
}

export function closeMigration(ctx: AppContext, batchId: string, cancel = false) {
  const batch = getMigration(ctx, batchId)
  requireUsable(batch)
  if (ctx.repos.batchItems.list(batchId, { status: ['needs_reconciliation', 'running'] }).length) throw new ServiceError(409, 'Some pages have an unknown outcome. Check them first.')
  for (const item of ctx.repos.batchItems.list(batchId, { status: ['pending', 'awaiting_review', 'approved', 'failed'] })) ctx.repos.batchItems.update(item.id, { status: 'cancelled' })
  ctx.repos.batches.update(batchId, { status: cancel ? 'cancelled' : 'completed', finishedAt: ctx.now().toISOString() })
  recordAudit(ctx, { operation: cancel ? 'migration.cancel' : 'migration.close', outcome: 'success', message: batch.name, details: { batchId } })
  return migrationView(ctx, batchId)
}

// ── Restore ───────────────────────────────────────────────────────────────────

const RestoreInput = z.object({
  itemIds: z.array(z.string()).min(1).max(500),
  /** Also restore pages edited after the migration (those edits are overwritten). */
  overwriteLaterEdits: z.boolean().default(false),
})

/**
 * Writes the saved original back. Possible because LegendKeeper accepts blocks exactly as it
 * returned them (verified live: the restored page is identical, block ids included). Refused
 * when the page was edited after the migration, unless you accept overwriting those edits.
 * Restoring works on closed jobs too.
 */
export async function restoreMigration(ctx: AppContext, batchId: string, input: unknown) {
  getMigration(ctx, batchId)
  if (runningPhase(batchId)) throw new ServiceError(409, 'This job is busy.')
  const parsed = RestoreInput.safeParse(input)
  if (!parsed.success) throw new ServiceError(400, 'Choose pages to restore.')
  if (!ctx.config().lk.allowWrites) throw new ServiceError(409, 'Writes are switched off (LKC_ALLOW_WRITES=false).')
  const results: { itemId: string; page: string; outcome: 'restored' | 'refused' | 'failed' | 'uncertain'; message: string }[] = []
  for (const item of ctx.repos.batchItems.list(batchId, { status: ['succeeded'] })) {
    if (!parsed.data.itemIds.includes(item.id)) continue
    const backup = ctx.repos.migrationBackups.latestForItem(item.id)
    if (!backup || backup.status !== 'applied' || !backup.resultVersion) {
      results.push({ itemId: item.id, page: item.title, outcome: 'refused', message: backup?.status === 'restored' ? 'Already restored.' : 'There is no applied migration to undo for this page.' })
      continue
    }
    try {
      const current = await ctx.connector().getDocumentContent(backup.resourceId, backup.documentId)
      if (current.version !== backup.resultVersion && !parsed.data.overwriteLaterEdits) {
        results.push({ itemId: item.id, page: item.title, outcome: 'refused', message: 'The page was edited after the migration. Restoring would overwrite those edits, so it was not done. Download the original instead, or restore with “overwrite later edits”.' })
        continue
      }
      let restoreVersion: string
      try {
        restoreVersion = (await ctx.connector().replaceDocumentBlocks(backup.resourceId, backup.documentId, backup.originalBlocks, current.version)).version
      } catch (error) {
        const failure = toConnectorError(error)
        const uncertain = failure.details.outcome === 'unknown'
        results.push({ itemId: item.id, page: item.title, outcome: uncertain ? 'uncertain' : 'failed', message: uncertain ? `${failure.message} The outcome is unknown; open the page to check. The original is still saved.` : `${failure.message} Nothing was changed.` })
        recordAudit(ctx, { operation: 'migration.restore', outcome: uncertain ? 'uncertain' : 'failure', approval: 'approved', projectId: backup.projectId, resourceId: backup.resourceId, message: failure.message, details: { backupId: backup.id } })
        continue
      }
      const notes: string[] = []
      if (backup.proposedTags) {
        try {
          const tags = (await ctx.connector().getResource(backup.resourceId)).tags
          if (sameTags(tags, backup.proposedTags)) await ctx.connector().updateResourceTags(backup.resourceId, backup.originalTags)
          else notes.push('Tags were changed since the migration, so they were left as they are.')
        } catch (error) {
          notes.push(`Tags could not be restored: ${toConnectorError(error).message}`)
        }
      }
      let identical = false
      try {
        const read = await ctx.connector().getDocumentContent(backup.resourceId, backup.documentId)
        identical = stableStringify(read.blocks) === stableStringify(backup.originalBlocks)
      } catch {
        identical = false
      }
      if (!identical) notes.push('The read-back differs in some detail from the saved original; check the page.')
      ctx.repos.migrationBackups.mark(backup.id, { status: 'restored', restoreVersion, note: notes.join(' ') || null })
      ctx.repos.batchItems.update(item.id, { flags: [...new Set([...item.flags, 'restored'])], error: notes.join(' ') || null, result: { ...(item.result as object), restoredAt: ctx.now().toISOString(), restoreVersion } })
      results.push({ itemId: item.id, page: item.title, outcome: 'restored', message: notes.join(' ') || 'Restored to the saved original (identical when read back).' })
      recordAudit(ctx, { operation: 'migration.restore', outcome: 'success', approval: 'approved', projectId: backup.projectId, resourceId: backup.resourceId, message: `Restored “${backup.resourceName}”`, details: { backupId: backup.id, identical, overwroteLaterEdits: current.version !== backup.resultVersion } })
    } catch (error) {
      results.push({ itemId: item.id, page: item.title, outcome: 'failed', message: `Could not read the page: ${toConnectorError(error).message} Nothing was changed.` })
    }
  }
  return { ...migrationView(ctx, batchId), restoreResults: results }
}

// ── Views and exports ─────────────────────────────────────────────────────────

/** The plan without the bulky block arrays (for lists). */
function summaryOf(plan: MigrationPlan | null) {
  if (!plan) return null
  const { originalBlocks: _o, proposedBlocks: _p, before: _b, after: _a, ...rest } = plan
  return rest
}

export function migrationView(ctx: AppContext, batchId: string) {
  const batch = getMigration(ctx, batchId)
  let recipe: ReturnType<typeof batchRecipe> | null = null
  try {
    recipe = batchRecipe(ctx, batch)
  } catch {
    recipe = null
  }
  const template = batch.templateId ? ctx.repos.templates.get(batch.templateId) : recipe?.definition.templateId ? ctx.repos.templates.get(recipe.definition.templateId) : null
  const backups = new Map(ctx.repos.migrationBackups.listForBatch(batchId).map((b) => [b.itemId, b]))
  const items = ctx.repos.batchItems.list(batchId).map((item) => {
    const plan = planOf(item)
    const draft = plan ? ctx.repos.drafts.get(plan.draftId) : null
    return {
      ...item,
      plan: summaryOf(plan),
      statusExplanation: ITEM_STATUS_EXPLANATIONS[item.status],
      draftChanged: Boolean(plan && draft && draft.revision !== plan.draftRevision),
      acknowledged: item.decision && item.decision.startsWith('[') ? (JSON.parse(item.decision) as string[]) : [],
      backup: backups.get(item.id) ?? null,
    }
  })
  const counts = ctx.repos.batchItems.counts(batchId)
  const tokens = { input: items.reduce((n, i) => n + (i.inputTokens ?? 0), 0), output: items.reduce((n, i) => n + (i.outputTokens ?? 0), 0) }
  const model = ctx.config().ai.model
  const options = optionsOf(batch)
  return {
    batch: { ...batch, options: { ...batch.options, lastDryRun: undefined } },
    phase: runningPhase(batchId),
    mode: options.mode,
    recipe: recipe ? { id: recipe.id, version: recipe.version, latestVersion: recipe.latestVersion, name: recipe.definition.name, settings: recipe.definition.migration, unmappedHandling: recipe.definition.unmappedHandling } : null,
    template: { id: template?.id ?? null, ...describeTemplate(template ?? null) },
    items,
    counts,
    overview: {
      pages: items.length,
      analysed: items.filter((i) => i.plan).length,
      numberChanges: items.filter((i) => i.flags.includes('mechanics_changed')).length,
      unmapped: items.filter((i) => i.flags.includes('unmapped')).length,
      blocked: items.filter((i) => i.flags.includes('errors')).length,
      approved: counts.approved,
      succeeded: counts.succeeded,
      restored: items.filter((i) => i.flags.includes('restored')).length,
      failedOrUnresolved: counts.failed + counts.needs_reconciliation,
    },
    usage: { ...tokens, model, estimatedCostUsd: estimateCostUsd(model, tokens.input, tokens.output), pricesAsOf: PRICES_AS_OF },
    hasDryRun: Boolean((batch.options as { lastDryRun?: unknown }).lastDryRun),
  }
}

/** One page's full comparison, including the old and proposed blocks for previews. */
export function migrationItem(ctx: AppContext, batchId: string, itemId: string) {
  getMigration(ctx, batchId)
  const item = ctx.repos.batchItems.get(itemId)
  if (!item || item.batchId !== batchId) throw new ServiceError(404, 'Page not found in this migration job.')
  const plan = planOf(item)
  const draft = plan ? ctx.repos.drafts.get(plan.draftId) : null
  return { item: { ...item, plan: summaryOf(plan) }, plan, draftChanged: Boolean(plan && draft && draft.revision !== plan.draftRevision), backup: ctx.repos.migrationBackups.latestForItem(itemId) }
}

/** The saved original of a page, as JSON (for safekeeping or manual recovery). */
export function migrationOriginal(ctx: AppContext, batchId: string, itemId: string) {
  getMigration(ctx, batchId)
  const backup = ctx.repos.migrationBackups.latestForItem(itemId)
  const item = ctx.repos.batchItems.get(itemId)
  const plan = item ? planOf(item) : null
  if (!backup && !plan) throw new ServiceError(404, 'No original is saved for this page yet.')
  const doc = backup
    ? { resourceId: backup.resourceId, name: backup.resourceName, documentId: backup.documentId, version: backup.originalVersion, tags: backup.originalTags, savedAt: backup.createdAt, blocks: backup.originalBlocks }
    : { resourceId: plan!.resourceId, name: plan!.pageName, documentId: plan!.documentId, version: plan!.sourceVersion, tags: plan!.metadata.tagsBefore, savedAt: null, blocks: plan!.originalBlocks }
  const name = doc.name.replace(/[^A-Za-z0-9._-]+/g, '-').slice(0, 60) || 'page'
  return { fileName: `${name}-original.json`, contentType: 'application/json', body: JSON.stringify(doc, null, 2) }
}

export function exportMigration(ctx: AppContext, batchId: string, input: { report: 'results' | 'dry_run'; format: 'json' | 'csv' }) {
  const batch = getMigration(ctx, batchId)
  const view = migrationView(ctx, batchId)
  const name = batch.name.replace(/[^A-Za-z0-9._-]+/g, '-').slice(0, 60) || 'migration'
  const report = (batch.options as { lastDryRun?: { entries: Record<string, unknown>[] } }).lastDryRun
  if (input.report === 'dry_run' && !report) throw new ServiceError(404, 'No dry run has been made yet.')
  const doc = input.report === 'dry_run' ? report : { batch: view.batch, template: view.template, recipe: view.recipe, overview: view.overview, items: view.items }
  const rows =
    input.report === 'dry_run'
      ? report!.entries.map((e) => ({ page: e.page as string, resource_id: e.resourceId as string, number_changes: e.numberChanges as number, unmapped: e.unmapped as number, kept_blocks: e.kept as number, can_proceed: e.canProceed ? 'yes' : 'no', problems: (e.problems as string[]).join(' | ') }))
      : view.items.map((i) => ({
          page: i.title,
          resource_id: i.resourceId,
          status: i.status,
          number_changes: i.plan?.mechanics.length ?? 0,
          unmapped: i.plan?.unmapped.length ?? 0,
          kept_blocks: i.plan?.kept.length ?? 0,
          links_added_back: i.plan?.links.addedBack.length ?? 0,
          recovery: i.backup?.status ?? '',
          error: i.error,
        }))
  const secrets = configuredSecrets()
  return input.format === 'json'
    ? { fileName: `${name}-${input.report}.json`, contentType: 'application/json', body: JSON.stringify(redactSecrets(doc, secrets), null, 2) }
    : { fileName: `${name}-${input.report}.csv`, contentType: 'text/csv', body: toCsv(redactSecrets(rows, secrets) as Record<string, string | number | null>[]) }
}
