import 'server-only'
import { p } from '@legendkeeper/sdk/blocks'
import { idempotencyKeyFor, newAppId, newLkResourceId } from '@/core/ids'

/** Ids for blocks the app inserts: chosen in advance, so a repeated insert is refused instead of doubled. */
const newBlockId = () => newLkResourceId()
import { acceptedTags, type CanonicalPage } from '@/core/page-model'
import { resolvePageType } from '@/core/resolve'
import type { AppContext } from '../context'
import type { Draft } from '../db/repositories'
import { ConnectorError, toConnectorError } from '../lk/errors'
import { buildCreatePayload, payloadBytes } from '../lk/render'
import type { CreatePageInput, CreatedPage, Placement, ResourceDetail } from '../lk/types'
import type { RecipeDefinition } from '@/core/recipe'
import { randomToken, sha256Hex, stableStringify } from '../hash'
import { recordAudit } from './audit'
import { knownProjectId } from './connection'
import { getDraft, recipeForDraft, templateForDraft, validateWithRender } from './drafts'
import { ServiceError } from './errors'
import { isLkTemplate } from './lk-templates'
import { isEmptyImage, skeletonFromBlocks } from '@/core/lk-layout'
import { comparableContent, hasAllIds, hasUnwritable, planFill, type FillOp } from '@/core/template-fill'
import { renderFromLayout } from '../lk/render-layout'

/**
 * Guarded single-page creation.
 *
 * Nothing reaches LegendKeeper unless every one of these holds:
 *  1. Writes are switched on in configuration (LKC_ALLOW_WRITES, on by default).
 *  2. (No separate gate.) Page creation was verified live for this SDK version; the first
 *     page you approve for a project is recorded as confirmation that writing works there.
 *     The optional "write check" on the Connection page does the same with a test page.
 *  3. The draft's recipe allows creation.
 *  4. The draft validates with no errors, and the user acknowledges any warnings.
 *  5. The connection is confirmed live, and the key's project is the expected project.
 *  6. The parent page and every linked page are confirmed to exist in LegendKeeper.
 *  7. The user approves the exact content shown in the final preview. Approval is bound to
 *     a hash of that content and expires; any edit after the preview invalidates it.
 *
 * Duplicate prevention: each draft gets a resource ID chosen in advance, plus an
 * Idempotency-Key derived from that ID and the content. LegendKeeper refuses a second
 * resource with the same ID (409 DUPLICATE_ID), so one draft can never create two pages.
 * A write is never retried automatically. When its outcome is uncertain (timeout, dropped
 * connection, server error), the app only *reads* — it asks whether that ID exists.
 *
 * From a LegendKeeper template: when the draft's template was copied from a LegendKeeper
 * template (and "create from the template itself" is on), the page is created as a copy of
 * that template (`resources.createFromTemplate`, same planned ID and Idempotency-Key rules),
 * then filled: its first page tab is replaced (with an If-Match version check, keeping the
 * template's built-in boxes the API cannot write), and the draft's tags and aliases are added
 * to the template's. If filling fails, the page exists but is unfinished (`write_incomplete`);
 * "Finish the page" repeats only the filling steps, which never create anything.
 */

const APPROVAL_TTL_MS = 15 * 60 * 1000
const VERIFY_MARKER = 'Created by LK Companion to verify that it can create pages.'

export interface Blocker {
  code: string
  message: string
}

/** Configuration-level blockers that apply to every write. */
export function configBlockers(ctx: AppContext): Blocker[] {
  const config = ctx.config()
  const blockers: Blocker[] = []
  if (!config.lk.apiKey) blockers.push({ code: 'NO_KEY', message: 'No LegendKeeper API key is configured.' })
  if (!config.lk.allowWrites) {
    blockers.push({ code: 'WRITES_DISABLED', message: 'Writes are switched off (LKC_ALLOW_WRITES=false in .env.local). Remove that line or set it to true, then restart the app.' })
  }
  return blockers
}

export function draftBlockers(ctx: AppContext, draft: Draft): Blocker[] {
  const blockers = [...configBlockers(ctx)]
  const recipe = recipeForDraft(ctx, draft)
  if (!recipe) blockers.push({ code: 'NO_RECIPE', message: 'The draft has no recipe.' })
  else if (!recipe.allowCreate) {
    blockers.push({ code: 'RECIPE_NO_CREATE', message: `The recipe “${recipe.name}” does not allow creating pages. Turn on “Allow creation after approval” in the recipe, then re-run or re-validate.` })
  }
  if (draft.page.migration?.sourceResourceId) {
    blockers.push({ code: 'MIGRATION_DRAFT', message: 'This draft belongs to a template migration. It updates the existing page and is applied from its migration job; it is never created as a new page.' })
  }
  if (!['draft', 'awaiting_approval', 'write_failed'].includes(draft.status)) {
    blockers.push({ code: 'BAD_STATUS', message: `A draft in status “${draft.status}” cannot be written.` })
  }
  return blockers
}

function payloadHash(payload: CreatePageInput): string {
  const { idempotencyKey: _ignored, ...content } = payload
  return sha256Hex(stableStringify(content))
}

function renderFor(ctx: AppContext, draft: Draft, page: CanonicalPage, plannedResourceId: string) {
  const recipe = recipeForDraft(ctx, draft)!
  const pageType = resolvePageType(recipe)
  if (!pageType) throw new ServiceError(400, 'The recipe’s page type is not defined.')
  const { template } = templateForDraft(ctx, pageType, page, recipe)
  const provisional: CreatePageInput = buildCreatePayload(page, { pageType, template }, plannedResourceId, 'pending')
  const layout = template.lkLayout
  // Only set when used, so content fingerprints of plain pages are unchanged.
  if (layout?.sourceKind === 'template') provisional.templateId = layout.sourceResourceId
  const hash = payloadHash(provisional)
  const payload = { ...provisional, idempotencyKey: idempotencyKeyFor('lkc', plannedResourceId, hash.slice(0, 16)) }
  return { payload, hash }
}

// ── Step 1: prepare (final preview) ─────────────────────────────────────────

export interface PrepareOptions {
  /** Run every check but do not plan a page id or create an approval. Never writes. */
  dryRun?: boolean
  /** How long the approval stays valid (single pages: 15 minutes; batches: longer, re-checked before writing). */
  ttlMs?: number
  /** The live project, already confirmed by the caller (batches check the connection once). */
  project?: { id: string; name: string }
}

