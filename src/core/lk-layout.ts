import { z } from 'zod'
import type { PageTypeDefinition } from './page-types'

/**
 * Page layouts copied from LegendKeeper.
 *
 * A layout is the block structure of a LegendKeeper template (or of any page you choose as an
 * example), read with the documented read operations (`resources.get`, `documents.getBlocks`)
 * and stored locally. When a draft is written, the app fills a copy of that structure:
 * - infobox key-value rows whose key matches a field ("Armour Class", "Strength", …) get
 *   that field's value;
 * - titled text blocks whose title matches a section ("Traits", "Actions", …) get that
 *   section's paragraphs;
 * - the first level-1 heading becomes the page name;
 * - free paragraphs outside the infobox and text blocks are placeholders, replaced by the
 *   description and other lore sections.
 *
 * The template text itself ("Example Bite. …", "Creature Description Text") is never written.
 *
 * When the source is a LegendKeeper template, a new page can instead be created as a copy of
 * the template itself (`resources.createFromTemplate`, SDK 4.1.0), which brings its sidebar
 * properties, icon, banner and other tabs; the app then fills the first page tab with this
 * layout. A copied layout does not follow later edits to the template until you refresh it.
 */

export const LkLayout = z.object({
  sourceProjectId: z.string().max(256).nullable().default(null),
  sourceResourceId: z.string().min(1).max(256),
  sourceName: z.string().max(500),
  /** `template` when the source sits in LegendKeeper's templates list, `page` for an example page. */
  sourceKind: z.enum(['template', 'page']),
  documentName: z.string().max(500),
  /** Skeleton blocks: ids, ranks and parts the API cannot write already removed. */
  blocks: z.array(z.record(z.string(), z.unknown())).max(2000),
  /** Titles of parts that could not be copied (e.g. the TAGS property, which only the app can show). */
  droppedParts: z.array(z.string().max(256)).max(100).default([]),
  fetchedAt: z.string(),
})
export type LkLayout = z.infer<typeof LkLayout>

/**
 * LegendKeeper's virtual root of templates (documented in API v3 / SDK 4.1.0): a top-level
 * template has this parent id, and a resource under a template is a template too.
 */
export const LK_TEMPLATES_PARENT_ID = 'templates'

type AnyBlock = Record<string, unknown>

const BLOCK_CONTAINER_KEYS = ['children', 'rows', 'items', 'content'] as const

/** Removes ids and ranks (the new page gets its own) and parts the API cannot write. */
export function skeletonFromBlocks(blocks: unknown[]): { blocks: AnyBlock[]; droppedParts: string[] } {
  const droppedParts: string[] = []
  const clean = (value: unknown): unknown => {
    if (Array.isArray(value)) {
      return value
        .filter((item) => {
          if (item && typeof item === 'object' && (item as AnyBlock).kind === 'unsupported') {
            const title = (item as AnyBlock).title
            droppedParts.push(typeof title === 'string' && title ? title : 'an item the API cannot read')
            return false
          }
          if (isEmptyImage(item)) {
            droppedParts.push('the empty image slot (LegendKeeper refuses an image without a picture; add one after the page is created)')
            return false
          }
          return true
        })
        .map(clean)
    }
    if (value && typeof value === 'object') {
      const out: AnyBlock = {}
      for (const [key, inner] of Object.entries(value as AnyBlock)) {
        // Block and row ids are dropped (new pages get new ones); a collection filter's `id` is
        // part of the filter itself and is required, so it stays.
        if ((key === 'id' && (value as AnyBlock).type !== 'filter') || key === 'rank') continue
        out[key] = clean(inner)
      }
      return out
    }
    return value
  }
  return { blocks: clean(blocks) as AnyBlock[], droppedParts }
}

/** An image block or property with no picture. LegendKeeper answers "unsupported href" to these. */
export function isEmptyImage(item: unknown): boolean {
  if (!item || typeof item !== 'object') return false
  const block = item as AnyBlock
  return block.kind === 'image' && (typeof block.url !== 'string' || block.url.trim() === '')
}

function normalizeKey(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, '')
}

/**
 * Rows that combine several fields in the 2024 statblock style, e.g. "Immunities" holds damage
 * immunities and condition immunities ("Poison; Poisoned").
 */
const COMBINED_ROWS: Record<string, string[]> = {
  immunities: ['damageImmunities', 'conditionImmunities'],
}

/** The field keys a layout row key stands for, in order; empty when it matches no field. */
export function fieldsForLayoutKey(rowKey: string, pageType: PageTypeDefinition, extraLabels: Record<string, string[]> = {}): string[] {
  const key = normalizeKey(rowKey)
  if (!key) return []
  const fieldKeys = new Set(pageType.fields.map((field) => field.key))
  const combined = COMBINED_ROWS[key]?.filter((fieldKey) => fieldKeys.has(fieldKey))
  if (combined && combined.length > 1) return combined
  for (const field of pageType.fields) {
    const labels = [field.label, field.key, ...field.aliases, ...(extraLabels[field.key] ?? [])]
    if (labels.some((label) => normalizeKey(label) === key)) return [field.key]
  }
  return []
}

export interface LayoutSummary {
  /** Key-value rows in the layout and the fields they will hold. */
  rows: { key: string; fieldKeys: string[] }[]
  /** Titles of text blocks, which hold the section with the same heading. */
  sections: string[]
  /** Whether the layout has free paragraphs where the description goes. */
  hasDescriptionArea: boolean
}

/** Describes how a layout will be filled, for the template screen and for building section lists. */
export function summarizeLayout(blocks: AnyBlock[], pageType: PageTypeDefinition): LayoutSummary {
  const rows: LayoutSummary['rows'] = []
  const sections: string[] = []
  let hasDescriptionArea = false
  const visit = (block: AnyBlock, depth: number) => {
    if (block.kind === 'keyValue' && Array.isArray(block.rows)) {
      for (const row of block.rows as AnyBlock[]) {
        const key = typeof row.key === 'string' ? row.key : ''
        rows.push({ key, fieldKeys: fieldsForLayoutKey(key, pageType) })
      }
    }
    if (depth === 0 && block.kind === 'textField' && typeof block.title === 'string' && block.isTitleHidden !== true) sections.push(block.title)
    if (depth === 0 && isPlaceholderBlock(block)) hasDescriptionArea = true
    for (const container of BLOCK_CONTAINER_KEYS) {
      const inner = block[container]
      if (container !== 'content' && Array.isArray(inner) && !(block.kind === 'keyValue' && container === 'rows')) {
        for (const child of inner as AnyBlock[]) if (child && typeof child === 'object' && typeof child.kind === 'string') visit(child, depth + 1)
      }
    }
  }
  for (const block of blocks) visit(block, 0)
  return { rows, sections, hasDescriptionArea }
}

/** Top-level text a template uses as a stand-in for the page's own description. */
export function isPlaceholderBlock(block: AnyBlock): boolean {
  return ['paragraph', 'heading', 'bulletList', 'orderedList', 'quote'].includes(String(block.kind))
}
