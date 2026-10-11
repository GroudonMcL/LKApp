/**
 * Extraction turns an uploaded file or pasted text into plain source text the rest of the
 * pipeline understands. Each format has its own extractor; adding PDF, DOCX, HTML or OCR
 * later means adding one extractor, without changing anything downstream.
 */

export type ExtractedFormat = 'text' | 'markdown' | 'json'

export interface SourceInput {
  bytes: Uint8Array
  fileName: string | null
  /** MIME type reported by the browser, if any. Treated as a hint only. */
  mimeType: string | null
  /** Set when the user explicitly chose a format for pasted text. */
  declaredFormat?: ExtractedFormat | null
}

export interface OutlineEntry {
  level: number
  heading: string
  /** Character offset of the heading line in `text`. */
  offset: number
}

export interface ExtractedSource {
  format: ExtractedFormat
  /** The text shown to reviewers and sent to the AI. Never truncated. */
  text: string
  /** The parsed value, for JSON sources. */
  json?: unknown
  /** A likely page title found in the source (first heading, `name` key…), if any. */
  title: string | null
  outline: OutlineEntry[]
  stats: { chars: number; lines: number; words: number }
  warnings: string[]
}

export interface Extractor {
  id: string
  format: ExtractedFormat
  /** File extensions (lowercase, with dot) this extractor handles. */
  extensions: string[]
  mimeTypes: string[]
  extract(text: string): ExtractedSource
}

export class ExtractionError extends Error {
  constructor(
    message: string,
    readonly code:
      | 'EMPTY'
      | 'TOO_LARGE'
      | 'TOO_LONG'
      | 'NOT_UTF8'
      | 'BINARY'
      | 'UNSUPPORTED_TYPE'
      | 'INVALID_JSON',
  ) {
    super(message)
    this.name = 'ExtractionError'
  }
}
