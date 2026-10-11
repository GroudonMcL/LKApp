import type { PageTypeDefinition } from './page-types'
import { levenshtein, normalizeName, normalizeTag } from './text'

/**
 * Wiki Health checks. Pure functions over the metadata index and page summaries; they only
 * *report*. Every finding says how sure it is and whether a person should look at it:
 *
 * - severity: `problem` (something is wrong), `suggestion` (worth a look; may be intentional),
 *   `info` (for awareness).
 * - certainty: `definite` (a fact, e.g. a page has no tags), `likely`, `possible`.
 *
 * A difference from a template is never reported as definite: older or special pages can
 * differ on purpose.
 */

export type AuditCategory = 'untagged' | 'tags' | 'template' | 'missing_fields' | 'duplicates' | 'broken_links' | 'naming' | 'attribution' | 'unreadable'
export const AUDIT_CATEGORIES: { id: AuditCategory; label: string; needsContent: boolean; description: string }[] = [
  { id: 'untagged', label: 'Pages without tags', needsContent: false, description: 'Pages that carry no tag at all.' },
  { id: 'tags', label: 'Inconsistent or redundant tags', needsContent: false, description: 'Tags that differ only in capitals, singular/plural, or a likely typo.' },
  { id: 'template', label: 'Possibly outdated layout', needsContent: true, description: 'Pages whose structure differs a lot from the current template for their type.' },
  { id: 'missing_fields', label: 'Missing expected fields', needsContent: true, description: 'Pages of a type whose required fields (from your recipes) cannot be found.' },
  { id: 'duplicates', label: 'Possible duplicate pages', needsContent: false, description: 'Pages with the same or nearly the same name.' },
  { id: 'broken_links', label: 'Broken links', needsContent: true, description: 'Links to pages that no longer exist (or that this key cannot see).' },
  { id: 'naming', label: 'Inconsistent names', needsContent: false, description: 'Names with stray spaces, or names that differ only in capitals from another page.' },
  { id: 'attribution', label: 'Missing source attribution', needsContent: true, description: 'Pages of a type whose recipe requires sources, without a Sources section.' },
  { id: 'unreadable', label: 'Unreadable content', needsContent: true, description: 'Pages that could not be read, or parts the API cannot show.' },
]

export type Severity = 'problem' | 'suggestion' | 'info'
export type Certainty = 'definite' | 'likely' | 'possible'

export interface AuditResource {
  id: string
  name: string
  parentId: string | null
  tags: string[]
  aliases: string[]
  path: string | null
  updatedAt: string | null
}

/** What the audit knows of a page's content (from the content cache). */
export interface PageSummary {
  version: string | null
  error: string | null
  hasInfobox: boolean
  headings: string[]
  textFieldTitles: string[]
  keyValueKeys: string[]
  mentionIds: string[]
  unsupportedCount: number
  text: string
}

/** What pages of one type are expected to have, from your templates and recipes. */
export interface TypeExpectation {
  pageTypeId: string
  pageTypeLabel: string
  /** A template copied from LegendKeeper for this type, if any. */
  template: { name: string; keyValueKeys: string[]; sections: string[]; hasInfobox: boolean } | null
  requiredFields: { key: string; label: string; aliases: string[] }[]
  attributionRequired: boolean
}

export interface FindingDraft {
  key: string
  category: AuditCategory
  severity: Severity
  certainty: Certainty
  resourceId: string | null
  resourceName: string | null
  related: { id: string; name: string }[]
  title: string
  explanation: string
  evidence: Record<string, unknown>
  remedy: string
  needsReview: boolean
  /** What the finding was based on; a later change to it means the finding may be stale. */
  fingerprint: string | null
}

export interface AuditInput {
  resources: AuditResource[]
  /** Resources to report on. Project-wide checks (tags) run only for full audits. */
  inScope: Set<string>
  fullProject: boolean
  summaries: Map<string, PageSummary>
  pageTypes: PageTypeDefinition[]
  expectations: Map<string, TypeExpectation>
  checks: Set<AuditCategory>
}

/** Which page type a page is, judged by its tags (e.g. "Monster" → creature). */
export function pageTypeForTags(tags: string[], pageTypes: PageTypeDefinition[]): PageTypeDefinition | null {
  const wanted = new Set(tags.map(normalizeTag))
  for (const type of pageTypes) {
    const typeTags = [type.suggestedTag, ...type.alternativeTags].filter((t): t is string => Boolean(t)).map(normalizeTag)
    if (typeTags.some((t) => wanted.has(t))) return type
  }
  return null
}

