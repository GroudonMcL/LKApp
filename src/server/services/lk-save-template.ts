import 'server-only'
import { z } from 'zod'
import { idempotencyKeyFor, newLkResourceId } from '@/core/ids'
import type { AppContext } from '../context'
import { randomToken, sha256Hex, stableStringify } from '../hash'
import { toConnectorError } from '../lk/errors'
import type { ResourceDetail } from '../lk/types'
import { recordAudit } from './audit'
import { knownProjectId } from './connection'
import { ServiceError } from './errors'
import { isLkTemplate, resourceIdFrom } from './lk-templates'
import { configBlockers } from './write'

/**
 * Saving a LegendKeeper page as a LegendKeeper template (`resources.saveAsTemplate`, SDK 4.1.0).
 *
 * LegendKeeper copies the page (and, if asked, the pages under it) into a new top-level
 * template: fields, sidebar properties and tabs with their content, under new ids. The page
 * itself does not change. Only a project admin may do this, so it needs an ADMIN key.
 *
 * Same guard as page creation: a final preview with a one-time approval token, an id for the
 * new template chosen in advance plus an Idempotency-Key (a repeat can never make a second
 * copy), no automatic retry, and a read-back. Nothing is ever deleted.
 */

const APPROVAL_TTL_MS = 15 * 60 * 1000
const PENDING_KEY = 'lk.saveAsTemplate.pending'
/** One copy holds at most 100 resources (the page and its descendants). */
const MAX_COPY = 100

export const SaveAsTemplateRequest = z.object({
  /** A LegendKeeper page id, or a link to the page. */
  resource: z.string().trim().min(1).max(500),
  name: z.string().trim().min(1).max(500).optional(),
  includeChildren: z.boolean().default(false),
})

interface Pending {
  token: string
  hash: string
  expiresAt: string
  resourceId: string
  name: string
  includeChildren: boolean
  templateId: string
  idempotencyKey: string
}

/** Counts the pages under a page, up to `limit` (read-only). */
async function countDescendants(ctx: AppContext, resourceId: string, limit: number): Promise<number> {
  let count = 0
  const queue = [resourceId]
  while (queue.length && count <= limit) {
    const parentId = queue.shift()!
    let cursor: string | null = null
    for (let page = 0; page < 20; page++) {
      const result = await ctx.connector().listResources({ parentId, cursor, limit: 100 })
      const children = result.items.filter((item) => item.parentId === parentId)
      count += children.length
      queue.push(...children.map((child) => child.id))
      if (!result.hasMore || !result.nextCursor || count > limit) break
      cursor = result.nextCursor
    }
  }
  return count
}

const defaultTemplateName = (name: string) => (/\btemplate\b/i.test(name) ? name : `${name} Template`)