/** The final preview with a one-time approval token. */
export async function prepareWrite(ctx: AppContext, draftId: string, options: Omit<PrepareOptions, 'dryRun'> = {}) {
  const prepared = await prepareInternal(ctx, draftId, { ...options, dryRun: false })
  return { ...prepared, approvalToken: prepared.approvalToken!, expiresAt: prepared.expiresAt!, plannedResourceId: prepared.plannedResourceId! }
}

/** Every check of the final preview, without planning or approving anything. Never writes. */
export async function dryRunWrite(ctx: AppContext, draftId: string, options: Omit<PrepareOptions, 'dryRun'> = {}) {
  return prepareInternal(ctx, draftId, { ...options, dryRun: true })
}

async function prepareInternal(ctx: AppContext, draftId: string, options: PrepareOptions) {
  const draft = getDraft(ctx, draftId)
  const blockers = draftBlockers(ctx, draft)
  if (blockers.length) {
    if (options.dryRun) throw new ServiceError(409, 'Writing is not possible yet.', blockers.map((b) => b.message), 'BLOCKED')
    recordAudit(ctx, { operation: 'write.prepare', outcome: 'blocked', draftId, jobId: draft.jobId, message: blockers.map((b) => b.message).join(' '), details: { blockers } })
    throw new ServiceError(409, 'Writing is not possible yet.', blockers.map((b) => b.message), 'BLOCKED')
  }
  // A page made from a LegendKeeper template: read the template now, so the preview matches it.
  const synced = await syncTemplateLayout(ctx, draft)
  const recipe = recipeForDraft(ctx, draft)!
  const job = ctx.repos.jobs.get(draft.jobId)
  const { findings } = validateWithRender(ctx, draft.page, recipe, job)
  const errors = findings.filter((f) => f.severity === 'error')
  if (errors.length) throw new ServiceError(409, 'Fix the validation errors before writing.', errors.map((f) => f.message), 'INVALID')

  const connector = ctx.connector()
  // Confirm the connection live and that the key still points at the expected project.
  let project = options.project
  if (!project) {
    try {
      project = await connector.getProject()
      await connector.pingProject(project.id)
    } catch (error) {
      throw new ServiceError(502, `The LegendKeeper connection is not working: ${toConnectorError(error).message}`)
    }
  }
  const expected = knownProjectId(ctx)
  if (expected && expected !== project.id) {
    throw new ServiceError(409, `The API key now belongs to a different project (${project.name}) than the one this app was set up with. Test the connection again, then open the final preview again.`)
  }
  if (!expected) {
    ctx.repos.settings.set('lk.lastProjectId', project.id)
    ctx.repos.settings.set('lk.lastProjectName', project.name)
  }

  // Confirm the parent and every linked page exist.
  const page = structuredClone(draft.page)
  let parent: { id: string; name: string } | null = null
  if (page.parentId) {
    try {
      const resource = await connector.getResource(page.parentId)
      parent = { id: resource.id, name: resource.name }
    } catch (error) {
      throw new ServiceError(409, `The parent page could not be confirmed: ${toConnectorError(error).message}`)
    }
  }
  const missingLinks: string[] = []
  const links: { mention: string; resourceId: string; name: string }[] = []
  for (const ref of page.references) {
    if (ref.status !== 'resolved' || !ref.resourceId) continue
    try {
      const resource = await connector.getResource(ref.resourceId)
      ref.verifiedAt = ctx.now().toISOString()
      links.push({ mention: ref.mention, resourceId: resource.id, name: resource.name })
    } catch (error) {
      const failure = toConnectorError(error)
      missingLinks.push(`“${ref.mention}” → ${ref.resourceId}: ${failure.message}`)
    }
  }
  if (missingLinks.length) throw new ServiceError(409, 'Some linked pages could not be confirmed. Choose another page or leave them unresolved.', missingLinks)

  // Another chance to catch duplicates the index may not know about yet.
  const sameName: { id: string; path: string }[] = []
  try {
    for (const hit of await connector.search(page.name, 10)) {
      if (hit.name === page.name) sameName.push({ id: hit.resourceId, path: [...hit.path, hit.name].join(' / ') })
    }
  } catch {
    /* search is advisory only */
  }

  const warnings = findings.filter((f) => f.severity === 'warning').map((f) => f.message)
  for (const match of sameName) warnings.push(`LegendKeeper search found a page with the same name: ${match.path} (${match.id}).`)

  // Created from a LegendKeeper template: confirm it is still a template and say what it brings.
  const rendered = renderFor(ctx, draft, page, draft.plannedResourceId ?? 'a0000000000000000000000a')
  const fromTemplate = rendered.payload.templateId ? (synced?.template ?? null) : null
  // A template that adds nothing: say what the source has that the page will not show.
  const leftOut = notWrittenParts(ctx, draft, page)
  if (leftOut.length) warnings.push(`The template “${synced?.template.name ?? 'used'}” adds nothing of its own, so these are not written: ${leftOut.join(', ')}. Change the template's layout rules to add them, or add a box for them to the template in LegendKeeper.`)
  if (synced?.changed) warnings.push(`The template “${synced.template.name}” was changed in LegendKeeper since its layout was copied; this preview uses it as it is now.`)
  const placement = await planPlacement(ctx, recipe, page.parentId, rendered.payload.name).catch((error) => ({
    placement: null,
    description: `At the end (the pages beside it could not be read just now: ${toConnectorError(error).message})`,
  }))
  const finalTags = mergeLabels(fromTemplate?.tags ?? [], rendered.payload.tags)

  if (options.dryRun) {
    // Same checks and the same rendered content as a real preview, but nothing is planned or approved.
    const { payload, hash } = renderFor(ctx, draft, page, draft.plannedResourceId ?? 'a0000000000000000000000a')
    return {
      approvalToken: null as string | null,
      expiresAt: null as string | null,
      payloadHash: hash.slice(0, 16),
      project: { id: project.id, name: project.name },
      plannedResourceId: null as string | null,
      name: payload.name,
      parent,
      tags: page.tags.filter((t) => t.accepted && t.status !== 'rejected').map((t) => ({ value: t.existingMatch ?? t.value, status: t.status })),
      aliases: payload.aliases,
      links,
      documentName: payload.documentName,
      blocks: payload.blocks,
      bytes: payloadBytes(payload),
      warnings,
      sameName,
      fromTemplate,
      placement: placement.description,
      finalTags,
    }
  }

  const plannedResourceId = draft.plannedResourceId ?? newLkResourceId()
  const { payload, hash } = renderFor(ctx, draft, page, plannedResourceId)
  ctx.repos.drafts.setPlannedWrite(draft.id, plannedResourceId, payload.idempotencyKey)
  ctx.repos.drafts.setStatus(draft.id, draft.status, { page })
  const token = randomToken()
  const expiresAt = new Date(ctx.now().getTime() + (options.ttlMs ?? APPROVAL_TTL_MS)).toISOString()
  ctx.repos.drafts.setApproval(draft.id, token, hash, expiresAt)

  recordAudit(ctx, {
    operation: 'write.prepare',
    outcome: 'success',
    approval: 'not_approved',
    projectId: project.id,
    resourceId: plannedResourceId,
    draftId,
    jobId: draft.jobId,
    recipeId: draft.recipeId,
    recipeVersion: draft.recipeVersion,
    message: `Final preview for “${page.name}”`,
    details: { payloadHash: hash.slice(0, 16), bytes: payloadBytes(payload), warnings: warnings.length, templateId: payload.templateId ?? null },
  })

  return {
    approvalToken: token as string | null,
    expiresAt: expiresAt as string | null,
    payloadHash: hash.slice(0, 16),
    project: { id: project.id, name: project.name },
    plannedResourceId: plannedResourceId as string | null,
    name: payload.name,
    parent,
    tags: page.tags.filter((t) => t.accepted && t.status !== 'rejected').map((t) => ({ value: t.existingMatch ?? t.value, status: t.status })),
    aliases: payload.aliases,
    links,
    documentName: payload.documentName,
    blocks: payload.blocks,
    bytes: payloadBytes(payload),
    warnings,
    sameName,
    fromTemplate,
    placement: placement.description,
    finalTags,
  }
}

