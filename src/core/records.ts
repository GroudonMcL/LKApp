import { z } from 'zod'
import { getByPath, jsonValueToText, markdownOutline } from './extraction'
import { readTypeLine } from './statblock'

/**
 * Record extraction: one source document can hold many records (twenty magic items, a
 * chapter of NPCs, a bestiary). A recipe's `extraction` rules say how records are separated.
 *
 * Nothing is guessed silently. Every record carries flags for anything doubtful (too short,
 * too long, missing the expected labels, text before the first record), and the reviewer
 * decides. Splitting never drops text: the records plus the preamble cover the whole source.
 */

export const RecordRules = z.object({
  /**
   * - `whole`: the whole source is one record.
   * - `heading`: a new record starts at every heading of `headingLevel` (Markdown, HTML and Word headings).
   * - `statblock`: a new record starts at a name line followed by a creature type line
   *   ("Small Humanoid (Goblinoid), Neutral Evil"). Works for PDFs and plain text.
   * - `separator`: records are separated by lines equal to `separator` (e.g. `---`).
   * - `paragraph`: every blank-line-separated paragraph is a record (short lists of entries).
   * - `json_array`: each item of the JSON array at `jsonPath` is a record.
   */
  mode: z.enum(['whole', 'heading', 'statblock', 'separator', 'paragraph', 'json_array']).default('whole'),
  headingLevel: z.number().int().min(1).max(6).default(2),
  separator: z.string().min(1).max(50).default('---'),
  /** Dotted path to the array of records; empty when the JSON itself is the array. */
  jsonPath: z.string().max(200).default(''),
  /** Path, inside each JSON record, of its name and of its own identifier. */
  jsonNamePath: z.string().max(200).default('name'),
  jsonIdPath: z.string().max(200).default('id'),
  /** Records shorter than this are flagged (possibly only a heading). */
  minChars: z.number().int().min(0).max(10_000).default(40),
  /** A record is expected to contain at least one of these labels (e.g. "Armor Class"); others are flagged. */
  expectLabels: z.array(z.string().min(1).max(60)).max(20).default([]),
})
export type RecordRules = z.infer<typeof RecordRules>

export interface PageStart {
  page: number
  /** Character offset in the source text where this page begins. */
  offset: number
}

export type RecordFlag = 'preamble' | 'too_short' | 'too_long' | 'missing_expected_labels' | 'no_split_found' | 'duplicate_title_in_source' | 'invalid_json_record'

export interface ExtractedRecord {
  index: number
  title: string
  text: string
  json?: unknown
  /** Character offset in the source text (not for JSON records). */
  offset: number | null
  /** Source page where the record starts (PDFs). */
  page: number | null
  /** Heading path above the record, e.g. "Chapter 3 / Goblinoids". */
  section: string | null
  /** The record's own identifier in the source, when the source has one (JSON). */
  sourceRecordId: string | null
  flags: RecordFlag[]
}

export const FLAG_EXPLANATIONS: Record<RecordFlag, string> = {
  preamble: 'Text before the first record (an introduction or chapter text). Skipped unless you include it.',
  too_short: 'Very short: it may be only a heading, or the end of the previous record.',
  too_long: 'Very long: it may contain several records merged together. Check the split rules.',
  missing_expected_labels: 'None of the labels this recipe expects were found, so this may not be a record of this kind.',
  no_split_found: 'The split rule found no record boundaries, so the whole source became one record.',
  duplicate_title_in_source: 'Another record in the same source has the same title.',
  invalid_json_record: 'This JSON entry is not an object, so fields cannot be mapped from it.',
}

export function pageAt(pages: PageStart[], offset: number | null): number | null {
  if (offset === null) return null
  let page: number | null = null
  for (const start of pages) {
    if (start.offset <= offset) page = start.page
    else break
  }
  return page
}

interface Slice {
  title: string
  start: number
  end: number
  preamble?: boolean
}

