import { plainText, walk, type Block } from '@legendkeeper/sdk/blocks'

/**
 * A compact summary of a LegendKeeper page's structure, used by Wiki Health checks and
 * tag suggestions. Built from the blocks the API returns; nothing here is guessed.
 */
export interface PageStructure {
  blockCount: number
  kinds: Record<string, number>
  hasInfobox: boolean
  /** Text of every heading, in order. */
  headings: string[]
  /** Titles of titled text blocks (e.g. "Traits", "Actions"). */
  textFieldTitles: string[]
  /** Keys of every key-value row, in the page and its infobox (e.g. "Armour Class"). */
  keyValueKeys: string[]
  /** Resources this page links to (mention runs and link lists). */
  mentionIds: string[]
  /** Blocks the API cannot express (kept by LegendKeeper, unreadable here). */
  unsupportedCount: number
  textChars: number
  /** The page's plain text, capped (used for label checks and tag suggestions). */
  text: string
}

/** Text kept per page in the local cache. Larger pages are checked on their first part only. */
export const STRUCTURE_TEXT_LIMIT = 20_000

export function pageStructure(blocks: unknown[]): PageStructure {
  const kinds: Record<string, number> = {}
  const headings: string[] = []
  const textFieldTitles: string[] = []
  const keyValueKeys: string[] = []
  const mentionIds = new Set<string>()
  let unsupportedCount = 0
  let blockCount = 0
  walk(blocks as Block[], (block) => {
    blockCount++
    const b = block as unknown as Record<string, unknown>
    const kind = String(b.kind)
    kinds[kind] = (kinds[kind] ?? 0) + 1
    if (kind === 'unsupported') unsupportedCount++
    if (kind === 'heading') headings.push(plainText(block as Block).trim())
    if (kind === 'textField' && typeof b.title === 'string' && b.isTitleHidden !== true) textFieldTitles.push(b.title)
    if (kind === 'keyValue' && Array.isArray(b.rows)) {
      for (const row of b.rows as { key?: string; content?: unknown[] }[]) {
        if (row.key) keyValueKeys.push(row.key)
        for (const run of row.content ?? []) collectMention(run, mentionIds)
      }
    }
    if (Array.isArray(b.content)) for (const run of b.content) collectMention(run, mentionIds)
    if (Array.isArray(b.items)) for (const item of b.items as { resourceId?: string }[]) if (item?.resourceId) mentionIds.add(item.resourceId)
  })
  const text = plainText(blocks as Block[])
  return {
    blockCount,
    kinds,
    hasInfobox: (kinds.infobox ?? 0) > 0,
    headings,
    textFieldTitles,
    keyValueKeys,
    mentionIds: [...mentionIds],
    unsupportedCount,
    textChars: text.length,
    text: text.slice(0, STRUCTURE_TEXT_LIMIT),
  }
}

function collectMention(run: unknown, ids: Set<string>) {
  const mention = (run as { mention?: { resourceId?: string } } | null)?.mention
  if (mention?.resourceId) ids.add(mention.resourceId)
}
