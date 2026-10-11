import { ExtractionError, type ExtractedSource, type Extractor, type OutlineEntry } from './types'

function stats(text: string): ExtractedSource['stats'] {
  return {
    chars: text.length,
    lines: text === '' ? 0 : text.split('\n').length,
    words: (text.match(/\S+/g) ?? []).length,
  }
}

/** Normalises line endings and strips a byte-order mark. Content is otherwise unchanged. */
export function normalizeNewlines(text: string): string {
  return text.replace(/^﻿/, '').replace(/\r\n?/g, '\n')
}

export const plainTextExtractor: Extractor = {
  id: 'plain-text',
  format: 'text',
  extensions: ['.txt', '.text'],
  mimeTypes: ['text/plain'],
  extract(raw) {
    const text = normalizeNewlines(raw)
    const firstLine = text.split('\n').find((line) => line.trim() !== '')?.trim() ?? null
    return {
      format: 'text',
      text,
      title: firstLine && firstLine.length <= 120 ? firstLine : null,
      outline: [],
      stats: stats(text),
      warnings: [],
    }
  },
}

export function markdownOutline(text: string): OutlineEntry[] {
  const outline: OutlineEntry[] = []
  let offset = 0
  let inFence = false
  for (const line of text.split('\n')) {
    if (/^\s*(```|~~~)/.test(line)) inFence = !inFence
    const match = !inFence ? /^(#{1,6})\s+(.+?)\s*#*\s*$/.exec(line) : null
    if (match) outline.push({ level: match[1]!.length, heading: match[2]!, offset })
    offset += line.length + 1
  }
  return outline
}

export const markdownExtractor: Extractor = {
  id: 'markdown',
  format: 'markdown',
  extensions: ['.md', '.markdown', '.mdown'],
  mimeTypes: ['text/markdown', 'text/x-markdown'],
  extract(raw) {
    const text = normalizeNewlines(raw)
    const outline = markdownOutline(text)
    const h1 = outline.find((entry) => entry.level === 1)
    return {
      format: 'markdown',
      text,
      title: h1?.heading ?? outline[0]?.heading ?? null,
      outline,
      stats: stats(text),
      warnings: [],
    }
  },
}

export const jsonExtractor: Extractor = {
  id: 'json',
  format: 'json',
  extensions: ['.json'],
  mimeTypes: ['application/json', 'text/json'],
  extract(raw) {
    const source = normalizeNewlines(raw)
    let json: unknown
    try {
      json = JSON.parse(source)
    } catch (error) {
      throw new ExtractionError(
        `The file is not valid JSON: ${(error as Error).message}. Fix the file or paste it as plain text.`,
        'INVALID_JSON',
      )
    }
    // Pretty-printed so reviewers and the AI see a stable, readable form. Values are unchanged.
    const text = JSON.stringify(json, null, 2)
    const warnings: string[] = []
    if (Array.isArray(json) && json.length > 1) {
      warnings.push(
        `The JSON is a list of ${json.length} items. Phase 1 creates one page per import, so pick one item (split the source) or the draft will describe only one of them.`,
      )
    }
    return { format: 'json', text, json, title: jsonTitle(json), outline: [], stats: stats(text), warnings }
  },
}

function jsonTitle(value: unknown): string | null {
  const object = Array.isArray(value) ? value[0] : value
  if (object && typeof object === 'object') {
    for (const key of ['name', 'title', 'Name', 'Title']) {
      const candidate = (object as Record<string, unknown>)[key]
      if (typeof candidate === 'string' && candidate.trim() !== '') return candidate.trim()
    }
  }
  return null
}

/**
 * Reads a value from parsed JSON by a dotted path: `stats.ac`, `names[0]`, `a.b[2].c`.
 * Returns undefined for anything that does not exist. No evaluation, no wildcards.
 */
export function getByPath(value: unknown, path: string): unknown {
  const parts = path
    .replace(/\[(\d+)\]/g, '.$1')
    .split('.')
    .filter((part) => part !== '')
  let current: unknown = value
  for (const part of parts) {
    if (current === null || typeof current !== 'object') return undefined
    if (Array.isArray(current)) {
      if (!/^\d+$/.test(part)) return undefined
      current = current[Number(part)]
    } else {
      if (!Object.prototype.hasOwnProperty.call(current, part)) return undefined
      current = (current as Record<string, unknown>)[part]
    }
  }
  return current
}

/** Turns a JSON value into display text for a field, without inventing anything. */
export function jsonValueToText(value: unknown): string | null {
  if (value === undefined || value === null) return null
  if (typeof value === 'string') return value
  if (typeof value === 'number' || typeof value === 'boolean') return String(value)
  if (Array.isArray(value) && value.every((item) => ['string', 'number', 'boolean'].includes(typeof item))) {
    return value.map(String).join(', ')
  }
  return JSON.stringify(value)
}

export const EXTRACTORS: Extractor[] = [markdownExtractor, jsonExtractor, plainTextExtractor]

/** Formats recognised but not supported in Phase 1, with a clear explanation. */
export const UNSUPPORTED_FORMATS: { extensions: string[]; mimePrefixes: string[]; label: string }[] = [
  { extensions: ['.pdf'], mimePrefixes: ['application/pdf'], label: 'PDF' },
  {
    extensions: ['.docx', '.doc', '.odt', '.rtf'],
    mimePrefixes: ['application/vnd.openxmlformats', 'application/msword', 'application/vnd.oasis', 'application/rtf'],
    label: 'Word-processor documents',
  },
  { extensions: ['.html', '.htm'], mimePrefixes: ['text/html'], label: 'HTML' },
  {
    extensions: ['.png', '.jpg', '.jpeg', '.gif', '.webp', '.tif', '.tiff', '.bmp'],
    mimePrefixes: ['image/'],
    label: 'Images (OCR)',
  },
]