// ── Step 2: approve and write ───────────────────────────────────────────────

export async function approveWrite(ctx: AppContext, draftId: string, input: { approvalToken: string; acknowledgeWarnings: boolean }) {
  const draft = getDraft(ctx, draftId)
  if (draft.status !== 'awaiting_approval' || !draft.approvalToken || !draft.approvalPayloadHash || !draft.plannedResourceId) {
    throw new ServiceError(409, 'There is no pending approval for this draft. Open the final preview again.')
  }
  if (input.approvalToken !== draft.approvalToken) throw new ServiceError(409, 'This approval is not valid (it may have been replaced by a newer preview). Open the final preview again.')
  if (draft.approvalExpiresAt && Date.parse(draft.approvalExpiresAt) < ctx.now().getTime()) {
    throw new ServiceError(409, 'The approval has expired. Open the final preview again.')
  }

  const blockers = draftBlockers(ctx, draft)
  if (blockers.length) throw new ServiceError(409, 'Writing is not possible.', blockers.map((b) => b.message), 'BLOCKED')
  const recipe = recipeForDraft(ctx, draft)!
  const { findings } = validateWithRender(ctx, draft.page, recipe, ctx.repos.jobs.get(draft.jobId))
  if (findings.some((f) => f.severity === 'error')) throw new ServiceError(409, 'The draft has validation errors.', findings.filter((f) => f.severity === 'error').map((f) => f.message))
  if (findings.some((f) => f.severity === 'warning') && !input.acknowledgeWarnings) {
    throw new ServiceError(400, 'Acknowledge the warnings to approve this write.', [], 'WARNINGS_NOT_ACKNOWLEDGED')
  }

  const { payload, hash } = renderFor(ctx, draft, draft.page, draft.plannedResourceId)
  if (hash !== draft.approvalPayloadHash) {
    throw new ServiceError(409, 'The draft changed after the final preview. Open the preview again and re-approve.')
  }

  // From a template: it must still be as it was at the final preview (otherwise nothing is created).
  if (payload.templateId) {
    const { resource, blocks } = await readTemplate(ctx, payload.templateId)
    const layout = templateForDraft(ctx, resolvePageType(recipe)!, draft.page, recipe).template.lkLayout
    if (!layout || stableStringify(skeletonFromBlocks(blocks).blocks) !== stableStringify(layout.blocks)) {
      throw new ServiceError(409, `The template “${resource.name}” was changed in LegendKeeper after the final preview. Open the final preview again.`)
    }
  }

  // Exactly one request can move the draft from awaiting_approval to writing.
  if (!ctx.repos.drafts.claimForWrite(draft.id, input.approvalToken)) {
    throw new ServiceError(409, 'This write has already been started.')
  }
  const projectId = knownProjectId(ctx)
  const auditBase = { draftId, jobId: draft.jobId, recipeId: draft.recipeId, recipeVersion: draft.recipeVersion, projectId, resourceId: draft.plannedResourceId, model: draft.page.processing?.servedByModel ?? draft.page.processing?.model ?? null }
  recordAudit(ctx, { ...auditBase, operation: 'write.approve', outcome: 'info', approval: 'approved', message: `Approved creation of “${payload.name}”`, details: { payloadHash: hash.slice(0, 16), idempotencyKey: payload.idempotencyKey } })

  // Position among siblings, decided now (read-only). If it cannot be worked out, the page goes last.
  const placement = await planPlacement(ctx, recipe, payload.parentId, payload.name).catch(() => ({ placement: null, description: 'At the end' }))
  const anchor = placement.placement?.before ?? placement.placement?.after
  // The body includes the position, so a different position needs its own Idempotency-Key.
  const idempotencyKey = anchor ? idempotencyKeyFor(payload.idempotencyKey, anchor) : payload.idempotencyKey

  try {
    if (payload.templateId) {
      const created = await ctx.connector().createFromTemplate({
        templateId: payload.templateId,
        resourceId: payload.resourceId,
        name: payload.name,
        parentId: payload.parentId,
        idempotencyKey,
        placement: placement.placement,
      })
      recordAudit(ctx, { ...auditBase, resourceId: created.id, operation: 'write.create_from_template', outcome: 'success', approval: 'approved', message: `Created “${created.name}” (${created.id}) as a copy of the template ${payload.templateId}`, details: { templateId: payload.templateId, placement: placement.description, idempotencyKey } })
      return await fillFromTemplate(ctx, draft.id, created.id, payload, auditBase, 'Created from the LegendKeeper template')
    }
    const created = await ctx.connector().createPage({ ...payload, idempotencyKey, placement: placement.placement })
    return await finishCreated(ctx, draft.id, created, payload, auditBase, 'Created')
  } catch (error) {
    return await handleWriteFailure(ctx, draft.id, toConnectorError(error), payload, auditBase)
  }
}

