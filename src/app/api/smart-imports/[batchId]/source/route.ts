import { handle, intParam } from '@/server/http'
import { recordSource, sourceLines } from '@/server/services/smart-import'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

/** The source text of one page (`itemId`), or some lines of a source (`sourceId`, `from`, `to`). Local only. */
export async function GET(request: Request, { params }: { params: Promise<{ batchId: string }> }) {
  const { batchId } = await params
  const url = new URL(request.url)
  const itemId = url.searchParams.get('itemId')
  return handle((ctx) =>
    itemId
      ? recordSource(ctx, batchId, itemId)
      : sourceLines(ctx, batchId, url.searchParams.get('sourceId') ?? '', { from: intParam(url.searchParams.get('from'), 1), to: intParam(url.searchParams.get('to'), 1) }),
  )
}
