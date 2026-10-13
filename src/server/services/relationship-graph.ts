import 'server-only'
import { z } from 'zod'
import { RELATION_LABELS, buildRelations, textRelations, type RelationSupport, type RelationType } from '@/core/knowledge/analysis'
import type { AppContext } from '../context'
import { ServiceError } from './errors'
import { knowledgeBase } from './knowledge-base'

/**
 * The relationship map: many pages at once, up to the whole project. The same relationships as
 * the one-page browser (links, labelled fields, the page tree, accepted AI suggestions and, on
 * request, wording), gathered for every page and joined into one graph. Read-only; nothing is
 * sent anywhere.
 */

export const GraphInput = z.object({
  /** Centre the map on this page and show the pages within `depth` steps; without it, the whole project. */
  centre: z.string().max(256).optional(),
  depth: z.coerce.number().int().min(1).max(4).default(2),
  /**
   * Include "filed under" (the page tree). Without a choice: only while fewer than a quarter of
   * the pages have been read (otherwise every page's parent would crowd the map).
   */
  tree: z.boolean().optional(),
  /** Include relationships inferred from wording (slower; only for up to 400 pages read). */
  wording: z.coerce.boolean().default(false),
  /** Pages to show at most; the most connected are kept. */
  maxNodes: z.coerce.number().int().min(10).max(3000).default(800),
  kinds: z.array(z.string().max(40)).max(20).optional(),
})
export type GraphInput = z.input<typeof GraphInput>

export interface GraphEdge {
  source: string
  target: string
  /** Relationship types between the two pages, both directions. */
  types: RelationType[]
  /** The strongest support: field > link > ai > text > api. */
  support: RelationSupport
  count: number
}

const SUPPORT_RANK: Record<RelationSupport, number> = { field: 0, link: 1, ai: 2, text: 3, api: 4 }

export function relationshipGraph(ctx: AppContext, projectId: string, input: GraphInput = {}) {
  const options = GraphInput.parse(input)
  const kb = knowledgeBase(ctx, projectId)
  if (!kb.pages.length) throw new ServiceError(409, 'There are no pages in the local index yet. Scan the project on the Page browser first.')
  if (options.centre && !kb.byId.get(options.centre)) throw new ServiceError(404, 'That page is not in the last project scan.')

  const read = kb.pages.filter((p) => p.content)
  const tree = options.tree ?? read.length < kb.pages.length / 4
  let relations = buildRelations(kb.pages).filter((r) => tree || r.type !== 'part_of')
  let wordingNote: string | null = null
  if (options.wording) {
    if (read.length <= 400 || options.centre) {
      const scope = options.centre ? new Set([options.centre, ...relations.filter((r) => r.from === options.centre || r.to === options.centre).flatMap((r) => [r.from, r.to])]) : new Set(read.map((p) => p.id))
      relations = [...relations, ...textRelations(kb.pages, scope)]
    } else wordingNote = `Relationships from wording are left out for the whole project (${read.length} pages read); centre the map on a page to include them.`
  }
  for (const item of ctx.repos.knowledge.list(projectId, { kinds: ['relationship'], statuses: ['accepted'], limit: 5000 }).items.filter((i) => i.origin === 'ai')) {
    const d = item.data as { from: string; to: string; type: RelationType }
    relations.push({ from: d.from, to: d.to, type: d.type, support: 'ai', evidence: item.evidence[0]! })
  }
  relations = relations.filter((r) => r.from !== r.to && kb.byId.has(r.from) && kb.byId.has(r.to))

  // One edge per pair of pages.
  const pairs = new Map<string, GraphEdge>()
  for (const r of relations) {
    const [a, b] = r.from < r.to ? [r.from, r.to] : [r.to, r.from]
    const key = `${a}\u0000${b}`
    const edge = pairs.get(key)
    if (!edge) pairs.set(key, { source: a, target: b, types: [r.type], support: r.support, count: 1 })
    else {
      edge.count++
      if (!edge.types.includes(r.type)) edge.types.push(r.type)
      if (SUPPORT_RANK[r.support] < SUPPORT_RANK[edge.support]) edge.support = r.support
    }
  }
  let edges = [...pairs.values()]
  const kindOf = (id: string) => kb.byId.get(id)?.kind ?? 'other'
  if (options.kinds?.length) {
    const allowed = new Set(options.kinds)
    edges = edges.filter((e) => (allowed.has(kindOf(e.source)) || e.source === options.centre) && (allowed.has(kindOf(e.target)) || e.target === options.centre))
  }

  // Which pages: the neighbourhood of the centre, or every connected page.
  const adjacency = new Map<string, string[]>()
  for (const e of edges) {
    adjacency.set(e.source, [...(adjacency.get(e.source) ?? []), e.target])
    adjacency.set(e.target, [...(adjacency.get(e.target) ?? []), e.source])
  }
  const distance = new Map<string, number>()
  if (options.centre) {
    distance.set(options.centre, 0)
    let frontier = [options.centre]
    for (let step = 1; step <= options.depth && frontier.length; step++) {
      const next: string[] = []
      for (const id of frontier) for (const other of adjacency.get(id) ?? []) if (!distance.has(other)) (distance.set(other, step), next.push(other))
      frontier = next
    }
  } else for (const id of adjacency.keys()) distance.set(id, 0)

  const degree = (id: string) => adjacency.get(id)?.length ?? 0
  let ids = [...distance.keys()]
  const total = ids.length
  if (ids.length > options.maxNodes) {
    ids = ids.sort((a, b) => (distance.get(a)! - distance.get(b)!) || degree(b) - degree(a)).slice(0, options.maxNodes)
  }
  const shown = new Set(ids)
  edges = edges.filter((e) => shown.has(e.source) && shown.has(e.target))
  const unconnected = options.centre ? 0 : kb.pages.filter((p) => !adjacency.has(p.id)).length

  return {
    nodes: ids.map((id) => {
      const page = kb.byId.get(id)!
      return { id, name: page.name, kind: page.kind, degree: degree(id), distance: distance.get(id)!, read: Boolean(page.content) }
    }),
    edges,
    labels: RELATION_LABELS,
    tree,
    totals: { pages: kb.pages.length, connected: total, shown: ids.length, edges: edges.length, unconnected, read: read.length },
    notes: [
      ...(total > ids.length ? [`${total - ids.length} more connected page(s) are not shown; the ${ids.length} most connected are.`] : []),
      ...(wordingNote ? [wordingNote] : []),
      ...(read.length < kb.pages.length ? [`${kb.pages.length - read.length} page(s) have not been read by an audit, so links from them are not known. Run a Wiki Health audit to include them.`] : []),
    ],
  }
}
