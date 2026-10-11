import { handle } from '@/server/http'
import { addBatchSources } from '@/server/services/import-batches'
import { ServiceError } from '@/server/services/errors'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

/**
 * Adds one file (`file`) or one pasted text (`text`, optional `name` and `format`) to a batch.
 * One per request keeps every request small and gives each file its own result.
 */
export async function POST(request: Request, { params }: { params: Promise<{ batchId: string }> }) {
  const { batchId } = await params
  return handle(async (ctx) => {
    const limit = ctx.config().limits.maxDocumentBytes
    const declared = Number(request.headers.get('content-length') ?? '0')
    if (declared > limit + 1024 * 1024) throw new ServiceError(413, `The file is larger than the ${limit.toLocaleString('en-GB')} byte limit for documents.`)
    let form: FormData
    try {
      form = await request.formData()
    } catch {
      throw new ServiceError(400, 'Expected a form upload.')
    }
    const file = form.get('file')
    if (file && typeof file !== 'string' && file.size > 0) {
      if (file.size > limit) throw new ServiceError(413, `“${file.name}” is larger than the ${limit.toLocaleString('en-GB')} byte limit.`)
      const fileName = file.name.replace(/[\\/]/g, '_').slice(0, 200) || null
      return addBatchSources(ctx, batchId, [{ bytes: new Uint8Array(await file.arrayBuffer()), fileName, mimeType: file.type || null }], [])
    }
    const text = form.get('text')
    if (typeof text !== 'string' || text.trim() === '') throw new ServiceError(400, 'Choose a file or paste some text.')
    const name = form.get('name')
    const format = form.get('format')
    return addBatchSources(ctx, batchId, [], [
      { name: typeof name === 'string' && name.trim() ? name.trim().slice(0, 200) : 'Pasted text', text, format: format === 'text' || format === 'markdown' || format === 'json' ? format : null },
    ])
  }, 201)
}
