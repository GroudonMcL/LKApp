import 'server-only'
import { z } from 'zod'
import { newAppId } from '@/core/ids'
import { LK_TEMPLATES_PARENT_ID, skeletonFromBlocks, summarizeLayout, type LkLayout } from '@/core/lk-layout'
import { findBuiltInPageType } from '@/core/page-types'
import { TemplateDefinition, type PageTemplate } from '@/core/template'
import type { AppContext } from '../context'
import { recordAudit } from './audit'
import { requireProjectId } from './connection'
import { ServiceError } from './errors'

/**
 * Copying page layouts from LegendKeeper. Read-only towards LegendKeeper: it lists resources
 * and reads one document's blocks, then stores a local template.
 */

export interface LkTemplateListing {
  id: string
  name: string
  updatedAt: string | null
}

/**
 * The templates of the connected project. LegendKeeper's resource list includes them with
 * the parent id "templates" (observed, not documented), so this is a best-effort list; any
 * page can also be used as an example by its id.
 */
export async function listLkTemplates(ctx: AppContext): Promise<{ templates: LkTemplateListing[]; note: string }> {
  await requireProjectId(ctx)
  const templates: LkTemplateListing[] = []
  let cursor: string | null = null
  for (let page = 0; page < 20; page++) {
    const result = await ctx.connector().listResources({ parentId: LK_TEMPLATES_PARENT_ID, cursor, limit: 100 })
    templates.push(...result.items.filter((item) => item.parentId === LK_TEMPLATES_PARENT_ID).map((item) => ({ id: item.id, name: item.name, updatedAt: item.updatedAt })))
    if (!result.hasMore || !result.nextCursor) break
    cursor = result.nextCursor
  }
  return {
    templates,
    note: 'LegendKeeper lists templates as resources whose parent is “templates”. This is observed behaviour, not documented, so it may change.',
  }
}

export const CopyLayoutInput = z.object({
  /** A LegendKeeper resource id, or a link to the page. */
  resource: z.string().trim().min(1).max(500),
  pageType: z.string().min(1).max(64),
  name: z.string().trim().max(200).optional(),
  /** Update this local template instead of creating a new one. */
  templateId: z.string().max(100).optional(),
})

/** Accepts a bare id or a LegendKeeper link and returns the resource id. */
export function resourceIdFrom(input: string): string {
  const trimmed = input.trim()
  // Links look like https://app.legendkeeper.com/a/<project>/resources/<id>/... — take the
  // segment after "resources", or the last id-like segment.
  const afterResources = trimmed.match(/resources\/([a-z0-9]{8,32})/i)
  if (afterResources) return afterResources[1]!
  if (/^[a-z0-9]{6,32}$/i.test(trimmed)) return trimmed
  throw new ServiceError(400, 'Enter a LegendKeeper page id (for example “l1ylm24t”) or a link to the page.')
}

export async function copyLayoutFromLegendKeeper(ctx: AppContext, input: unknown): Promise<{ template: PageTemplate; report: ReturnType<typeof layoutReport> }> {
  const parsed = CopyLayoutInput.safeParse(input)
  if (!parsed.success) throw new ServiceError(400, 'The request is not valid.', parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`))
  const { pageType: pageTypeId, templateId } = parsed.data
  const pageType = findBuiltInPageType(pageTypeId)
  if (!pageType) throw new ServiceError(400, `“${pageTypeId}” is not a page type.`)
  const existing = templateId ? ctx.repos.templates.get(templateId) : null
  if (templateId && !existing) throw new ServiceError(404, 'Template not found.')
  if (existing?.origin === 'example') throw new ServiceError(400, 'Example templates are read-only.')

  const projectId = await requireProjectId(ctx)
  const resourceId = resourceIdFrom(parsed.data.resource)
  const resource = await ctx.connector().getResource(resourceId)
  const document = resource.documents.find((doc) => doc.type === 'page')
  if (!document) throw new ServiceError(400, `“${resource.name}” has no page document to copy a layout from.`)
  const content = await ctx.connector().getDocumentContent(resourceId, document.id)
  const { blocks, droppedParts } = skeletonFromBlocks(content.blocks)
  if (blocks.length === 0) throw new ServiceError(400, `“${resource.name}” is empty, so there is no layout to copy.`)

  const layout: LkLayout = {
    sourceProjectId: projectId,
    sourceResourceId: resource.id,
    sourceName: resource.name,
    sourceKind: resource.parentId === LK_TEMPLATES_PARENT_ID ? 'template' : 'page',
    documentName: document.name,
    blocks,
    droppedParts,
    fetchedAt: ctx.now().toISOString(),
  }
  const summary = summarizeLayout(blocks, pageType)
  // Section order: the layout's text blocks first, then the page type's other sections.
  const sections = [...summary.sections]
  for (const heading of pageType.sections) if (!sections.some((s) => s.toLowerCase() === heading.toLowerCase())) sections.push(heading)

  const definition = TemplateDefinition.parse({
    ...(existing?.definition ?? {}),
    name: parsed.data.name || existing?.definition.name || `${resource.name} (from LegendKeeper)`,
    pageType: pageType.id,
    description: existing?.definition.description || `Layout copied from the LegendKeeper ${layout.sourceKind} “${resource.name}”.`,
    sections,
    infoboxFields: [...new Set(summary.rows.flatMap((row) => row.fieldKeys))],
    includeSourcesSection: existing?.definition.includeSourcesSection ?? false,
    lkLayout: layout,
  })
  if (existing && existing.definition.pageType !== definition.pageType) {
    const inUse = ctx.repos.recipes.list().filter((recipe) => recipe.definition.templateId === existing.id)
    if (inUse.length) throw new ServiceError(409, `The template is used by recipes for “${existing.definition.pageType}” pages: ${inUse.map((r) => r.definition.name).join(', ')}.`)
  }

  const id = existing?.id ?? newAppId('tpl')
  if (existing) ctx.repos.templates.update(id, definition)
  else ctx.repos.templates.insert(id, 'local', definition)
  recordAudit(ctx, {
    operation: existing ? 'template.refresh' : 'template.copy',
    outcome: 'success',
    message: `${definition.name} ← ${resource.name}`,
    details: { templateId: id, sourceResourceId: resource.id, sourceKind: layout.sourceKind, droppedParts },
  })
  const template = ctx.repos.templates.get(id)!
  return { template, report: layoutReport(template) }
}

/** What the app will do with each part of a copied layout, in words for the template screen. */
export function layoutReport(template: PageTemplate) {
  const layout = template.definition.lkLayout
  const pageType = findBuiltInPageType(template.definition.pageType)
  if (!layout || !pageType) return null
  const summary = summarizeLayout(layout.blocks, pageType)
  const covered = new Set(summary.rows.flatMap((row) => row.fieldKeys))
  return {
    rows: summary.rows.map((row) => ({ key: row.key, fields: row.fieldKeys.map((key) => pageType.fields.find((f) => f.key === key)?.label ?? key) })),
    sections: summary.sections,
    hasDescriptionArea: summary.hasDescriptionArea,
    fieldsWithoutRow: pageType.fields.filter((field) => !covered.has(field.key)).map((field) => field.label),
    droppedParts: layout.droppedParts,
  }
}
