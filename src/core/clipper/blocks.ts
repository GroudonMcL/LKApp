import { collection, h, mention, rule, type Block } from '@legendkeeper/sdk/blocks'

/**
 * Web Clipper: the blocks the clipper adds around clipped content (pure, no API calls).
 *
 * The layout follows the brief:
 * - New page:    H1 "From <Source>", then the clipped content.
 * - Append:      a divider, H1 "From <Source>", then the clipped content, after everything
 *                already on the page (which is never changed).
 * - Source page: a "Backlinks" collection of every page that links to the source.
 *
 * The source name in the heading is a real mention of the Source page, so every clipped page
 * becomes a backlink of its source and shows up in that collection.
 */

export interface SourceRef {
  resourceId: string
  /** Shown in the heading. When omitted, LegendKeeper shows the Source page's current name. */
  label?: string
}

/** H1 "From <Source>", the source name a mention of the Source page. */
export function sourceHeading(source: SourceRef): Block {
  return h(1, 'From ', mention({ resourceId: source.resourceId, ...(source.label ? { text: source.label } : {}) }))
}

/** The content of a new clipped page. */
export function newPageBlocks(source: SourceRef, content: Block[]): Block[] {
  return [sourceHeading(source), ...content]
}

/** What an append adds after the existing content: divider, source heading, content. */
export function appendedBlocks(source: SourceRef, content: Block[]): Block[] {
  return [rule(), sourceHeading(source), ...content]
}

/**
 * The whole page after an append: the existing blocks exactly as read (ids, ranks and
 * unsupported blocks included, so the replace keeps them unchanged), then the new blocks.
 * On an empty page the divider is left out.
 */
export function pageAfterAppend(existing: Block[], source: SourceRef, content: Block[]): Block[] {
  const hasContent = existing.some((block) => !isEmptyParagraph(block))
  return hasContent ? [...existing, ...appendedBlocks(source, content)] : [...existing.filter((b) => !isEmptyParagraph(b)), ...newPageBlocks(source, content)]
}

/**
 * The filter LegendKeeper's own "Backlinks" collection writes: every resource whose documents,
 * properties or map pins link to the page holding the collection (`$self`).
 */
export const BACKLINKS_FILTER = {
  type: 'filter',
  filterType: 'field',
  id: 'backlinks',
  scope: 'edges',
  field: 'targetId',
  operator: 'equals',
  value: '$self',
} as const

/**
 * A new Source page: a titled Backlinks collection, the same shape as the Source pages already
 * in the project (made in the LegendKeeper app).
 */
export function sourcePageBlocks(): Block[] {
  return [collection({ filter: { ...BACKLINKS_FILTER }, title: 'Backlinks', isTitleHidden: false })]
}

export function isBacklinksCollection(block: Block): boolean {
  if (block.kind !== 'resourceCollection') return false
  const filter = (block as { filter?: Record<string, unknown> }).filter
  return !!filter && filter.scope === 'edges' && filter.field === 'targetId' && filter.value === '$self'
}

function isEmptyParagraph(block: Block): boolean {
  if (block.kind !== 'paragraph') return false
  const content = (block as { content?: unknown[] }).content
  return !content || content.length === 0
}
