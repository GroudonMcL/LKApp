/**
 * Pure comparison helpers for template migration: what a page said before, what the proposed
 * page says, and what changed in between. Nothing here talks to LegendKeeper or the AI.
 *
 * The checks are deliberately literal. A sentence counts as kept only if it appears (ignoring
 * capitals, spaces and punctuation) in the proposed page; a number counts as kept only if the
 * same number appears as often as before. Anything else is reported, never assumed.
 */

/** One readable line of a page: a paragraph, list item, heading or key-value row. */
export interface ReadLine {
  kind: 'heading' | 'paragraph' | 'list' | 'row'
  /** Plain text (for rows: "Key: value"). */
  text: string
  /** The same line with bold, italic and web links as Markdown (used when copying it). */
  markdown: string
  /** The heading or titled box the line sits under, if any. */
  section: string | null
  key?: string
  value?: string
}

/** A block the migration keeps exactly as it is (sent back by id), e.g. an image or a secret. */
export interface PreservedPart {
  id: string | null
  kind: string
  label: string
  /** `infobox`: a row of the infobox; `page`: a block on the page. */
  container: 'page' | 'infobox'
  /** The heading or titled box it was under; null when it came before any heading. */
  section: string | null
  /** True when it came before any text (it then goes to the top of the new page). */
  atTop: boolean
  block: Record<string, unknown>
}

export type FormattingCounts = Record<'bold' | 'italic' | 'underline' | 'strike' | 'code' | 'link' | 'sub' | 'sup', number>

export interface PageReading {
  /** Input for the import pipeline: the page's readable content as Markdown. */
  markdown: string
  lines: ReadLine[]
  /** Mention runs: their wording and target. */
  mentions: { text: string; resourceId: string }[]
  /** Every page this page links to (mentions, link lists, collections). */
  linkIds: string[]
  preserved: PreservedPart[]
  /** Blocks left out because they carry no information (e.g. divider lines). */
  dropped: Record<string, number>
  formatting: FormattingCounts
  /** The level-1 heading repeating the page name, when there is one. */
  title: string | null
}

export function emptyFormatting(): FormattingCounts {
  return { bold: 0, italic: 0, underline: 0, strike: 0, code: 0, link: 0, sub: 0, sup: 0 }
}

