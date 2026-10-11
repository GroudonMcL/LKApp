import 'server-only'
import { z } from 'zod'
import { newAppId } from '@/core/ids'
import { EXAMPLE_RECIPES, RecipeDefinition, type Recipe } from '@/core/recipe'
import { resolvePageType, resolveTemplate } from '@/core/resolve'
import { extractSource } from '@/core/extraction'
import { FLAG_EXPLANATIONS, extractRecords } from '@/core/records'
import { applyDefaultValues, type DraftContext } from '@/core/draft-common'
import { buildStructuralDraft } from '@/core/structural'
import { validateDraft } from '@/core/validation'
import { TemplateDefinition, type PageTemplate } from '@/core/template'
import type { AppContext } from '../context'
import { recordAudit } from './audit'
import { ServiceError } from './errors'

export { ServiceError }

function issuesOf(error: z.ZodError): string[] {
  return error.issues.map((issue) => `${issue.path.join('.') || '(recipe)'}: ${issue.message}`)
}

/** Checks the parts of a recipe that Zod alone cannot: references to page types, templates and fields. */
export function checkRecipe(ctx: AppContext, definition: RecipeDefinition): string[] {
  const problems: string[] = []
  const pageType = resolvePageType(definition)
  if (!pageType) {
    problems.push(`targetPageType: “${definition.targetPageType}” is not a built-in page type and does not match the recipe's custom page type.`)
    return problems
  }
  const keys = new Set(pageType.fields.map((f) => f.key))
  for (const key of definition.requiredFields) if (!keys.has(key)) problems.push(`requiredFields: “${key}” is not a field of ${pageType.label}.`)
  for (const mapping of definition.fieldMappings) if (!keys.has(mapping.fieldKey)) problems.push(`fieldMappings: “${mapping.fieldKey}” is not a field of ${pageType.label}.`)
  if (definition.templateId) {
    const template = ctx.repos.templates.get(definition.templateId)
    if (!template) problems.push(`templateId: template “${definition.templateId}” does not exist.`)
    else if (template.definition.pageType !== pageType.id) {
      problems.push(`templateId: template “${template.definition.name}” is for “${template.definition.pageType}” pages, not “${pageType.id}”.`)
    }
  }
  return problems
}

export function listRecipes(ctx: AppContext): Recipe[] {
  return ctx.repos.recipes.list()
}

export function getRecipe(ctx: AppContext, id: string): Recipe {
  const recipe = ctx.repos.recipes.get(id)
  if (!recipe) throw new ServiceError(404, 'Recipe not found.')
  return recipe
}

export function createRecipe(ctx: AppContext, input: unknown): Recipe {
  const parsed = RecipeDefinition.safeParse(input)
  if (!parsed.success) throw new ServiceError(400, 'The recipe is not valid.', issuesOf(parsed.error))
  const problems = checkRecipe(ctx, parsed.data)
  if (problems.length) throw new ServiceError(400, 'The recipe is not valid.', problems)
  const recipe = ctx.repos.recipes.insert(newAppId('rcp'), parsed.data)
  recordAudit(ctx, { operation: 'recipe.create', outcome: 'success', recipeId: recipe.id, recipeVersion: recipe.version, message: recipe.definition.name })
  return recipe
}

export function updateRecipe(ctx: AppContext, id: string, input: unknown, expectedVersion: number): Recipe {
  const parsed = RecipeDefinition.safeParse(input)
  if (!parsed.success) throw new ServiceError(400, 'The recipe is not valid.', issuesOf(parsed.error))
  const problems = checkRecipe(ctx, parsed.data)
  if (problems.length) throw new ServiceError(400, 'The recipe is not valid.', problems)
  const result = ctx.repos.recipes.update(id, parsed.data, expectedVersion)
  if (result === null) throw new ServiceError(404, 'Recipe not found.')
  if (result === 'conflict') throw new ServiceError(409, 'The recipe was changed elsewhere since you opened it. Reload and reapply your changes.')
  recordAudit(ctx, { operation: 'recipe.update', outcome: 'success', recipeId: id, recipeVersion: result.version, message: result.definition.name })
  return result
}

