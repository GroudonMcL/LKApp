import { z } from 'zod'
import { pageTypeForTags } from './audit-checks'
import { guessPageType } from './extraction'
import type { PageTypeDefinition } from './page-types'
import { normalizeTag } from './text'
import { MAX_TAG_LENGTH, MAX_TAGS_PER_RESOURCE } from './tagging'

/**
 * The tagging assistant: suggestions for tags to add to (or, only when you select it,
 * remove from) existing pages.
 *
 * Policies:
 * - A `existing_only`: only tags that already exist in the project.
 * - B `allow_new`: new tags may be suggested; each one must be approved explicitly.
 * - C `approved_taxonomy`: only tags in your approved list, optionally limited to page types.
 *   Aliases in the taxonomy map spelling variants to the approved tag.
 *
 * Existing tags are never merged automatically. Suggestions say where they come from and how
 * sure they are; only `definite` and `likely` additions start pre-selected.
 */

export const TaxonomyEntry = z.object({
  tag: z.string().trim().min(1).max(MAX_TAG_LENGTH),
  /** Other spellings that mean this tag (e.g. "Monsters", "monster"). Suggestions use the approved spelling. */
  aliases: z.array(z.string().trim().min(1).max(MAX_TAG_LENGTH)).max(20).default([]),
  /** Page types this tag is meant for; empty = any page. */
  pageTypes: z.array(z.string().min(1).max(64)).max(10).default([]),
  /** A grouping for the review screen, e.g. "Type", "Region", "Subject". */
  category: z.string().trim().max(60).default(''),
  description: z.string().max(500).default(''),
})
export type TaxonomyEntry = z.infer<typeof TaxonomyEntry>

export const TagRule = z.object({
  /** All given conditions must hold. */
  when: z.object({
    pageType: z.string().max(64).nullable().default(null),
    /** The page is inside this folder (a page and everything below it). */
    underResourceId: z.string().max(100).nullable().default(null),
    nameContains: z.string().max(200).nullable().default(null),
    hasTag: z.string().max(MAX_TAG_LENGTH).nullable().default(null),
  }),
  add: z.array(z.string().trim().min(1).max(MAX_TAG_LENGTH)).min(1).max(10),
  note: z.string().max(300).default(''),
})
export type TagRule = z.infer<typeof TagRule>

export const TaxonomyConfig = z.object({
  policy: z.enum(['existing_only', 'allow_new', 'approved_taxonomy']).default('existing_only'),
  approved: z.array(TaxonomyEntry).max(500).default([]),
  rules: z.array(TagRule).max(200).default([]),
  /** Also ask the AI (page text is sent to the AI provider). */
  useAi: z.boolean().default(false),
  maxSuggestionsPerPage: z.number().int().min(1).max(20).default(6),
  /** Suggest tags that siblings share, when at least this share of siblings (≥ 3) has them. */
  siblingShare: z.number().min(0.5).max(1).default(0.6),
})
export type TaxonomyConfig = z.infer<typeof TaxonomyConfig>

export type SuggestionSource = 'rule' | 'page_type' | 'folder' | 'siblings' | 'links' | 'text' | 'ai'
export type SuggestionCertainty = 'definite' | 'likely' | 'possible'

export interface TagSuggestion {
  tag: string
  action: 'add' | 'remove'
  /** existing: the tag exists in the project; new: it would be created by adding it. */
  existence: 'existing' | 'new'
  source: SuggestionSource
  certainty: SuggestionCertainty
  reason: string
  selected: boolean
  /** Why the policy refused it, when it did (shown, never applied). */
  refused: string | null
}

export interface TagPageInput {
  id: string
  name: string
  parentId: string | null
  tags: string[]
  /** Ancestors from the root down. */
  ancestors: { id: string; name: string }[]
  /** Siblings' tag lists (same parent). */
  siblingTags: string[][]
  /** Names of pages this page links to. */
  linkedNames: string[]
  /** Plain text of the page (may be empty when content was not read). */
  text: string
}

export interface TagContext {
  existing: Map<string, { tag: string; count: number }>
  pageTypes: PageTypeDefinition[]
  config: TaxonomyConfig
}

export function existingTagMap(tags: { tag: string; count: number }[]): Map<string, { tag: string; count: number }> {
  const map = new Map<string, { tag: string; count: number }>()
  // Most used first, so a case variant resolves to the spelling the project uses most.
  for (const t of [...tags].sort((a, b) => b.count - a.count)) if (!map.has(normalizeTag(t.tag))) map.set(normalizeTag(t.tag), t)
  return map
}

/** The approved spelling for a tag under the taxonomy (aliases resolve to their entry). */
function taxonomyEntryFor(tag: string, config: TaxonomyConfig): TaxonomyEntry | null {
  const key = normalizeTag(tag)
  return config.approved.find((e) => normalizeTag(e.tag) === key || e.aliases.some((a) => normalizeTag(a) === key)) ?? null
}

