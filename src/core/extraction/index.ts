import { EXTRACTORS, UNSUPPORTED_FORMATS, markdownOutline } from './extractors'
import { ExtractionError, type ExtractedFormat, type ExtractedSource, type SourceInput } from './types'
import type { PageTypeDefinition } from '../page-types'

export * from './types'
export { getByPath, jsonValueToText, markdownOutline } from './extractors'

export interface ExtractionLimits {
  maxBytes: number
  maxChars: number
}

function extensionOf(fileName: string | null): string | null {
  if (!fileName) return null
  const match = /\.[A-Za-z0-9]+$/.exec(fileName)
  return match ? match[0].toLowerCase() : null
}

/**
 * Validates and extracts a source. Throws `ExtractionError` with a human-readable message
 * when the input is empty, too large, not text, or in a format Phase 1 does not support.
 * Large inputs are refused, never silently truncated.
 */
export function extractSource(input: SourceInput, limits: ExtractionLimits): ExtractedSource {
  if (input.bytes.byteLength === 0) throw new ExtractionError('The source is empty.', 'EMPTY')
  if (input.bytes.byteLength > limits.maxBytes) {
    throw new ExtractionError(
      `The source is ${formatBytes(input.bytes.byteLength)}, over the ${formatBytes(limits.maxBytes)} upload limit. Split it into smaller files (for example one chapter or one entry per file).`,
      'TOO_LARGE',
    )
  }

  const extension = extensionOf(input.fileName)
  const mime = input.mimeType?.toLowerCase() ?? ''
  const unsupported = UNSUPPORTED_FORMATS.find(
    (format) =>
      (extension && format.extensions.includes(extension)) || format.mimePrefixes.some((prefix) => mime.startsWith(prefix)),
  )
  if (unsupported) {
    throw new ExtractionError(
      `${unsupported.label} are not supported in Phase 1. Copy the text out of the document and paste it, or save it as .txt or .md.`,
      'UNSUPPORTED_TYPE',
    )
  }

  if (input.bytes.includes(0)) {
    throw new ExtractionError('The file looks binary, not text. Phase 1 accepts plain text, Markdown and JSON.', 'BINARY')
  }

  let text: string
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(input.bytes)
  } catch {
    throw new ExtractionError('The file is not valid UTF-8 text. Re-save it as UTF-8 and try again.', 'NOT_UTF8')
  }
  if (text.trim() === '') throw new ExtractionError('The source contains only whitespace.', 'EMPTY')

  const format = chooseFormat(input.declaredFormat ?? null, extension, mime, text)
  const extractor = EXTRACTORS.find((candidate) => candidate.format === format)!
  const extracted = extractor.extract(text)

  if (extracted.text.length > limits.maxChars) {
    throw new ExtractionError(
      `The source has ${extracted.text.length.toLocaleString('en-GB')} characters, over the ${limits.maxChars.toLocaleString('en-GB')} character limit for one import. Use “Split source” to break it into sections and import one section at a time.`,
      'TOO_LONG',
    )
  }
  extracted.warnings.push(...detectSuspiciousInstructions(extracted.text))
  return extracted
}