// ── Pages created from a LegendKeeper template ─────────────────────────────

export interface TemplateUse {
  id: string
  name: string
  tabs: { name: string; type: string }[]
  /** The page tab the draft's content goes into (the template's first page tab). */
  filledTab: string
  sidebarProperties: number
  tags: string[]
  aliases: string[]
  /** Parts of that tab the API cannot write (built-in Tags/Aliases boxes, empty image slots); the page keeps them as they are. */
  keptBoxes: string[]
}

type AnyBlock = Record<string, unknown>

/** The template and its first page tab, as LegendKeeper has them now. Read-only. */
async function readTemplate(ctx: AppContext, templateId: string) {
  let resource: ResourceDetail
  try {
    resource = await ctx.connector().getResource(templateId)
  } catch (error) {
    throw new ServiceError(409, `The LegendKeeper template ${templateId} could not be read: ${toConnectorError(error).message} Copy another template's layout on the Recipes & templates page if it was deleted.`)
  }
  if (!(await isLkTemplate(ctx, resource))) {
    throw new ServiceError(409, `“${resource.name}” is no longer a LegendKeeper template. Copy the layout of another template on the Recipes & templates page.`)
  }
  const tab = firstPageTab(resource)
  if (!tab) throw new ServiceError(409, `The LegendKeeper template “${resource.name}” has no page tab for the content.`)
  let blocks: unknown[]
  try {
    blocks = (await ctx.connector().getDocumentContent(resource.id, tab.id)).blocks
  } catch (error) {
    throw new ServiceError(502, `The template “${resource.name}” could not be read: ${toConnectorError(error).message}`)
  }
  return { resource, tab, blocks }
}

/** Parts of a tab the API cannot write, by name. */
function unwritableParts(blocks: unknown): string[] {
  const parts: string[] = []
  const visit = (value: unknown) => {
    if (Array.isArray(value)) return value.forEach(visit)
    if (!value || typeof value !== 'object') return
    const block = value as AnyBlock
    if (block.kind === 'unsupported') parts.push(typeof block.title === 'string' && block.title ? block.title : 'a built-in box')
    else if (isEmptyImage(block)) parts.push(`the empty ${typeof block.title === 'string' && block.title ? block.title : 'image'} slot`)
    else Object.values(block).forEach(visit)
  }
  visit(blocks)
  return parts
}

/**
 * Keeps the local copy of the template's layout in step with the template in LegendKeeper, so the
 * final preview shows exactly what will be written into the new page. Read-only towards
 * LegendKeeper. Null when the draft's template is not a LegendKeeper template.
 */
async function syncTemplateLayout(ctx: AppContext, draft: Draft): Promise<{ template: TemplateUse; changed: boolean } | null> {
  const recipe = recipeForDraft(ctx, draft)
  const pageType = recipe ? resolvePageType(recipe) : null
  if (!recipe || !pageType) return null
  const { record, template } = templateForDraft(ctx, pageType, draft.page, recipe)
  const layout = template.lkLayout
  if (!layout || layout.sourceKind !== 'template') return null
  const { resource, tab, blocks } = await readTemplate(ctx, layout.sourceResourceId)
  const fresh = skeletonFromBlocks(blocks)
  const changed = stableStringify(fresh.blocks) !== stableStringify(layout.blocks)
  if (changed && record && record.origin === 'local') {
    ctx.repos.templates.update(record.id, { ...record.definition, lkLayout: { ...layout, sourceName: resource.name, documentName: tab.name, blocks: fresh.blocks, droppedParts: fresh.droppedParts, fetchedAt: ctx.now().toISOString() } })
    recordAudit(ctx, { operation: 'template.refresh', outcome: 'success', draftId: draft.id, message: `${record.definition.name} ← ${resource.name} (changed in LegendKeeper; refreshed for the final preview)`, details: { templateId: record.id, sourceResourceId: resource.id } })
  }
  return {
    changed,
    template: {
      id: resource.id,
      name: resource.name,
      tabs: resource.documents.map((d) => ({ name: d.name, type: d.type })),
      filledTab: tab.name,
      sidebarProperties: resource.properties.length,
      tags: resource.tags,
      aliases: resource.aliases,
      keptBoxes: unwritableParts(blocks),
    },
  }
}

function firstPageTab(resource: ResourceDetail) {
  return [...resource.documents].filter((d) => d.type === 'page').sort((a, b) => ((a.rank ?? '') < (b.rank ?? '') ? -1 : (a.rank ?? '') > (b.rank ?? '') ? 1 : 0))[0] ?? null
}

/** What the draft has that its template leaves no place for (only when the template adds nothing). */
function notWrittenParts(ctx: AppContext, draft: Draft, page: CanonicalPage): string[] {
  const recipe = recipeForDraft(ctx, draft)
  const pageType = recipe ? resolvePageType(recipe) : null
  if (!recipe || !pageType) return []
  const { template } = templateForDraft(ctx, pageType, page, recipe)
  if (!template.lkLayout || template.layoutRules.additions !== 'none') return []
  const report = { leftOut: [] as string[] }
  renderFromLayout(page, pageType, template.lkLayout, template.includeSourcesSection, { rules: template.layoutRules, report })
  return report.leftOut
}

/** The draft laid out in the blocks of the template copy itself (ids kept, image slots kept). */
function renderIntoCopy(ctx: AppContext, draft: Draft, copyBlocks: unknown[]): unknown[] {
  const recipe = recipeForDraft(ctx, draft)!
  const pageType = resolvePageType(recipe)!
  const { template } = templateForDraft(ctx, pageType, draft.page, recipe)
  return renderFromLayout(draft.page, pageType, { ...template.lkLayout!, blocks: copyBlocks as AnyBlock[] }, template.includeSourcesSection, { keepEmptyImages: true, rules: template.layoutRules })
}