/** Infers what kind of page this is: from its tags first, then from its text. */
export function inferPageType(page: TagPageInput, pageTypes: PageTypeDefinition[]): { type: PageTypeDefinition; from: 'tags' | 'text' } | null {
  const byTags = pageTypeForTags(page.tags, pageTypes)
  if (byTags) return { type: byTags, from: 'tags' }
  if (!page.text) return null
  const guess = guessPageType(page.text, pageTypes)[0]
  if (guess && guess.matched.length >= 3) {
    const type = pageTypes.find((t) => t.id === guess.pageType)
    if (type) return { type, from: 'text' }
  }
  return null
}

export function suggestTagsForPage(page: TagPageInput, ctx: TagContext, aiSuggestions: { tag: string; reason: string; certainty: SuggestionCertainty }[] = []): TagSuggestion[] {
  const { config } = ctx
  const have = new Set(page.tags.map(normalizeTag))
  const out = new Map<string, TagSuggestion>()
  const inferred = inferPageType(page, ctx.pageTypes)

  const propose = (raw: string, source: SuggestionSource, certainty: SuggestionCertainty, reason: string) => {
    const trimmed = raw.trim()
    if (!trimmed || trimmed.length > MAX_TAG_LENGTH) return
    // Resolve spelling: taxonomy alias → approved tag; otherwise the project's existing spelling.
    const entry = taxonomyEntryFor(trimmed, config)
    const existing = ctx.existing.get(normalizeTag(entry?.tag ?? trimmed))
    const tag = entry?.tag ?? existing?.tag ?? trimmed
    const key = normalizeTag(tag)
    if (have.has(key)) return
    let refused: string | null = null
    const isNew = !ctx.existing.has(key)
    if (config.policy === 'existing_only' && isNew) refused = 'Not an existing tag (policy: existing tags only).'
    if (config.policy === 'approved_taxonomy') {
      if (!entry) refused = 'Not in your approved taxonomy.'
      else if (entry.pageTypes.length && (!inferred || !entry.pageTypes.includes(inferred.type.id))) refused = `The taxonomy limits “${entry.tag}” to ${entry.pageTypes.join(', ')} pages.`
    }
    const previous = out.get(key)
    const rank = { definite: 3, likely: 2, possible: 1 }
    if (previous && rank[previous.certainty] >= rank[certainty]) {
      if (!previous.reason.includes(reason)) previous.reason = `${previous.reason} Also: ${reason}`
      return
    }
    out.set(key, {
      tag,
      action: 'add',
      existence: isNew ? 'new' : 'existing',
      source,
      certainty,
      reason: previous ? `${reason} Also: ${previous.reason}` : reason,
      // Pre-select only sure, allowed suggestions; new tags always need a conscious tick.
      selected: refused === null && !isNew && (certainty === 'definite' || certainty === 'likely'),
      refused,
    })
  }

  // 1. Your rules.
  for (const rule of config.rules) {
    const w = rule.when
    if (w.pageType && inferred?.type.id !== w.pageType) continue
    if (w.underResourceId && !page.ancestors.some((a) => a.id === w.underResourceId) && page.id !== w.underResourceId) continue
    if (w.nameContains && !page.name.toLowerCase().includes(w.nameContains.toLowerCase())) continue
    if (w.hasTag && !have.has(normalizeTag(w.hasTag))) continue
    for (const tag of rule.add) propose(tag, 'rule', 'definite', rule.note ? `Your rule: ${rule.note}` : 'Matches one of your tagging rules.')
  }

  // 2. Page type (the type's conventional tag, in the spelling the project uses most).
  if (inferred && inferred.from === 'text') {
    const options = [inferred.type.suggestedTag, ...inferred.type.alternativeTags].filter((t): t is string => Boolean(t))
    const best = options.map((o) => ctx.existing.get(normalizeTag(o))).filter((x): x is NonNullable<typeof x> => Boolean(x)).sort((a, b) => b.count - a.count)[0]
    propose(best?.tag ?? inferred.type.suggestedTag ?? options[0] ?? '', 'page_type', 'possible', `The text looks like a ${inferred.type.label} page.`)
  }

  // 3. Folder: an ancestor whose name is an existing tag (e.g. a page under “Saltmarsh”).
  for (const ancestor of page.ancestors) {
    if (ctx.existing.has(normalizeTag(ancestor.name))) propose(ancestor.name, 'folder', 'likely', `The page is inside “${ancestor.name}”, which is also a tag.`)
  }

  // 4. Siblings: a tag most pages next to this one share.
  const siblings = page.siblingTags.filter((tags) => tags.length > 0)
  if (siblings.length >= 3) {
    const counts = new Map<string, { tag: string; n: number }>()
    for (const tags of siblings) for (const tag of new Set(tags)) counts.set(normalizeTag(tag), { tag, n: (counts.get(normalizeTag(tag))?.n ?? 0) + 1 })
    for (const { tag, n } of counts.values()) {
      if (n / siblings.length >= config.siblingShare) propose(tag, 'siblings', n / siblings.length >= 0.9 ? 'likely' : 'possible', `${n} of ${siblings.length} pages next to this one have it.`)
    }
  }

  // 5. Links: the page links to a page whose name is an existing tag.
  for (const name of page.linkedNames) {
    if (ctx.existing.has(normalizeTag(name))) propose(name, 'links', 'possible', `The page links to “${name}”, which is also a tag.`)
  }

  // 6. Text: an approved taxonomy tag (or its alias) appears in the page name or text.
  for (const entry of config.approved) {
    const terms = [entry.tag, ...entry.aliases]
    const where = terms.find((t) => wordIn(page.name, t)) ? 'name' : terms.find((t) => page.text && wordIn(page.text.slice(0, 5000), t)) ? 'text' : null
    if (where) propose(entry.tag, 'text', where === 'name' ? 'likely' : 'possible', `“${entry.tag}” (or one of its aliases) appears in the page ${where}.`)
  }
  // 6b. Text: one of your existing tags is named in the page name or its opening lines (e.g. “An NPC who…”).
  // Only the opening is checked, and at most three, to keep everyday words from flooding the list.
  const opening = page.text.slice(0, 300)
  let fromText = 0
  for (const { tag } of [...ctx.existing.values()].sort((a, b) => b.count - a.count)) {
    if (fromText >= 3) break
    if (tag.length < 3 || have.has(normalizeTag(tag))) continue
    const where = wordIn(page.name, tag) ? 'name' : opening && wordIn(opening, tag) ? 'opening text' : null
    if (!where) continue
    propose(tag, 'text', 'possible', `Your existing tag “${tag}” appears in the page ${where}.`)
    fromText++
  }

  // 7. AI suggestions (only when enabled; already limited to the allowed tags by the prompt, checked again here).
  for (const s of aiSuggestions) propose(s.tag, 'ai', s.certainty === 'definite' ? 'likely' : s.certainty, `AI: ${s.reason}`)

  const sorted = [...out.values()].sort((a, b) => certaintyRank(b.certainty) - certaintyRank(a.certainty) || a.tag.localeCompare(b.tag))
  // At most `maxSuggestionsPerPage` usable suggestions, plus a few refused ones shown for information.
  const additions = [...sorted.filter((s) => s.refused === null).slice(0, config.maxSuggestionsPerPage), ...sorted.filter((s) => s.refused !== null).slice(0, 5)]
  // Never exceed LegendKeeper's tag limit per page.
  let room = MAX_TAGS_PER_RESOURCE - page.tags.length
  for (const s of additions) {
    if (!s.selected) continue
    if (room > 0) room--
    else s.selected = false
  }
  return [...additions, ...questionableTags(page, ctx, inferred?.type ?? null)]
}

