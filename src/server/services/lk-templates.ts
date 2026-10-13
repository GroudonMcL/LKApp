import 'server-only'
import { z } from 'zod'
import { newAppId } from '@/core/ids'
import { LK_TEMPLATES_PARENT_ID, skeletonFromBlocks, summarizeLayout, type LkLayout } from '@/core/lk-layout'
import { findBuiltInPageType, type PageTypeDefinition } from '@/core/page-types'
import { LayoutRules, TemplateDefinition, type PageTemplate } from '@/core/template'
import type { AppContext } from '../context'
import type { Recipe } from '@/core/recipe'
import type { ResourceSummary } from '../lk/types'
import { toConnectorError } from '../lk/errors'
import { recordAudit } from './audit'
import { requireProjectId } from './connection'
import { ServiceError } from './errors'
import { recipeFromTemplate } from './recipes'
import { configBlockers } from './write'
import { hasAllIds } from '@/core/template-fill'

/**
 * LegendKeeper templates. Listing them and copying a layout are read-only towards LegendKeeper:
 * they list templates and read one document's blocks, then store a local template. Creating a
 * page from a template is part of the guarded write (services/write.ts); saving a page as a
 * template is in services/lk-save-template.ts.
 */

export interface LkTemplateListing {
  id: string
  name: string
  updatedAt: string | null
  /** The template it sits under (a resource under a template is a template too), or null at the top level. */
  parentTemplate: { id: string; name: string } | null
  tags: string[]
  /** Its documents ("tabs"), by type: page, map, time, board. */
  documents: { id: string; name: string; type: string }[]
}

/** The project's templates at any depth, from LegendKeeper's documented `templates.list` (SDK 4.1.0). */
export async function listLkTemplates(ctx: AppContext): Promise<{ templates: LkTemplateListing[]; note: string }> {
  const projectId = await requireProjectId(ctx)
  let items: ResourceSummary[] = []
  let note = 'Every template in the project, including templates inside other templates (LegendKeeper’s templates list).'
  try {
    let cursor: string | null = null
    for (let page = 0; page < 20; page++) {
      const result = await ctx.connector().listTemplates({ cursor, limit: 100 })
      items.push(...result.items)
      if (!result.hasMore || !result.nextCursor) break
      cursor = result.nextCursor
    }
  } catch (error) {
    // Fall back to the templates seen by the last scan, and say so.
    const indexed = ctx.repos.index.templates(projectId)
    if (!indexed.length) throw error
    items = indexed
    note = `LegendKeeper’s templates list could not be read just now (${toConnectorError(error).message}), so these are the templates from the last scan.`
  }
  const byId = new Map(items.map((item) => [item.id, item]))
  const templates = items
    .map((item) => {
      const parent = item.parentId && item.parentId !== LK_TEMPLATES_PARENT_ID ? byId.get(item.parentId) : undefined
      return {
        id: item.id,
        name: item.name,
        updatedAt: item.updatedAt,
        parentTemplate: parent ? { id: parent.id, name: parent.name } : null,
        tags: item.tags,
        documents: item.documents,
      }
    })
    .sort((a, b) => a.name.localeCompare(b.name))
  return { templates, note }
}

/**
 * Whether a resource is a LegendKeeper template: its parent chain reaches the virtual root
 * "templates". Reads at most a few parents.
 */
export async function isLkTemplate(ctx: AppContext, resource: { id: string; parentId: string | null }): Promise<boolean> {
  let parentId = resource.parentId
  for (let depth = 0; parentId && depth < 12; depth++) {
    if (parentId === LK_TEMPLATES_PARENT_ID) return true
    parentId = (await ctx.connector().getResource(parentId)).parentId
  }
  return false
}

