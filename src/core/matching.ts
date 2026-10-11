import type { PageTypeDefinition } from './page-types'
import type { IndexedResource } from './references'
import { levenshtein, normalizeName } from './text'

/**
 * Matching a new record against pages that already exist, to catch duplicates.
 *
 * A shared name alone never proves two pages are the same thing (two villages can share a
 * name; one NPC can have several names), so each candidate collects *signals* and the result
 * is one of:
 * - `exact`: exactly one page has the same name or alias, and a second signal agrees (its
 *   page-type tag, or the same parent page). Treated as a verified duplicate.
 * - `strong`: exactly one page has the same (or a normalised) name or alias, without a second signal.
 * - `ambiguous`: several pages match, or only similar names (spelling variants, plurals) match.
 * - `none`: no page is known with that name.
 *
 * Pure: it works on the local metadata index. Live checks happen at the final preview.
 */

export type MatchCategory = 'exact' | 'strong' | 'ambiguous' | 'none'
export type MatchSignal = 'exact_name' | 'exact_alias' | 'alias_matches_name' | 'case_insensitive' | 'normalized' | 'similar_name' | 'type_tag' | 'same_parent'

export interface MatchCandidate {
  resourceId: string
  name: string
  path: string | null
  tags: string[]
  signals: MatchSignal[]
  score: number
}

export interface MatchResult {
  category: MatchCategory
  candidates: MatchCandidate[]
  explanation: string
  /** False when no project index was available, so matching could not run. */
  indexAvailable: boolean
}

const WEIGHTS: Record<MatchSignal, number> = {
  exact_name: 5,
  exact_alias: 4,
  alias_matches_name: 4,
  case_insensitive: 3,
  normalized: 3,
  similar_name: 1,
  type_tag: 2,
  same_parent: 2,
}
const NAME_SIGNALS: MatchSignal[] = ['exact_name', 'exact_alias', 'alias_matches_name', 'case_insensitive', 'normalized']

export const SIGNAL_LABELS: Record<MatchSignal, string> = {
  exact_name: 'same name',
  exact_alias: 'the name is one of its aliases',
  alias_matches_name: 'one of the record’s aliases is its name',
  case_insensitive: 'same name, different capitals',
  normalized: 'same name apart from accents or punctuation',
  similar_name: 'similar name (spelling or plural)',
  type_tag: 'has this page type’s tag',
  same_parent: 'same parent page',
}

/** A reusable matcher for many records against one project index. */
export class Matcher {
  private readonly byNormalized = new Map<string, IndexedResource[]>()

  constructor(private readonly resources: IndexedResource[]) {
    for (const resource of resources) {
      for (const name of [resource.name, ...resource.aliases]) {
        const key = normalizeName(name)
        if (!key) continue
        const list = this.byNormalized.get(key) ?? []
        if (!list.includes(resource)) list.push(resource)
        this.byNormalized.set(key, list)
      }
    }
  }

  get size() {
    return this.resources.length
  }

