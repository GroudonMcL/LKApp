import 'server-only'
import { destinationLabel, destinationType, withExtraFields } from '@/core/destinations'
import { EXAMPLE_RECIPES, RecipeDefinition, type Recipe } from '@/core/recipe'
import { resolvePageType } from '@/core/resolve'
import { LAYOUT_PRESETS, type PageTemplate } from '@/core/template'
import { BUILT_IN_PAGE_TYPES, findBuiltInPageType, type PageTypeDefinition } from '@/core/page-types'
import { skeletonFromBlocks, summarizeLayout } from '@/core/lk-layout'
import type { AppContext } from '../context'
import { toConnectorError } from '../lk/errors'
import { recordAudit } from './audit'
import { ServiceError } from './errors'
import { copyLayout, listLkTemplates } from './lk-templates'
import { createRecipe } from './recipes'

/**
 * Where imported pages can go: one destination per LegendKeeper template (or, before any are set
 * up, per built-in page type). The import's AI chooses a destination for each page it finds; you
 * never write a recipe for it.
 *
 * Setting up a destination reads the template from LegendKeeper (read-only) and stores a local
 * copy of its layout plus a recipe that uses it. Templates already copied into the app are
 * reused, with the layout rules you chose for them.
 */

const SETTINGS_KEY = 'import.destinations'

interface Stored {
  templateId: string
  recipeId: string
  enabled: boolean
  reason?: string
}

export interface Destination {
  /** The local template id; stable for the destination. */
  key: string
  label: string
  templateId: string
  recipeId: string
  recipeVersion: number
  pageType: string
  pageTypeLabel: string
  lkTemplateId: string | null
  /** Field labels, in order, that the AI fills. */
  fields: string[]
  sections: string[]
  layout: 'exact' | 'fit' | 'custom' | 'own'
  enabled: boolean
  reason: string | null
  builtIn: boolean
}

function stored(ctx: AppContext): Stored[] {
  return ctx.repos.settings.get<Stored[]>(SETTINGS_KEY) ?? []
}

function describe(ctx: AppContext, entry: Stored, builtIn = false): Destination | null {
  const template = ctx.repos.templates.get(entry.templateId)
  const recipe = ctx.repos.recipes.get(entry.recipeId)
  if (!template || !recipe) return null
  const pageType = resolvePageType(recipe.definition)
  if (!pageType) return null
  const rules = template.definition.layoutRules
  const layout = !template.definition.lkLayout ? 'own' : sameRules(rules, LAYOUT_PRESETS.exact) ? 'exact' : sameRules(rules, LAYOUT_PRESETS.fit) ? 'fit' : 'custom'
  return {
    key: template.id,
    label: template.definition.lkLayout ? destinationLabel(template.definition.lkLayout.sourceName) : pageType.label,
    templateId: template.id,
    recipeId: recipe.id,
    recipeVersion: recipe.version,
    pageType: pageType.id,
    pageTypeLabel: pageType.label,
    lkTemplateId: template.definition.lkLayout?.sourceKind === 'template' ? template.definition.lkLayout.sourceResourceId : null,
    fields: pageType.fields.map((field) => field.label),
    sections: template.definition.sections,
    layout,
    enabled: entry.enabled,
    reason: entry.reason ?? null,
    builtIn,
  }
}

const sameRules = (a: object, b: object) => JSON.stringify(a) === JSON.stringify({ ...b })

/** The destinations set up from LegendKeeper templates. */
export function listDestinations(ctx: AppContext): Destination[] {
  return stored(ctx)
    .map((entry) => describe(ctx, entry))
    .filter((d): d is Destination => d !== null)
}

/**
 * The destinations an import may use: the enabled ones set up from LegendKeeper templates, or,
 * when there are none, one per built-in page type (laid out by the app). The recipes for the
 * built-in ones are made on first use.
 */
export function activeDestinations(ctx: AppContext): Destination[] {
  const own = listDestinations(ctx).filter((d) => d.enabled)
  if (own.length) return own
  return BUILT_IN_PAGE_TYPES.map((type) => {
    const templateId = `example-${type.id.replace(/_/g, '-')}`
    const recipe = builtInRecipe(ctx, type.id, templateId)
    return describe(ctx, { templateId, recipeId: recipe.id, enabled: true }, true)
  }).filter((d): d is Destination => d !== null)
}