/** Lower case, unified dashes and quotes, punctuation and Markdown markers reduced to spaces. */
export function normalizeForCompare(text: string): string {
  return text
    .normalize('NFKC')
    .replace(/[−–—]/g, '-')
    .replace(/[‘’]/g, "'")
    .replace(/[“”]/g, '"')
    .toLowerCase()
    .replace(/\*+/g, ' ')
    .replace(/[^\p{L}\p{N}+\-/']+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

/** Splits a line into sentences. Very short fragments are ignored. */
export function sentences(text: string): string[] {
  return text
    .split(/(?<=[.!?;])\s+(?=[\p{Lu}\p{N}"'(*])/u)
    .map((s) => s.trim())
    .filter((s) => normalizeForCompare(s).length >= 3)
}

/**
 * Numbers as written, e.g. "17", "+5", "18d10", "5,900", "1/4", "-1". Dice and modifiers are
 * kept whole so "1d8" and "1d6" differ.
 */
export function numberTokens(text: string): string[] {
  const normalized = text.normalize('NFKC').replace(/[−–]/g, '-')
  return normalized.match(/[+-]?\d+(?:[.,/]\d+)*(?:d\d+)?/g)?.map((t) => t.replace(/,(?=\d{3}\b)/g, '')) ?? []
}

/** What is in `before` but not in `after`, and the reverse, counting repeats. */
export function multisetDiff(before: string[], after: string[]): { missing: string[]; added: string[] } {
  const counts = new Map<string, number>()
  for (const t of before) counts.set(t, (counts.get(t) ?? 0) + 1)
  const added: string[] = []
  for (const t of after) {
    const n = counts.get(t) ?? 0
    if (n > 0) counts.set(t, n - 1)
    else added.push(t)
  }
  const missing: string[] = []
  for (const [t, n] of counts) for (let i = 0; i < n; i++) missing.push(t)
  return { missing, added }
}

export interface FieldChange {
  oldKey: string | null
  oldValue: string | null
  newKey: string | null
  newValue: string | null
  change: 'same' | 'relabelled' | 'changed' | 'new' | 'moved_to_text' | 'split' | 'not_found'
}

export interface Coverage {
  /** Old text not found in the proposed page (it will be kept in a notes section). */
  unmapped: { text: string; markdown: string; section: string | null }[]
  /** Old text found under a different label or heading. */
  relocated: { text: string; from: string | null; to: string | null }[]
  /** Text in the proposed page that the old page did not contain (reworded or added). */
  reworded: { text: string; section: string | null }[]
  fields: FieldChange[]
}

/**
 * Compares the readable content of two versions of a page.
 * `after` should not include the blocks that are kept as they are.
 */
export function compareContent(before: PageReading, after: PageReading): Coverage {
  const afterText = ` ${after.lines.map((l) => normalizeForCompare(l.text)).join(' | ')} `
  const beforeText = ` ${before.lines.map((l) => normalizeForCompare(l.text)).join(' | ')} `
  const contains = (haystack: string, needle: string) => needle !== '' && haystack.includes(needle)

  const unmapped: Coverage['unmapped'] = []
  const relocated: Coverage['relocated'] = []
  const fields: FieldChange[] = []

  // Key-value rows: matched by label first, then by value.
  const newRows = after.lines.filter((l) => l.kind === 'row')
  const usedNew = new Set<ReadLine>()
  const oldRows = before.lines.filter((l) => l.kind === 'row')
  const rowValueText = ` ${newRows.map((r) => normalizeForCompare(r.value ?? '')).join(' | ')} `
  for (const row of oldRows) {
    const key = normalizeForCompare(row.key ?? '')
    const value = normalizeForCompare(row.value ?? '')
    const sameKey = newRows.find((r) => !usedNew.has(r) && normalizeForCompare(r.key ?? '') === key)
    if (sameKey) {
      usedNew.add(sameKey)
      fields.push({ oldKey: row.key!, oldValue: row.value!, newKey: sameKey.key!, newValue: sameKey.value!, change: normalizeForCompare(sameKey.value ?? '') === value ? 'same' : 'changed' })
      if (normalizeForCompare(sameKey.value ?? '') !== value && !contains(afterText, value)) unmapped.push({ text: row.text, markdown: row.markdown, section: row.section })
      continue
    }
    // Same value under another label: prefer the label that looks most alike ("CON" → "Constitution").
    const sameValue = value
      ? newRows
          .filter((r) => !usedNew.has(r) && normalizeForCompare(r.value ?? '') === value)
          .sort((a, b) => keyAffinity(key, normalizeForCompare(b.key ?? '')) - keyAffinity(key, normalizeForCompare(a.key ?? '')))[0]
      : undefined
    if (sameValue) {
      usedNew.add(sameValue)
      fields.push({ oldKey: row.key!, oldValue: row.value!, newKey: sameValue.key!, newValue: sameValue.value!, change: 'relabelled' })
      relocated.push({ text: row.text, from: row.key ?? null, to: sameValue.key ?? null })
      continue
    }
    if (contains(afterText, normalizeForCompare(row.text))) {
      fields.push({ oldKey: row.key!, oldValue: row.value!, newKey: null, newValue: null, change: 'moved_to_text' })
      relocated.push({ text: row.text, from: row.key ?? null, to: 'page text' })
      continue
    }
    const words = value.split(' ').filter(Boolean)
    if (words.length > 1 && words.every((w) => new RegExp(`(^|[\\s|])${escapeRegex(w)}([\\s|]|$)`).test(rowValueText))) {
      fields.push({ oldKey: row.key!, oldValue: row.value!, newKey: null, newValue: null, change: 'split' })
      relocated.push({ text: row.text, from: row.key ?? null, to: 'several fields' })
      continue
    }
    fields.push({ oldKey: row.key!, oldValue: row.value!, newKey: null, newValue: null, change: 'not_found' })
    unmapped.push({ text: row.text, markdown: row.markdown, section: row.section })
  }
  for (const row of newRows) if (!usedNew.has(row)) fields.push({ oldKey: null, oldValue: null, newKey: row.key!, newValue: row.value!, change: 'new' })

  // Paragraphs and list items: every sentence must still be there.
  for (const line of before.lines) {
    if (line.kind !== 'paragraph' && line.kind !== 'list') continue
    const missing = sentences(line.text).filter((s) => !contains(afterText, normalizeForCompare(s)))
    if (missing.length === 0) {
      const target = after.lines.find((l) => (l.kind === 'paragraph' || l.kind === 'list') && contains(` ${normalizeForCompare(l.text)} `, normalizeForCompare(line.text)))
      if (target && target.section && line.section && normalizeForCompare(target.section) !== normalizeForCompare(line.section)) {
        relocated.push({ text: line.text, from: line.section, to: target.section })
      }
      continue
    }
    unmapped.push({ text: line.text, markdown: line.markdown, section: line.section })
  }

  // Sentences that were not on the old page (reworded or invented text).
  const reworded: Coverage['reworded'] = []
  for (const line of after.lines) {
    if (line.kind !== 'paragraph' && line.kind !== 'list') continue
    for (const s of sentences(line.text)) if (!contains(beforeText, normalizeForCompare(s))) reworded.push({ text: s, section: line.section })
  }
  return { unmapped, relocated, reworded, fields }
}

/** Number changes between two versions, each with the old (or new) line it came from. */
export function mechanicsChanges(before: PageReading, after: PageReading): { id: string; change: 'missing' | 'added'; value: string; context: string }[] {
  const tokensOf = (reading: PageReading) => reading.lines.flatMap((l) => numberTokens(l.text).map((t) => ({ t, line: l.text })))
  const b = tokensOf(before)
  const a = tokensOf(after)
  const { missing, added } = multisetDiff(
    b.map((x) => x.t),
    a.map((x) => x.t),
  )
  const out: { id: string; change: 'missing' | 'added'; value: string; context: string }[] = []
  const seen = new Map<string, number>()
  const push = (change: 'missing' | 'added', value: string, pool: { t: string; line: string }[]) => {
    const n = (seen.get(`${change}:${value}`) ?? 0) + 1
    seen.set(`${change}:${value}`, n)
    const context = pool.filter((x) => x.t === value)[n - 1]?.line ?? pool.find((x) => x.t === value)?.line ?? ''
    out.push({ id: `${change}:${value}:${n}`, change, value, context: context.slice(0, 300) })
  }
  for (const v of missing) push('missing', v, b)
  for (const v of added) push('added', v, a)
  return out
}

/** Formatting that the proposed page has less of than the old one (e.g. underline). */
export function formattingLost(before: FormattingCounts, after: FormattingCounts): string[] {
  return (Object.keys(before) as (keyof FormattingCounts)[]).filter((k) => after[k] < before[k]).map((k) => `${k} (${before[k]} → ${after[k]})`)
}

/** How alike two labels look: shared start, abbreviation, or shared words. */
function keyAffinity(a: string, b: string): number {
  if (!a || !b) return 0
  if (a === b) return 100
  if (b.startsWith(a) || a.startsWith(b)) return 50
  let prefix = 0
  while (prefix < Math.min(a.length, b.length) && a[prefix] === b[prefix]) prefix++
  const words = a.split(' ').filter((w) => b.split(' ').includes(w)).length
  return prefix * 2 + words * 5
}

function escapeRegex(text: string) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}
