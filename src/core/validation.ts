import { CanonicalPage, type ValidationFinding } from './page-model'
import { checkFieldValue, type PageTypeDefinition } from './page-types'
import type { RecipeDefinition } from './recipe'
import { MAX_TAGS_PER_RESOURCE } from './tagging'
import { containsLoosely, numberTokens } from './text'
import { isLkResourceId } from './ids'

/**
 * Draft validation.
 *
 * - `error`: blocks writing until fixed.
 * - `warning`: allowed, but must be acknowledged when approving the write.
 * - `info`: context only.
 *
 * Validation is pure: everything it needs is passed in, so it can run in tests, on the
 * server before a write, and again after every edit.
 */

export interface ValidationContext {
  pageType: PageTypeDefinition | null
  recipe: RecipeDefinition | null
  /** The original source text, when still available, for grounding checks. */
  sourceText: string | null
  /** Pages in the resource index with the same name (possible duplicates). */
  sameNamePages: { id: string; name: string }[]
  /** Whether the parent was found in the resource index (null when the index is empty). */
  parentInIndex: boolean | null
  /** Whether a resource index exists, so link suggestions were possible. */
  indexAvailable: boolean
}

export function validateDraft(input: unknown, ctx: ValidationContext): { page: CanonicalPage | null; findings: ValidationFinding[] } {
  const parsed = CanonicalPage.safeParse(input)
  if (!parsed.success) {
    return {
      page: null,
      findings: parsed.error.issues.map((issue) => ({
        severity: 'error',
        code: 'SCHEMA',
        path: issue.path.join('.') || null,
        message: issue.message,
      })),
    }
  }
  const page = parsed.data
  const findings: ValidationFinding[] = []
  const add = (severity: ValidationFinding['severity'], code: string, path: string | null, message: string) =>
    findings.push({ severity, code, path, message })

  // Identity
  if (page.name.trim() === '') add('error', 'NAME_EMPTY', 'name', 'The page needs a name.')
  if (page.name !== page.name.trim()) add('warning', 'NAME_WHITESPACE', 'name', 'The name starts or ends with spaces.')
  for (const other of ctx.sameNamePages) {
    add('warning', 'POSSIBLE_DUPLICATE', 'name', `A page called “${other.name}” already exists (${other.id}). Creating this draft would add a second page with the same name.`)
  }
  const aliasSet = new Set<string>()
  page.aliases.forEach((alias, i) => {
    if (aliasSet.has(alias)) add('warning', 'ALIAS_DUPLICATE', `aliases.${i}`, `The alias “${alias}” is listed twice.`)
    aliasSet.add(alias)
  })

  // Page type
  if (!ctx.pageType) {
    add('error', 'PAGE_TYPE_UNKNOWN', 'pageType', `The page type “${page.pageType}” is not defined. Choose a built-in type or define it in the recipe.`)
  } else if (ctx.pageType.id !== page.pageType) {
    add('error', 'PAGE_TYPE_MISMATCH', 'pageType', `The draft is a “${page.pageType}” page but its recipe produces “${ctx.pageType.id}” pages.`)
  }

  // Destination
  if (page.parentId === null) {
    add('warning', 'PARENT_ROOT', 'parentId', 'No parent is set, so the page would be created at the top level of the project tree. That needs an ADMIN API key.')
  } else if (!isLkResourceId(page.parentId) && !/^[A-Za-z0-9_-]{1,256}$/.test(page.parentId)) {
    add('error', 'PARENT_INVALID', 'parentId', 'The parent ID does not look like a LegendKeeper resource ID.')
  } else if (ctx.parentInIndex === false) {
    add('info', 'PARENT_UNVERIFIED', 'parentId', 'The parent is not in the local resource index. It will be checked against LegendKeeper before writing.')
  }

  // Fields
  const required = new Set(ctx.recipe?.requiredFields ?? [])
  const knownKeys = new Set(ctx.pageType?.fields.map((f) => f.key) ?? [])
  for (const key of required) {
    if (ctx.pageType && !knownKeys.has(key)) {
      add('error', 'REQUIRED_FIELD_UNKNOWN', 'recipe.requiredFields', `The recipe requires a field “${key}” that this page type does not have.`)
    }
  }
  page.fields.forEach((field, i) => {
    const path = `fields.${i}`
    const definition = ctx.pageType?.fields.find((f) => f.key === field.key)
    if (ctx.pageType && !definition) add('warning', 'FIELD_UNKNOWN', path, `“${field.label}” is not a field of this page type and will not be written.`)
    const hasValue = field.value !== null && field.value.trim() !== ''
    const writable = hasValue && (field.status === 'source' || field.status === 'user')
    if (required.has(field.key) && !writable) {
      add('error', 'REQUIRED_FIELD_MISSING', path, `“${field.label}” is required by the recipe but has no confirmed value. Enter it from the source, or change the recipe.`)
    }
    if (hasValue && field.status === 'uncertain') {
      add('warning', 'FIELD_UNCERTAIN', path, `“${field.label}” is uncertain and will not be written unless you confirm it.${field.note ? ` ${field.note}` : ''}`)
    }
    if (hasValue && field.status === 'suggested') {
      add('warning', 'FIELD_SUGGESTED', path, `“${field.label}” is a suggestion, not a source fact, and will not be written unless you confirm it.`)
    }
    if (hasValue && field.status === 'missing') {
      add('warning', 'FIELD_STATUS_INCONSISTENT', path, `“${field.label}” has a value but is marked missing; it will not be written.`)
    }
    if (!hasValue && field.status !== 'missing') {
      add('info', 'FIELD_EMPTY', path, `“${field.label}” is empty.`)
    }
    if (hasValue && definition) {
      const problem = checkFieldValue(definition.kind, field.value!)
      if (problem) add('warning', 'FIELD_FORMAT', path, `“${field.label}”: ${problem}`)
    }
    if (writable && field.status === 'source' && ctx.sourceText !== null) {
      const missingNumbers = numberTokens(field.value!).filter((n) => !numberTokens(ctx.sourceText!).includes(n))
      if (missingNumbers.length > 0) {
        add('warning', 'FIELD_NUMBER_NOT_IN_SOURCE', path, `“${field.label}” contains ${missingNumbers.join(', ')}, which does not appear in the source.`)
      }
      if (field.sourceQuote && !containsLoosely(ctx.sourceText, field.sourceQuote)) {
        add('warning', 'FIELD_QUOTE_NOT_IN_SOURCE', path, `The supporting quote for “${field.label}” was not found in the source.`)
      }
    }
  })

  // Sections
  const writableFieldCount = page.fields.filter((f) => f.value && (f.status === 'source' || f.status === 'user')).length
  if (page.sections.length === 0 && writableFieldCount === 0) add('error', 'EMPTY_DRAFT', 'sections', 'The draft has no content to write.')
  page.sections.forEach((section, i) => {
    if (section.paragraphs.length === 0) add('info', 'SECTION_EMPTY', `sections.${i}`, `The section “${section.heading}” is empty and will be skipped.`)
    if (section.kind === 'unmapped') {
      add('warning', 'UNMAPPED_CONTENT', `sections.${i}`, `“${section.heading}” holds source text that did not fit the template. Move it into the right section or keep it as is.`)
    }
    if (ctx.sourceText !== null) {
      const sourceNumbers = new Set(numberTokens(ctx.sourceText))
      const unknown = [...new Set(section.paragraphs.flatMap(numberTokens))].filter((n) => !sourceNumbers.has(n))
      if (unknown.length > 0) {
        add('warning', 'SECTION_NUMBER_NOT_IN_SOURCE', `sections.${i}`, `“${section.heading}” contains number(s) not found in the source: ${unknown.slice(0, 10).join(', ')}.`)
      }
    }
  })

  // Tags
  const accepted = page.tags.filter((t) => t.accepted && t.status !== 'rejected')
  if (accepted.length > MAX_TAGS_PER_RESOURCE) add('error', 'TOO_MANY_TAGS', 'tags', `LegendKeeper allows at most ${MAX_TAGS_PER_RESOURCE} tags per page.`)
  page.tags.forEach((tag, i) => {
    if (tag.status === 'new' && tag.accepted) {
      add('warning', 'TAG_NEW', `tags.${i}`, `“${tag.value}” is a new tag that does not exist in the project yet.${tag.similarTo ? ` Did you mean “${tag.similarTo}”?` : ''}`)
    }
    if (tag.status === 'case_variant') {
      add('info', 'TAG_CASE_VARIANT', `tags.${i}`, `“${tag.value}” will be written as the existing tag “${tag.existingMatch}”.`)
    }
    if (tag.status === 'rejected') add('info', 'TAG_REJECTED', `tags.${i}`, `“${tag.value}” will not be added: ${tag.reason}`)
  })
  if (accepted.length === 0) add('warning', 'NO_TAGS', 'tags', 'The page would have no tags.')

  // References
  page.references.forEach((ref, i) => {
    const path = `references.${i}`
    if (ref.status === 'ambiguous') {
      add('error', 'REFERENCE_AMBIGUOUS', path, `“${ref.mention}” matches ${ref.candidates.length} pages. Choose the right one, or leave it unresolved.`)
    }
    if (ref.status === 'resolved' && !ref.resourceId) add('error', 'REFERENCE_NO_ID', path, `“${ref.mention}” is marked resolved but has no page ID.`)
    if (ref.status === 'resolved' && ref.resourceId && !ref.candidates.some((c) => c.resourceId === ref.resourceId)) {
      add('error', 'REFERENCE_UNVERIFIED_ID', path, `“${ref.mention}” points to an ID that did not come from LegendKeeper.`)
    }
    if (ref.status === 'unresolved' && ref.candidates.length > 0) {
      add('info', 'REFERENCE_SUGGESTIONS', path, `“${ref.mention}” has possible matches; it will stay plain text unless you choose one.`)
    }
  })
  if (!ctx.indexAvailable && page.references.length > 0) {
    add('info', 'NO_INDEX', 'references', 'No resource index has been built, so links could not be matched automatically. Run a project scan, or search for each page manually.')
  }

  return { page, findings }
}

export function hasBlockingErrors(findings: ValidationFinding[]): boolean {
  return findings.some((f) => f.severity === 'error')
}

export function countBySeverity(findings: ValidationFinding[]) {
  return {
    errors: findings.filter((f) => f.severity === 'error').length,
    warnings: findings.filter((f) => f.severity === 'warning').length,
    info: findings.filter((f) => f.severity === 'info').length,
  }
}