/** Union, keeping order, ignoring case for duplicates. */
export function mergeLabels(first: string[], second: string[]): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (const value of [...first, ...second]) {
    const key = value.trim().toLowerCase()
    if (!key || seen.has(key)) continue
    seen.add(key)
    out.push(value)
  }
  return out
}

const FILL_PLAN = (draftId: string) => `write.templateFill.${draftId}`

/** A fill in progress: the edits worked out once, and how many are done (so it can resume). */
interface FillState {
  resourceId: string
  documentId: string
  ops: FillOp[]
  done: number
}

/** One edit. Returns the new document version, or null when LegendKeeper gives none (deletes). */
async function applyFillOp(connector: ReturnType<AppContext['connector']>, resourceId: string, documentId: string, op: FillOp, version: string): Promise<string | null> {
  // An edit repeated after its reply was lost finds itself already done: that counts as done.
  const already = (error: unknown, kind: 'duplicate_id' | 'not_found') => error instanceof ConnectorError && error.kind === kind
  switch (op.op) {
    case 'replaceAll':
      return (await connector.replaceDocumentBlocks(resourceId, documentId, op.blocks, version)).version
    case 'replace':
      return (await connector.replaceBlock(resourceId, documentId, op.blockId, op.block, version)).version
    case 'update':
      return (await connector.updateBlock(resourceId, documentId, op.blockId, op.patch, version)).version
    case 'updateProperty':
      return (await connector.updateInfoboxProperty(resourceId, documentId, op.blockId, op.propertyId, op.patch, version)).version
    case 'insert':
      try {
        return (await connector.insertBlock(resourceId, documentId, { block: op.block, after: op.after, before: op.before, parent: op.parent }, version)).version
      } catch (error) {
        if (already(error, 'duplicate_id')) return null
        throw error
      }
    case 'createProperty':
      try {
        return (await connector.createInfoboxProperty(resourceId, documentId, op.blockId, op.property, version)).version
      } catch (error) {
        if (already(error, 'duplicate_id')) return null
        throw error
      }
    case 'delete':
      try {
        await connector.deleteBlock(resourceId, documentId, op.blockId, version)
      } catch (error) {
        if (!already(error, 'not_found')) throw error
      }
      return null
    case 'deleteProperty':
      try {
        await connector.deleteInfoboxProperty(resourceId, documentId, op.blockId, op.propertyId, version)
      } catch (error) {
        if (!already(error, 'not_found')) throw error
      }
      return null
  }
}

const describeOp = (op: FillOp) =>
  op.op === 'replaceAll' ? 'writing the page tab' : op.op === 'delete' || op.op === 'deleteProperty' ? `removing the template's ${op.label}` : op.op === 'insert' || op.op === 'createProperty' ? `adding ${op.label}` : `filling ${op.label}`

/**
 * Fills a page just created as a copy of a template, in place: the draft is laid out in the
 * copy's own blocks (so the template's order, image slots and built-in boxes stay exactly as
 * they are), checked against the approved content, and written as small edits (see
 * core/template-fill.ts), each with the document version it expects. Then the draft's tags and
 * aliases are added. Never creates the page, so it is safe to repeat; a fill that stopped
 * resumes where it stopped. Reads the page back at the end.
 */
async function fillFromTemplate(ctx: AppContext, draftId: string, resourceId: string, payload: CreatePageInput, auditBase: AuditBase, label: string) {
  const connector = ctx.connector()
  let step = 'reading the new page'
  let writes = 0
  try {
    const resource = await connector.getResource(resourceId)
    const tab = firstPageTab(resource)
    if (!tab) throw new Error('The new page has no page tab to fill.')
    let state = ctx.repos.settings.get<FillState>(FILL_PLAN(draftId))
    let version: string | null = null
    if (!state || state.resourceId !== resourceId) {
      step = 'reading its page tab'
      let content = await connector.getDocumentContent(resourceId, tab.id)
      // Ids are only needed to edit block by block, which only a tab with an empty image slot
      // needs; otherwise the whole tab is written at once.
      if (hasUnwritable(content.blocks) && !hasAllIds(content.blocks)) {
        step = 'preparing its page tab'
        await connector.assignBlockIds(resourceId, tab.id)
        writes++
        content = await connector.getDocumentContent(resourceId, tab.id)
      }
      step = 'working out the changes'
      const desired = renderIntoCopy(ctx, getDraft(ctx, draftId), content.blocks)
      if (comparableContent(desired) !== comparableContent(payload.blocks)) {
        throw new Error('The template was changed in LegendKeeper after the final preview, so the page was not filled (nothing of the template was removed). Fill it in LegendKeeper, or delete it there and import again.')
      }
      state = { resourceId, documentId: tab.id, ops: planFill(content.blocks, desired, newBlockId), done: 0 }
      ctx.repos.settings.set(FILL_PLAN(draftId), state)
      version = content.version
    }
    while (state.done < state.ops.length) {
      const op = state.ops[state.done]!
      step = describeOp(op)
      if (version === null) version = (await connector.getDocumentContent(resourceId, state.documentId)).version
      version = await applyFillOp(connector, resourceId, state.documentId, op, version)
      writes++
      state = { ...state, done: state.done + 1 }
      ctx.repos.settings.set(FILL_PLAN(draftId), state)
    }
    step = 'adding the tags and aliases'
    const current = await connector.getResource(resourceId)
    const tags = mergeLabels(current.tags, payload.tags)
    const aliases = mergeLabels(current.aliases, payload.aliases)
    if (stableStringify(tags) !== stableStringify(current.tags) || stableStringify(aliases) !== stableStringify(current.aliases)) {
      await connector.updateResourceLabels(resourceId, { tags, aliases })
      writes++
    }
    ctx.repos.settings.set(FILL_PLAN(draftId), null)
    recordAudit(ctx, { ...auditBase, resourceId, operation: 'write.fill', outcome: 'success', approval: 'approved', message: `Filled “${current.name}” in place: ${state.ops.length} edit(s) to its page tab`, details: { edits: state.ops.map(describeOp), writes } })
    const created: CreatedPage = { resourceId, name: current.name, parentId: current.parentId, tags, documentId: state.documentId, documentType: 'page' }
    return await finishCreated(ctx, draftId, created, { ...payload, tags, aliases }, auditBase, label)
  } catch (error) {
    const failure = error instanceof ConnectorError ? error : new ConnectorError('unknown', error instanceof Error ? error.message : String(error), { outcome: 'not_applied' })
    const message = `The page was created from the template (${resourceId}), but ${step} did not finish: ${failure.message} Nothing else was created. Use “Finish the page” to carry on from there.`
    const draft = getDraft(ctx, draftId)
    ctx.repos.drafts.setStatus(draftId, 'write_incomplete', { writeError: message, createdResourceId: resourceId, page: { ...draft.page, lkResourceId: resourceId } })
    recordAudit(ctx, { ...auditBase, resourceId, operation: 'write.fill', outcome: 'failure', approval: 'approved', errorCode: failure.details.code ?? failure.kind, requestId: failure.details.requestId ?? null, message })
    return { status: 'write_incomplete' as const, resourceId, message, issues: failure.details.issues ?? [] }
  }
}

