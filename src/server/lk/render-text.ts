import { bold, br, h, mention, p, ul, type Block, type Run } from '@legendkeeper/sdk/blocks'
import { resolvedReferences, type CanonicalPage } from '@/core/page-model'

/** Shared text helpers for the renderers: paragraphs, bold runs and mention links. */

/** Mention text → resource id, longest text first so "Free City of Greyhawk" beats "Greyhawk". */
export function mentionTargets(page: CanonicalPage): Map<string, string> {
  const entries = resolvedReferences(page)
    .map((ref) => [ref.mention, ref.resourceId!] as const)
    .sort((a, b) => b[0].length - a[0].length)
  return new Map(entries)
}

export function paragraphBlocks(text: string, targets: Map<string, string>, linked: Set<string>): Block[] {
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
export function inlineRuns(line: string, targets: Map<string, string>, linked: Set<string>): Run[] {
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

export function sourcesBlocks(page: CanonicalPage): Block[] {
  if (page.sources.length === 0) return []
  const items = page.sources.map((source) => (source.citation ? `${source.title} — ${source.citation}` : source.title))
  return [h(2, 'Sources'), ul(items[0]!, ...items.slice(1))]
}

const NAME_CONNECTIVES = new Set(['of', 'the', 'and', 'or', 'to', 'in', 'on', 'with', 'from', 'a', 'an', 'at', 'for', 'by'])

/**
 * Bolds the name at the start of a statblock entry: "Nimble Feet. The underboss …" becomes
 * "**Nimble Feet.** The underboss …". Only names that look like a title count (at most eight
 * words, each capitalised apart from small words like "of"; brackets such as "(3/Day)" or
 * "(Recharge 5–6)" allowed), so an ordinary sentence is left alone. Text already starting in
 * bold is unchanged. The text itself is not altered, only its formatting.
 */
export function boldEntryName(paragraph: string): string {
  if (paragraph.trimStart().startsWith('**')) return paragraph
  const match = /^(\s*)([^.:\n]{1,80}?\.)(\s+\S)/.exec(paragraph)
  if (!match) return paragraph
  const name = match[2]!
  const words = name.slice(0, -1).replace(/\([^)]*\)/g, ' ').trim().split(/\s+/).filter(Boolean)
  if (words.length === 0 || words.length > 8) return paragraph
  const titleLike = words.every((word, i) => /^[\p{Lu}\d]/u.test(word) || (i > 0 && NAME_CONNECTIVES.has(word.toLowerCase())))
  if (!titleLike) return paragraph
  return `${match[1]}**${name}**${paragraph.slice(match[1]!.length + name.length)}`
}