  match(record: { name: string; aliases?: string[]; parentId?: string | null }, pageType: PageTypeDefinition | null): MatchResult {
    const name = record.name.trim()
    const aliases = (record.aliases ?? []).map((a) => a.trim()).filter(Boolean)
    const found = new Map<string, MatchCandidate>()
    const add = (resource: IndexedResource, signal: MatchSignal) => {
      const candidate = found.get(resource.id) ?? { resourceId: resource.id, name: resource.name, path: resource.path ?? null, tags: resource.tags ?? [], signals: [], score: 0 }
      if (!candidate.signals.includes(signal)) candidate.signals.push(signal)
      found.set(resource.id, candidate)
    }

    for (const term of [name, ...aliases]) {
      const key = normalizeName(term)
      if (!key) continue
      for (const resource of this.byNormalized.get(key) ?? []) {
        const isAliasTerm = term !== name
        if (resource.name === term) add(resource, isAliasTerm ? 'alias_matches_name' : 'exact_name')
        else if (resource.aliases.includes(term)) add(resource, isAliasTerm ? 'alias_matches_name' : 'exact_alias')
        else if (resource.name.toLowerCase() === term.toLowerCase() || resource.aliases.some((a) => a.toLowerCase() === term.toLowerCase())) add(resource, 'case_insensitive')
        else add(resource, 'normalized')
      }
    }

    // Similar names: spelling variants and plurals ("Goblin" / "Goblins"), only when nothing closer was found.
    const key = normalizeName(name)
    if (found.size === 0 && key.length >= 5) {
      const allowed = key.length > 10 ? 2 : 1
      for (const [other, resources] of this.byNormalized) {
        if (Math.abs(other.length - key.length) > allowed || other[0] !== key[0]) continue
        if (levenshtein(other, key) <= allowed) for (const resource of resources) add(resource, 'similar_name')
      }
    }

    const typeTags = new Set(pageType ? [pageType.suggestedTag, ...pageType.alternativeTags].filter(Boolean).map((t) => t!.toLowerCase()) : [])
    for (const candidate of found.values()) {
      if (candidate.tags.some((t) => typeTags.has(t.toLowerCase()))) candidate.signals.push('type_tag')
      const resource = this.resources.find((r) => r.id === candidate.resourceId)
      if (record.parentId && resource?.parentId === record.parentId) candidate.signals.push('same_parent')
      candidate.score = candidate.signals.reduce((sum, s) => sum + WEIGHTS[s], 0)
    }

    const candidates = [...found.values()].sort((a, b) => b.score - a.score || a.name.localeCompare(b.name)).slice(0, 10)
    const named = candidates.filter((c) => c.signals.some((s) => NAME_SIGNALS.includes(s)))
    const describe = (c: MatchCandidate) => `“${c.name}”${c.path ? ` (${c.path})` : ''}: ${c.signals.map((s) => SIGNAL_LABELS[s]).join(', ')}`

    if (named.length === 1) {
      const only = named[0]!
      const direct = only.signals.some((s) => s === 'exact_name' || s === 'exact_alias' || s === 'alias_matches_name')
      const confirmed = only.signals.includes('type_tag') || only.signals.includes('same_parent')
      if (direct && confirmed) {
        return { category: 'exact', candidates, explanation: `A page with this name already exists — ${describe(only)}.`, indexAvailable: true }
      }
      return { category: 'strong', candidates, explanation: `Probably already exists — ${describe(only)}. Check whether it is the same entity.`, indexAvailable: true }
    }
    if (named.length > 1) {
      return { category: 'ambiguous', candidates, explanation: `${named.length} existing pages match this name. Choose whether one of them is the same entity.`, indexAvailable: true }
    }
    if (candidates.length > 0) {
      return { category: 'ambiguous', candidates, explanation: `Pages with similar names exist — ${candidates.slice(0, 3).map(describe).join('; ')}. They may or may not be the same entity.`, indexAvailable: true }
    }
    return { category: 'none', candidates: [], explanation: 'No existing page with this name is known.', indexAvailable: true }
  }
}

export const NO_INDEX_MATCH: MatchResult = {
  category: 'none',
  candidates: [],
  explanation: 'Duplicates could not be checked because the project has not been scanned yet (Page browser → Scan project). The final preview still searches LegendKeeper by name.',
  indexAvailable: false,
}

/** Records in the same batch that would create pages with the same name. */
export function duplicatesWithinBatch(names: { id: string; name: string }[]): Map<string, string[]> {
  const groups = new Map<string, string[]>()
  for (const { id, name } of names) {
    const key = normalizeName(name)
    if (!key) continue
    groups.set(key, [...(groups.get(key) ?? []), id])
  }
  const out = new Map<string, string[]>()
  for (const ids of groups.values()) if (ids.length > 1) for (const id of ids) out.set(id, ids.filter((other) => other !== id))
  return out
}