/** Repeats the filling steps for a page created from a template whose filling did not finish. */
export async function finishTemplatePage(ctx: AppContext, draftId: string) {
  const draft = getDraft(ctx, draftId)
  if (draft.status !== 'write_incomplete' || !draft.createdResourceId || !draft.plannedResourceId) throw new ServiceError(409, 'There is no unfinished page for this draft.')
  const { payload, hash } = renderFor(ctx, draft, draft.page, draft.plannedResourceId)
  if (draft.approvalPayloadHash && hash !== draft.approvalPayloadHash) {
    throw new ServiceError(409, 'The draft changed after it was approved, so the approved content no longer matches. Undo the change, or finish the page in LegendKeeper by hand.')
  }
  const auditBase = { draftId, jobId: draft.jobId, recipeId: draft.recipeId, recipeVersion: draft.recipeVersion, projectId: knownProjectId(ctx), resourceId: draft.createdResourceId, model: null }
  recordAudit(ctx, { ...auditBase, operation: 'write.fill', outcome: 'info', approval: 'approved', message: 'Finishing a page created from a template' })
  return fillFromTemplate(ctx, draftId, draft.createdResourceId, payload, auditBase, 'Finished the page created from the template')
}

// ── Position among siblings ────────────────────────────────────────────────

const byRank = (a: { rank: string | null }, b: { rank: string | null }) => {
  // LegendKeeper compares ranks as plain strings (not locale order).
  const x = a.rank ?? '\uffff'
  const y = b.rank ?? '\uffff'
  return x < y ? -1 : x > y ? 1 : 0
}

/**
 * Where the new page goes. `alphabetical`: before the first sibling (in LegendKeeper's order)
 * whose name sorts after it; otherwise last. Read-only.
 */
export async function planPlacement(ctx: AppContext, recipe: Pick<RecipeDefinition, 'placement'>, parentId: string | null, name: string): Promise<{ placement: Placement | null; description: string }> {
  if (recipe.placement !== 'alphabetical') return { placement: null, description: 'After the last page beside it' }
  const siblings: { id: string; name: string; rank: string | null }[] = []
  let cursor: string | null = null
  for (let page = 0; page < 30; page++) {
    const result = await ctx.connector().listResources({ parentId, cursor, limit: 100 })
    siblings.push(...result.items.filter((item) => (item.parentId ?? null) === parentId))
    if (!result.hasMore || !result.nextCursor) break
    cursor = result.nextCursor
  }
  siblings.sort(byRank)
  const next = siblings.find((s) => s.name.localeCompare(name, 'en', { sensitivity: 'base', numeric: true }) > 0)
  return next ? { placement: { before: next.id }, description: `Alphabetical: before “${next.name}”` } : { placement: null, description: 'Alphabetical: after the last page beside it' }
}

type AuditBase = { draftId: string; jobId: string; recipeId: string | null; recipeVersion: number | null; projectId: string | null; resourceId: string | null; model: string | null }

async function handleWriteFailure(ctx: AppContext, draftId: string, failure: ConnectorError, payload: CreatePageInput, auditBase: AuditBase) {
  const failed = { errorCode: failure.details.code ?? failure.kind, requestId: failure.details.requestId ?? null }

  if (failure.kind === 'duplicate_id' || failure.details.outcome === 'unknown') {
    // The page may exist (an earlier attempt succeeded, or this one did before the reply was lost).
    // Find out by reading — never by writing again.
    const existence = await checkExists(ctx, payload.resourceId)
    if (existence.exists && existence.created) {
      if (payload.templateId) return fillFromTemplate(ctx, draftId, payload.resourceId, payload, auditBase, 'Created from the LegendKeeper template (confirmed after an uncertain reply)')
      return finishCreated(ctx, draftId, existence.created, payload, auditBase, 'Created (confirmed after an uncertain reply)')
    }
    if (existence.exists === false && failure.kind !== 'duplicate_id') {
      const message = `The write did not go through: ${failure.message} LegendKeeper confirms the page does not exist, so it is safe to approve again.`
      ctx.repos.drafts.setStatus(draftId, 'write_failed', { writeError: message })
      recordAudit(ctx, { ...auditBase, ...failed, operation: 'write.create', outcome: 'failure', approval: 'approved', message })
      return { status: 'write_failed' as const, message, issues: failure.details.issues ?? [] }
    }
    const message =
      failure.kind === 'duplicate_id'
        ? 'LegendKeeper says a resource with this draft’s ID already exists, but this key cannot read it. It may be a deleted page in the trash, or hidden from this key. Check LegendKeeper; if the page is not there, use “Assign a new page ID”.'
        : `The outcome is uncertain: ${failure.message} The app will not retry automatically. Use “Check outcome” to see whether the page was created.`
    ctx.repos.drafts.setStatus(draftId, 'write_uncertain', { writeError: message })
    recordAudit(ctx, { ...auditBase, ...failed, operation: 'write.create', outcome: 'uncertain', approval: 'approved', message })
    return { status: 'write_uncertain' as const, message, issues: [] }
  }

  const message = `LegendKeeper refused the write. Nothing was created. ${failure.message}`
  ctx.repos.drafts.setStatus(draftId, 'write_failed', { writeError: message })
  recordAudit(ctx, { ...auditBase, ...failed, operation: 'write.create', outcome: 'failure', approval: 'approved', message, details: { issues: failure.details.issues ?? [] } })
  return { status: 'write_failed' as const, message, issues: failure.details.issues ?? [] }
}

