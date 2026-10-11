import { handle, intParam } from '@/server/http'
import { liveSearch } from '@/server/services/discovery'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

/** LegendKeeper's own search (names, aliases and page content). */
export async function GET(request: Request) {
  const params = new URL(request.url).searchParams
  return handle(async (ctx) => ({ hits: await liveSearch(ctx, params.get('q') ?? '', Math.min(intParam(params.get('limit'), 20), 50)) }))
}
