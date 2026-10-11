import { handle } from '@/server/http'
import { browseLive } from '@/server/services/discovery'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

/** One page straight from LegendKeeper (used before a scan exists). */
export async function GET(request: Request) {
  const params = new URL(request.url).searchParams
  return handle((ctx) => browseLive(ctx, params.get('cursor'), params.get('parentId')))
}