async function checkExists(ctx: AppContext, resourceId: string): Promise<{ exists: boolean | null; created?: CreatedPage }> {
  try {
    const resource = await ctx.connector().getResource(resourceId)
    const document = resource.documents[0]
    return {
      exists: true,
      created: { resourceId: resource.id, name: resource.name, parentId: resource.parentId, tags: resource.tags, documentId: document?.id ?? null, documentType: document?.type ?? null },
    }
  } catch (error) {
    const failure = toConnectorError(error)
    return { exists: failure.kind === 'not_found' ? false : null }
  }
}

/** Records a created page, reads it back, and closes the import. */
async function finishCreated(ctx: AppContext, draftId: string, created: CreatedPage, payload: CreatePageInput, auditBase: AuditBase, label: string) {
  const readback = await readBack(ctx, created)
  const draft = getDraft(ctx, draftId)
  const page = { ...draft.page, lkResourceId: created.resourceId }
  ctx.repos.drafts.setStatus(draftId, 'created', {
    writeError: null,
    createdResourceId: created.resourceId,
    createdDocumentId: created.documentId,
    createdVersion: readback.version,
    page,
  })
  ctx.repos.jobs.update(draft.jobId, { status: 'completed' })
  ctx.repos.jobs.purgeSource(draft.jobId)
  recordFirstWrite(ctx, created, readback)

  const mismatches: string[] = []
  if (readback.name !== null && readback.name !== payload.name) mismatches.push(`name is “${readback.name}”`)
  if (readback.parentId !== undefined && (readback.parentId ?? null) !== (payload.parentId ?? null)) mismatches.push('parent differs')
  if (readback.tags && stableStringify([...readback.tags].sort()) !== stableStringify([...payload.tags].sort())) mismatches.push('tags differ')
  recordAudit(ctx, {
    ...auditBase,
    resourceId: created.resourceId,
    operation: 'write.create',
    outcome: 'success',
    approval: 'approved',
    message: `${label}: “${payload.name}” (${created.resourceId})`,
    details: { documentId: created.documentId, version: readback.version, readbackError: readback.error, mismatches, blocks: readback.blockCount, idempotencyKey: payload.idempotencyKey },
  })
  return { status: 'created' as const, resourceId: created.resourceId, documentId: created.documentId, version: readback.version, readback, mismatches, acceptedTags: acceptedTags(page) }
}

/** The first page created (and read back) for a project with this SDK version confirms that writing works there. */
function recordFirstWrite(ctx: AppContext, created: CreatedPage, readback: { error: string | null; version: string | null }) {
  const projectId = knownProjectId(ctx)
  if (!projectId || readback.error !== null || ctx.repos.verifications.latest(projectId, ctx.sdkVersion)) return
  ctx.repos.verifications.insert({
    id: newAppId('ver'),
    projectId,
    sdkVersion: ctx.sdkVersion,
    resourceId: created.resourceId,
    documentId: created.documentId,
    details: { name: created.name, method: 'first_write', version: readback.version },
  })
}

async function readBack(ctx: AppContext, created: CreatedPage) {
  try {
    const resource = await ctx.connector().getResource(created.resourceId)
    const documentId = created.documentId ?? resource.documents[0]?.id ?? null
    const content = documentId ? await ctx.connector().getDocumentContent(created.resourceId, documentId) : null
    return {
      name: resource.name,
      parentId: resource.parentId,
      tags: resource.tags,
      version: content?.version ?? null,
      text: content?.text ?? null,
      blockCount: content?.blocks.length ?? null,
      error: null as string | null,
    }
  } catch (error) {
    return { name: null, parentId: undefined, tags: null, version: null, text: null, blockCount: null, error: toConnectorError(error).message }
  }
}

// ── Checking an uncertain outcome ───────────────────────────────────────────

export async function checkOutcome(ctx: AppContext, draftId: string) {
  const draft = getDraft(ctx, draftId)
  if (!['write_uncertain', 'write_failed'].includes(draft.status) || !draft.plannedResourceId) {
    throw new ServiceError(409, 'There is no write outcome to check for this draft.')
  }
  const existence = await checkExists(ctx, draft.plannedResourceId)
  const auditBase = { draftId, jobId: draft.jobId, recipeId: draft.recipeId, recipeVersion: draft.recipeVersion, projectId: knownProjectId(ctx), resourceId: draft.plannedResourceId, model: null }
  if (existence.exists && existence.created) {
    const planned = recipeForDraft(ctx, draft) ? renderFor(ctx, draft, draft.page, draft.plannedResourceId).payload : null
    if (planned?.templateId) {
      // Created from a template: whether it was filled is not known, and filling is a write, so
      // leave that to "Finish the page".
      const message = `The page exists (${draft.plannedResourceId}): it was created from the template. Use “Finish the page” to make sure its content, tags and aliases were filled.`
      ctx.repos.drafts.setStatus(draftId, 'write_incomplete', { writeError: message, createdResourceId: draft.plannedResourceId })
      recordAudit(ctx, { ...auditBase, operation: 'write.check_outcome', outcome: 'info', message })
      return { status: 'write_incomplete' as const, resourceId: draft.plannedResourceId, message }
    }
    const recipe = recipeForDraft(ctx, draft)
    const pageType = recipe ? resolvePageType(recipe) : null
    const payload: CreatePageInput =
      pageType && recipe
        ? buildCreatePayload(draft.page, { pageType, template: templateForDraft(ctx, pageType, draft.page, recipe).template }, draft.plannedResourceId, draft.idempotencyKey ?? '')
        : { resourceId: draft.plannedResourceId, name: draft.page.name, parentId: draft.page.parentId, tags: acceptedTags(draft.page), aliases: draft.page.aliases, documentName: 'Main', blocks: [], idempotencyKey: draft.idempotencyKey ?? '' }
    return finishCreated(ctx, draftId, existence.created, payload, auditBase, 'Confirmed created by outcome check')
  }
  if (existence.exists === false) {
    const message = `LegendKeeper reports no readable page with ID ${draft.plannedResourceId}. You can open the final preview and approve again; the same page ID is reused, so a duplicate is impossible. (If LegendKeeper said the ID is already taken, it may belong to a deleted page: check, then use “Assign a new page ID”.)`
    ctx.repos.drafts.setStatus(draftId, 'write_failed', { writeError: message })
    recordAudit(ctx, { ...auditBase, operation: 'write.check_outcome', outcome: 'info', message })
    return { status: 'write_failed' as const, message }
  }
  const message = 'Could not reach LegendKeeper to check the outcome. Try again later; nothing will be retried automatically.'
  recordAudit(ctx, { ...auditBase, operation: 'write.check_outcome', outcome: 'uncertain', message })
  return { status: draft.status, message }
}

