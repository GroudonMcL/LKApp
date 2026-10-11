import { handle } from '@/server/http'
import { tagOverview } from '@/server/services/tags'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function GET(request: Request) {
  const refresh = new URL(request.url).searchParams.get('refresh') === '1'
  return handle((ctx) => tagOverview(ctx, { refresh }))
}
