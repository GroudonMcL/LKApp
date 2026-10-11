import { handle } from '@/server/http'
import { connectionSummary, ensureConnectionChecked, testConnection } from '@/server/services/connection'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

/** The connection summary. Tests the connection first when there is no recent result. */
export async function GET() {
  return handle(async (ctx) => {
    await ensureConnectionChecked(ctx)
    return connectionSummary(ctx)
  })
}

/** Tests the connection with live, read-only calls. */
export async function POST() {
  return handle(async (ctx) => ({ check: await testConnection(ctx), summary: connectionSummary(ctx) }))
}