export function extractRecords(
  source: { text: string; json?: unknown; format: 'text' | 'markdown' | 'json'; title: string | null; pages?: PageStart[] },
  rules: RecordRules,
  limits: { maxChars: number },
): ExtractedRecord[] {
  if (rules.mode === 'json_array') return jsonRecords(source, rules, limits)
  const text = source.text
  let slices: Slice[]
  let noSplit = false
  switch (rules.mode) {
    case 'heading':
      slices = headingSlices(text, rules.headingLevel)
      break
    case 'statblock':
      slices = statblockSlices(text)
      break
    case 'separator':
      slices = separatorSlices(text, rules.separator)
      break
    case 'paragraph':
      slices = paragraphSlices(text)
      break
    default:
      slices = []
  }
  if (rules.mode !== 'whole' && slices.filter((s) => !s.preamble).length === 0) noSplit = true
  if (rules.mode === 'whole' || noSplit) slices = [{ title: source.title ?? firstLine(text), start: 0, end: text.length }]

  // Headings that start a record are record titles, not sections of the records after them.
  const recordStarts = new Set(slices.filter((s) => !s.preamble).map((s) => s.start))
  const outline = source.format === 'markdown' ? markdownOutline(text).filter((entry) => !recordStarts.has(entry.offset)) : []
  const records = slices
    .map((slice) => ({ slice, body: text.slice(slice.start, slice.end).trim() }))
    .filter(({ body, slice }) => body !== '' || !slice.preamble)
    .map(({ slice, body }, index): ExtractedRecord => {
      const flags: RecordFlag[] = []
      if (slice.preamble) flags.push('preamble')
      if (noSplit) flags.push('no_split_found')
      if (!slice.preamble && body.replace(/\s/g, '').length < rules.minChars) flags.push('too_short')
      if (body.length > limits.maxChars) flags.push('too_long')
      if (!slice.preamble && rules.expectLabels.length && !rules.expectLabels.some((label) => new RegExp(`(^|[^\\p{L}])${escapeRegex(label)}([^\\p{L}]|$)`, 'iu').test(body))) {
        flags.push('missing_expected_labels')
      }
      return {
        index,
        title: slice.title || '(untitled)',
        text: body,
        offset: slice.start,
        page: pageAt(source.pages ?? [], slice.start),
        section: sectionPath(outline, slice.start, rules.mode === 'heading' ? rules.headingLevel : 7),
        sourceRecordId: null,
        flags,
      }
    })
  markDuplicateTitles(records)
  return records
}

