import 'server-only'
import { z } from 'zod'
import { ENTITY_KINDS } from '@/core/assistant/plan'
import { buildRelations } from '@/core/knowledge/analysis'
import { newAppId } from '@/core/ids'
import { normalizeName, normalizeTag } from '@/core/text'
import type { AppContext } from '../context'
import { chronologyData } from './chronology'
import { requireProjectId } from './connection'
import { ServiceError } from './errors'

/**
 * Combined search over the local index and the page content audits read: name and aliases,
 * kind, tags, folder, text, labelled fields, dates (from the chronology), links in either
 * direction, and open findings. Every result is a page id from the last scan.
 *
 * Text search is plain substring matching on stored page text. Semantic (embedding) search
 * was considered and not added: names, tags, fields and links already locate pages well in a
 * wiki of this size, and embeddings would need either an external service or a large local
 * model. LegendKeeper's own full-text search remains available on the Page browser.
 */

const csv = z
  .union([z.string(), z.array(z.string())])
  .optional()
  .transform((v) => (v === undefined ? [] : (Array.isArray(v) ? v : v.split(',')).map((s) => s.trim()).filter(Boolean)))

export const SearchQuery = z.object({
  q: z.string().max(200).optional(),
  kind: z.enum(ENTITY_KINDS).optional(),
  tags: csv,
  untagged: z.coerce.boolean().optional(),
  folder: z.string().max(100).optional(),
  text: z.string().max(200).optional(),
  field: z.string().max(100).optional(),
  fieldValue: z.string().max(200).optional(),
  dateFrom: z.coerce.number().int().optional(),
  dateTo: z.coerce.number().int().optional(),
  linksTo: z.string().max(100).optional(),
  linkedFrom: z.string().max(100).optional(),
  findings: z.enum(['any', 'audit', 'knowledge', 'none']).optional(),
  read: z.enum(['read', 'unread']).optional(),
  limit: z.coerce.number().int().min(1).max(2000).default(300),
})
export type SearchQuery = z.infer<typeof SearchQuery>

