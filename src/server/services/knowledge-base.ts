import 'server-only'
import { pageTypeForTags } from '@/core/audit-checks'
import type { KbPage } from '@/core/chronology/entries'
import { entityKindFor } from '@/core/knowledge/entities'
import { LK_TEMPLATES_PARENT_ID } from '@/core/lk-layout'
import { allPageTypes, resolvePageType } from '@/core/resolve'
import type { AppContext } from '../context'

/**
 * What the app knows of the project, for chronology and knowledge analysis: the local index
 * (names, aliases, tags, the page tree) joined with the page content that Wiki Health audits
 * read (text, labelled fields, links). Nothing here calls LegendKeeper.
 *
 * Content is as fresh as the last audit that read each page; `stats` says how much of the
 * project that covers, so screens can say what their findings rest on.
 */
export function knowledgeBase(ctx: AppContext, projectId: string) {
  const indexed = ctx.repos.index.forAudit(projectId).filter((p) => p.id !== LK_TEMPLATES_PARENT_ID && p.parentId !== LK_TEMPLATES_PARENT_ID)
  const byId = new Map(indexed.map((p) => [p.id, p]))
  const content = new Map(ctx.repos.contentCache.all(projectId).map((c) => [c.resourceId, c]))
  const customTypes = ctx.repos.recipes
    .list()
    .map((r) => resolvePageType(r.definition))
    .filter((t): t is NonNullable<typeof t> => Boolean(t))
  const types = allPageTypes(customTypes.filter((t) => !t.builtIn))
  let withFields = 0
  let lastRead: string | null = null
  const pages: KbPage[] = indexed.map((p) => {
    const ancestors: string[] = []
    let parent = p.parentId ? byId.get(p.parentId) : undefined
    let guard = 0
    while (parent && guard++ < 50) {
      ancestors.unshift(parent.name)
      parent = parent.parentId ? byId.get(parent.parentId) : undefined
    }
    const snapshot = content.get(p.id)
    const structure = snapshot?.structure ?? null
    if (structure?.fields) withFields++
    if (snapshot && (!lastRead || snapshot.fetchedAt > lastRead)) lastRead = snapshot.fetchedAt
    const pageType = pageTypeForTags(p.tags, types)
    return {
      id: p.id,
      name: p.name,
      aliases: p.aliases,
      tags: p.tags,
      parentId: p.parentId,
      ancestors,
      kind: entityKindFor({ tags: p.tags, pageTypeId: pageType?.id ?? null, ancestors }),
      content: structure
        ? { version: snapshot!.version, text: structure.text, fields: structure.fields ?? [], mentionIds: structure.mentionIds, links: structure.links ?? [] }
        : null,
    }
  })
  const read = pages.filter((p) => p.content).length
  return {
    pages,
    byId: new Map(pages.map((p) => [p.id, p])),
    stats: {
      indexed: pages.length,
      read,
      /** Pages read by an audit since Phase 3, which records labelled fields and link texts. */
      readWithFields: withFields,
      lastRead,
    },
  }
}

export type KnowledgeBase = ReturnType<typeof knowledgeBase>