function builtInRecipe(ctx: AppContext, pageType: string, templateId: string): Recipe {
  const existing = ctx.repos.recipes.list().find((recipe) => recipe.definition.templateId === templateId && recipe.definition.targetPageType === pageType)
  if (existing) return existing
  const base = EXAMPLE_RECIPES.find((example) => example.targetPageType === pageType)
  const label = BUILT_IN_PAGE_TYPES.find((type) => type.id === pageType)?.label ?? pageType
  return createRecipe(ctx, RecipeDefinition.parse({ ...(base ?? {}), name: `Import: ${label}`, description: `Made by the import for ${label} pages.`, targetPageType: pageType, templateId, allowCreate: true }))
}

export function setDestinationEnabled(ctx: AppContext, key: string, enabled: boolean) {
  const all = stored(ctx)
  const entry = all.find((d) => d.templateId === key)
  if (!entry) throw new ServiceError(404, 'Destination not found.')
  entry.enabled = enabled
  ctx.repos.settings.set(SETTINGS_KEY, all)
  return listDestinations(ctx)
}

/** Removes a destination from the import (its template and recipe stay, for other uses). */
export function removeDestination(ctx: AppContext, key: string) {
  ctx.repos.settings.set(SETTINGS_KEY, stored(ctx).filter((d) => d.templateId !== key))
  return listDestinations(ctx)
}

/**
 * Sets up a destination for each LegendKeeper template that has none yet (or only the ones
 * named). Reads only. Returns what was added and what was skipped, with the reason.
 */
export async function setUpDestinations(ctx: AppContext, input: { lkTemplateIds?: string[] } = {}) {
  const { templates } = await listLkTemplates(ctx)
  const all = stored(ctx)
  const have = new Set(listDestinations(ctx).map((d) => d.lkTemplateId).filter(Boolean))
  const wanted = templates.filter((t) => (!input.lkTemplateIds || input.lkTemplateIds.includes(t.id)) && !have.has(t.id) && t.documents.some((doc) => doc.type === 'page'))
  const added: Destination[] = []
  const skipped: { name: string; reason: string }[] = []
  const usedTypeIds = new Set(ctx.repos.recipes.list().map((r) => r.definition.customPageType?.id).filter((id): id is string => Boolean(id)))
  for (const lk of wanted) {
    try {
      const entry = await setUpOne(ctx, lk, usedTypeIds)
      all.push(entry)
      ctx.repos.settings.set(SETTINGS_KEY, all)
      const view = describe(ctx, entry)
      if (view) added.push(view)
    } catch (error) {
      skipped.push({ name: lk.name, reason: error instanceof ServiceError ? error.message : toConnectorError(error).message })
    }
  }
  recordAudit(ctx, { operation: 'import.destinations', outcome: 'success', message: `${added.length} set up, ${skipped.length} skipped`, details: { added: added.map((d) => d.label), skipped } })
  return { added, skipped, destinations: listDestinations(ctx) }
}