export function runChecks(input: AuditInput): FindingDraft[] {
  const out: FindingDraft[] = []
  const byId = new Map(input.resources.map((r) => [r.id, r]))
  const scoped = input.resources.filter((r) => input.inScope.has(r.id))
  const fp = (r: AuditResource) => input.summaries.get(r.id)?.version ?? r.updatedAt ?? null
  const add = (f: FindingDraft) => out.push(f)

  if (input.checks.has('untagged')) {
    for (const r of scoped) {
      if (r.tags.length > 0) continue
      add({
        key: `untagged:${r.id}`,
        category: 'untagged',
        severity: 'problem',
        certainty: 'definite',
        resourceId: r.id,
        resourceName: r.name,
        related: [],
        title: `“${r.name}” has no tags`,
        explanation: 'Pages without tags are harder to find, filter and group.',
        evidence: { path: r.path },
        remedy: 'Add tags (the Tagging assistant can suggest them).',
        needsReview: true,
        fingerprint: r.updatedAt,
      })
    }
  }

  if (input.checks.has('tags') && input.fullProject) {
    const counts = new Map<string, number>()
    for (const r of input.resources) for (const tag of r.tags) counts.set(tag, (counts.get(tag) ?? 0) + 1)
    const tags = [...counts.keys()].sort()
    const seen = new Set<string>()
    for (let i = 0; i < tags.length; i++) {
      for (let j = i + 1; j < tags.length; j++) {
        const a = tags[i]!
        const b = tags[j]!
        const relation = tagRelation(a, b)
        if (!relation) continue
        const pairKey = [a, b].sort().join('|')
        if (seen.has(pairKey)) continue
        seen.add(pairKey)
        const [rare, common] = (counts.get(a) ?? 0) <= (counts.get(b) ?? 0) ? [a, b] : [b, a]
        const pages = input.resources.filter((r) => r.tags.includes(rare)).slice(0, 20)
        add({
          key: `tags:${pairKey}`,
          category: 'tags',
          severity: 'suggestion',
          certainty: relation.certainty,
          resourceId: null,
          resourceName: null,
          related: pages.map((p) => ({ id: p.id, name: p.name })),
          title: `Tags “${rare}” (${counts.get(rare)}) and “${common}” (${counts.get(common)}) ${relation.label}`,
          explanation: `${relation.explanation} If they mean the same thing, using one of them keeps filtering reliable. They may also be deliberately different.`,
          evidence: { tags: { [a]: counts.get(a), [b]: counts.get(b) } },
          remedy: `Decide whether “${rare}” should become “${common}”. The Tagging assistant can add the chosen tag; tags are never merged automatically.`,
          needsReview: true,
          fingerprint: `${counts.get(a)}|${counts.get(b)}`,
        })
      }
    }
  }

  if (input.checks.has('duplicates') || input.checks.has('naming')) {
    const groups = new Map<string, AuditResource[]>()
    for (const r of input.resources) {
      const key = normalizeName(r.name)
      if (key) groups.set(key, [...(groups.get(key) ?? []), r])
    }
    for (const group of groups.values()) {
      if (group.length < 2 || !group.some((r) => input.inScope.has(r.id))) continue
      const exactSame = new Set(group.map((r) => r.name)).size === 1
      const sameType = group.every((r) => r.tags.length > 0) && new Set(group.map((r) => pageTypeForTags(r.tags, input.pageTypes)?.id ?? `?${r.id}`)).size === 1
      const ids = group.map((r) => r.id).sort()
      if (input.checks.has('duplicates')) {
        add({
          key: `duplicates:${ids.join(',')}`,
          category: 'duplicates',
          severity: 'suggestion',
          certainty: sameType ? 'likely' : 'possible',
          resourceId: group[0]!.id,
          resourceName: group[0]!.name,
          related: group.slice(1).map((r) => ({ id: r.id, name: r.name })),
          title: `${group.length} pages named “${group[0]!.name}”${exactSame ? '' : ' (spelled slightly differently)'}`,
          explanation: sameType
            ? 'These pages share a name and look like the same kind of page. They may be duplicates.'
            : 'These pages share a name but may be different things (for example a place and an adventure with the same name).',
          evidence: { pages: group.map((r) => ({ id: r.id, name: r.name, path: r.path, tags: r.tags })) },
          remedy: 'Open both pages. If they describe the same entity, combine them in LegendKeeper by hand (the app never merges pages); otherwise mark this as intentional.',
          needsReview: true,
          fingerprint: group.map((r) => `${r.id}@${r.updatedAt}`).join('|'),
        })
      }
      if (input.checks.has('naming') && !exactSame && group.some((r) => input.inScope.has(r.id))) {
        add({
          key: `naming:${ids.join(',')}`,
          category: 'naming',
          severity: 'suggestion',
          certainty: 'definite',
          resourceId: group[0]!.id,
          resourceName: group[0]!.name,
          related: group.slice(1).map((r) => ({ id: r.id, name: r.name })),
          title: `Names differ only in capitals, accents or punctuation: ${group.map((r) => `“${r.name}”`).join(', ')}`,
          explanation: 'Inconsistent spelling of the same name makes search and links less reliable.',
          evidence: { names: group.map((r) => r.name) },
          remedy: 'If they are the same entity, use one spelling (and add the other as an alias).',
          needsReview: true,
          fingerprint: group.map((r) => r.name).join('|'),
        })
      }
    }
  }

  if (input.checks.has('naming')) {
    for (const r of scoped) {
      if (r.name !== r.name.trim() || /\s{2,}/.test(r.name)) {
        add({
          key: `naming:spaces:${r.id}`,
          category: 'naming',
          severity: 'suggestion',
          certainty: 'definite',
          resourceId: r.id,
          resourceName: r.name,
          related: [],
          title: `“${r.name}” has stray spaces in its name`,
          explanation: 'Leading, trailing or double spaces make exact-name search and link matching fail.',
          evidence: { name: JSON.stringify(r.name) },
          remedy: 'Rename the page without the extra spaces.',
          needsReview: false,
          fingerprint: r.name,
        })
      }
    }
  }

  // Content checks need page summaries.
  for (const r of scoped) {
    const summary = input.summaries.get(r.id)
    if (!summary) continue
    const type = pageTypeForTags(r.tags, input.pageTypes)
    const expectation = type ? input.expectations.get(type.id) : undefined

    if (input.checks.has('unreadable')) {
      if (summary.error) {
        add({
          key: `unreadable:error:${r.id}`,
          category: 'unreadable',
          severity: 'problem',
          certainty: 'definite',
          resourceId: r.id,
          resourceName: r.name,
          related: [],
          title: `“${r.name}” could not be read`,
          explanation: summary.error,
          evidence: { error: summary.error },
          remedy: 'Open the page in LegendKeeper. If it opens normally, run the audit again later.',
          needsReview: true,
          fingerprint: summary.version,
        })
      } else if (summary.unsupportedCount > 0) {
        add({
          key: `unreadable:unsupported:${r.id}`,
          category: 'unreadable',
          severity: 'info',
          certainty: 'definite',
          resourceId: r.id,
          resourceName: r.name,
          related: [],
          title: `“${r.name}” has ${summary.unsupportedCount} part(s) the API cannot show`,
          explanation: 'LegendKeeper keeps these parts; this app cannot read or check them, and a migration keeps them in place untouched.',
          evidence: { unsupportedBlocks: summary.unsupportedCount },
          remedy: 'Nothing to do unless you expect these parts to be checked.',
          needsReview: false,
          fingerprint: summary.version,
        })
      }
    }
    if (summary.error) continue

    if (input.checks.has('broken_links')) {
      const missing = summary.mentionIds.filter((id) => !byId.has(id))
      if (missing.length) {
        add({
          key: `broken_links:${r.id}`,
          category: 'broken_links',
          severity: 'problem',
          certainty: 'likely',
          resourceId: r.id,
          resourceName: r.name,
          related: [],
          title: `“${r.name}” links to ${missing.length} page(s) that were not found`,
          explanation: 'The linked pages are not in the project index. They were probably deleted, or this API key is not allowed to see them.',
          evidence: { missingResourceIds: missing },
          remedy: 'Open the page and fix or remove the links (or restore the linked pages from the trash).',
          needsReview: true,
          fingerprint: summary.version,
        })
      }
    }

    if (expectation && input.checks.has('template') && expectation.template) {
      const t = expectation.template
      const pageKeys = new Set(summary.keyValueKeys.map(normalizeTag))
      const pageSections = new Set([...summary.textFieldTitles, ...summary.headings].map(normalizeTag))
      const keyHits = t.keyValueKeys.filter((k) => pageKeys.has(normalizeTag(k))).length
      const sectionHits = t.sections.filter((s) => pageSections.has(normalizeTag(s))).length
      const keyRatio = t.keyValueKeys.length ? keyHits / t.keyValueKeys.length : 1
      const noInfobox = t.hasInfobox && !summary.hasInfobox
      if (noInfobox || keyRatio < 0.5) {
        add({
          key: `template:${r.id}`,
          category: 'template',
          severity: 'suggestion',
          certainty: noInfobox || keyRatio < 0.25 ? 'likely' : 'possible',
          resourceId: r.id,
          resourceName: r.name,
          related: [],
          title: `“${r.name}” may use an older layout than “${t.name}”`,
          explanation: `${noInfobox ? 'The page has no infobox, while the template has one. ' : ''}It has ${keyHits} of the template’s ${t.keyValueKeys.length} infobox rows and ${sectionHits} of its ${t.sections.length} sections. The difference may be intentional.`,
          evidence: { template: t.name, rowsFound: keyHits, rowsInTemplate: t.keyValueKeys.length, sectionsFound: sectionHits, sectionsInTemplate: t.sections.length, missingRows: t.keyValueKeys.filter((k) => !pageKeys.has(normalizeTag(k))) },
          remedy: 'Review it in Template migration, which shows a before-and-after comparison before anything changes.',
          needsReview: true,
          fingerprint: summary.version,
        })
      }
    }

    if (expectation && input.checks.has('missing_fields') && expectation.requiredFields.length) {
      const haystack = `${summary.keyValueKeys.join('\n')}\n${summary.text}`
      const missing = expectation.requiredFields.filter((field) => ![field.label, ...field.aliases].some((label) => hasLabel(haystack, label)))
      if (missing.length) {
        add({
          key: `missing_fields:${r.id}`,
          category: 'missing_fields',
          severity: 'problem',
          certainty: 'likely',
          resourceId: r.id,
          resourceName: r.name,
          related: [],
          title: `“${r.name}” seems to lack ${missing.map((f) => f.label).join(', ')}`,
          explanation: `Your recipes require these for ${expectation.pageTypeLabel} pages, and no matching label was found on the page. The page may write them differently.`,
          evidence: { missing: missing.map((f) => f.label), lookedFor: missing.flatMap((f) => [f.label, ...f.aliases]) },
          remedy: 'Add the missing values in LegendKeeper, or add the page’s wording as a label in the recipe.',
          needsReview: true,
          fingerprint: summary.version,
        })
      }
    }

    if (expectation?.attributionRequired && input.checks.has('attribution')) {
      const hasSources = [...summary.headings, ...summary.textFieldTitles].some((h) => /^(sources?|references?|citations?)$/i.test(h.trim()))
      if (!hasSources) {
        add({
          key: `attribution:${r.id}`,
          category: 'attribution',
          severity: 'problem',
          certainty: 'likely',
          resourceId: r.id,
          resourceName: r.name,
          related: [],
          title: `“${r.name}” has no Sources section`,
          explanation: `A recipe for ${expectation.pageTypeLabel} pages requires source attribution, and the page has no heading or text block called “Sources”.`,
          evidence: { headings: summary.headings.slice(0, 20) },
          remedy: 'Add a Sources section naming where the information comes from.',
          needsReview: true,
          fingerprint: summary.version,
        })
      }
    }
  }
  return out.map((f) => ({ ...f, fingerprint: f.fingerprint ?? (f.resourceId && byId.get(f.resourceId) ? fp(byId.get(f.resourceId)!) : null) }))
}

function hasLabel(text: string, label: string): boolean {
  const escaped = label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  return new RegExp(`(^|[^\\p{L}])${escaped}([^\\p{L}]|$)`, 'iu').test(text)
}

function tagRelation(a: string, b: string): { label: string; explanation: string; certainty: Certainty } | null {
  if (a === b) return null
  if (normalizeTag(a) === normalizeTag(b)) return { label: 'differ only in capitals or spacing', explanation: 'They are spelled the same apart from capitals or spaces.', certainty: 'definite' }
  const la = a.toLowerCase()
  const lb = b.toLowerCase()
  const singular = (s: string) => s.replace(/(ies)$/, 'y').replace(/(es|s)$/, '')
  if (singular(la) === singular(lb) && la.length > 2) return { label: 'look like singular and plural', explanation: 'One looks like the plural of the other.', certainty: 'likely' }
  const shortest = Math.min(la.length, lb.length)
  if (shortest >= 5 && levenshtein(la, lb) <= (Math.max(la.length, lb.length) >= 8 ? 2 : 1)) return { label: 'look like a spelling variant', explanation: 'They differ by one or two letters, which may be a typo.', certainty: 'possible' }
  return null
}
