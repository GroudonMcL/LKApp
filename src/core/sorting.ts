/**
 * Cutting a source into pages from a sorting by line numbers (see server/ai/prompts/sort.ts).
 *
 * The AI only names line ranges; this code does the cutting, so every page's text is exactly the
 * source's text. Ranges outside the source are clipped, unknown page kinds become "other", and
 * every non-blank line that neither an entry nor a discard covers is reported as unplaced, so
 * nothing disappears without being shown.
 *
 * Pure: no network, no database.
 */

export interface NumberedLine {
  n: number
  text: string
}

export interface Range {
  from: number
  to: number
}

/** The source's lines, numbered from 1. */
export function numberLines(text: string): NumberedLine[] {
  return text.split('\n').map((line, i) => ({ n: i + 1, text: line }))
}

/** Lines shown to the AI: non-blank, each cut to `maxLineChars` (the cut text is still kept in the page). */
export function promptLines(lines: NumberedLine[], maxLineChars = 1200): NumberedLine[] {
  return lines.filter((line) => line.text.trim() !== '').map((line) => ({ n: line.n, text: line.text.length > maxLineChars ? `${line.text.slice(0, maxLineChars)} […]` : line.text }))
}

/**
 * Parts of the source for one AI request each, cut before a heading where possible, so a long
 * document is sorted in several requests.
 */
export function sortChunks(lines: NumberedLine[], maxChars: number): NumberedLine[][] {
  const shown = promptLines(lines)
  const chunks: NumberedLine[][] = []
  let current: NumberedLine[] = []
  let size = 0
  for (let i = 0; i < shown.length; i++) {
    const line = shown[i]!
    const cost = line.text.length + 8
    if (current.length && size + cost > maxChars) {
      // Prefer to cut at the last heading in the second half of the chunk.
      let cut = current.length
      for (let j = current.length - 1; j > current.length / 2; j--) {
        if (/^#{1,3}\s/.test(current[j]!.text)) {
          cut = j
          break
        }
      }
      chunks.push(current.slice(0, cut))
      current = current.slice(cut)
      size = current.reduce((n, l) => n + l.text.length + 8, 0)
    }
    current.push(line)
    size += cost
  }
  if (current.length) chunks.push(current)
  return chunks
}

export interface SortedEntry {
  title: string
  /** The destination key, or null for "other". */
  destination: string | null
  ranges: Range[]
  text: string
  confidence: 'high' | 'medium' | 'low'
  why: string
  /** Other entries that share lines with this one. */
  overlapsWith: string[]
}

export interface SortResult {
  entries: SortedEntry[]
  discarded: (Range & { why: string; preview: string })[]
  unplaced: (Range & { preview: string })[]
  notes: string[]
}

interface RawEntry {
  title: string
  kind: string
  ranges: Range[]
  confidence: 'high' | 'medium' | 'low'
  why: string
}

/** Clips, sorts and merges ranges to the source's lines. */
export function cleanRanges(ranges: Range[], lineCount: number): Range[] {
  const clipped = ranges
    .map((r) => ({ from: Math.max(1, Math.min(r.from, r.to)), to: Math.min(lineCount, Math.max(r.from, r.to)) }))
    .filter((r) => r.from <= r.to)
    .sort((a, b) => a.from - b.from)
  const merged: Range[] = []
  for (const range of clipped) {
    const last = merged[merged.length - 1]
    if (last && range.from <= last.to + 1) last.to = Math.max(last.to, range.to)
    else merged.push({ ...range })
  }
  return merged
}

function textOf(lines: NumberedLine[], ranges: Range[]): string {
  return ranges
    .map((r) => lines.slice(r.from - 1, r.to).map((l) => l.text).join('\n').trim())
    .filter(Boolean)
    .join('\n\n')
}

function preview(lines: NumberedLine[], range: Range): string {
  const text = lines.slice(range.from - 1, range.to).map((l) => l.text.trim()).filter(Boolean).join(' ')
  return text.length > 160 ? `${text.slice(0, 157)}…` : text
}

/**
 * Applies a sorting (possibly from several AI requests) to the source. `kinds` maps the codes
 * the AI saw to destination keys. Entries of the same title and kind from neighbouring requests
 * are joined.
 */