/** The final preview: what will be copied, under which name, with a one-time approval token. Read-only. */
export async function prepareSaveAsTemplate(ctx: AppContext, input: unknown) {
  const parsed = SaveAsTemplateRequest.safeParse(input)
  if (!parsed.success) throw new ServiceError(400, 'The request is not valid.', parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`))
  const blockers = configBlockers(ctx)
  if (blockers.length) throw new ServiceError(409, 'Saving a template is not possible yet.', blockers.map((b) => b.message), 'BLOCKED')
  const resourceId = resourceIdFrom(parsed.data.resource)
  const connector = ctx.connector()

  let project
  let resource: ResourceDetail
  try {
    project = await connector.getProject()
    await connector.pingProject(project.id)
    resource = await connector.getResource(resourceId)
  } catch (error) {
    const failure = toConnectorError(error)
    throw new ServiceError(failure.kind === 'not_found' ? 404 : 502, failure.kind === 'not_found' ? `No page with the id ${resourceId} could be read.` : failure.message)
  }
  const expected = knownProjectId(ctx)
  if (expected && expected !== project.id) throw new ServiceError(409, `The API key now belongs to a different project (${project.name}). Test the connection again first.`)

  const warnings: string[] = []
  if (await isLkTemplate(ctx, resource)) warnings.push(`“${resource.name}” is already a template; this makes a second, top-level copy of it.`)
  const descendants = parsed.data.includeChildren ? await countDescendants(ctx, resource.id, MAX_COPY) : 0
  if (descendants + 1 > MAX_COPY) {
    throw new ServiceError(409, `“${resource.name}” has more than ${MAX_COPY - 1} pages under it. LegendKeeper copies at most ${MAX_COPY} pages into one template; save it without the pages under it.`)
  }
  const name = parsed.data.name || defaultTemplateName(resource.name)
  try {
    const existing: string[] = []
    let cursor: string | null = null
    for (let page = 0; page < 20; page++) {
      const result = await connector.listTemplates({ cursor, limit: 100 })
      existing.push(...result.items.map((item) => item.name))
      if (!result.hasMore || !result.nextCursor) break
      cursor = result.nextCursor
    }
    if (existing.some((n) => n.toLowerCase() === name.toLowerCase())) warnings.push(`A template called “${name}” already exists. The new one will have the same name.`)
  } catch {
    /* advisory */
  }

  const templateId = newLkResourceId()
  const pending: Pending = {
    token: randomToken(),
    hash: '',
    expiresAt: new Date(ctx.now().getTime() + APPROVAL_TTL_MS).toISOString(),
    resourceId: resource.id,
    name,
    includeChildren: parsed.data.includeChildren,
    templateId,
    idempotencyKey: idempotencyKeyFor('lkc-tpl', templateId),
  }
  pending.hash = sha256Hex(stableStringify({ resourceId: pending.resourceId, name, includeChildren: pending.includeChildren, templateId })).slice(0, 16)
  ctx.repos.settings.set(PENDING_KEY, pending)
  recordAudit(ctx, {
    operation: 'template.save.prepare',
    outcome: 'success',
    approval: 'not_approved',
    projectId: project.id,
    resourceId: resource.id,
    message: `Final preview: save “${resource.name}” as the template “${name}”`,
    details: { templateId, includeChildren: pending.includeChildren, descendants },
  })
  return {
    approvalToken: pending.token,
    expiresAt: pending.expiresAt,
    project: { id: project.id, name: project.name },
    page: {
      id: resource.id,
      name: resource.name,
      tabs: resource.documents.map((d) => ({ name: d.name, type: d.type })),
      sidebarProperties: resource.properties.length,
      tags: resource.tags,
    },
    name,
    includeChildren: pending.includeChildren,
    descendants,
    plannedTemplateId: templateId,
    fingerprint: pending.hash,
    warnings,
  }
}

/** Saves the previewed page as a template. Needs the preview's token and explicit confirmation. */
export async function approveSaveAsTemplate(ctx: AppContext, input: { approvalToken: string }) {
  const pending = ctx.repos.settings.get<Pending>(PENDING_KEY)
  if (!pending || pending.token !== input.approvalToken) throw new ServiceError(409, 'There is no matching preview to approve (it may have been replaced or already used). Open the preview again.')
  if (Date.parse(pending.expiresAt) < ctx.now().getTime()) throw new ServiceError(409, 'The approval has expired. Open the preview again.')
  const blockers = configBlockers(ctx)
  if (blockers.length) throw new ServiceError(409, 'Saving a template is not possible.', blockers.map((b) => b.message), 'BLOCKED')
  // One use only: claim it before sending anything.
  ctx.repos.settings.set(PENDING_KEY, null)

  const projectId = knownProjectId(ctx)
  const auditBase = { projectId, resourceId: pending.templateId }
  recordAudit(ctx, { ...auditBase, operation: 'template.save', outcome: 'info', approval: 'approved', message: `Approved saving ${pending.resourceId} as the template “${pending.name}”`, details: { sourceResourceId: pending.resourceId, includeChildren: pending.includeChildren, idempotencyKey: pending.idempotencyKey } })

  let saved: ResourceDetail | null = null
  try {
    saved = await ctx.connector().saveAsTemplate({
      resourceId: pending.resourceId,
      templateId: pending.templateId,
      name: pending.name,
      includeChildren: pending.includeChildren,
      idempotencyKey: pending.idempotencyKey,
    })
  } catch (error) {
    const failure = toConnectorError(error)
    const failed = { errorCode: failure.details.code ?? failure.kind, requestId: failure.details.requestId ?? null }
    if (failure.kind === 'permission') {
      const message = 'LegendKeeper refused: only a project admin may save templates. Use an API key with the Admin role (LegendKeeper → Project Settings → Developers → API Keys). Nothing was created.'
      recordAudit(ctx, { ...auditBase, ...failed, operation: 'template.save', outcome: 'failure', approval: 'approved', message })
      return { status: 'failed' as const, message }
    }
    if (failure.kind !== 'duplicate_id' && failure.details.outcome !== 'unknown') {
      const message = `LegendKeeper refused. Nothing was created. ${failure.message}`
      recordAudit(ctx, { ...auditBase, ...failed, operation: 'template.save', outcome: 'failure', approval: 'approved', message })
      return { status: 'failed' as const, message }
    }
    // Uncertain: find out by reading, never by sending again.
    try {
      saved = await ctx.connector().getResource(pending.templateId)
    } catch (readError) {
      const notFound = toConnectorError(readError).kind === 'not_found'
      const message = notFound && failure.kind !== 'duplicate_id'
        ? `The request did not go through (${failure.message}). LegendKeeper confirms no template was created; open the preview again to retry.`
        : `The outcome is uncertain (${failure.message}). Check the templates list in LegendKeeper for “${pending.name}” before trying again.`
      recordAudit(ctx, { ...auditBase, ...failed, operation: 'template.save', outcome: notFound ? 'failure' : 'uncertain', approval: 'approved', message })
      return { status: notFound ? ('failed' as const) : ('uncertain' as const), message }
    }
  }

  // Read back: it must be a top-level template with the approved name.
  let readback: ResourceDetail | null = null
  let readbackError: string | null = null
  try {
    readback = await ctx.connector().getResource(saved.id)
  } catch (error) {
    readbackError = toConnectorError(error).message
  }
  const mismatches: string[] = []
  if (readback && readback.parentId !== 'templates') mismatches.push('it is not at the top of the templates list')
  if (readback && readback.name !== pending.name) mismatches.push(`its name is “${readback.name}”`)
  recordAudit(ctx, {
    ...auditBase,
    resourceId: saved.id,
    operation: 'template.save',
    outcome: 'success',
    approval: 'approved',
    message: `Saved ${pending.resourceId} as the template “${saved.name}” (${saved.id})`,
    details: { sourceResourceId: pending.resourceId, includeChildren: pending.includeChildren, tabs: saved.documents.length, readbackError, mismatches },
  })
  return { status: 'created' as const, template: { id: saved.id, name: saved.name, tabs: saved.documents.length }, readbackError, mismatches }
}