/**
 * Gives a draft a fresh planned page ID. Only for the rare case where LegendKeeper says the
 * planned ID is taken but no such page can be read (e.g. it was deleted and sits in the
 * trash). Requires the user to confirm they checked LegendKeeper, because a new ID removes
 * the guarantee that this draft cannot create a second page.
 */
export function assignNewPlannedId(ctx: AppContext, draftId: string, input: { confirmCheckedLegendKeeper: boolean }) {
  const draft = getDraft(ctx, draftId)
  if (!['write_uncertain', 'write_failed'].includes(draft.status)) throw new ServiceError(409, 'Only a draft whose write failed or is uncertain can get a new page ID.')
  if (!input.confirmCheckedLegendKeeper) throw new ServiceError(400, 'Confirm that you checked LegendKeeper and the page does not exist.')
  const previous = draft.plannedResourceId
  const next = newLkResourceId()
  ctx.repos.drafts.setPlannedWrite(draft.id, next, idempotencyKeyFor('lkc', next, 'pending'))
  ctx.repos.drafts.setStatus(draft.id, 'write_failed', { writeError: 'A new page ID was assigned. Open the final preview to approve again.' })
  recordAudit(ctx, { operation: 'write.new_planned_id', outcome: 'info', draftId, jobId: draft.jobId, resourceId: next, message: `Replaced planned ID ${previous ?? '(none)'} after the user confirmed the page does not exist` })
  return { plannedResourceId: next }
}

// ── Write capability check ──────────────────────────────────────────────────

/**
 * Verifies that page creation works against this project: creates one clearly named test
 * page under the configured sandbox parent, then reads it back. The test page is left in
 * place for you to inspect and delete in LegendKeeper (Phase 1 never deletes anything).
 */
export async function verifyWriteCapability(ctx: AppContext, input: { confirm: boolean }) {
  if (!input.confirm) throw new ServiceError(400, 'Confirm that a test page may be created.')
  const blockers = configBlockers(ctx)
  const sandboxParentId = ctx.config().lk.sandboxParentId
  if (!sandboxParentId) blockers.push({ code: 'NO_SANDBOX', message: 'Set LKC_SANDBOX_PARENT_ID in .env.local to the ID of a page that can hold test pages, then restart.' })
  if (blockers.length) throw new ServiceError(409, 'The write check cannot run yet.', blockers.map((b) => b.message), 'BLOCKED')

  const connector = ctx.connector()
  let project
  let sandbox
  try {
    project = await connector.getProject()
    await connector.pingProject(project.id)
    sandbox = await connector.getResource(sandboxParentId!)
  } catch (error) {
    const failure = toConnectorError(error)
    throw new ServiceError(502, failure.kind === 'not_found' ? `The sandbox parent ${sandboxParentId} was not found: ${failure.message}` : failure.message)
  }
  ctx.repos.settings.set('lk.lastProjectId', project.id)
  ctx.repos.settings.set('lk.lastProjectName', project.name)

  const plannedResourceId = newLkResourceId()
  const stamp = ctx.now().toISOString().slice(0, 16).replace('T', ' ')
  const payload: CreatePageInput = {
    resourceId: plannedResourceId,
    name: `LK Companion write check ${stamp}`,
    parentId: sandbox.id,
    tags: [],
    aliases: [],
    documentName: 'Main',
    blocks: [p(`${VERIFY_MARKER} Safe to delete.`)],
    idempotencyKey: idempotencyKeyFor('lkc-verify', plannedResourceId),
  }
  const auditBase = { projectId: project.id, resourceId: plannedResourceId }
  recordAudit(ctx, { ...auditBase, operation: 'write.verify', outcome: 'info', approval: 'approved', message: `Write check approved under “${sandbox.name}”` })

  let created: CreatedPage
  try {
    created = await connector.createPage(payload)
  } catch (error) {
    const failure = toConnectorError(error)
    if (failure.details.outcome === 'unknown') {
      const existence = await checkExists(ctx, plannedResourceId)
      if (!existence.exists || !existence.created) {
        recordAudit(ctx, { ...auditBase, operation: 'write.verify', outcome: existence.exists === false ? 'failure' : 'uncertain', approval: 'approved', errorCode: failure.details.code ?? failure.kind, requestId: failure.details.requestId ?? null, message: failure.message })
        throw new ServiceError(502, `The write check did not complete: ${failure.message}`)
      }
      created = existence.created
    } else {
      recordAudit(ctx, { ...auditBase, operation: 'write.verify', outcome: 'failure', approval: 'approved', errorCode: failure.details.code ?? failure.kind, requestId: failure.details.requestId ?? null, message: failure.message, details: { issues: failure.details.issues } })
      throw new ServiceError(failure.kind === 'permission' ? 403 : 502, `The write check failed: ${failure.message}`, (failure.details.issues ?? []).map((i) => `${i.path}: ${i.message}`))
    }
  }

  const readback = await readBack(ctx, created)
  const ok = readback.error === null && (readback.text ?? '').includes(VERIFY_MARKER) && readback.parentId === sandbox.id
  if (!ok) {
    recordAudit(ctx, { ...auditBase, operation: 'write.verify', outcome: 'failure', approval: 'approved', message: 'Created, but reading it back did not match', details: { readback } })
    throw new ServiceError(502, `A test page was created (${created.resourceId}) but reading it back did not match what was written. Page creation stays disabled. ${readback.error ?? ''}`)
  }
  ctx.repos.verifications.insert({
    id: newAppId('ver'),
    projectId: project.id,
    sdkVersion: ctx.sdkVersion,
    resourceId: created.resourceId,
    documentId: created.documentId,
    details: { name: payload.name, sandboxParentId: sandbox.id, version: readback.version },
  })
  recordAudit(ctx, { ...auditBase, resourceId: created.resourceId, operation: 'write.verify', outcome: 'success', approval: 'approved', message: `Write check passed: created and read back “${payload.name}”`, details: { documentId: created.documentId, version: readback.version } })
  return { resourceId: created.resourceId, name: payload.name, sandbox: { id: sandbox.id, name: sandbox.name }, version: readback.version }
}