export function advancedSearch(ctx: AppContext, projectId: string, input: unknown) {
  const query = SearchQuery.parse(input ?? {})
  const { kb, entries } = chronologyData(ctx, projectId)
  const q = query.q ? normalizeName(query.q) : null
  const text = query.text?.toLowerCase()
  const tags = query.tags.map(normalizeTag)
  const field = query.field ? normalizeName(query.field) : null
  const fieldValue = query.fieldValue?.toLowerCase()
  let folder: Set<string> | null = null
  if (query.folder) {
    folder = new Set()
    let grew = true
    const roots = new Set([query.folder])
    while (grew) {
      grew = false
      for (const p of kb.pages) if (p.parentId && (roots.has(p.parentId) || folder.has(p.parentId)) && !folder.has(p.id)) (folder.add(p.id), (grew = true))
    }
  }
  const relations = query.linksTo || query.linkedFrom ? buildRelations(kb.pages).filter((r) => r.support !== 'api') : []
  const auditOpen = new Set(ctx.repos.findings.list(projectId, { statuses: ['open', 'queued'], limit: 100_000 }).items.map((f) => f.resourceId).filter(Boolean) as string[])
  const knowledgeOpen = new Set(ctx.repos.knowledge.list(projectId, { statuses: ['open'], limit: 100_000 }).items.flatMap((i) => i.resourceIds))
  const datesByPage = new Map<string, { lo: number; hi: number; display: string }[]>()
  for (const e of entries) {
    if (!e.resourceId || !e.date.sort) continue
    datesByPage.set(e.resourceId, [...(datesByPage.get(e.resourceId) ?? []), { lo: e.date.sort.lo, hi: e.date.sort.hi, display: `${e.title}: ${e.date.original}` }])
  }

  const rows: { id: string; name: string; kind: string; tags: string[]; folder: string; read: boolean; why: string[] }[] = []
  for (const p of kb.pages) {
    const why: string[] = []
    if (q) {
      const hit = [p.name, ...p.aliases].find((n) => normalizeName(n).includes(q))
      if (!hit) continue
      if (hit !== p.name) why.push(`alias “${hit}”`)
    }
    if (query.kind && p.kind !== query.kind) continue
    if (tags.length && !tags.every((t) => p.tags.some((pt) => normalizeTag(pt) === t))) continue
    if (query.untagged && p.tags.length) continue
    if (folder && !folder.has(p.id)) continue
    if (query.read === 'read' && !p.content) continue
    if (query.read === 'unread' && p.content) continue
    if (text) {
      const at = p.content?.text.toLowerCase().indexOf(text) ?? -1
      if (at < 0) continue
      why.push(`text: …${p.content!.text.slice(Math.max(0, at - 40), at + text.length + 40).replace(/\s+/g, ' ')}…`)
    }
    if (field || fieldValue) {
      const f = p.content?.fields.find((x) => (!field || normalizeName(x.key) === field) && (!fieldValue || x.value.toLowerCase().includes(fieldValue)))
      if (!f) continue
      why.push(`${f.key}: ${f.value}`)
    }
    if (query.dateFrom !== undefined || query.dateTo !== undefined) {
      const lo = query.dateFrom ?? -Infinity
      const hi = (query.dateTo ?? Infinity) + 0.999
      const hit = (datesByPage.get(p.id) ?? []).find((d) => d.hi >= lo && d.lo <= hi)
      if (!hit) continue
      why.push(hit.display)
    }
    if (query.linksTo && !relations.some((r) => r.from === p.id && r.to === query.linksTo)) continue
    if (query.linkedFrom && !relations.some((r) => r.from === query.linkedFrom && r.to === p.id)) continue
    if (query.findings === 'audit' && !auditOpen.has(p.id)) continue
    if (query.findings === 'knowledge' && !knowledgeOpen.has(p.id)) continue
    if (query.findings === 'any' && !auditOpen.has(p.id) && !knowledgeOpen.has(p.id)) continue
    if (query.findings === 'none' && (auditOpen.has(p.id) || knowledgeOpen.has(p.id))) continue
    if (auditOpen.has(p.id)) why.push('open Wiki Health finding')
    if (knowledgeOpen.has(p.id)) why.push('open analysis finding')
    rows.push({ id: p.id, name: p.name, kind: p.kind, tags: p.tags, folder: p.ancestors.join(' / '), read: Boolean(p.content), why })
  }
  rows.sort((a, b) => {
    if (query.dateFrom !== undefined || query.dateTo !== undefined) {
      const ka = Math.min(...(datesByPage.get(a.id) ?? []).map((d) => d.lo))
      const kb2 = Math.min(...(datesByPage.get(b.id) ?? []).map((d) => d.lo))
      if (ka !== kb2) return ka - kb2
    }
    return a.name.localeCompare(b.name)
  })
  return {
    total: rows.length,
    rows: rows.slice(0, query.limit),
    coverage: kb.stats,
    note: text || field || fieldValue || query.linksTo || query.linkedFrom ? `Text, fields and links come from the ${kb.stats.read} page(s) audits have read; ${kb.stats.indexed - kb.stats.read} have not been read.` : null,
  }
}

const SaveInput = z.object({ name: z.string().trim().min(1).max(100), query: z.record(z.string(), z.unknown()) })

export function saveSearch(ctx: AppContext, input: unknown) {
  const { name, query } = SaveInput.parse(input ?? {})
  SearchQuery.parse(query)
  const id = newAppId('srch')
  ctx.repos.savedSearches.insert({ id, name, query })
  return ctx.repos.savedSearches.list()
}

export function deleteSearch(ctx: AppContext, id: string) {
  if (!ctx.repos.savedSearches.list().some((s) => s.id === id)) throw new ServiceError(404, 'Saved search not found.')
  ctx.repos.savedSearches.remove(id)
  return ctx.repos.savedSearches.list()
}

export async function searchProject(ctx: AppContext, input: unknown) {
  return advancedSearch(ctx, await requireProjectId(ctx), input)
}
