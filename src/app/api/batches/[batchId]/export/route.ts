import { errorResponse } from '@/server/http'
import { getAppContext } from '@/server/context'
import { exportBatch } from '@/server/services/import-batches'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

/** Downloads the batch results or the last dry run as JSON or CSV. No credentials are included. */
export async function GET(request: Request, { params }: { params: Promise<{ batchId: string }> }) {
  const { batchId } = await params
  const url = new URL(request.url)
  const report = url.searchParams.get('report') === 'dry_run' ? 'dry_run' : 'results'
  const format = url.searchParams.get('format') === 'csv' ? 'csv' : 'json'
  try {
    const file = exportBatch(getAppContext(), batchId, { report, format })
    return new Response(file.body, {
      headers: {
        'content-type': `${file.contentType}; charset=utf-8`,
        'content-disposition': `attachment; filename="${file.fileName}"`,
        'cache-control': 'no-store',
      },
    })
  } catch (error) {
    return errorResponse(error)
  }
}
