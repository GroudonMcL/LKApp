import { handle } from '@/server/http'
import { requireProjectId } from '@/server/services/connection'
import { relationshipsFor } from '@/server/services/knowledge-analysis'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

/** One page's known relationships (outgoing and incoming) and its immediate neighbours. Read-only. */
export async function GET(_request: Request, { params }: { params: Promise<{ resourceId: string }> }) {
  const { resourceId } = await params
  return handle(async (ctx) => relationshipsFor(ctx, await requireProjectId(ctx), resourceId))
}
