import type { PageReference, ReferenceCandidate } from './page-model'
import type { LinkPolicy } from './recipe'
import { normalizeName } from './text'

/**
 * Reference resolution: matching a mention in a draft ("Mordenkainen") to an existing
 * LegendKeeper page.
 *
 * Rules:
 * - Only resource IDs that come from LegendKeeper (the local resource index or live search)
 *   are ever proposed. Nothing is invented.
 * - A link is auto-selected only when exactly one page has that exact name or alias.
 * - Several exact matches → `ambiguous`; the user must choose (or leave it unresolved).
 * - Near matches (different case, punctuation, partial names) are offered as suggestions,
 *   but the reference stays `unresolved` until the user picks one.
 * - Every selected ID is checked again against LegendKeeper right before writing.
 */

export interface IndexedResource {
  id: string
  name: string
  aliases: string[]
  parentId: string | null
  path?: string | null
  tags?: string[]
}

const MAX_CANDIDATES = 10

export class ReferenceIndex {
  private readonly exactName = new Map<string, IndexedResource[]>()
  private readonly exactAlias = new Map<string, IndexedResource[]>()
  private readonly lowerName = new Map<string, IndexedResource[]>()
  private readonly normalized = new Map<string, IndexedResource[]>()
  private readonly all: IndexedResource[]

  constructor(resources: IndexedResource[]) {
    this.all = resources
    for (const resource of resources) {
      push(this.exactName, resource.name, resource)
      push(this.lowerName, resource.name.toLowerCase(), resource)
      push(this.normalized, normalizeName(resource.name), resource)
      for (const alias of resource.aliases) {
        push(this.exactAlias, alias, resource)
        push(this.lowerName, alias.toLowerCase(), resource)
        push(this.normalized, normalizeName(alias), resource)
      }
    }
  }

  get size(): number {
    return this.all.length
  }

  /** Exact matches first; if there are none, near matches as suggestions. */
  find(mention: string): { exact: ReferenceCandidate[]; near: ReferenceCandidate[] } {
    const text = mention.trim()
    const exact = dedupe([
      ...(this.exactName.get(text) ?? []).map((r) => candidate(r, 'exact_name')),
      ...(this.exactAlias.get(text) ?? []).map((r) => candidate(r, 'exact_alias')),
    ])
    if (exact.length > 0) return { exact: exact.slice(0, MAX_CANDIDATES), near: [] }

    const near = dedupe([
      ...(this.lowerName.get(text.toLowerCase()) ?? []).map((r) => candidate(r, 'case_insensitive')),
      ...(this.normalized.get(normalizeName(text)) ?? []).map((r) => candidate(r, 'normalized')),
      ...this.partialMatches(text),
    ])
    return { exact: [], near: near.slice(0, MAX_CANDIDATES) }
  }

  private partialMatches(mention: string): ReferenceCandidate[] {
    const key = normalizeName(mention)
    if (key.length < 4) return []
    const tokens = key.split(' ')
    const out: ReferenceCandidate[] = []
    for (const resource of this.all) {
      const names = [resource.name, ...resource.aliases].map(normalizeName)
      if (names.some((name) => name !== key && containsTokens(name.split(' '), tokens))) {
        out.push(candidate(resource, 'partial'))
        if (out.length >= MAX_CANDIDATES) break
      }
    }
    return out
  }