/** Tags already on the page that may be wrong or redundant. Shown with a reason; never pre-selected. */
export function questionableTags(page: TagPageInput, ctx: TagContext, type: PageTypeDefinition | null): TagSuggestion[] {
  const out: TagSuggestion[] = []
  const seen = new Map<string, string>()
  for (const tag of page.tags) {
    const key = normalizeTag(tag)
    const remove = (reason: string, certainty: SuggestionCertainty) =>
      out.push({ tag, action: 'remove', existence: 'existing', source: 'rule', certainty, reason, selected: false, refused: null })
    if (seen.has(key)) {
      remove(`Same as “${seen.get(key)}” on this page apart from capitals or spaces.`, 'definite')
      continue
    }
    seen.set(key, tag)
    const singular = key.replace(/(ies)$/, 'y').replace(/(es|s)$/, '')
    const twin = page.tags.find((other) => other !== tag && normalizeTag(other).replace(/(ies)$/, 'y').replace(/(es|s)$/, '') === singular && normalizeTag(other).length < key.length)
    if (twin) remove(`The page also has “${twin}”; this looks like its plural.`, 'likely')
    if (ctx.config.policy === 'approved_taxonomy') {
      const entry = taxonomyEntryFor(tag, ctx.config)
      if (!entry) remove('Not in your approved taxonomy.', 'possible')
      else if (normalizeTag(entry.tag) !== key) remove(`Your taxonomy spells this “${entry.tag}”.`, 'likely')
      else if (entry.pageTypes.length && type && !entry.pageTypes.includes(type.id)) remove(`Your taxonomy limits it to ${entry.pageTypes.join(', ')} pages; this looks like a ${type.label} page.`, 'possible')
    }
  }
  return out
}

function certaintyRank(c: SuggestionCertainty) {
  return c === 'definite' ? 3 : c === 'likely' ? 2 : 1
}

function wordIn(text: string, term: string): boolean {
  const escaped = term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  return new RegExp(`(^|[^\\p{L}\\p{N}])${escaped}([^\\p{L}\\p{N}]|$)`, 'iu').test(text)
}

/** The tag list to write: current tags, plus selected additions, minus selected removals. Order kept. */
export function applyTagChanges(current: string[], suggestions: TagSuggestion[]): string[] {
  const removals = new Set(suggestions.filter((s) => s.selected && s.action === 'remove' && !s.refused).map((s) => s.tag))
  const result = current.filter((tag) => !removals.has(tag))
  const have = new Set(result.map(normalizeTag))
  for (const s of suggestions) {
    if (!s.selected || s.action !== 'add' || s.refused) continue
    if (have.has(normalizeTag(s.tag))) continue
    result.push(s.tag)
    have.add(normalizeTag(s.tag))
  }
  return result
}
