import 'server-only'
import { ExtractionError, extractSource, formatBytes, markdownOutline, type ExtractedSource, type ExtractionLimits } from '@/core/extraction'
import { htmlToMarkdown } from '@/core/extraction/html'
import { detectSuspiciousInstructions } from '@/core/extraction'
import type { PageStart } from '@/core/records'

/**
 * Extraction for every supported file type, including binary documents.
 *
 * | Type | How | AI? |
 * | --- | --- | --- |
 * | .txt .md .json | existing text extractors | no |
 * | .html .htm | HTML → Markdown (headings, lists, tables kept) | no |
 * | .docx | mammoth (Word → HTML), then HTML → Markdown | no |
 * | .pdf with a text layer | PDF.js (via unpdf), page by page; page numbers kept | no |
 * | .pdf without a text layer (scanned) | flagged; can be transcribed by AI on request | yes, opt-in |
 * | .png .jpg .jpeg .webp .gif | flagged; can be transcribed by AI on request | yes, opt-in |
 *
 * Old `.doc`, `.odt`, `.rtf` and other formats are refused with advice to save as .docx or PDF.
 */

export type OriginalFormat = 'text' | 'markdown' | 'json' | 'html' | 'docx' | 'pdf' | 'image'

export interface DocumentExtraction {
  originalFormat: OriginalFormat
  /** The format of `text` for the rest of the pipeline. */
  format: ExtractedSource['format']
  text: string
  json?: unknown
  title: string | null
  warnings: string[]
  /** Source page starts, for PDFs; empty for formats without pages. */
  pages: PageStart[]
  totalPages: number | null
  method: 'parser' | 'ai_transcription'
  /** The file has no usable text and must be transcribed (images, scanned PDFs). */
  needsTranscription: boolean
  /** For transcription: the media type the AI will receive. */
  mediaType: string | null
}

export interface DocumentLimits extends ExtractionLimits {
  /** Upload limit for binary documents (PDF, DOCX, images). */
  maxDocumentBytes: number
}

const IMAGE_TYPES: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
}
/** The Claude API accepts images up to about 5 MB each. */
export const MAX_IMAGE_BYTES = 5 * 1024 * 1024

const REFUSED: { extensions: string[]; advice: string }[] = [
  { extensions: ['.doc'], advice: 'Old Word .doc files are not supported. Open the file in Word and save it as .docx (or PDF).' },
  { extensions: ['.odt', '.rtf', '.pages'], advice: 'This word-processor format is not supported. Save it as .docx or PDF.' },
  { extensions: ['.tif', '.tiff', '.bmp', '.heic'], advice: 'This image format is not supported. Save it as PNG or JPEG.' },
  { extensions: ['.xls', '.xlsx', '.csv', '.ods'], advice: 'Spreadsheets are not supported yet. Export the rows as JSON, or copy them into a text file.' },
]

function extensionOf(fileName: string | null): string | null {
  const match = fileName ? /\.[A-Za-z0-9]+$/.exec(fileName) : null
  return match ? match[0].toLowerCase() : null
}

export function detectOriginalFormat(fileName: string | null, mimeType: string | null, bytes: Uint8Array): OriginalFormat | null {
  const ext = extensionOf(fileName)
  const mime = (mimeType ?? '').toLowerCase()
  if (ext === '.pdf' || mime === 'application/pdf' || startsWith(bytes, '%PDF-')) return 'pdf'
  if (ext === '.docx' || mime.includes('wordprocessingml')) return 'docx'
  if (ext === '.html' || ext === '.htm' || mime === 'text/html') return 'html'
  if ((ext && IMAGE_TYPES[ext]) || ['image/png', 'image/jpeg', 'image/webp', 'image/gif'].includes(mime)) return 'image'
  if (ext === '.json') return 'json'
  if (ext === '.md' || ext === '.markdown') return 'markdown'
  return null
}