export function applySort(lines: NumberedLine[], parts: { entries: RawEntry[]; discarded: (Range & { why: string })[] }[], kinds: Map<string, string>): SortResult {
  const notes: string[] = []
  const byKey = new Map<string, RawEntry & { destination: string | null }>()
  const order: string[] = []
  for (const part of parts) {
    for (const entry of part.entries) {
      const title = entry.title.trim() || 'Untitled'
      const destination = kinds.get(entry.kind.trim().toLowerCase()) ?? null
      if (!destination && entry.kind.trim().toLowerCase() !== 'other') notes.push(`The AI named a page kind “${entry.kind}” that does not exist for “${title}”; it is treated as “other”.`)
      const key = `${title.toLowerCase()}\u0000${destination ?? ''}`
      const existing = byKey.get(key)
      if (existing) existing.ranges.push(...entry.ranges)
      else {
        byKey.set(key, { ...entry, title, destination, ranges: [...entry.ranges] })
        order.push(key)
      }
    }
  }
  const entries: SortedEntry[] = []
  const claimed = order.map((key) => cleanRanges(byKey.get(key)!.ranges, lines.length))
  for (const [index, key] of order.entries()) {
    const raw = byKey.get(key)!
    const ranges = withHeadings(lines, claimed[index]!, claimed.filter((_, i) => i !== index).flat())
    const text = textOf(lines, ranges)
    if (!text) {
      notes.push(`“${raw.title}” had no lines of the source, so it was left out.`)
      continue
    }
    entries.push({ title: raw.title.slice(0, 200), destination: raw.destination, ranges, text, confidence: raw.confidence, why: raw.why.slice(0, 300), overlapsWith: [] })
  }
  const covers = (ranges: Range[], n: number) => ranges.some((r) => n >= r.from && n <= r.to)
  for (const entry of entries) {
    entry.overlapsWith = entries.filter((other) => other !== entry && other.ranges.some((r) => entry.ranges.some((e) => r.from <= e.to && e.from <= r.to))).map((other) => other.title)
  }

  // A line an entry keeps is never discarded.
  const entryRanges = entries.flatMap((e) => e.ranges)
  const discardedRanges = cleanRanges(parts.flatMap((p) => p.discarded), lines.length)
  const whyFor = (range: Range) => parts.flatMap((p) => p.discarded).find((d) => d.from <= range.to && range.from <= d.to)?.why ?? ''
  const discarded: SortResult['discarded'] = []
  for (const range of discardedRanges) {
    let start: number | null = null
    for (let n = range.from; n <= range.to + 1; n++) {
      const free = n <= range.to && !covers(entryRanges, n)
      if (free && start === null) start = n
      if (!free && start !== null) {
        const piece = { from: start, to: n - 1 }
        if (preview(lines, piece)) discarded.push({ ...piece, why: whyFor(piece).slice(0, 200), preview: preview(lines, piece) })
        start = null
      }
    }
  }

  // Non-blank lines nobody placed.
  const unplaced: SortResult['unplaced'] = []
  let start: number | null = null
  const placed = (n: number) => covers(entryRanges, n) || covers(discardedRanges, n)
  for (let n = 1; n <= lines.length + 1; n++) {
    const line = lines[n - 1]
    const blank = !line || line.text.trim() === ''
    const open = n <= lines.length && !placed(n) && !blank
    if (open && start === null) start = n
    if (!open && start !== null && (n > lines.length || !blank || placed(n))) {
      let end = n - 1
      while (end > start && lines[end - 1]!.text.trim() === '') end--
      unplaced.push({ from: start, to: end, preview: preview(lines, { from: start, to: end }) })
      start = null
    }
  }
  return { entries, discarded, unplaced, notes }
}

const isHeadingLine = (text: string) => /^#{1,6}\s+\S/.test(text.trim()) || /^(\*\*|__)[^*_]{2,60}(\*\*|__):?$/.test(text.trim())

/**
 * An entry keeps the headings inside it and just before it, even when the AI's line numbers
 * skip them: two of its ranges separated only by headings and blank lines are joined, and a
 * heading right before a range (with no other entry's lines between) is included. Headings such
 * as "Secrets" matter: they say which text players must not see.
 */
export function withHeadings(lines: NumberedLine[], ranges: Range[], others: Range[]): Range[] {
  if (!ranges.length) return ranges
  const taken = (n: number) => others.some((r) => n >= r.from && n <= r.to)
  const filler = (n: number) => {
    const text = lines[n - 1]?.text ?? ''
    return !taken(n) && (text.trim() === '' || isHeadingLine(text))
  }
  const out: Range[] = []
  for (const range of ranges) {
    const last = out[out.length - 1]
    if (last) {
      let gapFiller = true
      for (let n = last.to + 1; n < range.from; n++) if (!filler(n)) gapFiller = false
      if (gapFiller) {
        last.to = Math.max(last.to, range.to)
        continue
      }
    }
    out.push({ ...range })
  }
  // A part that starts with text takes in its own heading (the nearest one just before it); a
  // part that starts with a heading already has it, and the headings above it are its parents'.
  for (const range of out) {
    if (isHeadingLine(lines[range.from - 1]!.text)) continue
    let n = range.from - 1
    while (n >= 1 && !taken(n) && lines[n - 1]!.text.trim() === '') n--
    if (n >= 1 && !taken(n) && isHeadingLine(lines[n - 1]!.text)) range.from = n
  }
  return cleanRanges(out, lines.length)
}

/** The text of some lines of the source (for an unplaced part made into a page). */
export function linesText(lines: NumberedLine[], ranges: Range[]): string {
  return textOf(lines, cleanRanges(ranges, lines.length))
}
