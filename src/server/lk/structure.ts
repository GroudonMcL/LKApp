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
  /**
   * Labelled values from key-value rows, in the page and its infobox ("Date: 576 CY"). Infobox
   * content is not part of `text` (LegendKeeper's plain text leaves it out), so it is kept
   * here. Absent in cache entries written before Phase 3.
   */
  fields?: { key: string; value: string; mentionIds: string[] }[]
  /** Each link with the words it shows, so its passage can be found in `text`. */
  links?: { resourceId: string; text: string }[]
}

/** Text kept per page in the local cache. Larger pages are checked on their first part only. */
export const STRUCTURE_TEXT_LIMIT = 20_000

export function pageStructure(blocks: unknown[]): PageStructure {
  const kinds: Record<string, number> = {}
  const headings: string[] = []
  const textFieldTitles: string[] = []
  const keyValueKeys: string[] = []
  const mentionIds = new Set<string>()
  const fields: NonNullable<PageStructure['fields']> = []
  const links = new Map<string, { resourceId: string; text: string }>()
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
      for (const row of b.rows as { key?: string; content?: unknown[]; text?: string }[]) {
        if (row.key) keyValueKeys.push(row.key)
        const rowMentions = new Set<string>()
        for (const run of row.content ?? []) (collectMention(run, mentionIds, links), collectMention(run, rowMentions))
        const value = typeof row.text === 'string' ? row.text : (row.content ?? []).map(runText).join('')
        if (row.key && value.trim()) fields.push({ key: row.key, value: value.trim().slice(0, 500), mentionIds: [...rowMentions] })
      }
    }
    if (Array.isArray(b.content)) for (const run of b.content) collectMention(run, mentionIds, links)
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
    fields: fields.slice(0, 200),
    links: [...links.values()].slice(0, 500),
  }
}

function runText(run: unknown): string {
  const r = run as { text?: string; mention?: { text?: string; name?: string } } | null
  return r?.text ?? r?.mention?.text ?? r?.mention?.name ?? ''
}

function collectMention(run: unknown, ids: Set<string>, links?: Map<string, { resourceId: string; text: string }>) {
  const mention = (run as { mention?: { resourceId?: string; text?: string; name?: string } } | null)?.mention
  if (!mention?.resourceId) return
  ids.add(mention.resourceId)
  const shown = runText(run).trim()
  if (links && shown && !links.has(`${mention.resourceId}|${shown}`)) links.set(`${mention.resourceId}|${shown}`, { resourceId: mention.resourceId, text: shown })
}