function startsWith(bytes: Uint8Array, prefix: string): boolean {
  if (bytes.byteLength < prefix.length) return false
  for (let i = 0; i < prefix.length; i++) if (bytes[i] !== prefix.charCodeAt(i)) return false
  return true
}

export async function extractDocument(
  input: { bytes: Uint8Array; fileName: string | null; mimeType: string | null; declaredFormat?: ExtractedSource['format'] | null },
  limits: DocumentLimits,
): Promise<DocumentExtraction> {
  const { bytes, fileName, mimeType } = input
  if (bytes.byteLength === 0) throw new ExtractionError('The file is empty.', 'EMPTY')
  const ext = extensionOf(fileName)
  const refused = REFUSED.find((entry) => ext && entry.extensions.includes(ext))
  if (refused) throw new ExtractionError(refused.advice, 'UNSUPPORTED_TYPE')

  const original = input.declaredFormat ? null : detectOriginalFormat(fileName, mimeType, bytes)
  if (original === 'pdf' || original === 'docx' || original === 'image') {
    if (bytes.byteLength > limits.maxDocumentBytes) {
      throw new ExtractionError(`The file is ${formatBytes(bytes.byteLength)}, over the ${formatBytes(limits.maxDocumentBytes)} limit for documents. Split it into smaller files.`, 'TOO_LARGE')
    }
    if (original === 'image') return extractImage(bytes, ext, mimeType)
    if (original === 'docx') return finish(await extractDocx(bytes), limits)
    return finish(await extractPdf(bytes), limits)
  }
  if (original === 'html') {
    if (bytes.byteLength > limits.maxBytes) throw new ExtractionError(`The file is ${formatBytes(bytes.byteLength)}, over the ${formatBytes(limits.maxBytes)} upload limit.`, 'TOO_LARGE')
    let html: string
    try {
      html = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
    } catch {
      throw new ExtractionError('The HTML file is not valid UTF-8 text. Re-save it as UTF-8.', 'NOT_UTF8')
    }
    const { markdown, title } = htmlToMarkdown(html)
    return finish({ originalFormat: 'html', format: 'markdown', text: markdown, title, warnings: [], pages: [], totalPages: null, method: 'parser', needsTranscription: false, mediaType: null }, limits)
  }
  // Text, Markdown, JSON: the existing extractors (size, encoding, JSON validity checks).
  const extracted = extractSource({ bytes, fileName, mimeType, declaredFormat: input.declaredFormat ?? null }, limits)
  return {
    originalFormat: extracted.format,
    format: extracted.format,
    text: extracted.text,
    json: extracted.json,
    title: extracted.title,
    warnings: extracted.warnings,
    pages: [],
    totalPages: null,
    method: 'parser',
    needsTranscription: false,
    mediaType: null,
  }
}

function finish(result: DocumentExtraction, limits: DocumentLimits): DocumentExtraction {
  if (!result.needsTranscription && result.text.trim() === '') throw new ExtractionError('No text could be found in the file.', 'EMPTY')
  if (result.text.length > limits.maxChars * 20) {
    throw new ExtractionError(
      `The document has ${result.text.length.toLocaleString('en-GB')} characters, more than one batch can handle (${(limits.maxChars * 20).toLocaleString('en-GB')}). Split it into parts.`,
      'TOO_LONG',
    )
  }
  if (!result.title) result.title = markdownOutline(result.text)[0]?.heading ?? null
  result.warnings.push(...detectSuspiciousInstructions(result.text))
  return result
}

