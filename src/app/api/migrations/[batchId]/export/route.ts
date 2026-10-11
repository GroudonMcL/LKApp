import { errorResponse } from '@/server/http'
import { getAppContext } from '@/server/context'
import { exportMigration } from '@/server/services/migrations'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function GET(request: Request, { params }: { params: Promise<{ batchId: string }> }) {
  const { batchId } = await params
  const url = new URL(request.url)
  try {
    const file = exportMigration(getAppContext(), batchId, { report: url.searchParams.get('report') === 'dry_run' ? 'dry_run' : 'results', format: url.searchParams.get('format') === 'csv' ? 'csv' : 'json' })
    return new Response(file.body, { headers: { 'content-type': `${file.contentType}; charset=utf-8`, 'content-disposition': `attachment; filename="${file.fileName}"`, 'cache-control': 'no-store' } })
  } catch (error) {
    return errorResponse(error)
  }
}