export const CopyLayoutInput = z.object({
  /** A LegendKeeper resource id, or a link to the page. */
  resource: z.string().trim().min(1).max(500),
  pageType: z.string().min(1).max(64),
  name: z.string().trim().max(200).optional(),
  /** Update this local template instead of creating a new one. */
  templateId: z.string().max(100).optional(),
  /** Also make a recipe that uses the new template (not when refreshing). */
  createRecipe: z.boolean().default(true),
  /** How strictly pages follow the template; kept as they are when refreshing without one. */
  layoutRules: LayoutRules.optional(),
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

export async function copyLayoutFromLegendKeeper(ctx: AppContext, input: unknown): Promise<{ template: PageTemplate; report: ReturnType<typeof layoutReport>; recipe: Recipe | null }> {
  const parsed = CopyLayoutInput.safeParse(input)
  if (!parsed.success) throw new ServiceError(400, 'The request is not valid.', parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`))
  const { pageType: pageTypeId, templateId } = parsed.data
  const pageType = pageTypeById(ctx, pageTypeId)
  if (!pageType) throw new ServiceError(400, `“${pageTypeId}” is not a page type.`)
  const existing = templateId ? ctx.repos.templates.get(templateId) : null
  if (templateId && !existing) throw new ServiceError(404, 'Template not found.')
  if (existing?.origin === 'example') throw new ServiceError(400, 'Example templates are read-only.')
  if (existing && existing.definition.pageType !== pageType.id) {
    const inUse = ctx.repos.recipes.list().filter((recipe) => recipe.definition.templateId === existing.id)
    if (inUse.length) throw new ServiceError(409, `The template is used by recipes for “${existing.definition.pageType}” pages: ${inUse.map((r) => r.definition.name).join(', ')}.`)
  }
  const { template, resourceName } = await copyLayout(ctx, { resource: parsed.data.resource, pageType, name: parsed.data.name, existing, layoutRules: parsed.data.layoutRules })
  const recipe = !existing && parsed.data.createRecipe ? recipeFromTemplate(ctx, template.id, { name: resourceName }) : null
  return { template, report: layoutReport(template, ctx), recipe }
}

/** A built-in page type, or the page type a recipe defines for itself (e.g. one made from a template). */
export function pageTypeById(ctx: AppContext, id: string): PageTypeDefinition | null {
  return findBuiltInPageType(id) ?? ctx.repos.recipes.list().map((recipe) => recipe.definition.customPageType).find((type) => type?.id === id) ?? null
}

/** Reads a LegendKeeper page or template (read-only) and stores its layout as a local template. */
export async function copyLayout(
  ctx: AppContext,
  input: { resource: string; pageType: PageTypeDefinition; name?: string; existing?: PageTemplate | null; layoutRules?: LayoutRules },
): Promise<{ template: PageTemplate; resourceName: string }> {
  const { pageType, existing } = input
  const projectId = await requireProjectId(ctx)
  const resourceId = resourceIdFrom(input.resource)
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
    sourceKind: (await isLkTemplate(ctx, resource)) ? 'template' : 'page',
    documentName: document.name,
    blocks,
    droppedParts,
    fetchedAt: ctx.now().toISOString(),
  }
  const summary = summarizeLayout(blocks, pageType)
  // Section order: the layout's text blocks first, then the page type's other sections.
  const sections = [...summary.sections]
  for (const heading of pageType.sections) if (!sections.some((s) => s.toLowerCase() === heading.toLowerCase())) sections.push(heading)
  if (sections.length === 0) sections.push('Description')

  const definition = TemplateDefinition.parse({
    ...(existing?.definition ?? {}),
    name: input.name || existing?.definition.name || `${resource.name} (from LegendKeeper)`,
    pageType: pageType.id,
    description: existing?.definition.description || `Layout copied from the LegendKeeper ${layout.sourceKind} “${resource.name}”.`,
    sections,
    infoboxFields: [...new Set(summary.rows.flatMap((row) => row.fieldKeys))],
    includeSourcesSection: existing?.definition.includeSourcesSection ?? false,
    lkLayout: layout,
    ...(input.layoutRules ? { layoutRules: input.layoutRules } : {}),
  })

  const id = existing?.id ?? newAppId('tpl')
  if (existing) ctx.repos.templates.update(id, definition)
  else ctx.repos.templates.insert(id, 'local', definition)
  recordAudit(ctx, {
    operation: existing ? 'template.refresh' : 'template.copy',
    outcome: 'success',
    message: `${definition.name} ← ${resource.name}`,
    details: { templateId: id, sourceResourceId: resource.id, sourceKind: layout.sourceKind, droppedParts },
  })
  return { template: ctx.repos.templates.get(id)!, resourceName: resource.name }
}

/** What the app will do with each part of a copied layout, in words for the template screen. */
export function layoutReport(template: PageTemplate, ctx?: AppContext) {
  const layout = template.definition.lkLayout
  const pageType = ctx ? pageTypeById(ctx, template.definition.pageType) : findBuiltInPageType(template.definition.pageType)
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

/**
 * Prepares a LegendKeeper template so pages made from it need one write fewer: gives the blocks
 * of its first page tab the ids LegendKeeper uses to address them (`assignBlockIds`). Nothing you
 * can see changes. Without it, every new page needs this step on its own copy. Only on request,
 * and only for a template copied into this app.
 */
export async function prepareLkTemplate(ctx: AppContext, localTemplateId: string, input: { confirm: boolean }) {
  if (!input.confirm) throw new ServiceError(400, 'Confirm that the template may be prepared in LegendKeeper.')
  const blockers = configBlockers(ctx)
  if (blockers.length) throw new ServiceError(409, 'Writing is not possible yet.', blockers.map((b) => b.message), 'BLOCKED')
  const local = ctx.repos.templates.get(localTemplateId)
  const layout = local?.definition.lkLayout
  if (!local || !layout || layout.sourceKind !== 'template') throw new ServiceError(404, 'This is not a template copied from a LegendKeeper template.')
  const resource = await ctx.connector().getResource(layout.sourceResourceId)
  if (!(await isLkTemplate(ctx, resource))) throw new ServiceError(409, `“${resource.name}” is no longer a LegendKeeper template.`)
  const tab = [...resource.documents].filter((d) => d.type === 'page').sort((a, b) => ((a.rank ?? '') < (b.rank ?? '') ? -1 : 1))[0]
  if (!tab) throw new ServiceError(409, `“${resource.name}” has no page tab.`)
  const content = await ctx.connector().getDocumentContent(resource.id, tab.id)
  if (hasAllIds(content.blocks)) return { prepared: false, already: true, name: resource.name }
  await ctx.connector().assignBlockIds(resource.id, tab.id)
  const after = await ctx.connector().getDocumentContent(resource.id, tab.id)
  recordAudit(ctx, { operation: 'template.prepare', outcome: 'success', approval: 'approved', resourceId: resource.id, message: `Gave the blocks of “${resource.name}” (${tab.name}) their ids; nothing visible changed`, details: { templateId: localTemplateId, ok: hasAllIds(after.blocks) } })
  return { prepared: true, already: false, name: resource.name }
}
