import { bold, br, h, infobox, keyValue, links, mention, p, property, ul, type Block, type PropertyBlock, type Run } from '@legendkeeper/sdk/blocks'
import { acceptedTags, resolvedReferences, writableFields, type CanonicalPage, type PageSection } from '@/core/page-model'
import type { PageTypeDefinition } from '@/core/page-types'
import type { TemplateDefinition } from '@/core/template'
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
    for (const paragraph of section.paragraphs) blocks.push(...paragraphBlocks(paragraph, section.kind === 'unmapped' ? new Map() : targets, linked))
  }
  placeStatistics()

  // 3. Sources.
  if (ctx.template.includeSourcesSection && page.sources.length > 0) {
    const items = page.sources.map((source) => (source.citation ? `${source.title} — ${source.citation}` : source.title))
    blocks.push(h(2, 'Sources'))
    blocks.push(ul(items[0]!, ...items.slice(1)))
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

/** Mention text → resource id, longest text first so "Free City of Greyhawk" beats "Greyhawk". */
function mentionTargets(page: CanonicalPage): Map<string, string> {
  const entries = resolvedReferences(page)
    .map((ref) => [ref.mention, ref.resourceId!] as const)
    .sort((a, b) => b[0].length - a[0].length)
  return new Map(entries)
}

function paragraphBlocks(text: string, targets: Map<string, string>, linked: Set<string>): Block[] {
  const lines = text.split('\n')
  const listItem = /^\s*(?:[-*•]|\d+[.)])\s+/
  if (lines.length > 1 && lines.every((line) => listItem.test(line))) {
    const items = lines.map((line) => inlineRuns(line.replace(listItem, ''), targets, linked))
    return [ul(items[0]!, ...items.slice(1))]
  }
  const runs: Run[] = []
  lines.forEach((line, i) => {
    if (i > 0) runs.push(br)
    runs.push(...inlineRuns(line, targets, linked))
  })
  return [p(runs)]
}

/**
 * Turns one line into runs: `**bold**` becomes bold text, and the first occurrence (per
 * section) of each resolved mention becomes a mention run that keeps the source wording.
 */
function inlineRuns(line: string, targets: Map<string, string>, linked: Set<string>): Run[] {
  const runs: Run[] = []
  const parts = line.split(/(\*\*[^*]+\*\*)/g).filter((part) => part !== '')
  for (const part of parts) {
    const isBold = /^\*\*[^*]+\*\*$/.test(part)
    const text = isBold ? part.slice(2, -2) : part
    const pieces = withMentions(text, targets, linked)
    for (const piece of pieces) {
      if (typeof piece === 'string') runs.push(...(isBold ? bold(piece) : [{ text: piece }]))
      else runs.push(...mention({ resourceId: piece.resourceId, text: piece.text }))
    }
  }
  return runs.length > 0 ? runs : [{ text: '' }]
}

function withMentions(text: string, targets: Map<string, string>, linked: Set<string>): (string | { resourceId: string; text: string })[] {
  if (targets.size === 0 || text === '') return [text]
  let best: { index: number; mention: string; resourceId: string } | null = null
  for (const [mentionText, resourceId] of targets) {
    if (linked.has(mentionText)) continue
    const index = findWord(text, mentionText)
    if (index !== -1 && (best === null || index < best.index)) best = { index, mention: mentionText, resourceId }
  }
  if (!best) return [text]
  linked.add(best.mention)
  const before = text.slice(0, best.index)
  const after = text.slice(best.index + best.mention.length)
  return [
    ...(before ? [before] : []),
    { resourceId: best.resourceId, text: best.mention },
    ...withMentions(after, targets, linked),
  ]
}

/** Index of `word` in `text` on word boundaries, case-sensitive; -1 if absent. */
function findWord(text: string, word: string): number {
  let from = 0
  while (from <= text.length) {
    const index = text.indexOf(word, from)
    if (index === -1) return -1
    const before = index === 0 ? '' : text[index - 1]!
    const after = text[index + word.length] ?? ''
    if (!/[\p{L}\p{N}]/u.test(before) && !/[\p{L}\p{N}]/u.test(after)) return index
    from = index + 1
  }
  return -1
}
