import { getAppContext } from '@/server/context'
import { errorResponse } from '@/server/http'
import { ServiceError } from '@/server/services/errors'
import { exportChronology, exportKnowledge, exportRelationships } from '@/server/services/phase3-exports'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

/** Chronology, knowledge findings and relationships as CSV or JSON, with source resource ids. */
export async function GET(request: Request, { params }: { params: Promise<{ kind: string }> }) {
  const { kind } = await params
  const url = new URL(request.url)
  const format = url.searchParams.get('format') === 'json' ? 'json' : 'csv'
  const query = Object.fromEntries(url.searchParams)
  delete query.format
  try {
    const ctx = getAppContext()
    const result =
      kind === 'chronology' ? exportChronology(ctx, query, format) : kind === 'knowledge' ? exportKnowledge(ctx, query, format) : kind === 'relationships' ? exportRelationships(ctx, query, format) : null
    if (!result) throw new ServiceError(404, 'Unknown export.')
    return new Response(result.body, {
      headers: { 'content-type': `${result.contentType}; charset=utf-8`, 'content-disposition': `attachment; filename="${result.fileName}"`, 'cache-control': 'no-store' },
    })
  } catch (error) {
    return errorResponse(error)
  }
}
