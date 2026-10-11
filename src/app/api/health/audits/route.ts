import { handle } from '@/server/http'
import { startAudit } from '@/server/services/wiki-health'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

/** Starts a read-only audit in the background. */
export async function POST(request: Request) {
  return handle(async (ctx) => startAudit(ctx, await request.json().catch(() => ({}))))
}