  /**
   * Finds exact, case-sensitive occurrences of known page names or aliases in a text.
   * Names shorter than four characters, and names that do not start with a capital
   * letter or digit, are ignored to avoid matching ordinary words.
   */
  scanText(text: string, exclude: string[] = [], options: { limit?: number; excludeTags?: string[] } = {}): string[] {
    const limit = options.limit ?? 50
    const excluded = new Set(exclude.map((name) => name.trim()))
    const excludedTags = new Set(options.excludeTags ?? [])
    // A name is skipped when every page with that name or alias carries an excluded tag.
    const onlyExcluded = (name: string) => {
      if (excludedTags.size === 0) return false
      const pages = [...(this.exactName.get(name) ?? []), ...(this.exactAlias.get(name) ?? [])]
      return pages.length > 0 && pages.every((page) => (page.tags ?? []).some((tag) => excludedTags.has(tag)))
    }
    const known = new Map<string, number>()
    for (const name of [...this.exactName.keys(), ...this.exactAlias.keys()]) {
      if (name.length < 4 || !/^[\p{Lu}\p{N}]/u.test(name) || excluded.has(name) || onlyExcluded(name)) continue
      const words = name.split(/\s+/).length
      known.set(name, Math.max(known.get(name) ?? 0, words))
    }
    if (known.size === 0) return []
    const maxWords = Math.min(8, Math.max(...known.values()))
    // Headings and the labels of "Label: value" lines are structure, not mentions ("Type:",
    // "### History"), so they are not scanned; the values after the labels are.
    const prose = text
      .split('\n')
      .filter((line) => !/^\s*#{1,6}\s/.test(line))
      .map((line) => line.replace(/^\s*(?:[-*•]\s+)?(?:\*\*)?[\p{L}][\p{L}\p{N} '’/()\-]{0,40}?(?:\*\*)?:(?:\*\*)?\s/u, ''))
      .join('\n')
    const tokens = prose.match(/[\p{L}\p{N}][\p{L}\p{N}'’\-]*/gu) ?? []
    const words = tokens.map((token) => token.replace(/['’]s$/u, ''))
    const found: string[] = []
    const seen = new Set<string>()
    for (let i = 0; i < words.length; i++) {
      // Longest match first, so "Free City of Greyhawk" wins over "Greyhawk".
      for (let n = Math.min(maxWords, words.length - i); n >= 1; n--) {
        const phrase = words.slice(i, i + n).join(' ')
        if (known.has(phrase)) {
          if (!seen.has(phrase)) {
            seen.add(phrase)
            found.push(phrase)
            if (found.length >= limit) return found
          }
          i += n - 1
          break
        }
      }
    }
    return found
  }
}

function push(map: Map<string, IndexedResource[]>, key: string, resource: IndexedResource) {
  const list = map.get(key)
  if (list) {
    if (!list.some((existing) => existing.id === resource.id)) list.push(resource)
  } else {
    map.set(key, [resource])
  }
}

function candidate(resource: IndexedResource, matchType: ReferenceCandidate['matchType']): ReferenceCandidate {
  return { resourceId: resource.id, name: resource.name, matchType, path: resource.path ?? null }
}

function dedupe(candidates: ReferenceCandidate[]): ReferenceCandidate[] {
  const seen = new Set<string>()
  return candidates.filter((c) => (seen.has(c.resourceId) ? false : (seen.add(c.resourceId), true)))
}

function containsTokens(haystack: string[], needle: string[]): boolean {
  if (needle.length > haystack.length) return false
  for (let i = 0; i <= haystack.length - needle.length; i++) {
    if (needle.every((token, j) => haystack[i + j] === token)) return true
  }
  return false
}

export interface MentionInput {
  mention: string
  relation: string | null
  origin: PageReference['origin']
}

/** Resolves mentions against the index according to the recipe's link policy. */
export function resolveReferences(
  mentions: MentionInput[],
  index: ReferenceIndex | null,
  policy: LinkPolicy,
  pageName: string,
): PageReference[] {
  if (policy.mode === 'off') return []
  const seen = new Set<string>()
  const out: PageReference[] = []
  for (const input of mentions) {
    const mention = input.mention.trim()
    if (mention === '' || mention === pageName.trim() || seen.has(mention)) continue
    seen.add(mention)
    out.push(resolveOne(`ref_${out.length + 1}`, { ...input, mention }, index, policy))
  }
  return out
}

export function resolveOne(id: string, input: MentionInput, index: ReferenceIndex | null, policy: LinkPolicy): PageReference {
  const base: PageReference = {
    id,
    mention: input.mention,
    relation: input.relation,
    candidates: [],
    status: 'unresolved',
    resourceId: null,
    resolvedBy: null,
    verifiedAt: null,
    origin: input.origin,
  }
  if (!index) return base
  const { exact, near } = index.find(input.mention)
  if (exact.length === 1 && policy.autoSelectExactMatch) {
    return { ...base, candidates: exact, status: 'resolved', resourceId: exact[0]!.resourceId, resolvedBy: 'auto_exact' }
  }
  if (exact.length >= 1) return { ...base, candidates: exact, status: exact.length > 1 ? 'ambiguous' : 'unresolved' }
  return { ...base, candidates: near }
}

/** Applies a user's choice: a candidate id, or `null` to leave the reference unresolved. */
export function chooseReference(reference: PageReference, resourceId: string | null): PageReference {
  if (resourceId === null) return { ...reference, status: 'left_unresolved', resourceId: null, resolvedBy: 'user', verifiedAt: null }
  if (!reference.candidates.some((c) => c.resourceId === resourceId)) {
    throw new Error('Only a listed candidate can be chosen. Search for the page first so its ID comes from LegendKeeper.')
  }
  return { ...reference, status: 'resolved', resourceId, resolvedBy: 'user', verifiedAt: null }
}
