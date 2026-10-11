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
