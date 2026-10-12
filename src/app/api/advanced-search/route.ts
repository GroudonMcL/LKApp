import { handle } from '@/server/http'
import { searchProject } from '@/server/services/advanced-search'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

/** Combined search over the local index and page content. Read-only; results are page ids from the last scan. */
export async function GET(request: Request) {
  const params = Object.fromEntries(new URL(request.url).searchParams)
  return handle((ctx) => searchProject(ctx, params))
}
