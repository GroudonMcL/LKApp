import { levenshtein, normalizeName } from '../text'

/**
 * Web Clipper: a local index of the project's pages, for the destination and source pickers
 * (pure, no API calls).
 *
 * LegendKeeper's own search (`search.search`) does not rank an exact name first: in the test
 * project "Dragon" came third, after "Red Dragon Wyrmling" and "Adult Red Dragon". The clipper
 * therefore ranks names itself, in the order the brief asks for, and adds LegendKeeper's
 * content matches last.
 */

export interface IndexDocument {
  id: string
  name: string
  type: string
}

export interface IndexEntry {
  id: string
  name: string
  aliases: string[]
  tags: string[]
  parentId: string | null
  documents: IndexDocument[]
}

export interface IndexedPage extends IndexEntry {
  /** Ancestor names from the top level down, not including the page itself. */
  path: string[]
}

export type MatchKind = 'exact_name' | 'name_prefix' | 'name_word' | 'name_contains' | 'alias' | 'tag' | 'fuzzy_name' | 'content'

export interface SearchResult {
  page: IndexedPage
  match: MatchKind
  /** The alias or tag that matched, or the content passage from LegendKeeper's search. */
  detail?: string
}

/** Lower is better. */
const MATCH_RANK: Record<MatchKind, number> = {
  exact_name: 0,
  name_prefix: 1,
  name_word: 2,
  name_contains: 3,
  alias: 4,
  fuzzy_name: 5,
  tag: 6,
  content: 7,
}

/** Document types the clipper can write blocks into (`blank` becomes a page on first write). */
export const WRITABLE_DOCUMENT_TYPES = new Set(['page', 'blank'])

export class ProjectIndex {
  private readonly byId = new Map<string, IndexedPage>()

  constructor(entries: IndexEntry[]) {
    const raw = new Map(entries.map((entry) => [entry.id, entry]))
    for (const entry of entries) this.byId.set(entry.id, { ...entry, path: ancestorNames(entry, raw) })
  }

  get size(): number {
    return this.byId.size
  }

  get(id: string): IndexedPage | undefined {
    return this.byId.get(id)
  }

  pages(): IndexedPage[] {
    return [...this.byId.values()]
  }

  /** "Bestiary / Dragon / Red Dragon Wyrmling" */
  displayPath(id: string): string {
    const page = this.byId.get(id)
    return page ? [...page.path, page.name].join(' / ') : ''
  }

  children(parentId: string): IndexedPage[] {
    return this.pages().filter((page) => page.parentId === parentId)
  }

  isDescendantOf(id: string, ancestorId: string): boolean {
    let current = this.byId.get(id)
    const seen = new Set<string>()
    while (current?.parentId && !seen.has(current.id)) {
      seen.add(current.id)
      if (current.parentId === ancestorId) return true
      current = this.byId.get(current.parentId)
    }
    return false
  }

  /**
   * Ranked name search: exact name, names starting with the query, names with a word starting
   * with it, names containing it, aliases, near spellings, then tags. Content matches come from
   * LegendKeeper's search and are merged in with `mergeContentHits`.
   */
  search(query: string, options: { limit?: number; filter?: (page: IndexedPage) => boolean } = {}): SearchResult[] {
    const q = normalizeName(query)
    if (!q) return []
    const results: SearchResult[] = []
    for (const page of this.byId.values()) {
      if (options.filter && !options.filter(page)) continue
      const match = matchPage(page, q)
      if (match) results.push({ page, ...match })
    }
    return sortResults(results).slice(0, options.limit ?? 20)
  }

  /** Adds LegendKeeper's content hits for pages not already found by name. */
  mergeContentHits(results: SearchResult[], hits: { resourceId: string; highlight?: string | null }[], limit = 20): SearchResult[] {
    const seen = new Set(results.map((result) => result.page.id))
    const merged = [...results]
    for (const hit of hits) {
      const page = this.byId.get(hit.resourceId)
      if (!page || seen.has(page.id)) continue
      seen.add(page.id)
      merged.push({ page, match: 'content', ...(hit.highlight ? { detail: hit.highlight } : {}) })
    }
    return merged.slice(0, limit)
  }

