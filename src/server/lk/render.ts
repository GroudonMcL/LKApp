import { h, infobox, keyValue, links, property, type Block, type PropertyBlock } from '@legendkeeper/sdk/blocks'
import { acceptedTags, resolvedReferences, writableFields, type CanonicalPage, type PageSection } from '@/core/page-model'
import type { PageTypeDefinition } from '@/core/page-types'
import type { TemplateDefinition } from '@/core/template'
import { renderFromLayout } from './render-layout'
import { boldEntryName, mentionTargets, paragraphBlocks, sourcesBlocks } from './render-text'
import type { CreatePageInput } from './types'

/**
 * Converts a canonical draft into LegendKeeper page blocks, using the official SDK's block
 * builders and following LegendKeeper's style guide:
 * - Facts a reader looks up at a glance go in an infobox at the top (floats right).
 * - Links to other pages are `mention` runs in the text, and a `links` property in the infobox.
 * - Game mechanics are kept apart from lore, in their own key-value block and sections.
 * - Only confirmed values (`source` or `user`) are written. Suggested, uncertain and missing
 *   values stay in the review screen.
 * - Only references with a LegendKeeper resource ID become links. Nothing else is linked.
 *
 * This function is pure: no network, no database. Tests validate its output against the
 * official OpenAPI block schema.
 */

export interface RenderContext {
  pageType: PageTypeDefinition
  template: TemplateDefinition
}

export const DEFAULT_DOCUMENT_NAME = 'Main'

export function renderPageBlocks(page: CanonicalPage, ctx: RenderContext): Block[] {
  if (ctx.template.lkLayout) return renderFromLayout(page, ctx.pageType, ctx.template.lkLayout, ctx.template.includeSourcesSection, { rules: ctx.template.layoutRules })
  const blocks: Block[] = []
  const targets = mentionTargets(page)

  // 1. Infobox: lore facts and related pages.
  const loreFields = orderFields(writableFields(page, 'lore'), ctx.template.infoboxFields)
  const related = [...new Set(resolvedReferences(page).map((ref) => ref.resourceId!))]
  const infoboxRows: PropertyBlock[] = []
  if (loreFields.length > 0) {
    infoboxRows.push(property(keyValue(loreFields.map((field) => [field.label, field.value!] as [string, string])), { title: 'Facts' }))
  }
  if (related.length > 0) infoboxRows.push(property(links(related), { title: 'Related' }))
  if (infoboxRows.length > 0) blocks.push(infobox(infoboxRows))

  // 2. Body sections in template order, with the statistics block before the first mechanics section.
  const mechanicsFields = writableFields(page, 'mechanics')
  const ordered = orderSections(page.sections, ctx.template.sections)
  let statisticsPlaced = mechanicsFields.length === 0
  const placeStatistics = () => {
    if (statisticsPlaced) return
    blocks.push(h(2, ctx.template.mechanicsHeading))
    blocks.push(keyValue(mechanicsFields.map((field) => [field.label, field.value!] as [string, string]), { title: ctx.template.mechanicsHeading, isTitleHidden: true }))
    statisticsPlaced = true
  }

  for (const section of ordered) {
    if (section.paragraphs.length === 0) continue
    if (section.kind === 'mechanics') placeStatistics()
    if (section.kind === 'unmapped') placeStatistics()
    blocks.push(h(2, section.heading))
    const linked = new Set<string>()
    for (const paragraph of section.paragraphs) {
      blocks.push(...paragraphBlocks(section.kind === 'mechanics' ? boldEntryName(paragraph) : paragraph, section.kind === 'unmapped' ? new Map() : targets, linked))
    }
  }
  placeStatistics()

  // 3. Sources.
  if (ctx.template.includeSourcesSection) {
    blocks.push(...sourcesBlocks(page))
  }

  return blocks
}

/** The single create request for a draft: resource fields plus one page document. */
export function buildCreatePayload(page: CanonicalPage, ctx: RenderContext, plannedResourceId: string, idempotencyKey: string): CreatePageInput {
  return {
    resourceId: plannedResourceId,
    name: page.name.trim(),
    parentId: page.parentId,
    tags: acceptedTags(page),
    aliases: page.aliases,
    documentName: DEFAULT_DOCUMENT_NAME,
    blocks: renderPageBlocks(page, ctx),
    idempotencyKey,
  }
}

/** Approximate request size. LegendKeeper's host refuses bodies over 1 MB. */
export function payloadBytes(payload: CreatePageInput): number {
  return new TextEncoder().encode(JSON.stringify(payload)).byteLength
}

export const MAX_PAYLOAD_BYTES = 900_000

// ── helpers ───────────────────────────────────────────────────────────────────

function orderFields<T extends { key: string }>(fields: T[], order: string[]): T[] {
  if (order.length === 0) return fields
  const rank = (key: string) => {
    const i = order.indexOf(key)
    return i === -1 ? order.length : i
  }
  return [...fields].filter((field) => order.includes(field.key)).sort((a, b) => rank(a.key) - rank(b.key))
}

function orderSections(sections: PageSection[], templateOrder: string[]): PageSection[] {
  const position = (section: PageSection) => {
    if (section.kind === 'unmapped') return Number.MAX_SAFE_INTEGER
    const i = templateOrder.findIndex((heading) => heading.toLowerCase() === section.heading.toLowerCase())
    return i === -1 ? templateOrder.length : i
  }
  return sections
    .map((section, index) => ({ section, index }))
    .sort((a, b) => position(a.section) - position(b.section) || a.index - b.index)
    .map((entry) => entry.section)
}
