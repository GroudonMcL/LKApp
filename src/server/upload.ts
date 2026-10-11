import 'server-only'
import type { ExtractedFormat } from '@/core/extraction'
import type { AppContext } from './context'
import { ServiceError } from './services/errors'

export interface UploadedSource {
  bytes: Uint8Array
  fileName: string | null
  mimeType: string | null
  declaredFormat: ExtractedFormat | null
  sourceKind: 'upload' | 'paste'
  fields: Record<string, string>
}

/**
 * Reads a multipart form holding either a `file` or pasted `text`, plus plain fields.
 * The declared size is checked before the body is read, so an oversized upload is refused
 * without being processed. File names are used only as labels, never as paths.
 */
export async function readSourceForm(request: Request, ctx: AppContext): Promise<UploadedSource> {
  const limit = ctx.config().limits.maxUploadBytes
  const declared = Number(request.headers.get('content-length') ?? '0')
  if (declared > limit + 64 * 1024) {
    throw new ServiceError(413, `The upload is larger than the ${limit.toLocaleString('en-GB')} byte limit. Split the file into smaller parts.`)
  }
  let form: FormData
  try {
    form = await request.formData()
  } catch {
    throw new ServiceError(400, 'Expected a form upload.')
  }
  const fields: Record<string, string> = {}
  for (const [key, value] of form.entries()) if (typeof value === 'string') fields[key] = value

  const formatField = fields.format
  const declaredFormat = formatField === 'text' || formatField === 'markdown' || formatField === 'json' ? formatField : null
  const file = form.get('file')
  if (file && typeof file !== 'string' && file.size > 0) {
    if (file.size > limit) throw new ServiceError(413, `The file is larger than the ${limit.toLocaleString('en-GB')} byte limit.`)
    const safeName = file.name.replace(/[\\/]/g, '_').slice(0, 200) || null
    return { bytes: new Uint8Array(await file.arrayBuffer()), fileName: safeName, mimeType: file.type || null, declaredFormat, sourceKind: 'upload', fields }
  }
  const text = fields.text ?? ''
  if (text.trim() === '') throw new ServiceError(400, 'Choose a file or paste some text.')
  return { bytes: new TextEncoder().encode(text), fileName: null, mimeType: null, declaredFormat, sourceKind: 'paste', fields }
}
