import { handle } from '@/server/http'
import { connectionSummary } from '@/server/services/connection'
import { scanStatus } from '@/server/services/discovery'
import { configBlockers, verificationBlocker } from '@/server/services/write'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

/** Dashboard summary. Uses only local data: it never calls LegendKeeper or the AI. */
export async function GET() {
  return handle((ctx) => {
    const verification = verificationBlocker(ctx)
    return {
      connection: connectionSummary(ctx),
      index: scanStatus(ctx),
      imports: ctx.repos.jobs.countByStatus(),
      pagesCreated: ctx.repos.drafts.countCreated(),
      recipes: ctx.repos.recipes.count(),
      writeBlockers: [...configBlockers(ctx), ...(verification ? [verification] : [])],
      recentActivity: ctx.repos.audit.list({ limit: 8 }),
    }
  })
}
