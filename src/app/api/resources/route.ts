import { handle, intParam } from '@/server/http'
import { browseIndex } from '@/server/services/discovery'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

/** Filtered, paginated browsing of the local resource index (server-side). */
export async function GET(request: Request) {
  const params = new URL(request.url).searchParams
  return handle((ctx) =>
    browseIndex(ctx, {
      q: params.get('q') ?? undefined,
      tag: params.get('tag') ?? undefined,
      untagged: params.get('untagged') === '1',
      parentId: params.has('parentId') ? params.get('parentId') || null : undefined,
      page: intParam(params.get('page'), 1),
      pageSize: intParam(params.get('pageSize'), 50),
    }),
  )
}
