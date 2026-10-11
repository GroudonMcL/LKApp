import { getByPath, jsonValueToText } from './extraction'
import type { CanonicalPage, PageField, PageSection, ProcessingMetadata, SourceAttribution } from './page-model'
import { CANONICAL_SCHEMA_VERSION } from './page-model'
import type { PageTypeDefinition } from './page-types'
import type { RecipeDefinition } from './recipe'
import type { TemplateDefinition } from './template'
import type { MentionInput } from './references'
import type { TagCandidate } from './tagging'
import { normalizeTag } from './text'

/** What a transformation (AI or structural) produces before tags and links are resolved. */
export interface DraftBuildResult {
  page: CanonicalPage
  mentions: MentionInput[]
  tagCandidates: TagCandidate[]
}

export interface DraftContext {
  pageType: PageTypeDefinition
  template: TemplateDefinition
  recipe: RecipeDefinition
  recipeId: string | null
  recipeVersion: number | null
  templateId: string | null
  jobId: string
  sourceText: string
  sourceJson?: unknown
  sourceTitle: string | null
  attribution: SourceAttribution
  now: string
  /** Names of tags that already exist in the project, most used first, when known. */
  existingTags?: string[]
}

export function emptyFields(pageType: PageTypeDefinition): PageField[] {
  return pageType.fields.map((field) => ({
    key: field.key,
    label: field.label,
    group: field.group,
    value: null,
    status: 'missing',
    sourceQuote: null,
    note: null,
  }))
}

/**
 * Applies the recipe's JSON field mappings. Mapped values are copied verbatim from the
 * source and marked as source facts. They take precedence over anything the AI returned.
 */
export function applyJsonMappings(fields: PageField[], recipe: RecipeDefinition, json: unknown): { fields: PageField[]; usedPaths: string[] } {
  if (json === undefined) return { fields, usedPaths: [] }
  const usedPaths: string[] = []
  const next = fields.map((field) => {
    const mapping = recipe.fieldMappings.find((m) => m.fieldKey === field.key && m.sourcePath)
    if (!mapping?.sourcePath) return field
    const value = jsonValueToText(getByPath(json, mapping.sourcePath))
    if (value === null || value.trim() === '') {
      return { ...field, note: `Mapped path “${mapping.sourcePath}” is empty or absent in the source.` }
    }
    usedPaths.push(mapping.sourcePath)
    return { ...field, value, status: 'source' as const, sourceQuote: value, note: `Copied from JSON path “${mapping.sourcePath}”.` }
  })
  return { fields: next, usedPaths }
}

export function baseTagCandidates(ctx: DraftContext): TagCandidate[] {
  const out: TagCandidate[] = []
  if (ctx.recipe.tagPolicy.includePageTypeTag && ctx.pageType.suggestedTag) {
    // Prefer the conventional tag the project uses most (e.g. "Monster" rather than "Creature").
    // existingTags is ordered by usage, most used first.
    const options = new Set([ctx.pageType.suggestedTag, ...ctx.pageType.alternativeTags].map(normalizeTag))
    const chosen = (ctx.existingTags ?? []).find((tag) => options.has(normalizeTag(tag))) ?? ctx.pageType.suggestedTag
    out.push({ value: chosen, origin: 'page_type', reason: `Conventional tag for ${ctx.pageType.label} pages.` })
  }
  for (const tag of ctx.recipe.tagPolicy.alwaysAdd) out.push({ value: tag, origin: 'recipe', reason: 'Always added by the recipe.' })
  return out
}

export function newPage(ctx: DraftContext, name: string, fields: PageField[], sections: PageSection[], processing: ProcessingMetadata): CanonicalPage {
  return {
    schemaVersion: CANONICAL_SCHEMA_VERSION,
    externalSourceId: null,
    lkResourceId: null,
    name,
    aliases: [],
    pageType: ctx.pageType.id,
    parentId: ctx.recipe.defaultParentId,
    tags: [],
    templateId: ctx.templateId,
    fields,
    sections,
    references: [],
    sources: [ctx.attribution],
    reviewerNotes: [],
    processing,
    migration: null,
  }
}

let sectionCounter = 0
export function sectionId(): string {
  sectionCounter = (sectionCounter + 1) % 1_000_000
  return `sec_${Date.now().toString(36)}_${sectionCounter}`
}

/** Section headings that hold game mechanics rather than lore. */
export const MECHANICS_HEADINGS = new Set(
  ['traits', 'actions', 'bonus actions', 'reactions', 'legendary actions', 'lair actions', 'rules text', 'properties', 'statistics', 'spellcasting', 'mythic actions'].map((h) => h.toLowerCase()),
)

/**
 * Fills fields the source left empty with the recipe's configured default values. They get
 * status `default`, so they are never mistaken for source facts. Source values always win.
 */
export function applyDefaultValues(page: CanonicalPage, recipe: RecipeDefinition): CanonicalPage {
  if (recipe.defaultValues.length === 0) return page
  const fields = page.fields.map((field) => {
    const configured = recipe.defaultValues.find((d) => d.fieldKey === field.key)
    if (!configured || (field.value !== null && field.value.trim() !== '' && field.status !== 'missing')) return field
    return { ...field, value: configured.value, status: 'default' as const, sourceQuote: null, note: 'Default value from the recipe (not in the source).' }
  })
  return { ...page, fields }
}
