import { handle } from '@/server/http'
import { connectionSummary, ensureConnectionChecked } from '@/server/services/connection'
import { scanStatus } from '@/server/services/discovery'
import { reviewCounts } from '@/server/services/review-queue'
import { configBlockers } from '@/server/services/write'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

/**
 * Dashboard summary. Uses local data, plus an automatic read-only connection test when there
 * is no recent result. Never calls the AI.
 */
export async function GET() {
  return handle(async (ctx) => {
    await ensureConnectionChecked(ctx)
    return {
      connection: connectionSummary(ctx),
      index: scanStatus(ctx),
      imports: ctx.repos.jobs.countByStatus(),
      pagesCreated: ctx.repos.drafts.countCreated(),
      recipes: ctx.repos.recipes.count(),
      review: reviewCounts(ctx),
      writeBlockers: configBlockers(ctx),
      recentActivity: ctx.repos.audit.list({ limit: 8 }),
    }
  })
}