async function setUpOne(ctx: AppContext, lk: { id: string; name: string }, usedTypeIds: Set<string>): Promise<Stored> {
  const resource = await ctx.connector().getResource(lk.id)
  const document = resource.documents.find((doc) => doc.type === 'page')
  if (!document) throw new ServiceError(400, 'It has no page tab.')
  const content = await ctx.connector().getDocumentContent(lk.id, document.id)
  const { blocks } = skeletonFromBlocks(content.blocks)
  if (!blocks.length) throw new ServiceError(400, 'It is empty.')
  const label = destinationLabel(lk.name)
  const description = `Made by the import for pages like the LegendKeeper template “${lk.name}”.`

  // A copy of this template you already made in the app is reused, with the page type and
  // layout rules you chose for it.
  const local = ctx.repos.templates
    .list()
    .filter((t) => t.definition.lkLayout?.sourceKind === 'template' && t.definition.lkLayout.sourceResourceId === lk.id)
    .sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1))[0]
  if (local) {
    const builtIn = findBuiltInPageType(local.definition.pageType)
    if (builtIn) {
      const type = withExtraFields(builtIn, blocks)
      const recipe = createRecipe(ctx, importRecipe(ctx, label, description, type.pageType.id, local.id, { extraFields: type.extraFields, ...onlyTemplateFields(type.pageType, blocks, local.definition.layoutRules.additions) }))
      return { templateId: local.id, recipeId: recipe.id, enabled: true, reason: 'Uses the copy of this template you already made, with its layout rules.' }
    }
    const own = ctx.repos.recipes.list().find((r) => r.definition.templateId === local.id && r.definition.customPageType?.id === local.definition.pageType)
    if (own) return { templateId: local.id, recipeId: own.id, enabled: true, reason: 'Uses the copy of this template you already made, with its layout rules.' }
  }

  const type = destinationType(lk.name, blocks, usedTypeIds)
  usedTypeIds.add(type.pageType.id)
  // Statblocks are fitted to each creature; everything else follows its template exactly.
  const rules = type.pageType.id === 'creature' ? LAYOUT_PRESETS.fit : LAYOUT_PRESETS.exact
  if (type.custom) {
    // The page type lives in the recipe, so the recipe comes first; then the template.
    const recipe = createRecipe(ctx, importRecipe(ctx, label, description, type.pageType.id, null, { customPageType: type.pageType }))
    const { template } = await copyLayout(ctx, { resource: lk.id, pageType: type.pageType, name: `${label} (from LegendKeeper)`, layoutRules: rules })
    const updated = ctx.repos.recipes.update(recipe.id, RecipeDefinition.parse({ ...recipe.definition, templateId: template.id }), recipe.version)
    if (!updated || updated === 'conflict') throw new ServiceError(409, 'The recipe changed while it was being set up.')
    return { templateId: template.id, recipeId: recipe.id, enabled: true, reason: type.reason }
  }
  const { template } = await copyLayout(ctx, { resource: lk.id, pageType: { ...type.pageType, fields: [...type.pageType.fields, ...type.extraFields] }, name: `${label} (from LegendKeeper)`, layoutRules: rules })
  const recipe = createRecipe(ctx, importRecipe(ctx, label, description, type.pageType.id, template.id, { extraFields: type.extraFields, ...onlyTemplateFields(type.pageType, blocks, rules.additions) }))
  return { templateId: template.id, recipeId: recipe.id, enabled: true, reason: type.reason }
}

/**
 * A template followed exactly adds no fields of its own, so the AI is offered only the fields
 * the template has a row for (the page type's others would only be left out of the page). The
 * page type keeps its id; only this recipe sees the shorter field list.
 */
function onlyTemplateFields(type: PageTypeDefinition, blocks: Record<string, unknown>[], additions: 'add' | 'none'): Partial<RecipeDefinition> {
  if (additions !== 'none') return {}
  const covered = new Set(summarizeLayout(blocks, type).rows.flatMap((row) => row.fieldKeys))
  return { customPageType: { ...type, builtIn: false, fields: type.fields.filter((field) => covered.has(field.key)) } }
}

function importRecipe(ctx: AppContext, label: string, description: string, pageType: string, templateId: string | null, extra: Partial<RecipeDefinition>) {
  const base = EXAMPLE_RECIPES.find((example) => example.targetPageType === pageType)
  return RecipeDefinition.parse({
    ...(base ?? {}),
    name: uniqueName(ctx, `Import: ${label}`),
    description,
    targetPageType: pageType,
    templateId,
    allowCreate: true,
    placement: 'alphabetical',
    // Sources from other editions often lack a statistic; nothing blocks the page for that.
    requiredFields: [],
    ...extra,
  })
}

function uniqueName(ctx: AppContext, name: string): string {
  const taken = new Set(ctx.repos.recipes.list().map((r) => r.definition.name))
  let unique = name
  for (let n = 2; taken.has(unique); n++) unique = `${name} (${n})`
  return unique
}

export type { PageTemplate }
