import { getAppContext } from '@/server/context'
import { errorResponse } from '@/server/http'
import { migrationOriginal } from '@/server/services/migrations'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

/** Downloads the saved original content of a page (JSON, exactly as LegendKeeper returned it). */
export async function GET(_request: Request, { params }: { params: Promise<{ batchId: string; itemId: string }> }) {
  const { batchId, itemId } = await params
  try {
    const file = migrationOriginal(getAppContext(), batchId, itemId)
    return new Response(file.body, { headers: { 'content-type': `${file.contentType}; charset=utf-8`, 'content-disposition': `attachment; filename="${file.fileName}"`, 'cache-control': 'no-store' } })
  } catch (error) {
    return errorResponse(error)
  }
}