function escapeRegex(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function firstLine(text: string): string {
  return (text.split('\n').find((line) => line.trim() !== '') ?? '').replace(/^#+\s*/, '').trim().slice(0, 200)
}

function headingSlices(text: string, level: number): Slice[] {
  const starts = markdownOutline(text).filter((entry) => entry.level === level)
  return withPreamble(
    text,
    starts.map((entry) => ({ title: entry.heading, start: entry.offset })),
    // A record ends at the next heading of the same or a higher level.
    (start) => {
      const next = markdownOutline(text).find((entry) => entry.offset > start && entry.level <= level)
      return next ? next.offset : text.length
    },
  )
}

function statblockSlices(text: string): Slice[] {
  const lines = text.split('\n')
  const starts: { title: string; start: number }[] = []
  let offset = 0
  const offsets = lines.map((line) => {
    const at = offset
    offset += line.length + 1
    return at
  })
  for (let i = 0; i < lines.length; i++) {
    const name = lines[i]!.replace(/^#+\s*/, '').replace(/\*\*/g, '').trim()
    if (!name || name.length > 80 || /[.:;]$/.test(name) || readTypeLine(name)) continue
    const nextIndex = lines.findIndex((line, j) => j > i && line.trim() !== '')
    if (nextIndex === -1) continue
    const next = lines[nextIndex]!.replace(/^[*_]+|[*_]+$/g, '').trim()
    if (readTypeLine(next)) starts.push({ title: name, start: offsets[i]! })
  }
  return withPreamble(text, starts, (start) => starts.find((s) => s.start > start)?.start ?? text.length)
}

function separatorSlices(text: string, separator: string): Slice[] {
  const slices: Slice[] = []
  let start = 0
  let offset = 0
  for (const line of text.split('\n')) {
    if (line.trim() === separator.trim()) {
      slices.push({ title: firstLine(text.slice(start, offset)), start, end: offset })
      start = offset + line.length + 1
    }
    offset += line.length + 1
  }
  slices.push({ title: firstLine(text.slice(start)), start, end: text.length })
  const real = slices.filter((s) => text.slice(s.start, s.end).trim() !== '')
  return real.length > 1 ? real : []
}

function paragraphSlices(text: string): Slice[] {
  const slices: Slice[] = []
  const pattern = /\n\s*\n/g
  let start = 0
  let match: RegExpExecArray | null
  while ((match = pattern.exec(text)) !== null) {
    slices.push({ title: firstLine(text.slice(start, match.index)), start, end: match.index })
    start = match.index + match[0].length
  }
  slices.push({ title: firstLine(text.slice(start)), start, end: text.length })
  const real = slices.filter((s) => text.slice(s.start, s.end).trim() !== '')
  return real.length > 1 ? real : []
}

function withPreamble(text: string, starts: { title: string; start: number }[], endOf: (start: number) => number): Slice[] {
  if (starts.length === 0) return []
  const slices: Slice[] = []
  if (starts[0]!.start > 0) slices.push({ title: 'Text before the first record', start: 0, end: starts[0]!.start, preamble: true })
  for (const s of starts) slices.push({ title: s.title, start: s.start, end: endOf(s.start) })
  // Text between a record's end and the next record start (e.g. a chapter heading) belongs to no record: keep it as a preamble.
  for (let i = 0; i < starts.length - 1; i++) {
    const end = endOf(starts[i]!.start)
    const nextStart = starts[i + 1]!.start
    if (end < nextStart && text.slice(end, nextStart).trim() !== '') slices.push({ title: `Text between records`, start: end, end: nextStart, preamble: true })
  }
  const last = starts[starts.length - 1]!
  const lastEnd = endOf(last.start)
  if (lastEnd < text.length && text.slice(lastEnd).trim() !== '') slices.push({ title: 'Text after the last record', start: lastEnd, end: text.length, preamble: true })
  return slices.sort((a, b) => a.start - b.start)
}

function sectionPath(outline: { level: number; heading: string; offset: number }[], offset: number, belowLevel: number): string | null {
  const path: { level: number; heading: string }[] = []
  for (const entry of outline) {
    if (entry.offset >= offset) break
    if (entry.level >= belowLevel) continue
    while (path.length && path[path.length - 1]!.level >= entry.level) path.pop()
    path.push(entry)
  }
  return path.length ? path.map((p) => p.heading).join(' / ') : null
}

function jsonRecords(source: { json?: unknown; title: string | null }, rules: RecordRules, limits: { maxChars: number }): ExtractedRecord[] {
  const container = rules.jsonPath ? getByPath(source.json, rules.jsonPath) : source.json
  if (!Array.isArray(container)) {
    return [
      {
        index: 0,
        title: source.title ?? 'JSON source',
        text: JSON.stringify(source.json, null, 2),
        json: source.json,
        offset: null,
        page: null,
        section: null,
        sourceRecordId: null,
        flags: ['no_split_found'],
      },
    ]
  }
  const records = container.map((item, index): ExtractedRecord => {
    const flags: RecordFlag[] = []
    const isObject = item !== null && typeof item === 'object' && !Array.isArray(item)
    if (!isObject) flags.push('invalid_json_record')
    const name = isObject ? jsonValueToText(getByPath(item, rules.jsonNamePath)) : null
    const id = isObject && rules.jsonIdPath ? jsonValueToText(getByPath(item, rules.jsonIdPath)) : null
    const text = JSON.stringify(item, null, 2)
    if (text.replace(/\s/g, '').length < rules.minChars) flags.push('too_short')
    if (text.length > limits.maxChars) flags.push('too_long')
    if (rules.expectLabels.length && isObject && !rules.expectLabels.some((label) => text.toLowerCase().includes(label.toLowerCase()))) flags.push('missing_expected_labels')
    return {
      index,
      title: name?.trim() || `Entry ${index + 1}`,
      text,
      json: item,
      offset: null,
      page: null,
      section: rules.jsonPath || null,
      sourceRecordId: id?.trim() || null,
      flags,
    }
  })
  markDuplicateTitles(records)
  return records
}

function markDuplicateTitles(records: ExtractedRecord[]) {
  const counts = new Map<string, number>()
  for (const r of records) if (!r.flags.includes('preamble')) counts.set(r.title.toLowerCase(), (counts.get(r.title.toLowerCase()) ?? 0) + 1)
  for (const r of records) if (!r.flags.includes('preamble') && (counts.get(r.title.toLowerCase()) ?? 0) > 1) r.flags.push('duplicate_title_in_source')
}