export function archiveRecipe(ctx: AppContext, id: string) {
  getRecipe(ctx, id)
  ctx.repos.recipes.archive(id)
  recordAudit(ctx, { operation: 'recipe.archive', outcome: 'success', recipeId: id })
}

// ── Templates ────────────────────────────────────────────────────────────────

export function listTemplates(ctx: AppContext): PageTemplate[] {
  return ctx.repos.templates.list()
}

export function createTemplate(ctx: AppContext, input: unknown): PageTemplate {
  const parsed = TemplateDefinition.safeParse(input)
  if (!parsed.success) throw new ServiceError(400, 'The template is not valid.', issuesOf(parsed.error))
  const id = newAppId('tpl')
  ctx.repos.templates.insert(id, 'local', parsed.data)
  recordAudit(ctx, { operation: 'template.create', outcome: 'success', message: parsed.data.name, details: { templateId: id } })
  return ctx.repos.templates.get(id)!
}

export function updateTemplate(ctx: AppContext, id: string, input: unknown): PageTemplate {
  const existing = ctx.repos.templates.get(id)
  if (!existing) throw new ServiceError(404, 'Template not found.')
  if (existing.origin === 'example') throw new ServiceError(400, 'Example templates are read-only. Duplicate it to make your own.')
  const parsed = TemplateDefinition.safeParse(input)
  if (!parsed.success) throw new ServiceError(400, 'The template is not valid.', issuesOf(parsed.error))
  ctx.repos.templates.update(id, parsed.data)
  recordAudit(ctx, { operation: 'template.update', outcome: 'success', message: parsed.data.name, details: { templateId: id } })
  return ctx.repos.templates.get(id)!
}

export function deleteTemplate(ctx: AppContext, id: string) {
  const existing = ctx.repos.templates.get(id)
  if (!existing) throw new ServiceError(404, 'Template not found.')
  if (existing.origin === 'example') throw new ServiceError(400, 'Example templates cannot be deleted.')
  const inUse = ctx.repos.recipes.list().filter((recipe) => recipe.definition.templateId === id)
  if (inUse.length) throw new ServiceError(409, `The template is used by: ${inUse.map((r) => r.definition.name).join(', ')}.`)
  ctx.repos.templates.delete(id)
  recordAudit(ctx, { operation: 'template.delete', outcome: 'success', details: { templateId: id } })
}

/**
 * Makes a recipe that uses this template. It starts from the built-in example recipe for the
 * template's page type (tag and link rules, AI instructions, required fields), named after the
 * template, with creation after approval switched on. Edit it like any other recipe.
 */
export function recipeFromTemplate(ctx: AppContext, templateId: string, options: { name?: string } = {}): Recipe {
  const template = ctx.repos.templates.get(templateId)
  if (!template) throw new ServiceError(404, 'Template not found.')
  const base = EXAMPLE_RECIPES.find((example) => example.targetPageType === template.definition.pageType)
  const name = options.name?.trim() || template.definition.name.replace(/ \(from LegendKeeper\)$| \(example\)$/, '')
  const taken = new Set(ctx.repos.recipes.list().map((recipe) => recipe.definition.name))
  let unique = name
  for (let n = 2; taken.has(unique); n++) unique = `${name} (${n})`
  const source = template.definition.lkLayout ? `the LegendKeeper ${template.definition.lkLayout.sourceKind} “${template.definition.lkLayout.sourceName}”` : `the template “${template.definition.name}”`
  const definition = RecipeDefinition.parse({
    ...(base ?? {}),
    name: unique,
    description: `Lays pages out like ${source}.${base?.description ? ` ${base.description}` : ''}`,
    targetPageType: template.definition.pageType,
    templateId,
    allowCreate: true,
  })
  return createRecipe(ctx, definition)
}

