import { handle } from '@/server/http'
import { requireProjectId } from '@/server/services/connection'
import { relationshipGraph } from '@/server/services/relationship-graph'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

/** The relationship map: the whole project, or the pages around one (`centre`, `depth`). Read-only. */
export async function GET(request: Request) {
  const url = new URL(request.url)
  const p = url.searchParams
  return handle(async (ctx) =>
    relationshipGraph(ctx, await requireProjectId(ctx), {
      centre: p.get('centre') || undefined,
      depth: p.get('depth') ? Number(p.get('depth')) : undefined,
      tree: p.get('tree') === 'true' ? true : p.get('tree') === 'false' ? false : undefined,
      wording: p.get('wording') === 'true',
      maxNodes: p.get('maxNodes') ? Number(p.get('maxNodes')) : undefined,
      kinds: p.getAll('kind').filter(Boolean),
    }),
  )
}