  /**
   * Source pages: descendants of the Sources page, or pages carrying the source tag.
   */
  sources(options: { sourcesRootId?: string | null; sourceTag?: string | null }): IndexedPage[] {
    return this.pages().filter(
      (page) =>
        (options.sourcesRootId ? this.isDescendantOf(page.id, options.sourcesRootId) : false) ||
        (options.sourceTag ? page.tags.includes(options.sourceTag) : false),
    )
  }

  /** Source pages whose name or alias is the given name (ignoring case, accents and punctuation). */
  findSourceByName(name: string, options: { sourcesRootId?: string | null; sourceTag?: string | null }): IndexedPage[] {
    const target = normalizeName(name)
    return this.sources(options).filter((page) => normalizeName(page.name) === target || page.aliases.some((alias) => normalizeName(alias) === target))
  }

  /** Adds or replaces one page (after the clipper creates one), without a full reload. */
  upsert(entry: IndexEntry): IndexedPage {
    const raw = new Map([...this.byId.values()].map((page) => [page.id, page as IndexEntry]))
    raw.set(entry.id, entry)
    const page = { ...entry, path: ancestorNames(entry, raw) }
    this.byId.set(entry.id, page)
    return page
  }
}

/** The page documents of a resource the clipper may append to, in tab order. */
export function writableDocuments(page: Pick<IndexEntry, 'documents'>): IndexDocument[] {
  return page.documents.filter((doc) => WRITABLE_DOCUMENT_TYPES.has(doc.type))
}

function matchPage(page: IndexedPage, q: string): { match: MatchKind; detail?: string } | null {
  const name = normalizeName(page.name)
  if (name === q) return { match: 'exact_name' }
  if (name.startsWith(q)) return { match: 'name_prefix' }
  const words = name.split(' ')
  if (words.some((word) => word.startsWith(q))) return { match: 'name_word' }
  if (name.includes(q)) return { match: 'name_contains' }
  for (const alias of page.aliases) {
    const a = normalizeName(alias)
    if (a === q || a.startsWith(q) || a.split(' ').some((word) => word.startsWith(q))) return { match: 'alias', detail: alias }
  }
  if (q.length >= 4 && isNearSpelling(words, q)) return { match: 'fuzzy_name' }
  const tag = page.tags.find((t) => {
    const n = normalizeName(t)
    return n === q || n.split(' ').some((word) => word.startsWith(q))
  })
  if (tag) return { match: 'tag', detail: tag }
  return null
}

/** One typo per four letters, against the whole name or any run of words of the query's length. */
function isNearSpelling(words: string[], q: string): boolean {
  const allowed = Math.floor(q.length / 4)
  const span = q.split(' ').length
  for (let i = 0; i + span <= words.length; i++) {
    if (levenshtein(words.slice(i, i + span).join(' '), q) <= allowed) return true
  }
  return false
}

function sortResults(results: SearchResult[]): SearchResult[] {
  return results.sort(
    (a, b) =>
      MATCH_RANK[a.match] - MATCH_RANK[b.match] ||
      a.page.name.length - b.page.name.length ||
      a.page.name.localeCompare(b.page.name),
  )
}

function ancestorNames(entry: IndexEntry, all: Map<string, IndexEntry>): string[] {
  const names: string[] = []
  const seen = new Set<string>([entry.id])
  let parentId = entry.parentId
  while (parentId && !seen.has(parentId)) {
    seen.add(parentId)
    const parent = all.get(parentId)
    if (!parent) break
    names.unshift(parent.name)
    parentId = parent.parentId
  }
  return names
}