// ── Trying a recipe on sample text ───────────────────────────────────────────

const MAX_SAMPLE_CHARS = 100_000
const MAX_SAMPLE_RECORDS = 5

/**
 * Tries a recipe (saved or not) on pasted sample text: splits it into records with the
 * recipe's rules and drafts the first few without AI. Nothing is stored, nothing is sent
 * anywhere. Shows how the rules, labels and defaults behave before running a batch.
 */
export function testRecipe(ctx: AppContext, input: unknown) {
  const parsed = z.object({ definition: z.unknown(), text: z.string().min(1).max(MAX_SAMPLE_CHARS), format: z.enum(['text', 'markdown', 'json']).nullable().optional() }).safeParse(input)
  if (!parsed.success) throw new ServiceError(400, 'Paste some sample text (up to 100,000 characters).')
  const recipeParsed = RecipeDefinition.safeParse(parsed.data.definition)
  if (!recipeParsed.success) throw new ServiceError(400, 'The recipe is not valid.', issuesOf(recipeParsed.error))
  const recipe = recipeParsed.data
  const problems = checkRecipe(ctx, recipe)
  if (problems.length) throw new ServiceError(400, 'The recipe is not valid.', problems)
  const pageType = resolvePageType(recipe)!
  const template = resolveTemplate(pageType, recipe.templateId ? ctx.repos.templates.get(recipe.templateId) : null)

  let source
  try {
    source = extractSource({ bytes: new TextEncoder().encode(parsed.data.text), fileName: null, mimeType: null, declaredFormat: parsed.data.format ?? null }, { maxBytes: MAX_SAMPLE_CHARS * 4, maxChars: MAX_SAMPLE_CHARS })
  } catch (error) {
    throw new ServiceError(400, (error as Error).message)
  }
  const records = extractRecords({ text: source.text, json: source.json, format: source.format, title: source.title }, recipe.extraction, { maxChars: ctx.config().limits.maxSourceChars })
  const real = records.filter((r) => !r.flags.includes('preamble'))
  const drafts = real.slice(0, MAX_SAMPLE_RECORDS).map((record) => {
    const format = record.json !== undefined ? 'json' : source.format
    const draftContext: DraftContext = {
      pageType,
      template,
      recipe,
      recipeId: null,
      recipeVersion: null,
      templateId: recipe.templateId,
      jobId: 'sample',
      sourceText: record.text,
      sourceJson: record.json,
      sourceTitle: record.title,
      attribution: { title: 'Sample', kind: 'paste', citation: null, jobId: 'sample', importedAt: ctx.now().toISOString() },
      now: ctx.now().toISOString(),
    }
    const page = applyDefaultValues(buildStructuralDraft(draftContext, format).page, recipe)
    const { findings } = validateDraft(page, { pageType, recipe, sourceText: record.text, sameNamePages: [], parentInIndex: null, indexAvailable: true })
    return {
      title: record.title,
      section: record.section,
      flags: record.flags.map((flag) => ({ flag, explanation: FLAG_EXPLANATIONS[flag] })),
      name: page.name,
      fields: page.fields.filter((f) => f.value !== null && f.value.trim() !== '').map((f) => ({ label: f.label, value: f.value, status: f.status, note: f.note })),
      missing: page.fields.filter((f) => f.status === 'missing').map((f) => f.label),
      sections: page.sections.map((s) => ({ heading: s.heading, kind: s.kind, paragraphs: s.paragraphs.length })),
      findings: findings.filter((f) => f.severity !== 'info').map((f) => ({ severity: f.severity, message: f.message })),
    }
  })
  return {
    format: source.format,
    recordCount: real.length,
    preamble: records.filter((r) => r.flags.includes('preamble')).map((r) => r.text.slice(0, 200)),
    records: real.map((r) => ({ title: r.title, chars: r.text.length, flags: r.flags })),
    drafts,
    shown: drafts.length,
  }
}
