import 'server-only'
import { p } from '@legendkeeper/sdk/blocks'
import { idempotencyKeyFor, newAppId, newLkResourceId } from '@/core/ids'
import { acceptedTags, type CanonicalPage } from '@/core/page-model'
import { resolvePageType, resolveTemplate } from '@/core/resolve'
import type { AppContext } from '../context'
import type { Draft } from '../db/repositories'
import { ConnectorError, toConnectorError } from '../lk/errors'
import { buildCreatePayload, payloadBytes } from '../lk/render'
import type { CreatePageInput, CreatedPage } from '../lk/types'
import { randomToken, sha256Hex, stableStringify } from '../hash'
import { recordAudit } from './audit'
import { knownProjectId } from './connection'
import { getDraft, recipeForDraft, validateWithRender } from './drafts'
import { ServiceError } from './errors'

/**
 * Guarded single-page creation.
 *
 * Nothing reaches LegendKeeper unless every one of these holds:
 *  1. Writes are switched on in configuration (LKC_ALLOW_WRITES=true).
 *  2. Page creation has been verified against this project with this SDK version
 *     (the "write check", which creates one clearly named test page under a sandbox parent).
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
    blockers.push({ code: 'WRITES_DISABLED', message: 'Writes are switched off. Set LKC_ALLOW_WRITES=true in .env.local and restart the app to enable them.' })
  }
  return blockers
}

export function verificationBlocker(ctx: AppContext): Blocker | null {
  const projectId = knownProjectId(ctx)
  if (!projectId) return { code: 'NOT_CONNECTED', message: 'Test the LegendKeeper connection first.' }
  const verification = ctx.repos.verifications.latest(projectId, ctx.sdkVersion)
  if (!verification) {
    return {
      code: 'WRITE_NOT_VERIFIED',
      message: `Page creation has not been verified for this project with SDK ${ctx.sdkVersion}. Run the write check on the Connection page first.`,
    }
  }
  return null
}

export function draftBlockers(ctx: AppContext, draft: Draft): Blocker[] {
  const blockers = [...configBlockers(ctx)]
  const verification = verificationBlocker(ctx)
  if (verification) blockers.push(verification)
  const recipe = recipeForDraft(ctx, draft)
  if (!recipe) blockers.push({ code: 'NO_RECIPE', message: 'The draft has no recipe.' })
  else if (!recipe.allowCreate) {
    blockers.push({ code: 'RECIPE_NO_CREATE', message: `The recipe “${recipe.name}” does not allow creating pages. Turn on “Allow creation after approval” in the recipe, then re-run or re-validate.` })
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
  const template = resolveTemplate(pageType, recipe.templateId ? ctx.repos.templates.get(recipe.templateId) : null)
  const provisional = buildCreatePayload(page, { pageType, template }, plannedResourceId, 'pending')
  const hash = payloadHash(provisional)
  const payload = { ...provisional, idempotencyKey: idempotencyKeyFor('lkc', plannedResourceId, hash.slice(0, 16)) }
  return { payload, hash }
}

// ── Step 1: prepare (final preview) ─────────────────────────────────────────

export async function prepareWrite(ctx: AppContext, draftId: string) {
  const draft = getDraft(ctx, draftId)
  const blockers = draftBlockers(ctx, draft)
  if (blockers.length) {
    recordAudit(ctx, { operation: 'write.prepare', outcome: 'blocked', draftId, jobId: draft.jobId, message: blockers.map((b) => b.message).join(' '), details: { blockers } })
    throw new ServiceError(409, 'Writing is not possible yet.', blockers.map((b) => b.message), 'BLOCKED')
  }
  const recipe = recipeForDraft(ctx, draft)!
  const job = ctx.repos.jobs.get(draft.jobId)
  const { findings } = validateWithRender(ctx, draft.page, recipe, job)
  const errors = findings.filter((f) => f.severity === 'error')
  if (errors.length) throw new ServiceError(409, 'Fix the validation errors before writing.', errors.map((f) => f.message), 'INVALID')

  const connector = ctx.connector()
  // Confirm the connection live and that the key still points at the expected project.
  let project
  try {
    project = await connector.getProject()
    await connector.pingProject(project.id)
  } catch (error) {
    throw new ServiceError(502, `The LegendKeeper connection is not working: ${toConnectorError(error).message}`)
  }
  const expected = knownProjectId(ctx)
  if (expected && expected !== project.id) {
    throw new ServiceError(409, `The API key now belongs to a different project (${project.name}) than the one this app was set up with. Test the connection again and re-run the write check.`)
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

  const plannedResourceId = draft.plannedResourceId ?? newLkResourceId()
  const { payload, hash } = renderFor(ctx, draft, page, plannedResourceId)
  ctx.repos.drafts.setPlannedWrite(draft.id, plannedResourceId, payload.idempotencyKey)
  ctx.repos.drafts.setStatus(draft.id, draft.status, { page })
  const token = randomToken()
  const expiresAt = new Date(ctx.now().getTime() + APPROVAL_TTL_MS).toISOString()
  ctx.repos.drafts.setApproval(draft.id, token, hash, expiresAt)

  const warnings = findings.filter((f) => f.severity === 'warning').map((f) => f.message)
  for (const match of sameName) warnings.push(`LegendKeeper search found a page with the same name: ${match.path} (${match.id}).`)
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
    details: { payloadHash: hash.slice(0, 16), bytes: payloadBytes(payload), warnings: warnings.length },
  })

  return {
    approvalToken: token,
    expiresAt,
    payloadHash: hash.slice(0, 16),
    project: { id: project.id, name: project.name },
    plannedResourceId,
    name: payload.name,
    parent,
    tags: page.tags.filter((t) => t.accepted && t.status !== 'rejected').map((t) => ({ value: t.existingMatch ?? t.value, status: t.status })),
    aliases: payload.aliases,
    links,
    documentName: payload.documentName,
    blocks: payload.blocks,
    bytes: payloadBytes(payload),
    warnings,
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

  // Exactly one request can move the draft from awaiting_approval to writing.
  if (!ctx.repos.drafts.claimForWrite(draft.id, input.approvalToken)) {
    throw new ServiceError(409, 'This write has already been started.')
  }
  const projectId = knownProjectId(ctx)
  const auditBase = { draftId, jobId: draft.jobId, recipeId: draft.recipeId, recipeVersion: draft.recipeVersion, projectId, resourceId: draft.plannedResourceId, model: draft.page.processing?.servedByModel ?? draft.page.processing?.model ?? null }
  recordAudit(ctx, { ...auditBase, operation: 'write.approve', outcome: 'info', approval: 'approved', message: `Approved creation of “${payload.name}”`, details: { payloadHash: hash.slice(0, 16), idempotencyKey: payload.idempotencyKey } })

  try {
    const created = await ctx.connector().createPage(payload)
    return await finishCreated(ctx, draft.id, created, payload, auditBase, 'Created')
  } catch (error) {
    return await handleWriteFailure(ctx, draft.id, toConnectorError(error), payload, auditBase)
  }
}

type AuditBase = { draftId: string; jobId: string; recipeId: string | null; recipeVersion: number | null; projectId: string | null; resourceId: string | null; model: string | null }

async function handleWriteFailure(ctx: AppContext, draftId: string, failure: ConnectorError, payload: CreatePageInput, auditBase: AuditBase) {
  const failed = { errorCode: failure.details.code ?? failure.kind, requestId: failure.details.requestId ?? null }

  if (failure.kind === 'duplicate_id' || failure.details.outcome === 'unknown') {
    // The page may exist (an earlier attempt succeeded, or this one did before the reply was lost).
    // Find out by reading — never by writing again.
    const existence = await checkExists(ctx, payload.resourceId)
    if (existence.exists && existence.created) {
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
    const recipe = recipeForDraft(ctx, draft)
    const pageType = recipe ? resolvePageType(recipe) : null
    const payload: CreatePageInput =
      pageType && recipe
        ? buildCreatePayload(draft.page, { pageType, template: resolveTemplate(pageType, recipe.templateId ? ctx.repos.templates.get(recipe.templateId) : null) }, draft.plannedResourceId, draft.idempotencyKey ?? '')
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
