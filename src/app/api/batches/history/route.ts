import { getAppContext } from '@/server/context'
import { errorResponse } from '@/server/http'
import { exportHistory } from '@/server/services/import-batches'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

/** Every job (imports, tagging, migrations) with its summary, as CSV or JSON. */
export async function GET(request: Request) {
  const url = new URL(request.url)
  try {
    const file = exportHistory(getAppContext(), url.searchParams.get('format') === 'csv' ? 'csv' : 'json')
    return new Response(file.body, { headers: { 'content-type': `${file.contentType}; charset=utf-8`, 'content-disposition': `attachment; filename="${file.fileName}"`, 'cache-control': 'no-store' } })
  } catch (error) {
    return errorResponse(error)
  }
}