function chooseFormat(declared: ExtractedFormat | null, extension: string | null, mime: string, text: string): ExtractedFormat {
  if (declared) return declared
  const byExtension = extension ? EXTRACTORS.find((extractor) => extractor.extensions.includes(extension)) : undefined
  if (byExtension) return byExtension.format
  const byMime = EXTRACTORS.find((extractor) => extractor.mimeTypes.includes(mime))
  if (byMime && byMime.format !== 'text') return byMime.format
  if (extension && !['.txt', '.text'].includes(extension) && extension !== '') {
    throw new ExtractionError(
      `Files ending in ${extension} are not supported. Phase 1 accepts .txt, .md and .json files, or pasted text.`,
      'UNSUPPORTED_TYPE',
    )
  }
  // Pasted or extension-less text: sniff gently.
  const trimmed = text.trim()
  if ((trimmed.startsWith('{') && trimmed.endsWith('}')) || (trimmed.startsWith('[') && trimmed.endsWith(']'))) {
    try {
      JSON.parse(trimmed)
      return 'json'
    } catch {
      /* not JSON; fall through */
    }
  }
  if (markdownOutline(text).length > 0) return 'markdown'
  return 'text'
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} bytes`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

// ── Splitting large sources ───────────────────────────────────────────────────

export interface SourceChunk {
  index: number
  heading: string
  text: string
  chars: number
}

/**
 * Splits a long Markdown or text source into chunks at headings (or blank-line paragraphs
 * when there are no headings), each at most `maxChars`. No text is dropped: joining the
 * chunks gives back the whole source. A single paragraph longer than `maxChars` is split
 * at line boundaries, then hard-split as a last resort.
 */
export function splitSource(text: string, maxChars: number): SourceChunk[] {
  const outline = markdownOutline(text).filter((entry) => entry.level <= 2)
  const boundaries =
    outline.length > 0 ? outline.map((entry) => entry.offset) : paragraphOffsets(text)
  if (boundaries[0] !== 0) boundaries.unshift(0)

  const pieces: string[] = []
  for (let i = 0; i < boundaries.length; i++) {
    pieces.push(text.slice(boundaries[i]!, boundaries[i + 1] ?? text.length))
  }

  const chunks: string[] = []
  let current = ''
  for (const piece of pieces.flatMap((piece) => hardSplit(piece, maxChars))) {
    if (current.length + piece.length > maxChars && current !== '') {
      chunks.push(current)
      current = ''
    }
    current += piece
  }
  if (current !== '') chunks.push(current)

  return chunks.map((chunk, index) => ({
    index,
    heading: markdownOutline(chunk)[0]?.heading ?? chunk.trim().split('\n')[0]!.slice(0, 80),
    text: chunk,
    chars: chunk.length,
  }))
}

function paragraphOffsets(text: string): number[] {
  const offsets = [0]
  const pattern = /\n\s*\n/g
  let match: RegExpExecArray | null
  while ((match = pattern.exec(text)) !== null) offsets.push(match.index + match[0].length)
  return offsets
}

function hardSplit(piece: string, maxChars: number): string[] {
  if (piece.length <= maxChars) return [piece]
  const out: string[] = []
  let current = ''
  for (const line of piece.split(/(?<=\n)/)) {
    if (line.length > maxChars) {
      if (current) out.push(current)
      current = ''
      for (let i = 0; i < line.length; i += maxChars) out.push(line.slice(i, i + maxChars))
      continue
    }
    if (current.length + line.length > maxChars) {
      out.push(current)
      current = ''
    }
    current += line
  }
  if (current) out.push(current)
  return out
}

// ── Hints ────────────────────────────────────────────────────────────────────

export interface PageTypeGuess {
  pageType: string
  score: number
  matched: string[]
}

/** A keyword-based hint about what kind of page a source describes. Never authoritative. */
export function guessPageType(text: string, types: PageTypeDefinition[]): PageTypeGuess[] {
  const haystack = text.toLowerCase()
  return types
    .map((type) => {
      const matched = type.detectionHints.filter((hint) => {
        const escaped = hint.toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
        return new RegExp(`(^|[^a-z])${escaped}([^a-z]|$)`).test(haystack)
      })
      return { pageType: type.id, score: matched.length / Math.max(type.detectionHints.length, 1), matched }
    })
    .filter((guess) => guess.score > 0)
    .sort((a, b) => b.score - a.score)
}

const SUSPICIOUS_PATTERNS: RegExp[] = [
  /ignore (all |any )?(the )?(previous|prior|above) (instructions|rules)/i,
  /disregard (all |any )?(the )?(previous|prior|above|system)/i,
  /\byou are now\b/i,
  /\bsystem prompt\b/i,
  /\b(assistant|system)\s*:/i,
  /\bnew instructions\b/i,
  /\bapprove (this|the) (write|creation)\b/i,
]

/**
 * Flags text that reads like instructions aimed at an AI. Such text is still treated as
 * plain data — this only warns the reviewer that the source may try to steer the AI.
 */
export function detectSuspiciousInstructions(text: string): string[] {
  const hits = SUSPICIOUS_PATTERNS.filter((pattern) => pattern.test(text))
  return hits.length === 0
    ? []
    : [
        'The source contains text that looks like instructions to an AI (for example “ignore previous instructions”). It will be treated as plain source text, but review the draft carefully.',
      ]
}
