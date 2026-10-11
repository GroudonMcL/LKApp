import 'server-only'
import { z } from 'zod'
import { allPageTypes } from '@/core/resolve'
import { inferPageType } from '@/core/tag-assistant'
import type { AppContext } from '../context'
import { ServiceError } from './errors'

/** Which existing pages a tagging or migration job covers. Chosen from the local page index. */
export const PageScope = z.object({
  mode: z.enum(['untagged', 'all', 'page_types', 'folder', 'criteria', 'resources']).default('untagged'),
  pageTypes: z.array(z.string().max(64)).max(20).default([]),
  folderId: z.string().max(100).nullable().default(null),
  tag: z.string().max(100).nullable().default(null),
  nameContains: z.string().max(200).nullable().default(null),
  resourceIds: z.array(z.string().max(100)).max(5000).default([]),
  maxPages: z.number().int().min(1).max(2000).default(200),
})
export type PageScope = z.infer<typeof PageScope>

export type IndexedPage = ReturnType<AppContext['repos']['index']['forAudit']>[number]

export function selectPages(pages: IndexedPage[], scope: PageScope): IndexedPage[] {
  const types = allPageTypes()
  let selected: IndexedPage[]
  switch (scope.mode) {
    case 'untagged':
      selected = pages.filter((p) => p.tags.length === 0)
      break
    case 'page_types':
      selected = pages.filter((p) => {
        const type = inferPageType({ id: p.id, name: p.name, parentId: p.parentId, tags: p.tags, ancestors: [], siblingTags: [], linkedNames: [], text: '' }, types)
        return type !== null && scope.pageTypes.includes(type.type.id)
      })
      break
    case 'folder': {
      const ids = new Set<string>(scope.folderId ? [scope.folderId] : [])
      let grew = true
      while (grew) {
        grew = false
        for (const p of pages) if (p.parentId && ids.has(p.parentId) && !ids.has(p.id)) (ids.add(p.id), (grew = true))
      }
      selected = pages.filter((p) => ids.has(p.id) && p.id !== scope.folderId)
      break
    }
    case 'criteria':
      selected = pages.filter((p) => (!scope.tag || p.tags.includes(scope.tag)) && (!scope.nameContains || p.name.toLowerCase().includes(scope.nameContains.toLowerCase())))
      break
    case 'resources': {
      const byId = new Map(pages.map((p) => [p.id, p]))
      selected = scope.resourceIds.map((id) => byId.get(id)).filter((p): p is IndexedPage => Boolean(p))
      break
    }
    default:
      selected = pages
  }
  return selected.slice(0, scope.maxPages)
}

/**
 * Turns what you typed (page names, ids or LegendKeeper links, one per line) into page ids.
 * A name must match exactly one page; otherwise the error lists the candidates.
 */
export function resolvePageRefs(pages: IndexedPage[], refs: string[]): string[] {
  const ids: string[] = []
  const problems: string[] = []
  for (const raw of refs.map((r) => r.trim()).filter(Boolean)) {
    const fromLink = raw.match(/resources\/([a-z0-9]{6,32})/i)?.[1]
    const byId = pages.find((p) => p.id === (fromLink ?? raw))
    if (byId) {
      ids.push(byId.id)
      continue
    }
    const named = pages.filter((p) => p.name.trim().toLowerCase() === raw.toLowerCase())
    if (named.length === 1) ids.push(named[0]!.id)
    else if (named.length > 1) problems.push(`“${raw}” matches ${named.length} pages (${named.map((p) => `${p.path ? `${p.path} / ` : ''}${p.name} — ${p.id}`).join('; ')}). Use the page id instead.`)
    else problems.push(`No page called or with the id “${raw}” in the last project scan.`)
  }
  if (problems.length) throw new ServiceError(400, 'Some pages could not be found.', problems)
  return [...new Set(ids)]
}