function extractImage(bytes: Uint8Array, ext: string | null, mimeType: string | null): DocumentExtraction {
  const mediaType = (ext && IMAGE_TYPES[ext]) || (mimeType && Object.values(IMAGE_TYPES).includes(mimeType) ? mimeType : 'image/png')
  if (bytes.byteLength > MAX_IMAGE_BYTES) {
    throw new ExtractionError(`The image is ${formatBytes(bytes.byteLength)}; the AI accepts images up to ${formatBytes(MAX_IMAGE_BYTES)}. Save it smaller (e.g. as JPEG) or crop it.`, 'TOO_LARGE')
  }
  return {
    originalFormat: 'image',
    format: 'markdown',
    text: '',
    title: null,
    warnings: ['This is an image. Its text can only be read by AI transcription (sent to the AI provider when you ask for it).'],
    pages: [],
    totalPages: null,
    method: 'parser',
    needsTranscription: true,
    mediaType,
  }
}

async function extractDocx(bytes: Uint8Array): Promise<DocumentExtraction> {
  const mammoth = (await import('mammoth')).default
  let result
  try {
    result = await mammoth.convertToHtml(
      { buffer: Buffer.from(bytes) },
      {
        // Never read linked files from disk, and drop embedded images (they cannot be imported).
        externalFileAccess: false,
        convertImage: mammoth.images.imgElement(async () => ({ src: '' })),
      },
    )
  } catch (error) {
    throw new ExtractionError(`The Word document could not be read: ${(error as Error).message}. Re-save it as .docx and try again.`, 'UNSUPPORTED_TYPE')
  }
  const { markdown, title } = htmlToMarkdown(result.value)
  const warnings = result.messages.filter((m) => m.type === 'warning').length
  return {
    originalFormat: 'docx',
    format: 'markdown',
    text: markdown,
    title,
    warnings: warnings ? [`The Word converter reported ${warnings} formatting issue(s) (usually unrecognised styles). Check headings and tables in the extracted text.`] : [],
    pages: [],
    totalPages: null,
    method: 'parser',
    needsTranscription: false,
    mediaType: null,
  }
}

/** Fewer characters than this per page, on average, means the PDF is probably scanned. */
const MIN_CHARS_PER_PAGE = 40

async function extractPdf(bytes: Uint8Array): Promise<DocumentExtraction> {
  const { extractText, getDocumentProxy } = await import('unpdf')
  let pages: string[]
  let totalPages: number
  try {
    const pdf = await getDocumentProxy(new Uint8Array(bytes))
    const result = await extractText(pdf, { mergePages: false })
    pages = result.text
    totalPages = result.totalPages
  } catch (error) {
    const message = (error as Error).message ?? ''
    if (/password/i.test(message)) throw new ExtractionError('The PDF is password-protected. Remove the password and try again.', 'UNSUPPORTED_TYPE')
    throw new ExtractionError(`The PDF could not be read: ${message}.`, 'UNSUPPORTED_TYPE')
  }

  const starts: PageStart[] = []
  let text = ''
  pages.forEach((pageText, i) => {
    const cleaned = tidyPdfText(pageText)
    if (i > 0) text += '\n\n'
    starts.push({ page: i + 1, offset: text.length })
    text += cleaned
  })
  const chars = text.replace(/\s/g, '').length
  const scanned = totalPages > 0 && chars / totalPages < MIN_CHARS_PER_PAGE
  const warnings: string[] = []
  if (scanned) {
    warnings.push(
      `This PDF has almost no text layer (${chars} characters on ${totalPages} page(s)); it is probably scanned. Its text can only be read by AI transcription.`,
    )
  } else {
    warnings.push('PDFs carry no heading structure. Check that records were split correctly; a recipe can split by statblock or by a separator line.')
  }
  return {
    originalFormat: 'pdf',
    format: 'text',
    text: scanned ? '' : text,
    title: null,
    warnings,
    pages: scanned ? [] : starts,
    totalPages,
    method: 'parser',
    needsTranscription: scanned,
    mediaType: scanned ? 'application/pdf' : null,
  }
}

/** Joins hyphenated line breaks and trims trailing spaces; keeps every word. */
function tidyPdfText(text: string): string {
  return text
    .replace(/\r\n?/g, '\n')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/(\p{L})-\n(\p{Ll})/gu, '$1$2')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}
