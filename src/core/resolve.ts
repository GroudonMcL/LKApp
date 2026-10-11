import { BUILT_IN_PAGE_TYPES, findBuiltInPageType, type PageTypeDefinition } from './page-types'
import type { RecipeDefinition } from './recipe'
import { TemplateDefinition, type PageTemplate } from './template'

/**
 * Works out the page type a recipe produces: a built-in type, or the recipe's custom type,
 * plus any extra fields the recipe adds. Returns null when the recipe names a type that
 * does not exist.
 */
export function resolvePageType(recipe: RecipeDefinition): PageTypeDefinition | null {
  const base =
    recipe.customPageType && recipe.customPageType.id === recipe.targetPageType
      ? recipe.customPageType
      : findBuiltInPageType(recipe.targetPageType)
  if (!base) return null
  if (recipe.extraFields.length === 0) return base
  const existing = new Set(base.fields.map((field) => field.key))
  return { ...base, fields: [...base.fields, ...recipe.extraFields.filter((field) => !existing.has(field.key))] }
}

export function pageTypeLabel(id: string, custom?: PageTypeDefinition | null): string {
  if (custom && custom.id === id) return custom.label
  return findBuiltInPageType(id)?.label ?? id
}

/** The template a draft should follow, falling back to the page type's default sections. */
export function resolveTemplate(pageType: PageTypeDefinition, template: PageTemplate | null): TemplateDefinition {
  if (template && template.definition.pageType === pageType.id) return template.definition
  return TemplateDefinition.parse({
    name: `${pageType.label} (default)`,
    pageType: pageType.id,
    sections: pageType.sections.length > 0 ? pageType.sections : ['Description'],
    infoboxFields: pageType.fields.filter((field) => field.group === 'lore').map((field) => field.key),
  })
}

export function allPageTypes(customTypes: PageTypeDefinition[] = []): PageTypeDefinition[] {
  const ids = new Set(BUILT_IN_PAGE_TYPES.map((type) => type.id))
  return [...BUILT_IN_PAGE_TYPES, ...customTypes.filter((type) => !ids.has(type.id))]
}
